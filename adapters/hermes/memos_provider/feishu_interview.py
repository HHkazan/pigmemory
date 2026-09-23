"""Feishu interactive cards for PigMemory user interviews.

This module deliberately does **not** submit ``feedback.submit`` or touch any
memory score.  It owns only the presentation-side loop:

1. send a 1..5 rating card after a completed Hermes turn;
2. parse the generic ``/card ...`` command emitted by Hermes' Feishu adapter;
3. send a structured reason follow-up or ask for one free-text reply; and
4. append the raw interaction to a local JSONL audit file for later wiring.

Keeping this boundary explicit lets the UI ship before human ratings become
an authoritative reward source.
"""

from __future__ import annotations

import contextlib
import json
import os
import threading
import time
import urllib.error
import urllib.request

from pathlib import Path
from typing import Any, Callable


_ACTION_KEY = "pigmemory_interview_action"
_DEFAULT_TIMEOUT_SECONDS = 8.0
_MAX_PREVIEW_CHARS = 180

HttpPost = Callable[[str, dict[str, Any], dict[str, str], float], dict[str, Any]]


def interview_enabled(platform: str) -> bool:
    """Return whether cards should be sent for this provider instance."""
    if (platform or "").strip().lower() != "feishu":
        return False
    value = os.environ.get("MEMOS_FEISHU_INTERVIEW_ENABLED", "true").strip().lower()
    return value not in {"0", "false", "no", "off", "disabled"}


def parse_interview_action(text: str) -> dict[str, Any] | None:
    """Parse the synthetic command produced by Hermes for a card click."""
    normalized = (text or "").strip()
    if not normalized.startswith("/card"):
        return None
    start = normalized.find("{")
    if start < 0:
        return None
    try:
        payload = json.loads(normalized[start:])
    except (TypeError, ValueError, json.JSONDecodeError):
        return None
    if not isinstance(payload, dict) or not payload.get(_ACTION_KEY):
        return None
    return payload


def build_rating_card(*, request_id: str, task_preview: str) -> dict[str, Any]:
    preview = _clip(task_preview, _MAX_PREVIEW_CHARS)
    context = f"\n\n本轮任务：{preview}" if preview else ""
    return {
        "config": {"wide_screen_mode": True},
        "header": {
            "title": {"tag": "plain_text", "content": "本轮记忆帮助度评分"},
            "template": "blue",
        },
        "elements": [
            {
                "tag": "markdown",
                "content": f"Hermes 本轮参考了 PigMemory 记忆。这些记忆对完成任务有多大帮助？{context}",
            },
            {
                "tag": "action",
                "actions": [
                    _button("1 · 很差", "danger", "rate", request_id, score=1),
                    _button("2", "default", "rate", request_id, score=2),
                    _button("3 · 一般", "default", "rate", request_id, score=3),
                    _button("4", "default", "rate", request_id, score=4),
                    _button("5 · 很好", "primary", "rate", request_id, score=5),
                ],
            },
            {
                "tag": "action",
                "actions": [
                    _button("跳过本次评分", "default", "skip", request_id),
                ],
            },
            {
                "tag": "note",
                "elements": [
                    {
                        "tag": "plain_text",
                        "content": "当前仅收集访谈反馈，不会修改 PigMemory 记忆分数。",
                    }
                ],
            },
        ],
    }


def build_skipped_card() -> dict[str, Any]:
    return {
        "config": {"wide_screen_mode": True},
        "header": {
            "title": {"tag": "plain_text", "content": "已跳过评分"},
            "template": "grey",
        },
        "elements": [
            {
                "tag": "markdown",
                "content": "好的，本次任务不再询问评分。",
            }
        ],
    }


def build_notice_card(*, title: str, content: str) -> dict[str, Any]:
    """Build a terminal informational card for `/review` outcomes."""
    return {
        "config": {"wide_screen_mode": True},
        "header": {
            "title": {"tag": "plain_text", "content": title},
            "template": "grey",
        },
        "elements": [
            {
                "tag": "markdown",
                "content": content,
            }
        ],
    }


def build_reason_card(*, request_id: str, score: int) -> dict[str, Any]:
    prompt = (
        "感谢评分。主要是哪一方面没有达到预期？"
        if score <= 3
        else "感谢评分。如果愿意，也可以补充这次体验最值得保留或改进的地方。"
    )
    return {
        "config": {"wide_screen_mode": True},
        "header": {
            "title": {"tag": "plain_text", "content": "再补充一个原因"},
            "template": "orange" if score <= 3 else "green",
        },
        "elements": [
            {"tag": "markdown", "content": prompt},
            {
                "tag": "action",
                "actions": [
                    _button("结果不正确", "danger", "reason", request_id, reason="incorrect"),
                    _button("任务没做完整", "default", "reason", request_id, reason="incomplete"),
                    _button("没有按要求做", "default", "reason", request_id, reason="requirements"),
                    _button("过程太绕或太慢", "default", "reason", request_id, reason="inefficient"),
                    _button("其他（文字说明）", "primary", "reason", request_id, reason="other"),
                ],
            },
        ],
    }


def build_thanks_card(*, request_id: str, allow_more: bool) -> dict[str, Any]:
    elements: list[dict[str, Any]] = [
        {
            "tag": "markdown",
            "content": "已收到，谢谢。当前反馈只用于访谈记录，不会修改记忆分数。",
        }
    ]
    if allow_more:
        elements.append(
            {
                "tag": "action",
                "actions": [
                    _button("补充原因或建议", "default", "ask_reason", request_id),
                ],
            }
        )
    return {
        "config": {"wide_screen_mode": True},
        "header": {
            "title": {"tag": "plain_text", "content": "反馈已收到"},
            "template": "green",
        },
        "elements": elements,
    }


def build_free_text_prompt_card() -> dict[str, Any]:
    return {
        "config": {"wide_screen_mode": True},
        "header": {
            "title": {"tag": "plain_text", "content": "请补充具体原因"},
            "template": "blue",
        },
        "elements": [
            {
                "tag": "markdown",
                "content": "请直接发送一条文字说明。接下来的一条普通文本会被记录为本次访谈原因，不会交给 Hermes 执行。",
            }
        ],
    }


def build_location_name_card(*, content: str) -> dict[str, Any]:
    """Build the one-shot semantic place naming card (never includes coordinates)."""
    return {
        "config": {"wide_screen_mode": True},
        "header": {
            "title": {"tag": "plain_text", "content": "为新地点命名"},
            "template": "blue",
        },
        "elements": [
            {"tag": "markdown", "content": content},
            {
                "tag": "note",
                "elements": [
                    {
                        "tag": "plain_text",
                        "content": "只保存地点名、城市和不可逆邻域标识，不在飞书中发送坐标。",
                    }
                ],
            },
        ],
    }


class FeishuInterviewClient:
    """Small standard-library Feishu sender plus JSONL interview recorder."""

    def __init__(
        self,
        runtime_home: Path,
        *,
        app_id: str | None = None,
        app_secret: str | None = None,
        domain: str | None = None,
        http_post: HttpPost | None = None,
        timeout_seconds: float = _DEFAULT_TIMEOUT_SECONDS,
    ) -> None:
        self.runtime_home = runtime_home
        self.app_id = (app_id or os.environ.get("FEISHU_APP_ID", "")).strip()
        self.app_secret = (app_secret or os.environ.get("FEISHU_APP_SECRET", "")).strip()
        self.domain = (domain or os.environ.get("FEISHU_DOMAIN", "feishu")).strip().lower()
        self.timeout_seconds = max(1.0, float(timeout_seconds))
        self._http_post = http_post or _default_http_post
        self._lock = threading.RLock()
        self._token = ""
        self._token_expires_at = 0.0
        self._rating_counts: dict[str, int] | None = None

    @property
    def configured(self) -> bool:
        return bool(self.app_id and self.app_secret)

    def send_rating_card(self, *, chat_id: str, request_id: str, task_preview: str) -> str:
        return self.send_card(
            chat_id=chat_id,
            card=build_rating_card(request_id=request_id, task_preview=task_preview),
        )

    def send_reason_card(self, *, chat_id: str, request_id: str, score: int) -> str:
        return self.send_card(
            chat_id=chat_id,
            card=build_reason_card(request_id=request_id, score=score),
        )

    def send_skipped_card(self, *, chat_id: str) -> str:
        return self.send_card(chat_id=chat_id, card=build_skipped_card())

    def send_thanks_card(self, *, chat_id: str, request_id: str, allow_more: bool) -> str:
        return self.send_card(
            chat_id=chat_id,
            card=build_thanks_card(request_id=request_id, allow_more=allow_more),
        )

    def send_free_text_prompt(self, *, chat_id: str) -> str:
        return self.send_card(chat_id=chat_id, card=build_free_text_prompt_card())

    def send_notice_card(self, *, chat_id: str, title: str, content: str) -> str:
        return self.send_card(
            chat_id=chat_id,
            card=build_notice_card(title=title, content=content),
        )

    def send_text(self, *, chat_id: str, text: str) -> str:
        """Send a plain proactive message to a Feishu chat."""
        if not self.configured:
            raise RuntimeError("FEISHU_APP_ID or FEISHU_APP_SECRET is not configured")
        token = self._tenant_token()
        response = self._http_post(
            f"{self._base_url()}/open-apis/im/v1/messages?receive_id_type=chat_id",
            {
                "receive_id": chat_id,
                "msg_type": "text",
                "content": json.dumps({"text": str(text or "").strip()}, ensure_ascii=False),
            },
            {
                "Authorization": f"Bearer {token}",
                "Content-Type": "application/json; charset=utf-8",
            },
            self.timeout_seconds,
        )
        _raise_for_feishu_error(response, "send proactive text")
        data = response.get("data")
        return str(data.get("message_id") or "") if isinstance(data, dict) else ""

    def rating_counts(self, memory_refs: list[dict[str, Any]]) -> dict[str, int]:
        """Return durable completed-rating counts for the requested memories."""
        with self._lock:
            if self._rating_counts is None:
                self._rating_counts = self._load_rating_counts_locked()
            return {
                _memory_ref_key(ref): self._rating_counts.get(_memory_ref_key(ref), 0)
                for ref in memory_refs
                if _memory_ref_key(ref)
            }

    def review_history(self, chat_id: str) -> dict[str, Any]:
        """Restore per-chat de-duplication, cooldown, and daily-cap state."""
        rated_episodes: set[str] = set()
        skipped_episodes: set[str] = set()
        automatic_card_timestamps: list[int] = []
        path = self.runtime_home / "logs" / "feishu-interviews.jsonl"
        with self._lock:
            try:
                with path.open("r", encoding="utf-8") as handle:
                    for line in handle:
                        try:
                            event = json.loads(line)
                        except (TypeError, ValueError, json.JSONDecodeError):
                            continue
                        if not isinstance(event, dict) or event.get("chatId") != chat_id:
                            continue
                        episode_id = str(event.get("episodeId") or "")
                        if event.get("kind") == "rating" and episode_id:
                            rated_episodes.add(episode_id)
                        elif event.get("kind") == "rating_skipped" and episode_id:
                            skipped_episodes.add(episode_id)
                        elif event.get("kind") == "rating_card_sent" and not event.get("manual"):
                            with contextlib.suppress(TypeError, ValueError):
                                automatic_card_timestamps.append(int(event.get("ts") or 0))
            except FileNotFoundError:
                pass
            except OSError:
                pass
        return {
            "ratedEpisodes": rated_episodes,
            "skippedEpisodes": skipped_episodes,
            "automaticCardTimestamps": sorted(
                timestamp for timestamp in automatic_card_timestamps if timestamp > 0
            ),
        }

    def send_card(self, *, chat_id: str, card: dict[str, Any]) -> str:
        if not self.configured:
            raise RuntimeError("FEISHU_APP_ID or FEISHU_APP_SECRET is not configured")
        token = self._tenant_token()
        response = self._http_post(
            f"{self._base_url()}/open-apis/im/v1/messages?receive_id_type=chat_id",
            {
                "receive_id": chat_id,
                "msg_type": "interactive",
                "content": json.dumps(card, ensure_ascii=False),
            },
            {
                "Authorization": f"Bearer {token}",
                "Content-Type": "application/json; charset=utf-8",
            },
            self.timeout_seconds,
        )
        _raise_for_feishu_error(response, "send interactive card")
        data = response.get("data")
        return str(data.get("message_id") or "") if isinstance(data, dict) else ""

    def record_event(self, payload: dict[str, Any]) -> None:
        """Append raw interview UI events without entering the reward pipeline."""
        event = {"ts": int(time.time() * 1000), **payload}
        path = self.runtime_home / "logs" / "feishu-interviews.jsonl"
        line = json.dumps(event, ensure_ascii=False, default=str, separators=(",", ":"))
        with self._lock:
            path.parent.mkdir(parents=True, exist_ok=True)
            with path.open("a", encoding="utf-8") as handle:
                handle.write(line + "\n")
            if event.get("kind") == "rating" and self._rating_counts is not None:
                for ref in event.get("memoryRefs") or []:
                    if not isinstance(ref, dict):
                        continue
                    key = _memory_ref_key(ref)
                    if key:
                        self._rating_counts[key] = self._rating_counts.get(key, 0) + 1

    def _load_rating_counts_locked(self) -> dict[str, int]:
        counts: dict[str, int] = {}
        path = self.runtime_home / "logs" / "feishu-interviews.jsonl"
        try:
            with path.open("r", encoding="utf-8") as handle:
                for line in handle:
                    try:
                        event = json.loads(line)
                    except (TypeError, ValueError, json.JSONDecodeError):
                        continue
                    if not isinstance(event, dict) or event.get("kind") != "rating":
                        continue
                    for ref in event.get("memoryRefs") or []:
                        if not isinstance(ref, dict):
                            continue
                        key = _memory_ref_key(ref)
                        if key:
                            counts[key] = counts.get(key, 0) + 1
        except FileNotFoundError:
            pass
        except OSError:
            pass
        return counts

    def _tenant_token(self) -> str:
        with self._lock:
            now = time.time()
            if self._token and now < self._token_expires_at:
                return self._token
            response = self._http_post(
                f"{self._base_url()}/open-apis/auth/v3/tenant_access_token/internal",
                {"app_id": self.app_id, "app_secret": self.app_secret},
                {"Content-Type": "application/json; charset=utf-8"},
                self.timeout_seconds,
            )
            _raise_for_feishu_error(response, "get tenant access token")
            token = str(response.get("tenant_access_token") or "")
            if not token:
                raise RuntimeError("Feishu token response did not contain tenant_access_token")
            expires_in = response.get("expire")
            ttl = float(expires_in) if isinstance(expires_in, int | float) else 7200.0
            self._token = token
            self._token_expires_at = now + max(60.0, ttl - 120.0)
            return token

    def _base_url(self) -> str:
        if self.domain in {"lark", "larksuite", "international"}:
            return "https://open.larksuite.com"
        return "https://open.feishu.cn"


def _button(
    label: str,
    button_type: str,
    action: str,
    request_id: str,
    **extra: Any,
) -> dict[str, Any]:
    return {
        "tag": "button",
        "text": {"tag": "plain_text", "content": label},
        "type": button_type,
        "value": {
            _ACTION_KEY: action,
            "request_id": request_id,
            **extra,
        },
    }


def _clip(value: str, limit: int) -> str:
    text = " ".join((value or "").strip().split())
    return text if len(text) <= limit else text[: limit - 1] + "…"


def _memory_ref_key(ref: dict[str, Any]) -> str:
    ref_id = str(ref.get("refId") or "").strip()
    ref_kind = str(ref.get("refKind") or "memory").strip()
    return f"{ref_kind}:{ref_id}" if ref_id else ""


def _raise_for_feishu_error(response: dict[str, Any], operation: str) -> None:
    code = response.get("code", 0)
    if code not in (0, "0", None):
        raise RuntimeError(f"Feishu {operation} failed: code={code} msg={response.get('msg')}")


def _default_http_post(
    url: str,
    payload: dict[str, Any],
    headers: dict[str, str],
    timeout_seconds: float,
) -> dict[str, Any]:
    request = urllib.request.Request(
        url,
        data=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
        headers=headers,
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout_seconds) as response:
            body = response.read().decode("utf-8", errors="replace")
    except urllib.error.HTTPError as err:
        detail = err.read(2000).decode("utf-8", errors="replace")
        raise RuntimeError(f"Feishu HTTP {err.code}: {detail}") from err
    except urllib.error.URLError as err:
        raise RuntimeError(f"Feishu request failed: {err.reason}") from err
    try:
        decoded = json.loads(body or "{}")
    except json.JSONDecodeError as err:
        raise RuntimeError("Feishu returned malformed JSON") from err
    if not isinstance(decoded, dict):
        raise RuntimeError("Feishu returned a non-object response")
    return decoded


__all__ = [
    "FeishuInterviewClient",
    "build_free_text_prompt_card",
    "build_location_name_card",
    "build_notice_card",
    "build_rating_card",
    "build_reason_card",
    "build_skipped_card",
    "build_thanks_card",
    "interview_enabled",
    "parse_interview_action",
]
