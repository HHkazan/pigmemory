from __future__ import annotations

import importlib.util
import json
import sys
import tempfile
import unittest

from datetime import datetime, timezone
from pathlib import Path
from types import SimpleNamespace
from typing import Any


ROOT = Path(__file__).resolve().parents[2]
PROVIDER_DIR = ROOT / "adapters" / "hermes" / "memos_provider"
if str(PROVIDER_DIR) not in sys.path:
    sys.path.insert(0, str(PROVIDER_DIR))

from feishu_interview import (  # noqa: E402
    FeishuInterviewClient,
    build_rating_card,
    build_skipped_card,
    parse_interview_action,
)
from shared_bridge_runtime import HermesHookDispatcher  # noqa: E402


def _load_provider_module():
    spec = importlib.util.spec_from_file_location(
        "pigmemory_hermes_provider_test",
        PROVIDER_DIR / "__init__.py",
    )
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class FeishuInterviewCardTests(unittest.TestCase):
    def test_rating_card_contains_five_scoped_actions(self) -> None:
        card = build_rating_card(request_id="req-1", task_preview="修复登录问题")
        actions = card["elements"][1]["actions"]
        self.assertEqual([item["value"]["score"] for item in actions], [1, 2, 3, 4, 5])
        self.assertTrue(all(item["value"]["request_id"] == "req-1" for item in actions))
        skip = card["elements"][2]["actions"][0]
        self.assertEqual(skip["value"]["pigmemory_interview_action"], "skip")
        self.assertIn("不会修改 PigMemory 记忆分数", card["elements"][3]["elements"][0]["content"])

    def test_skipped_card_closes_the_interview(self) -> None:
        card = build_skipped_card()
        self.assertEqual(card["header"]["title"]["content"], "已跳过评分")
        self.assertNotIn("action", [element["tag"] for element in card["elements"]])

    def test_parse_generic_hermes_card_command(self) -> None:
        payload = {
            "pigmemory_interview_action": "rate",
            "request_id": "req-1",
            "score": 2,
        }
        parsed = parse_interview_action(f"/card button {json.dumps(payload)}")
        self.assertEqual(parsed, payload)
        self.assertIsNone(parse_interview_action("普通用户消息"))

    def test_sender_fetches_token_then_posts_interactive_card(self) -> None:
        calls: list[tuple[str, dict[str, Any], dict[str, str]]] = []

        def fake_post(
            url: str,
            payload: dict[str, Any],
            headers: dict[str, str],
            _timeout: float,
        ) -> dict[str, Any]:
            calls.append((url, payload, headers))
            if url.endswith("tenant_access_token/internal"):
                return {"code": 0, "tenant_access_token": "token-1", "expire": 7200}
            return {"code": 0, "data": {"message_id": "om_1"}}

        with tempfile.TemporaryDirectory() as tmp:
            client = FeishuInterviewClient(
                Path(tmp),
                app_id="app-id",
                app_secret="secret",
                http_post=fake_post,
            )
            message_id = client.send_rating_card(
                chat_id="oc_chat",
                request_id="req-1",
                task_preview="完成测试",
            )

        self.assertEqual(message_id, "om_1")
        self.assertEqual(len(calls), 2)
        self.assertEqual(calls[1][1]["receive_id"], "oc_chat")
        self.assertEqual(calls[1][1]["msg_type"], "interactive")
        self.assertEqual(calls[1][2]["Authorization"], "Bearer token-1")

    def test_sender_posts_plain_text_for_proactive_interaction(self) -> None:
        calls: list[tuple[str, dict[str, Any], dict[str, str]]] = []

        def fake_post(
            url: str,
            payload: dict[str, Any],
            headers: dict[str, str],
            _timeout: float,
        ) -> dict[str, Any]:
            calls.append((url, payload, headers))
            if url.endswith("tenant_access_token/internal"):
                return {"code": 0, "tenant_access_token": "token-1", "expire": 7200}
            return {"code": 0, "data": {"message_id": "om_proactive"}}

        with tempfile.TemporaryDirectory() as tmp:
            client = FeishuInterviewClient(
                Path(tmp),
                app_id="app-id",
                app_secret="secret",
                http_post=fake_post,
            )
            message_id = client.send_text(
                chat_id="oc_chat",
                text="昨天的画像功能，今天继续吗？",
            )

        self.assertEqual(message_id, "om_proactive")
        self.assertEqual(calls[1][1]["msg_type"], "text")
        self.assertEqual(
            json.loads(calls[1][1]["content"])["text"],
            "昨天的画像功能，今天继续吗？",
        )

    def test_record_event_uses_separate_interview_log(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            client = FeishuInterviewClient(root, app_id="x", app_secret="y")
            client.record_event({"kind": "rating", "requestId": "req-1", "score": 5})
            rows = (root / "logs" / "feishu-interviews.jsonl").read_text(
                encoding="utf-8"
            ).splitlines()
        self.assertEqual(len(rows), 1)
        self.assertEqual(json.loads(rows[0])["score"], 5)

    def test_rating_counts_are_bound_to_referenced_memory_ids(self) -> None:
        refs = [
            {"refKind": "trace", "refId": "trace-1"},
            {"refKind": "skill", "refId": "skill-1"},
        ]
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            client = FeishuInterviewClient(root, app_id="x", app_secret="y")
            client.record_event({"kind": "rating", "memoryRefs": refs, "score": 4})
            reloaded = FeishuInterviewClient(root, app_id="x", app_secret="y")
            counts = reloaded.rating_counts(refs)

        self.assertEqual(counts, {"trace:trace-1": 1, "skill:skill-1": 1})


class _FakeInterviewClient:
    configured = True

    def __init__(self) -> None:
        self.events: list[dict[str, Any]] = []
        self.cards: list[tuple[str, dict[str, Any]]] = []

    def record_event(self, payload: dict[str, Any]) -> None:
        self.events.append(payload)

    def rating_counts(self, memory_refs: list[dict[str, Any]]) -> dict[str, int]:
        return {
            f"{ref['refKind']}:{ref['refId']}": 2
            for ref in memory_refs
        }

    def send_rating_card(self, **kwargs: Any) -> str:
        self.cards.append(("rating", kwargs))
        return "rating-message"

    def send_reason_card(self, **kwargs: Any) -> str:
        self.cards.append(("reason", kwargs))
        return "reason-message"

    def send_skipped_card(self, **kwargs: Any) -> str:
        self.cards.append(("skipped", kwargs))
        return "skipped-message"

    def send_thanks_card(self, **kwargs: Any) -> str:
        self.cards.append(("thanks", kwargs))
        return "thanks-message"

    def send_free_text_prompt(self, **kwargs: Any) -> str:
        self.cards.append(("free_text", kwargs))
        return "free-text-message"

    def send_notice_card(self, **kwargs: Any) -> str:
        self.cards.append(("notice", kwargs))
        return "notice-message"


class ProactiveScheduleTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.adapter = _load_provider_module()

    def test_daily_timer_sleeps_until_configured_shanghai_time(self) -> None:
        before_send = datetime(2026, 8, 7, 0, 0, tzinfo=timezone.utc)
        after_send = datetime(2026, 8, 7, 2, 0, tzinfo=timezone.utc)

        self.assertEqual(
            self.adapter._seconds_until_daily_time(
                "09:30",
                "Asia/Shanghai",
                now=before_send,
            ),
            90 * 60,
        )
        self.assertEqual(
            self.adapter._seconds_until_daily_time(
                "09:30",
                "Asia/Shanghai",
                now=after_send,
            ),
            23.5 * 60 * 60,
        )

    def test_daily_timer_rejects_invalid_time(self) -> None:
        with self.assertRaises(ValueError):
            self.adapter._seconds_until_daily_time("9:30", "Asia/Shanghai")


class HermesProviderInterviewHookTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.adapter = _load_provider_module()

    def _provider(self):
        provider = self.adapter.MemTensorProvider()
        provider._platform = "feishu"
        provider._chat_id = "chat-1"
        provider._user_id = "user-1"
        provider._feishu_interview = _FakeInterviewClient()
        provider._interview_requests["req-1"] = {
            "requestId": "req-1",
            "sessionId": "session-1",
            "episodeId": "episode-1",
            "traceId": "trace-1",
            "chatId": "chat-1",
            "allowedUserIds": ["user-1"],
            "createdAt": 9_999_999_999_999,
            "rating": None,
            "reason": None,
        }

        def send_now(send, *, name: str) -> None:
            del name
            send(provider._feishu_interview)

        provider._send_interview_followup = send_now
        return provider

    @staticmethod
    def _raw_action(payload: dict[str, Any]):
        return SimpleNamespace(
            event=SimpleNamespace(
                context=SimpleNamespace(open_chat_id="chat-1"),
                operator=SimpleNamespace(
                    open_id="user-1",
                    user_id="",
                    union_id="",
                ),
                action=SimpleNamespace(value=payload),
            )
        )

    @staticmethod
    def _event(text: str):
        return SimpleNamespace(
            text=text,
            source=SimpleNamespace(
                platform=SimpleNamespace(value="feishu"),
                chat_id="chat-1",
                user_id="user-1",
                user_id_alt="",
            ),
        )

    def test_low_rating_is_logged_and_opens_reason_card_without_bridge_rpc(self) -> None:
        provider = self._provider()
        payload = {
            "pigmemory_interview_action": "rate",
            "request_id": "req-1",
            "score": 2,
        }
        result = provider._on_pre_gateway_dispatch(
            event=self._event(f"/card button {json.dumps(payload)}")
        )
        self.assertEqual(result["action"], "skip")
        self.assertEqual(provider._interview_requests["req-1"]["rating"], 2)
        self.assertEqual(provider._feishu_interview.cards[0][0], "reason")
        rating_events = [e for e in provider._feishu_interview.events if e["kind"] == "rating"]
        self.assertEqual(rating_events[0]["score"], 2)

    def test_low_rating_returns_reason_card_inline_without_network_send(self) -> None:
        provider = self._provider()
        payload = {
            "pigmemory_interview_action": "rate",
            "request_id": "req-1",
            "score": 2,
        }

        result = provider._on_feishu_card_action(
            data=self._raw_action(payload),
            action_value=payload,
        )

        self.assertEqual(result["action"], "handled")
        self.assertEqual(result["card"]["header"]["title"]["content"], "再补充一个原因")
        self.assertEqual(provider._feishu_interview.cards, [])

    def test_skip_closes_current_request_and_suppresses_same_episode(self) -> None:
        provider = self._provider()
        payload = {
            "pigmemory_interview_action": "skip",
            "request_id": "req-1",
        }

        result = provider._on_feishu_card_action(
            data=self._raw_action(payload),
            action_value=payload,
        )

        self.assertEqual(result["card"]["header"]["title"]["content"], "已跳过评分")
        self.assertIn("episode-1", provider._interview_skipped_episodes)
        self.assertTrue(provider._interview_requests["req-1"]["skippedAt"])
        skipped_events = [
            event
            for event in provider._feishu_interview.events
            if event["kind"] == "rating_skipped"
        ]
        self.assertEqual(len(skipped_events), 1)

        provider._queue_feishu_interview(
            user_text="继续同一任务",
            trace_id="trace-2",
            episode_id="episode-1",
        )
        self.assertEqual(list(provider._interview_requests), ["req-1"])

    def test_other_reason_consumes_exactly_one_followup_text(self) -> None:
        provider = self._provider()
        reason_payload = {
            "pigmemory_interview_action": "reason",
            "request_id": "req-1",
            "reason": "other",
        }
        first = provider._on_pre_gateway_dispatch(
            event=self._event(f"/card button {json.dumps(reason_payload)}")
        )
        self.assertEqual(first["action"], "skip")
        self.assertIn("req-1", provider._pending_free_text_reasons)

        second = provider._on_pre_gateway_dispatch(
            event=self._event("回答偏离了我要求的输出格式")
        )
        self.assertEqual(second["action"], "skip")
        self.assertNotIn("req-1", provider._pending_free_text_reasons)
        self.assertEqual(
            provider._interview_requests["req-1"]["reason"],
            "回答偏离了我要求的输出格式",
        )

        third = provider._on_pre_gateway_dispatch(event=self._event("这是新的正常任务"))
        self.assertIsNone(third)

    def test_turn_end_accepts_current_singular_trace_id_contract(self) -> None:
        provider = self.adapter.MemTensorProvider()
        provider._bridge = SimpleNamespace()
        provider._session_id = "session-1"
        provider._episode_id = "episode-1"
        provider._bridge_request = lambda *_args, **_kwargs: {
            "traceId": "trace-current",
            "episodeId": "episode-1",
        }

        trace_id = provider._turn_end("你好", "你好！", [], 1_000)

        self.assertEqual(trace_id, "trace-current")
        self.assertEqual(provider._last_trace_id, "trace-current")

    def test_no_memory_hard_gate_does_not_call_review_evaluator(self) -> None:
        provider = self._provider()
        provider._bridge_request = lambda *_args, **_kwargs: self.fail(
            "review.evaluate must not run without referenced memory"
        )

        provider._prepare_review_candidate(
            user_text="普通任务",
            trace_id="trace-2",
            episode_id="episode-2",
            tool_calls=[{"name": "write_file", "output": "ok"}],
            memory_refs=[],
            started_at_ms=1_000,
            completed_at_ms=2_000,
        )

        self.assertEqual(
            provider._last_review_candidate["evaluation"]["reason"],
            "no_referenced_memory",
        )
        self.assertIsNone(provider._pending_review_candidate)

    def test_referenced_memory_is_scored_with_durable_rating_count(self) -> None:
        provider = self._provider()
        provider._bridge_request = lambda method, payload, **_kwargs: {
            "eligible": True,
            "score": 72,
            "threshold": 65,
            "reason": "eligible",
            "breakdown": {"tool": 60, "difficulty": 70, "memory": 80},
            "delivery": {
                "sendDelaySeconds": 8,
                "cooldownMinutes": 30,
                "dailyLimit": 5,
            },
        } if method == "review.evaluate" and payload["memories"][0]["ratingCount"] == 2 else {}

        provider._prepare_review_candidate(
            user_text="修复问题",
            trace_id="trace-2",
            episode_id="episode-2",
            tool_calls=[{"name": "apply_patch", "output": "ok"}],
            memory_refs=[{"refKind": "trace", "refId": "old-1", "relevance": 0.9}],
            started_at_ms=1_000,
            completed_at_ms=2_000,
        )

        candidate = provider._last_review_candidate
        self.assertEqual(candidate["memoryRefs"][0]["ratingCount"], 2)
        self.assertEqual(candidate["evaluation"]["score"], 72)
        self.assertIs(provider._pending_review_candidate, candidate)

    def test_manual_review_refuses_previous_turn_without_memory(self) -> None:
        provider = self._provider()
        provider._last_review_candidate = {
            "memoryRefs": [],
            "status": "no_referenced_memory",
        }

        result = provider._on_pre_gateway_dispatch(event=self._event("/review"))

        self.assertEqual(result["reason"], "pigmemory_manual_review")
        self.assertEqual(provider._feishu_interview.cards[0][0], "notice")
        self.assertIn("没有使用 PigMemory 记忆", provider._feishu_interview.cards[0][1]["content"])

    def test_manual_review_bypasses_threshold_and_sends_previous_turn_card(self) -> None:
        provider = self._provider()
        provider._start_interview_worker = lambda fn, _name: fn()
        provider._last_review_candidate = {
            "candidateId": "candidate-1",
            "sessionId": "session-1",
            "episodeId": "episode-2",
            "traceId": "trace-2",
            "userText": "完成重要任务",
            "memoryRefs": [
                {"refKind": "trace", "refId": "old-1", "relevance": 0.8}
            ],
            "reviewInput": {
                "memories": [
                    {
                        "refKind": "trace",
                        "refId": "old-1",
                        "relevance": 0.8,
                        "ratingCount": 1,
                    }
                ],
                "toolCalls": [],
            },
            "status": "below_threshold",
        }
        provider._bridge_request = lambda method, payload, **_kwargs: {
            "eligible": payload.get("manual") is True,
            "score": 31,
            "threshold": 65,
            "reason": "eligible",
            "breakdown": {"tool": 0, "difficulty": 0, "memory": 77},
            "delivery": {
                "sendDelaySeconds": 8,
                "cooldownMinutes": 30,
                "dailyLimit": 5,
            },
        } if method == "review.evaluate" else {}

        result = provider._on_pre_gateway_dispatch(event=self._event("/review"))

        self.assertEqual(result["reason"], "pigmemory_manual_review")
        self.assertEqual(provider._feishu_interview.cards[0][0], "rating")
        manual_requests = [
            request
            for request in provider._interview_requests.values()
            if request.get("candidateId") == "candidate-1"
        ]
        self.assertTrue(manual_requests[0]["manual"])

    def test_post_delivery_schedules_and_followup_cancels_automatic_review(self) -> None:
        provider = self._provider()
        candidate = {
            "status": "awaiting_delivery",
            "evaluation": {
                "delivery": {
                    "sendDelaySeconds": 60,
                    "cooldownMinutes": 0,
                    "dailyLimit": 0,
                }
            },
        }
        provider._pending_review_candidate = candidate

        handled = provider._on_post_gateway_delivery(
            event=self._event("原始任务"),
            outcome=SimpleNamespace(value="success"),
        )
        self.assertTrue(handled)
        self.assertEqual(candidate["status"], "scheduled")
        self.assertIsNotNone(provider._pending_review_timer)

        provider._on_pre_gateway_dispatch(event=self._event("继续补充需求"))
        self.assertEqual(candidate["status"], "cancelled_by_followup")
        self.assertIsNone(provider._pending_review_timer)


class HermesHookDispatcherTests(unittest.TestCase):
    def test_registers_and_routes_pre_gateway_dispatch(self) -> None:
        manager = SimpleNamespace(_hooks={})

        class Provider:
            def _on_pre_gateway_dispatch(self, **_kwargs: Any) -> dict[str, str]:
                return {"action": "skip", "reason": "handled"}

        provider = Provider()
        dispatcher = HermesHookDispatcher()
        dispatcher.bind(manager, provider)

        callback = manager._hooks["pre_gateway_dispatch"][0]
        result = callback(event=SimpleNamespace(text="/card button {}"))
        self.assertEqual(result, {"action": "skip", "reason": "handled"})

    def test_routes_direct_feishu_card_action(self) -> None:
        manager = SimpleNamespace(_hooks={})
        expected = {"action": "handled", "card": {"header": {}}}

        class Provider:
            def _on_feishu_card_action(self, **_kwargs: Any) -> dict[str, Any]:
                return expected

        provider = Provider()
        dispatcher = HermesHookDispatcher()
        dispatcher.bind(manager, provider)

        callback = manager._hooks["feishu_card_action"][0]
        result = callback(
            data=object(),
            action_value={"pigmemory_interview_action": "rate"},
        )
        self.assertEqual(result, expected)

    def test_routes_post_gateway_delivery(self) -> None:
        manager = SimpleNamespace(_hooks={})
        calls: list[dict[str, Any]] = []

        class Provider:
            def _on_post_gateway_delivery(self, **kwargs: Any) -> bool:
                calls.append(kwargs)
                return True

        provider = Provider()
        dispatcher = HermesHookDispatcher()
        dispatcher.bind(manager, provider)
        callback = manager._hooks["post_gateway_delivery"][0]
        callback(event="event", outcome="success")

        self.assertEqual(calls, [{"event": "event", "outcome": "success"}])


if __name__ == "__main__":
    unittest.main()
