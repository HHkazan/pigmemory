"""PigMemory — Hermes memory provider (Reflect2Evolve V7 core).

Implements the ``agent.memory_provider.MemoryProvider`` interface exposed
by the hermes-agent host (see
``hermes-agent/agent/memory_provider.py``). All heavy lifting lives in the
Node.js PigMemory core; this adapter is a thin Python client
that speaks JSON-RPC 2.0 over stdio to the packaged Node bridge.

Discovery
---------
The hermes-agent host discovers memory providers via
``plugins/memory/__init__.py::load_memory_provider`` which:

  1. Looks for a ``register(ctx)`` function and calls it with a
     ``_ProviderCollector`` that has ``register_memory_provider(provider)``.
  2. Falls back to finding a ``MemoryProvider`` subclass in the module.

We support **both** entry points.

Activation
----------
Set ``memory.provider: memtensor`` in ``~/.hermes/config.yaml`` (or the
relevant `$HERMES_HOME`).

Lifecycle mapping (V7 §0.2)
---------------------------

| Hermes hook          | Our action                                    |
| -------------------- | --------------------------------------------- |
| ``initialize``       | acquire shared bridge; open logical session   |
| ``on_turn_start``    | record turn count; stash message              |
| ``prefetch``         | ``turn.start`` RPC → Tier 1+2+3 retrieval     |
| ``queue_prefetch``   | no-op; real prefetch runs before the turn     |
| ``sync_turn``        | persist a synchronous ``turn.end`` RPC        |
| ``on_session_end``   | close this logical session                    |
| ``on_pre_compress``  | extract a short memory summary               |
| ``on_delegation``    | record a subagent outcome as a trace         |
| ``get_tool_schemas`` | expose memory, skill, and environment tools   |
| ``handle_tool_call`` | dispatch to PigMemory JSON-RPC tool methods   |
| ``shutdown``         | release provider lease                        |

Threading: all JSON-RPC calls are synchronous. One process-scoped runtime
owns bridge keepalive and reconnect; providers retain per-session state.
"""

from __future__ import annotations

import contextlib
import json
import logging
import os
import re
import sys
import threading
import time
import uuid
import weakref

from datetime import datetime, timedelta
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError


# Add our own directory to sys.path so the submodule imports below work
# whether hermes-agent loaded us bundled or via the user-plugin namespace.
_PLUGIN_DIR = Path(__file__).resolve().parent
if str(_PLUGIN_DIR) not in sys.path:
    sys.path.insert(0, str(_PLUGIN_DIR))

from bridge_client import BridgeError, MemosBridgeClient  # noqa: E402
from daemon_manager import (  # noqa: E402
    ensure_bridge_running,
    ensure_viewer_daemon,
    kill_zombie_bridges,
)
from feishu_interview import (  # noqa: E402
    FeishuInterviewClient,
    build_free_text_prompt_card,
    build_location_name_card,
    build_reason_card,
    build_skipped_card,
    build_thanks_card,
    interview_enabled,
    parse_interview_action,
)
from shared_bridge_runtime import (  # noqa: E402
    HERMES_HOOK_DISPATCHER,
    SHARED_BRIDGE_REGISTRY,
    SharedBridgeLease,
)


try:  # pragma: no cover — host-provided base class, absent in unit tests
    from agent.memory_provider import MemoryProvider  # type: ignore
except Exception:  # pragma: no cover

    class MemoryProvider:  # type: ignore[no-redef]
        """Fallback base class used when running outside hermes-agent host.

        Defines only the attributes the adapter reads so ``pyright`` and
        ``pytest`` stay happy in standalone test runs.
        """


logger = logging.getLogger(__name__)

PLUGIN_ID = "pigmemory-hermes"


def _seconds_until_daily_time(
    send_time: str,
    timezone_name: str,
    *,
    now: datetime | None = None,
) -> float:
    """Return the delay until the next local ``HH:mm`` occurrence.

    Proactive delivery is a daily scheduled action, so the adapter parks on
    one interruptible timer instead of polling PigMemory's outbox. Config
    changes are documented as restart-bound in the Viewer; restarting Hermes
    recreates this timer from the newly resolved configuration.
    """
    match = re.fullmatch(r"([01]\d|2[0-3]):([0-5]\d)", send_time)
    if match is None:
        raise ValueError(f"invalid proactive send time: {send_time!r}")
    try:
        timezone = ZoneInfo(timezone_name)
    except ZoneInfoNotFoundError as err:
        raise ValueError(f"invalid proactive timezone: {timezone_name!r}") from err
    current = now.astimezone(timezone) if now is not None else datetime.now(timezone)
    target = current.replace(
        hour=int(match.group(1)),
        minute=int(match.group(2)),
        second=0,
        microsecond=0,
    )
    if target <= current:
        target += timedelta(days=1)
    return max(0.0, (target - current).total_seconds())


def _read_plugin_version() -> str:
    """Read the npm package version that owns this Hermes adapter."""
    package_json = _PLUGIN_DIR.parents[2] / "package.json"
    try:
        payload = json.loads(package_json.read_text(encoding="utf-8"))
    except (OSError, ValueError, TypeError):
        return "dev"
    version = payload.get("version")
    return version.strip() if isinstance(version, str) and version.strip() else "dev"


PLUGIN_VERSION = _read_plugin_version()
_TOOL_FAILURE_REPAIR_HINT = (
    "This tool has failed multiple times in a row. You may want to call "
    "`memos_search` for relevant past experience before deciding what to do next."
)
_TOOL_FAILURE_HINT_THRESHOLD = 3
_COMPRESSION_CONTEXT_MAX_CHARS = 6_000


def _shared_bridge_enabled() -> bool:
    """Use the safe process-scoped bridge unless an operator opts out."""
    mode = os.environ.get("MEMOS_HERMES_BRIDGE_MODE", "shared").strip().lower()
    return mode not in {"legacy", "per_provider", "disabled", "false", "0"}


def _resolved_memos_runtime_home() -> Path:
    """Mirror the Node resolver closely enough to isolate distinct databases."""
    memos_home = os.environ.get("MEMOS_HOME", "").strip()
    if memos_home:
        return Path(memos_home).expanduser().resolve()
    config_file = os.environ.get("MEMOS_CONFIG_FILE", "").strip()
    if config_file:
        return Path(config_file).expanduser().resolve().parent
    return (Path.home() / ".hermes" / "memos-plugin").resolve()


def _memos_runtime_env_snapshot(runtime_home: Path | None = None) -> dict[str, str]:
    """Freeze the environment inputs that select a MemOS data home."""
    memos_home = os.environ.get("MEMOS_HOME", "").strip()
    if memos_home:
        resolved_home = runtime_home or Path(memos_home).expanduser().resolve()
        return {"MEMOS_HOME": str(resolved_home)}
    config_file = os.environ.get("MEMOS_CONFIG_FILE", "").strip()
    if config_file:
        return {
            "MEMOS_HOME": "",
            "MEMOS_CONFIG_FILE": str(Path(config_file).expanduser().resolve()),
        }
    return {
        "MEMOS_HOME": "",
        "MEMOS_CONFIG_FILE": "",
        "HOME": os.environ.get("HOME", "").strip() or str(Path.home()),
    }


def _shared_bridge_runtime_key(runtime_home: Path | None = None) -> tuple[str, ...]:
    """Use the data home as the authoritative shared-runtime boundary."""
    resolved_home = runtime_home or _resolved_memos_runtime_home()
    return (str(resolved_home), "hermes", "stdio")


def _prepare_shared_bridge(*, cleanup_legacy_zombies: bool = False) -> None:
    """Prepare bridge/viewer state without crossing data-home boundaries."""
    ensure_bridge_running()
    if cleanup_legacy_zombies:
        # The legacy scanner cannot distinguish data homes. Shared runtimes
        # instead rely on the Python scoped singleton and the CJS scoped PID
        # guard so one healthy home is never reaped while another starts.
        with contextlib.suppress(Exception):
            zombies = kill_zombie_bridges()
            if zombies:
                logger.info("MemOS: killed %d zombie bridge(s)", zombies)
    try:
        ensure_viewer_daemon()
    except Exception as err:
        logger.warning("MemOS: viewer daemon check failed — %s", err)


def _long_rpc_timeout_default() -> float:
    """Resolve the timeout used for long-running JSON-RPC calls.

    After 1-2 hours of Hermes use the memory / capture / reflection
    pipeline grows past the 30s JSON-RPC default and surfaces as
    ``[timeout] memory.search did not respond within 30.0s`` and
    ``[timeout] turn.end did not respond within 30.0s`` in the host
    logs (issue #2028). ``feedback.submit`` already opts into 75s;
    ``sync_turn``'s ``_ensure_bridge`` also uses 75s. Aligning the
    heavy retrieval / capture RPCs with the same 75s ceiling gives
    the pipeline enough headroom without turning genuinely hung
    calls into an indefinite wait. The value is overridable via
    ``MEMOS_HERMES_LONG_RPC_TIMEOUT`` for site-specific tuning; any
    unparseable / non-positive value falls back to the default.
    """
    raw = os.environ.get("MEMOS_HERMES_LONG_RPC_TIMEOUT", "")
    try:
        value = float(raw)
    except (TypeError, ValueError):
        return 75.0
    if value <= 0:
        return 75.0
    return value


_LONG_RPC_TIMEOUT = _long_rpc_timeout_default()

_HERMES_INTERNAL_REVIEW_PREFIXES = (
    "review the conversation above and consider saving to memory if appropriate.",
    "review the conversation above and update the skill library.",
    "review the conversation above and update two things:",
    "review the conversation above and consider saving or updating a skill if appropriate.",
    "review the conversation above and consider whether a skill should be saved or updated.",
)


def _is_hermes_internal_review_prompt(message: str) -> bool:
    """Return True for Hermes' own background memory/skill review turns."""
    normalized = " ".join((message or "").strip().lower().split())
    if not normalized:
        return False
    return any(normalized.startswith(prefix) for prefix in _HERMES_INTERNAL_REVIEW_PREFIXES)


def _is_verifier_feedback_prompt(message: str) -> bool:
    """Return True for explicit evaluator/verifier feedback turns."""
    text = " ".join((message or "").strip().lower().split())
    if not text:
        return False

    # Strong markers: formal verifier feedback
    strong_markers = (
        "本任务评为反例",
        "本任务评为正例",
        "verifier feedback",
        "verification feedback",
        "task rated as counterexample",
        "task is rated as counterexample",
        "r <= -0.5",
        "r≤-0.5",
        "r >= 0.5",
        "r≥0.5",
    )
    if any(marker in text for marker in strong_markers):
        return True
    if re.search(r"\br\s*(?:<=|>=|≤|≥)\s*-?\d+(?:\.\d+)?", text):
        return True

    # User correction markers: natural corrective feedback
    correction_markers = (
        "不对",
        "错了",
        "不是",
        "不行",
        "不对的",
        "写错了",
        "做错了",
        "理解错了",
        "wrong",
        "incorrect",
        "not right",
        "not correct",
        "that's wrong",
        "this is wrong",
    )
    if any(marker in text for marker in correction_markers):
        return True

    # Weak markers: require "feedback/反馈" + action keywords
    if "feedback" not in text and "反馈" not in text:
        return False
    feedback_markers = (
        "failed",
        "failure",
        "pass",
        "passed",
        "success",
        "succeeded",
        "should",
        "avoid",
        "next time",
        "失败",
        "成功",
        "应该",
        "不要",
        "下次",
    )
    return any(marker in text for marker in feedback_markers)


def _feedback_polarity(message: str) -> str:
    text = " ".join((message or "").strip().lower().split())
    if re.search(r"r\s*(?:<=|≤)\s*-?0\.5", text):
        return "negative"
    if "反例" in text:
        return "negative"
    if any(
        term in text
        for term in (
            "failed",
            "failure",
            "wrong",
            "incorrect",
            "not acceptable",
            "错误",
            "失败",
            "不对",
        )
    ):
        return "negative"
    if re.search(r"r\s*(?:>=|≥)\s*0\.5", text):
        return "positive"
    if "正例" in text:
        return "positive"
    if any(
        term in text
        for term in ("passed", "success", "succeeded", "correct", "great", "成功", "通过", "正确")
    ):
        return "positive"
    return "neutral"


def _feedback_magnitude(message: str, polarity: str) -> float:
    text = " ".join((message or "").strip().lower().split())
    match = re.search(r"\br\s*(?:=|:|<=|>=|≤|≥)\s*(-?\d+(?:\.\d+)?)", text)
    if match:
        with contextlib.suppress(Exception):
            return max(0.0, min(1.0, abs(float(match.group(1)))))
    return 1.0 if polarity in {"positive", "negative"} else 0.6


class MemTensorProvider(MemoryProvider):
    """MemOS Reflect2Evolve memory for hermes-agent.

    Wraps a JSON-RPC client around the shared PigMemory core.

    Only methods that Hermes actually calls are overridden here; every
    optional hook stays default so future versions of the base class can
    grow without breaking us.
    """

    def __init__(self) -> None:
        self._bridge: MemosBridgeClient | SharedBridgeLease | None = None
        self._shared_bridge = _shared_bridge_enabled()
        self._bridge_generation = 0
        self._reconnect_lock = threading.Lock()
        self._session_open_lock = threading.Lock()
        self._runtime_home: Path | None = None
        self._runtime_env: dict[str, str] = {}
        self._session_id: str = ""
        self._episode_id: str = ""
        self._hermes_home: str = ""
        self._agent_identity: str = "hermes"
        self._platform: str = "cli"
        self._chat_id: str = ""
        self._thread_id: str = ""
        self._user_id: str = ""
        self._user_id_alt: str = ""
        self._last_host_runtime: dict[str, str] = {}
        self._turn_number: int = 0
        # Last user turn text — used by `sync_turn` to compose `turn.end`.
        self._last_user_text: str = ""
        # Single-flight prefetch coordination.
        self._prefetch_lock = threading.Lock()
        self._prefetch_result: str = ""
        self._prefetch_thread: threading.Thread | None = None
        # Exact memory context injected by the most recent real prefetch.
        # Compression hooks only read this cache; they must never call the
        # lifecycle-mutating `turn.start` RPC.
        self._state_lock = threading.Lock()
        self._last_injected_context: str = ""
        self._active_turn_key: str = ""
        # Tool calls accumulated via the Hermes `post_tool_call` plugin
        # hook — flushed alongside user/assistant text in `sync_turn`.
        self._tool_calls: list[dict[str, Any]] = []
        # Reasoning text captured via the `post_llm_call` hook for the
        # current turn. Hermes' MemoryProvider.sync_turn signature only
        # carries the visible assistant text; reasoning lives on the
        # `assistant` message's `reasoning` field. We capture it from
        # `post_llm_call`'s `conversation_history` so the viewer can
        # show the model's thinking like OpenClaw does.
        self._turn_thinking: str = ""
        self._hook_registered = False
        self._bridge_keepalive_stop = threading.Event()
        self._bridge_keepalive_thread: threading.Thread | None = None
        self._proactive_stop = threading.Event()
        self._proactive_thread: threading.Thread | None = None
        self._location_stop = threading.Event()
        self._location_thread: threading.Thread | None = None
        self._session_close_thread: threading.Thread | None = None
        self._session_close_requested_for = ""
        # Hermes runs background memory/skill reviewers by forking an agent and
        # appending a synthetic user turn. That turn is instruction plumbing,
        # not a human utterance, so it must not become a MemOS trace.
        self._skip_current_turn = False
        # Track the last trace ID for feedback submission
        self._last_trace_id: str = ""
        self._tool_failure_streaks: dict[str, int] = {}
        # Feishu interview state is intentionally separate from the core
        # feedback/reward pipeline. Ratings and reasons are recorded to a
        # JSONL audit log, but never call `feedback.submit` yet.
        self._feishu_interview: FeishuInterviewClient | None = None
        self._feishu_proactive: FeishuInterviewClient | None = None
        self._interview_lock = threading.RLock()
        self._interview_requests: dict[str, dict[str, Any]] = {}
        self._pending_free_text_reasons: dict[str, dict[str, Any]] = {}
        self._interview_skipped_episodes: set[str] = set()
        self._interview_rated_episodes: set[str] = set()
        self._turn_started_at_ms: int = 0
        self._turn_memory_refs: dict[str, dict[str, Any]] = {}
        self._last_review_candidate: dict[str, Any] | None = None
        self._pending_review_candidate: dict[str, Any] | None = None
        self._pending_review_timer: threading.Timer | None = None
        self._auto_review_sent_at: list[int] = []

    # ─── Identity ─────────────────────────────────────────────────────────

    @property
    def name(self) -> str:  # type: ignore[override]
        return "memtensor"

    def is_available(self) -> bool:  # type: ignore[override]
        try:
            return ensure_bridge_running(probe_only=True)
        except Exception:
            return False

    # ─── Lifecycle ────────────────────────────────────────────────────────

    def initialize(self, session_id: str, **kwargs: Any) -> None:  # type: ignore[override]
        """Called once at agent startup.

        kwargs always include ``hermes_home`` and ``platform``. We stash
        them so the bridge can resolve the right `~/.hermes/memos-plugin/`
        and log the originating channel.

        Shared mode (the default) acquires a lightweight lease on one
        process-scoped Node bridge. Each provider still owns its logical
        session/episode state. ``MEMOS_HERMES_BRIDGE_MODE=legacy`` retains
        the old per-provider bridge as a one-release rollback path.
        """
        self._proactive_stop.set()
        if self._proactive_thread and self._proactive_thread.is_alive():
            self._proactive_thread.join(timeout=20.0)
        self._location_stop.set()
        if self._location_thread and self._location_thread.is_alive():
            self._location_thread.join(timeout=20.0)
        previous_bridge = self._bridge
        if previous_bridge is not None:
            old_pid = getattr(previous_bridge, "pid", "?")
            logger.info(
                "MemOS: releasing previous bridge handle (pid=%s) before re-init",
                old_pid,
            )
            self.on_session_end([])
            close_thread = self._session_close_thread
            if close_thread is not None and close_thread.is_alive():
                close_thread.join(timeout=5.5)
            with contextlib.suppress(Exception):
                previous_bridge.close()
            self._bridge = None
            self._bridge_generation = 0

        self._session_id = session_id or self._session_id
        self._session_close_requested_for = ""
        self._bridge_keepalive_stop.clear()
        self._proactive_stop.clear()
        self._location_stop.clear()
        with self._state_lock:
            self._last_injected_context = ""
            self._active_turn_key = ""
        self._hermes_home = str(kwargs.get("hermes_home") or "")
        self._platform = str(kwargs.get("platform") or "cli")
        self._chat_id = str(kwargs.get("chat_id") or "")
        self._thread_id = str(kwargs.get("thread_id") or "")
        self._user_id = str(kwargs.get("user_id") or "")
        self._user_id_alt = str(kwargs.get("user_id_alt") or "")
        self._agent_identity = str(kwargs.get("agent_identity") or "hermes")
        self._shared_bridge = _shared_bridge_enabled()
        self._runtime_home = _resolved_memos_runtime_home()
        self._runtime_env = _memos_runtime_env_snapshot(self._runtime_home)
        # Trigger enablement now lives in config.yaml. Constructing the small
        # client is side-effect free; `review.evaluate` decides whether an
        # automatic card may be sent.
        self._feishu_interview = (
            FeishuInterviewClient(self._runtime_home)
            if interview_enabled(self._platform) and self._chat_id
            else None
        )
        self._feishu_proactive = (
            FeishuInterviewClient(self._runtime_home)
            if self._platform.strip().lower() == "feishu" and self._chat_id
            else None
        )
        review_history: dict[str, Any] = {}
        if self._feishu_interview is not None:
            with contextlib.suppress(Exception):
                review_history = self._feishu_interview.review_history(self._chat_id)
        with self._interview_lock:
            self._cancel_pending_review_locked("provider_reinitialized")
            self._interview_requests.clear()
            self._pending_free_text_reasons.clear()
            self._interview_skipped_episodes = set(
                review_history.get("skippedEpisodes") or []
            )
            self._interview_rated_episodes = set(
                review_history.get("ratedEpisodes") or []
            )
            self._turn_memory_refs.clear()
            self._last_review_candidate = None
            self._pending_review_candidate = None
            self._auto_review_sent_at = list(
                review_history.get("automaticCardTimestamps") or []
            )

        new_bridge: MemosBridgeClient | SharedBridgeLease | None = None
        try:
            runtime_home = self._runtime_home
            runtime_env = dict(self._runtime_env)
            if self._shared_bridge:
                new_bridge = SHARED_BRIDGE_REGISTRY.acquire(
                    _shared_bridge_runtime_key(runtime_home),
                    client_factory=lambda home=str(runtime_home), env=runtime_env: (
                        MemosBridgeClient(
                            runtime_home=home,
                            extra_env=env,
                        )
                    ),
                    before_spawn=_prepare_shared_bridge,
                    host_handlers={
                        "host.llm.complete": self._handle_host_llm_complete,
                    },
                )
            else:
                _prepare_shared_bridge(cleanup_legacy_zombies=True)
                new_bridge = MemosBridgeClient(
                    runtime_home=str(runtime_home),
                    extra_env=runtime_env,
                )
                new_bridge.register_host_handler(
                    "host.llm.complete",
                    self._handle_host_llm_complete,
                )
            self._bridge = new_bridge
            self._open_session(session_id, timeout=60.0)
            mode = "shared" if self._shared_bridge else "legacy"
            runtime_id = getattr(new_bridge, "runtime_id", "per-provider")
            logger.info(
                "MemOS: bridge ready mode=%s runtime=%s generation=%d pid=%s "
                "session=%s platform=%s (episode deferred)",
                mode,
                runtime_id,
                self._bridge_generation,
                getattr(new_bridge, "pid", "?"),
                self._session_id,
                self._platform,
            )
        except Exception as err:
            logger.warning("MemOS: bridge init failed — %s", err)
            if new_bridge is not None:
                with contextlib.suppress(Exception):
                    new_bridge.close()
            self._bridge = None
            self._bridge_generation = 0
        # Register a Hermes plugin hook to capture tool calls as they
        # happen. The `post_tool_call` hook fires after every tool
        # dispatch (write_file, terminal, search_files, etc.) with the
        # tool name, arguments, and result. We accumulate them and
        # flush in `sync_turn`.
        self._register_tool_call_hook()
        self._start_bridge_keepalive()
        self._start_proactive_worker()
        self._start_location_worker()

    def system_prompt_block(self) -> str:  # type: ignore[override]
        return (
            "# PigMemory\n"
            "Persistent long-term memory is active. Call `memos_search`, "
            "`memos_get`, `memos_timeline`, `memos_environment`, "
            "`memos_skill_list`, or `memos_skill_get` when prior context or learned "
            "procedures would help. Relevant memories are automatically "
            "injected at the start of every turn.\n\n"
            "**Not the same as repo skills:** Hermes' `<available_skills>` / "
            "`skill_view(name=…)` load **repository SKILL.md** files. "
            "`memos_skill_get` / `memos_skill_list` refer to **PigMemory-crystallized** "
            "skills (learned from your runs). If both apply, you may use "
            "both: repo skills for product conventions, PigMemory skills for "
            "workflows proven on *your* past tasks."
        )

    # ─── Episode tracking ─────────────────────────────────────────────────
    #
    # We DON'T call `episode.open` ourselves. The core's `onTurnStart`
    # (RPC `turn.start`) automatically opens / reopens / boundary-cuts
    # an episode based on V7 §0.1 relation classification. Calling
    # `episode.open` from the adapter creates an orphan episode that
    # never receives any traces — and our `episode.close` then closes
    # that empty orphan, leaving the *real* episode (the one the
    # pipeline auto-created) without the close trigger that fires
    # reflect → reward → L2 / L3 / Skill.
    #
    # The real episode id surfaces in the `turn.start` response's
    # `query.episodeId` field; we stash it here so `on_session_end`
    # can close the right one.

    # ─── Tool call capture via Hermes plugin hook ──────────────────────────

    def _matches_session(self, session_id: str = "") -> bool:
        """Return True when a global Hermes hook belongs to this provider."""
        return not session_id or not self._session_id or session_id == self._session_id

    def _runtime_namespace(self) -> dict[str, Any]:
        profile_id = (self._agent_identity or "").strip() or "default"
        normalized_home = self._hermes_home.replace("\\", "/").rstrip("/")
        if normalized_home:
            marker = "/profiles/"
            if marker in normalized_home:
                profile_id = normalized_home.rsplit(marker, 1)[-1].split("/", 1)[0] or profile_id
            elif normalized_home.endswith("/.hermes") and profile_id in ("", "hermes"):
                profile_id = "default"
        return {
            "agentKind": "hermes",
            "profileId": profile_id,
            "profileLabel": profile_id,
        }

    def _record_namespace(self) -> dict[str, Any]:
        """Namespace used for write-path records.

        Hermes delegation hooks can be global and occasionally arrive through
        a provider instance whose `profileId` fell back to `default` while
        `agent_identity` still carries the real profile label (for example
        coder10). For writes, prefer the concrete non-default label so
        subagent outcome traces inherit the parent profile instead of leaking
        into hermes/default.
        """
        ns = dict(self._runtime_namespace())
        label = (self._agent_identity or ns.get("profileLabel") or "").strip()
        profile_id = str(ns.get("profileId") or "").strip()
        if profile_id in ("", "default", "hermes") and label and label not in ("default", "hermes"):
            ns["profileId"] = label
            ns["profileLabel"] = label
        return ns

    def _user_profile_subject_id(self) -> str:
        """Stable human identity used only by sidecar profile memory."""
        return (
            (self._user_id or "").strip()
            or (self._user_id_alt or "").strip()
            or (self._chat_id or "").strip()
            or "default"
        )

    def _register_tool_call_hook(self) -> None:
        try:
            from hermes_cli.plugins import (
                get_plugin_manager,  # pyright: ignore[reportMissingImports]
            )

            mgr = get_plugin_manager()
            HERMES_HOOK_DISPATCHER.bind(mgr, self)
            self._hook_registered = True
            logger.debug("MemOS: bound provider session=%s to shared hooks", self._session_id)
        except Exception as err:
            logger.debug("MemOS: could not register tool hook — %s", err)

    def _on_transform_tool_result(
        self,
        tool_name: str = "",
        arguments: dict | None = None,
        result: str = "",
        task_id: str | None = None,
        **kwargs: Any,
    ) -> str | None:
        """Append a small repair hint after repeated same-turn tool failures."""
        session_id = str(kwargs.get("session_id") or kwargs.get("sessionId") or "")
        if not self._matches_session(session_id):
            return None

        tool = str(tool_name or kwargs.get("toolName") or "unknown_tool")
        if not self._tool_result_failed(result, kwargs):
            self._tool_failure_streaks.pop(tool, None)
            return None

        count = self._tool_failure_streaks.get(tool, 0) + 1
        self._tool_failure_streaks[tool] = count
        if count < _TOOL_FAILURE_HINT_THRESHOLD:
            return None
        if _TOOL_FAILURE_REPAIR_HINT in (result or ""):
            return None
        text = (result or "").rstrip()
        return f"{text}\n\n{_TOOL_FAILURE_REPAIR_HINT}" if text else _TOOL_FAILURE_REPAIR_HINT

    @staticmethod
    def _tool_result_failed(result: str, payload: dict[str, Any]) -> bool:
        for key in ("is_error", "isError", "error", "failed"):
            value = payload.get(key)
            if value is True:
                return True
            if isinstance(value, str) and value.strip():
                return True
        try:
            parsed = json.loads(result or "")
        except Exception:
            parsed = None
        if isinstance(parsed, dict):
            error = parsed.get("error")
            if error is True:
                return True
            if isinstance(error, str) and error.strip():
                return True
            if parsed.get("is_error") is True or parsed.get("isError") is True:
                return True
        normalized = " ".join((result or "").strip().lower().split())
        if not normalized:
            return False
        failure_prefixes = (
            "error:",
            "failed:",
            "failure:",
            "exception:",
            "traceback ",
            "traceback:",
            "command failed",
            "tool failed",
        )
        if normalized.startswith(failure_prefixes):
            return True
        return " traceback (most recent call last)" in normalized

    def _on_post_tool_call(
        self,
        *,
        tool_name: str = "",
        args: dict | None = None,
        result: str = "",
        tool_call_id: str = "",
        session_id: str = "",
        **kw: Any,
    ) -> None:
        """Accumulate a tool call record for the current turn.

        We keep the host's ``tool_call_id`` on a private ``_id`` field so
        ``_on_post_llm_call`` can later attach the assistant message's
        ``reasoning`` (the model's "thinking before this tool") to the
        right entry. Hermes/OpenAI-compatible providers may surface the
        same call under ``id``, ``call_id``, or ``response_item_id``; keep
        all aliases so post-LLM and post-tool events can be merged even
        when a particular tool omits one field. Private fields are stripped
        before the JSON-RPC send.
        """
        if not self._matches_session(session_id):
            return
        ids = self._tool_call_ids(
            {
                "id": tool_call_id,
                "call_id": kw.get("call_id"),
                "response_item_id": kw.get("response_item_id"),
                "tool_call_id": kw.get("tool_call_id"),
            }
        )
        input_text = (
            json.dumps(args, ensure_ascii=False) if isinstance(args, dict) else str(args or "")
        )
        timing = self._coerce_tool_timing(kw)

        existing = self._find_tool_call(ids)
        if existing is not None:
            existing["name"] = tool_name or existing.get("name") or "unknown_tool"
            existing["input"] = input_text or existing.get("input", "")
            existing["output"] = (result or "")[:4000]
            existing["_ids"] = sorted(set((existing.get("_ids") or []) + ids))
            existing["_id"] = existing.get("_id") or (ids[0] if ids else "")
            if existing.get("_id"):
                existing["toolCallId"] = existing["_id"]
            if timing:
                existing.update(timing)
            return

        call = {
            "name": tool_name,
            "input": input_text,
            "output": (result or "")[:4000],
            "_id": ids[0] if ids else "",
            "_ids": ids,
            "toolCallId": ids[0] if ids else "",
        }
        if timing:
            call.update(timing)
        self._tool_calls.append(call)

    def _coerce_tool_timing(self, payload: dict[str, Any]) -> dict[str, int] | None:
        """Preserve real tool timing if Hermes exposes it in hook kwargs."""
        started = self._coerce_epoch_ms(
            payload.get("startedAt")
            or payload.get("started_at")
            or payload.get("startTime")
            or payload.get("start_time")
        )
        ended = self._coerce_epoch_ms(
            payload.get("endedAt")
            or payload.get("ended_at")
            or payload.get("endTime")
            or payload.get("end_time")
        )
        if started is not None and ended is not None and ended > started:
            return {"startedAt": started, "endedAt": ended}

        duration = self._coerce_duration_ms(
            payload.get("durationMs")
            or payload.get("duration_ms")
            or payload.get("elapsedMs")
            or payload.get("elapsed_ms")
            or payload.get("latencyMs")
            or payload.get("latency_ms")
        )
        if duration is not None and duration > 0:
            end_ms = int(time.time() * 1000)
            return {"startedAt": end_ms - duration, "endedAt": end_ms}

        return None

    @staticmethod
    def _coerce_epoch_ms(value: Any) -> int | None:
        if isinstance(value, int | float):
            numeric = float(value)
        elif isinstance(value, str):
            try:
                numeric = float(value)
            except ValueError:
                return None
        else:
            return None
        if numeric <= 0:
            return None
        # Accept seconds or milliseconds.
        if numeric < 10_000_000_000:
            numeric *= 1000
        return int(numeric)

    @staticmethod
    def _coerce_duration_ms(value: Any) -> int | None:
        if isinstance(value, int | float):
            numeric = float(value)
        elif isinstance(value, str):
            try:
                numeric = float(value)
            except ValueError:
                return None
        else:
            return None
        if numeric <= 0:
            return None
        return int(numeric)

    def _on_post_llm_call(
        self,
        *,
        conversation_history: list[dict[str, Any]] | None = None,
        user_message: str = "",
        session_id: str = "",
        **_kw: Any,
    ) -> None:
        """Capture reasoning content from assistant messages in this turn.

        Hermes' ``_build_assistant_message`` writes the model's reasoning
        text into ``msg["reasoning"]`` (extended thinking, OpenAI o1
        ``reasoning_content``, etc.). The default ``MemoryProvider.sync_turn``
        only carries plain ``user_content`` / ``assistant_content``, so we
        fish the reasoning out of the conversation history fired with the
        ``post_llm_call`` hook and stash it for the upcoming ``sync_turn``.

        We walk through assistant messages of the current turn (those
        after the most recent user message). For each message that
        contains ``tool_calls``, we attach two pieces of pre-tool context
        to each captured tool call:

        * ``thinkingBefore`` — private/model-native reasoning.
        * ``assistantTextBefore`` — visible assistant narration emitted in
          the same message before the tool call.

        The final reasoning (the message that produced the user-facing
        reply) becomes the turn-level ``agentThinking``.
        """
        if not self._matches_session(session_id):
            return
        if not conversation_history:
            return

        # Find the last user message and walk forward from there.
        last_user_idx = -1
        for i, msg in enumerate(conversation_history):
            if msg.get("role") == "user":
                last_user_idx = i

        # Build maps keyed by tool_call_id so post-tool events can be
        # merged with the canonical assistant message later.
        thinking_by_id: dict[str, str] = {}
        assistant_text_by_id: dict[str, str] = {}
        ordered_tool_calls: list[dict[str, Any]] = []
        ordered_object_ids: set[int] = set()
        # Reasoning of the message that produced the final reply (no
        # tool_calls in that message) becomes the turn-level thinking.
        final_reasoning = ""

        for msg in conversation_history[last_user_idx + 1 :]:
            if msg.get("role") != "assistant":
                continue
            r = msg.get("reasoning")
            r_str = r.strip() if isinstance(r, str) and r.strip() else ""
            content_str = self._assistant_text(msg.get("content"))
            tcs = msg.get("tool_calls")
            if isinstance(tcs, list) and tcs:
                # Reasoning preceded these tool calls.
                for tc in tcs:
                    if not isinstance(tc, dict):
                        continue
                    ids = self._tool_call_ids(tc)
                    if r_str:
                        for tc_id in ids:
                            thinking_by_id[tc_id] = r_str
                    if content_str:
                        for tc_id in ids:
                            assistant_text_by_id[tc_id] = content_str

                    existing = self._find_tool_call(ids)
                    # Some Hermes tools (for example planner/todo-style
                    # host tools) appear in the assistant message but do
                    # not fire `post_tool_call`. Add a placeholder so the
                    # trace still records the tool decision and reasoning;
                    # `post_tool_call` will merge real output later if it
                    # eventually arrives.
                    if existing is None:
                        existing = {
                            "name": self._tool_name(tc),
                            "input": self._tool_input(tc),
                            "output": "",
                            "thinkingBefore": r_str or "",
                            "assistantTextBefore": content_str or "",
                            "_id": ids[0] if ids else "",
                            "_ids": ids,
                            "toolCallId": ids[0] if ids else "",
                        }
                        self._tool_calls.append(existing)
                    else:
                        # Preserve output captured by post_tool_call, but
                        # let the LLM message supply canonical order,
                        # input/name aliases, and thinkingBefore.
                        existing["name"] = existing.get("name") or self._tool_name(tc)
                        existing["input"] = existing.get("input") or self._tool_input(tc)
                        existing["thinkingBefore"] = r_str or existing.get("thinkingBefore", "")
                        existing["assistantTextBefore"] = content_str or existing.get(
                            "assistantTextBefore", ""
                        )
                        existing["_ids"] = sorted(set((existing.get("_ids") or []) + ids))
                        existing["_id"] = existing.get("_id") or (ids[0] if ids else "")
                        if existing.get("_id"):
                            existing["toolCallId"] = existing["_id"]

                    marker = id(existing)
                    if marker not in ordered_object_ids:
                        ordered_tool_calls.append(existing)
                        ordered_object_ids.add(marker)
            else:
                # Plain assistant reply — overwrite final_reasoning so we
                # keep the LATEST one (mirrors Hermes' ``last_reasoning``).
                if r_str:
                    final_reasoning = r_str

        # Make the turn payload follow the LLM-declared tool order. This
        # matters when post_tool_call fires for later tools before
        # post_llm_call backfills earlier planner/todo calls.
        if ordered_tool_calls:
            remaining = [tc for tc in self._tool_calls if id(tc) not in ordered_object_ids]
            self._tool_calls = ordered_tool_calls + remaining

        # Attach thinkingBefore to matching captured tool calls.
        for tc in self._tool_calls:
            ids = tc.get("_ids") or ([tc.get("_id")] if tc.get("_id") else [])
            for tc_id in ids:
                if tc_id and tc_id in thinking_by_id:
                    tc["thinkingBefore"] = thinking_by_id[tc_id]
                    break
            for tc_id in ids:
                if tc_id and tc_id in assistant_text_by_id:
                    tc["assistantTextBefore"] = assistant_text_by_id[tc_id]
                    break

        self._turn_thinking = final_reasoning

    @staticmethod
    def _assistant_text(content: Any) -> str:
        """Extract visible assistant text from Hermes/OpenAI message content."""
        if isinstance(content, str):
            return content.strip()
        if isinstance(content, list):
            parts: list[str] = []
            for block in content:
                if isinstance(block, str):
                    text = block.strip()
                elif isinstance(block, dict):
                    raw = block.get("text") or block.get("content")
                    text = raw.strip() if isinstance(raw, str) else ""
                else:
                    text = ""
                if text:
                    parts.append(text)
            return "\n".join(parts).strip()
        return ""

    @staticmethod
    def _tool_call_ids(raw: dict[str, Any]) -> list[str]:
        ids: list[str] = []
        for key in ("id", "call_id", "response_item_id", "tool_call_id"):
            value = raw.get(key)
            if isinstance(value, str) and value and value not in ids:
                ids.append(value)
        return ids

    @staticmethod
    def _tool_name(raw: dict[str, Any]) -> str:
        fn = raw.get("function")
        if isinstance(fn, dict) and isinstance(fn.get("name"), str):
            return fn["name"]
        name = raw.get("name")
        return name if isinstance(name, str) and name else "unknown_tool"

    @staticmethod
    def _tool_input(raw: dict[str, Any]) -> str:
        fn = raw.get("function")
        if isinstance(fn, dict):
            args = fn.get("arguments")
            if isinstance(args, str):
                return args
            if args is not None:
                return json.dumps(args, ensure_ascii=False)
        for key in ("arguments", "args", "input"):
            args = raw.get(key)
            if isinstance(args, str):
                return args
            if args is not None:
                return json.dumps(args, ensure_ascii=False)
        return ""

    def _find_tool_call(self, ids: list[str]) -> dict[str, Any] | None:
        if not ids:
            return None
        needle = set(ids)
        for tc in self._tool_calls:
            existing = set(tc.get("_ids") or [])
            if tc.get("_id"):
                existing.add(str(tc["_id"]))
            if existing & needle:
                return tc
        return None

    # ─── Turn-level hooks ─────────────────────────────────────────────────

    def on_turn_start(self, turn_number: int, message: str, **_kwargs: Any) -> None:  # type: ignore[override]
        self._turn_number = int(turn_number or 0)
        self._skip_current_turn = _is_hermes_internal_review_prompt(message)
        self._last_user_text = "" if self._skip_current_turn else (message or "").strip()
        self._turn_started_at_ms = int(time.time() * 1000)
        with self._interview_lock:
            self._turn_memory_refs.clear()
        with self._state_lock:
            self._last_injected_context = ""
            self._active_turn_key = (
                f"{self._session_id}:{self._turn_number}"
                if self._session_id and self._turn_number > 0
                else ""
            )
        # Reset per-turn buffers so reasoning / tool calls captured here
        # belong only to this turn.
        self._turn_thinking = ""
        self._tool_calls = []
        self._tool_failure_streaks = {}

    def prefetch(self, query: str, *, session_id: str = "") -> str:  # type: ignore[override]
        """Inject relevant memories ahead of the next model call.

        If ``queue_prefetch`` already ran for this turn, return the
        cached result immediately. Otherwise synchronously run
        ``turn.start`` against the bridge (small overhead).
        """
        if self._prefetch_thread and self._prefetch_thread.is_alive():
            self._prefetch_thread.join(timeout=5.0)
        with self._prefetch_lock:
            cached = self._prefetch_result
            self._prefetch_result = ""
        if self._skip_current_turn or _is_hermes_internal_review_prompt(query):
            self._skip_current_turn = True
            return ""
        if cached:
            return cached
        if not self._ensure_bridge(session_id or self._session_id, timeout=10.0):
            return ""
        try:
            context = self._turn_start(query, session_id=session_id)
            with self._state_lock:
                self._last_injected_context = context[:_COMPRESSION_CONTEXT_MAX_CHARS]
            return context
        except Exception as err:
            logger.debug("MemOS: prefetch failed — %s", err)
            return ""

    def queue_prefetch(self, query: str, *, session_id: str = "") -> None:  # type: ignore[override]
        """No-op for MemOS.

        Hermes calls this AFTER ``sync_turn`` to warm the cache for a
        hypothetical next turn. In the V7 architecture each ``turn.end``
        triggers async capture / reward / induction work — running another
        ``turn.start`` against the same (already-closed) episode just
        races and produces ``episode already closed`` noise in the
        viewer's logs page. ``prefetch()`` (called BEFORE the next
        turn's LLM call) handles real retrieval; this hook is moot.
        """
        return

    def sync_turn(
        self,
        user_content: str,
        assistant_content: str,
        *,
        session_id: str = "",
    ) -> None:  # type: ignore[override]
        """Persist a completed turn immediately.

        Tool calls are captured via the Hermes ``post_tool_call``
        plugin hook (registered in ``initialize``). By the time
        ``sync_turn`` is called the full list of tool calls for this
        turn has already been accumulated in ``self._tool_calls``.
        """
        user = user_content or self._last_user_text
        assistant = assistant_content or ""
        tool_calls = self._tool_calls
        thinking = self._turn_thinking
        turn_started_at_ms = self._turn_started_at_ms or int(time.time() * 1000)
        with self._interview_lock:
            memory_refs = [dict(ref) for ref in self._turn_memory_refs.values()]
        self._tool_calls = []
        self._turn_thinking = ""
        if self._skip_current_turn or _is_hermes_internal_review_prompt(user):
            self._skip_current_turn = False
            self._last_user_text = ""
            return
        if not self._ensure_bridge(session_id or self._session_id, timeout=75.0):
            logger.warning("MemOS: sync_turn skipped because bridge is unavailable")
            return
        logger.info(
            "MemOS: sync_turn user=%d assistant=%d tools=%d thinking=%d",
            len(user),
            len(assistant),
            len(tool_calls),
            len(thinking),
        )
        ts_ms = int(time.time() * 1000)
        is_feedback_turn = _is_verifier_feedback_prompt(user)
        feedback_submitted = False
        current_trace_id = ""
        try:
            if user and not self._episode_id:
                self._turn_start(user, session_id=session_id or self._session_id)
            current_trace_id = self._turn_end(
                user,
                assistant,
                tool_calls,
                ts_ms,
                agent_thinking=thinking,
            )
            if is_feedback_turn:
                feedback_submitted = self._try_submit_verifier_feedback(
                    user,
                    assistant,
                    ts_ms,
                    trace_id=current_trace_id,
                )
        except Exception as err:
            if not self._is_transport_closed(err):
                logger.warning("MemOS: sync_turn turn.end failed — %s", err)
            else:
                logger.warning(
                    "MemOS: bridge transport closed during sync_turn; "
                    "reconnecting and retrying once — %s",
                    err,
                )
                try:
                    self._reconnect_bridge(session_id or self._session_id, timeout=75.0)
                    if user:
                        self._turn_start(user, session_id=session_id or self._session_id)
                    current_trace_id = self._turn_end(
                        user,
                        assistant,
                        tool_calls,
                        ts_ms,
                        agent_thinking=thinking,
                    )
                    if is_feedback_turn and not feedback_submitted:
                        feedback_submitted = self._try_submit_verifier_feedback(
                            user,
                            assistant,
                            ts_ms,
                            trace_id=current_trace_id,
                        )
                except Exception:
                    logger.exception(
                        "MemOS: sync_turn failed after bridge reconnect; "
                        "memory turn was not persisted"
                    )
        if is_feedback_turn and not feedback_submitted:
            # turn.end may time out while the bridge continues lite capture in
            # the background. Preserve the user's explicit signal at episode
            # scope instead of dropping Decision Repair entirely.
            self._try_submit_verifier_feedback(
                user,
                assistant,
                ts_ms,
                trace_id="",
                fallback=True,
            )
        if current_trace_id and not is_feedback_turn and self._feishu_interview is not None:
            self._prepare_review_candidate(
                user_text=user,
                trace_id=current_trace_id,
                episode_id=self._episode_id,
                tool_calls=tool_calls,
                memory_refs=memory_refs,
                started_at_ms=turn_started_at_ms,
                completed_at_ms=int(time.time() * 1000),
            )
        if user_content:
            self._last_user_text = user_content

    # ─── Feishu user interview (UI-only; no score mutation) ──────────────

    def _prepare_review_candidate(
        self,
        *,
        user_text: str,
        trace_id: str,
        episode_id: str,
        tool_calls: list[dict[str, Any]],
        memory_refs: list[dict[str, Any]],
        started_at_ms: int,
        completed_at_ms: int,
    ) -> None:
        """Evaluate a completed turn without sending before answer delivery."""
        client = self._feishu_interview
        counts: dict[str, int] = {}
        if client is not None and memory_refs:
            rating_counts = getattr(client, "rating_counts", None)
            if callable(rating_counts):
                with contextlib.suppress(Exception):
                    counts = rating_counts(memory_refs)
        scored_refs: list[dict[str, Any]] = []
        for ref in memory_refs:
            key = f"{ref.get('refKind') or 'memory'}:{ref.get('refId') or ''}"
            scored_refs.append({
                **ref,
                "ratingCount": max(0, int(counts.get(key, 0))),
            })
        review_input = {
            "memories": scored_refs,
            "toolCalls": [
                {
                    "name": call.get("name"),
                    "input": call.get("input"),
                    "output": call.get("output"),
                    "isError": self._tool_result_failed(
                        str(call.get("output") or ""),
                        call,
                    ),
                }
                for call in tool_calls
            ],
            "startedAt": started_at_ms,
            "completedAt": completed_at_ms,
        }
        if not scored_refs:
            evaluation: dict[str, Any] = {
                "eligible": False,
                "score": None,
                "threshold": 65,
                "reason": "no_referenced_memory",
                "breakdown": {
                    "tool": 0,
                    "difficulty": 0,
                    "memory": 0,
                    "effectiveToolCalls": 0,
                    "referencedMemories": 0,
                    "signals": {},
                },
                "delivery": {
                    "sendDelaySeconds": 0,
                    "cooldownMinutes": 0,
                    "dailyLimit": 0,
                },
            }
        else:
            try:
                evaluation = self._bridge_request(
                    "review.evaluate",
                    review_input,
                    timeout=10.0,
                )
                if not isinstance(evaluation, dict):
                    raise RuntimeError("review.evaluate returned a non-object")
            except Exception as err:
                logger.warning("MemOS: review trigger evaluation failed — %s", err)
                return

        candidate = {
            "candidateId": f"mrc_{uuid.uuid4().hex}",
            "sessionId": self._session_id,
            "episodeId": episode_id,
            "traceId": trace_id,
            "chatId": self._chat_id,
            "threadId": self._thread_id,
            "userText": user_text,
            "memoryRefs": scored_refs,
            "reviewInput": review_input,
            "evaluation": evaluation,
            "createdAt": completed_at_ms,
            "status": "awaiting_delivery" if evaluation.get("eligible") else str(
                evaluation.get("reason") or "ineligible"
            ),
        }
        with self._interview_lock:
            self._last_review_candidate = candidate
            self._pending_review_candidate = (
                candidate if evaluation.get("eligible") is True else None
            )
        if client is not None:
            with contextlib.suppress(Exception):
                client.record_event({
                    "kind": "review_trigger_evaluated",
                    "candidateId": candidate["candidateId"],
                    "sessionId": self._session_id,
                    "episodeId": episode_id,
                    "traceId": trace_id,
                    "chatId": self._chat_id,
                    "memoryRefs": scored_refs,
                    "score": evaluation.get("score"),
                    "threshold": evaluation.get("threshold"),
                    "eligible": evaluation.get("eligible"),
                    "reason": evaluation.get("reason"),
                    "breakdown": evaluation.get("breakdown"),
                })

    def _on_post_gateway_delivery(
        self,
        *,
        event: Any = None,
        outcome: Any = None,
        **_kwargs: Any,
    ) -> bool:
        """Release an eligible candidate only after host delivery completes."""
        source = getattr(event, "source", None)
        if source is None or not self._is_matching_feishu_source(source):
            return False
        outcome_value = str(getattr(outcome, "value", outcome) or "").lower()
        if outcome_value not in {"success", "processingoutcome.success"}:
            return True
        with self._interview_lock:
            candidate = self._pending_review_candidate
            if candidate is None or candidate.get("status") != "awaiting_delivery":
                return True
            delay = max(
                0.0,
                float((candidate.get("evaluation") or {}).get("delivery", {}).get(
                    "sendDelaySeconds",
                    0,
                )),
            )
            candidate["status"] = "scheduled"
            timer = threading.Timer(delay, self._send_scheduled_review, args=(candidate,))
            timer.daemon = True
            self._pending_review_timer = timer
            timer.start()
        return True

    def _send_scheduled_review(self, candidate: dict[str, Any]) -> None:
        with self._interview_lock:
            if candidate is not self._pending_review_candidate:
                return
            if candidate.get("status") != "scheduled":
                return
            if not self._automatic_review_limit_allows_locked(candidate):
                self._pending_review_candidate = None
                self._pending_review_timer = None
                return
            candidate["status"] = "sending"
            self._pending_review_timer = None
        request = self._queue_feishu_interview(
            user_text=str(candidate.get("userText") or ""),
            trace_id=str(candidate.get("traceId") or ""),
            episode_id=str(candidate.get("episodeId") or ""),
            candidate=candidate,
        )
        if request is None:
            with self._interview_lock:
                candidate["status"] = "suppressed"
                if candidate is self._pending_review_candidate:
                    self._pending_review_candidate = None

    def _automatic_review_limit_allows_locked(self, candidate: dict[str, Any]) -> bool:
        episode_id = str(candidate.get("episodeId") or "")
        if episode_id and (
            episode_id in self._interview_skipped_episodes
            or episode_id in self._interview_rated_episodes
        ):
            candidate["status"] = "episode_already_reviewed"
            return False
        delivery = (candidate.get("evaluation") or {}).get("delivery") or {}
        now_ms = int(time.time() * 1000)
        cutoff_ms = now_ms - 24 * 60 * 60 * 1000
        self._auto_review_sent_at = [
            sent_at for sent_at in self._auto_review_sent_at if sent_at >= cutoff_ms
        ]
        daily_limit = max(0, int(delivery.get("dailyLimit") or 0))
        if daily_limit and len(self._auto_review_sent_at) >= daily_limit:
            candidate["status"] = "daily_limit"
            return False
        cooldown_ms = max(0, int(float(delivery.get("cooldownMinutes") or 0) * 60_000))
        if cooldown_ms and self._auto_review_sent_at:
            if now_ms - self._auto_review_sent_at[-1] < cooldown_ms:
                candidate["status"] = "cooldown"
                return False
        return True

    def _cancel_pending_review_locked(self, reason: str) -> None:
        timer = self._pending_review_timer
        if timer is not None:
            timer.cancel()
        candidate = self._pending_review_candidate
        if candidate is not None and candidate.get("status") in {
            "awaiting_delivery",
            "scheduled",
        }:
            candidate["status"] = reason
        self._pending_review_timer = None
        self._pending_review_candidate = None

    def _handle_manual_review(self, actor_ids: set[str]) -> None:
        client = self._feishu_interview
        if client is None or not client.configured:
            logger.warning("MemOS: /review ignored because Feishu interview is not configured")
            return
        allowed = {value for value in (self._user_id, self._user_id_alt) if value}
        if allowed and not allowed.intersection(actor_ids):
            return
        with self._interview_lock:
            candidate = self._last_review_candidate
            self._cancel_pending_review_locked("manual_override")
        if candidate is None:
            self._send_interview_notice("没有可评分的上一轮", "还没有已完成的任务记录。")
            return
        if not candidate.get("memoryRefs"):
            self._send_interview_notice(
                "上一轮无需评分",
                "上一轮没有使用 PigMemory 记忆，因此没有评分对象。",
            )
            return
        if candidate.get("status") == "rated":
            self._send_interview_notice("上一轮已评分", "这轮记忆已经收到评分，不会重复记录。")
            return
        if candidate.get("status") == "sent":
            self._send_interview_notice("评分卡已经发送", "请直接使用上一张评分卡即可。")
            return
        review_input = {**candidate.get("reviewInput", {}), "manual": True}
        try:
            evaluation = self._bridge_request(
                "review.evaluate",
                review_input,
                timeout=10.0,
            )
        except Exception as err:
            logger.warning("MemOS: manual review evaluation failed — %s", err)
            return
        if not isinstance(evaluation, dict) or evaluation.get("eligible") is not True:
            self._send_interview_notice("手动评分已关闭", "请在 Viewer 设置中启用手动 `/review`。")
            return
        candidate["evaluation"] = evaluation
        candidate["status"] = "manual_sending"
        request = self._queue_feishu_interview(
            user_text=str(candidate.get("userText") or ""),
            trace_id=str(candidate.get("traceId") or ""),
            episode_id=str(candidate.get("episodeId") or ""),
            candidate=candidate,
            manual=True,
        )
        if request is None:
            candidate["status"] = "manual_failed"

    def _send_interview_notice(self, title: str, content: str) -> None:
        client = self._feishu_interview
        if client is None:
            return
        self._send_interview_followup(
            lambda sender: sender.send_notice_card(
                chat_id=self._chat_id,
                title=title,
                content=content,
            ),
            name="memos-feishu-review-notice",
        )

    def _queue_feishu_interview(
        self,
        *,
        user_text: str,
        trace_id: str,
        episode_id: str,
        candidate: dict[str, Any] | None = None,
        manual: bool = False,
    ) -> dict[str, Any] | None:
        client = self._feishu_interview
        chat_id = self._chat_id
        if client is None or not chat_id or not trace_id:
            return None
        with self._interview_lock:
            if not manual and episode_id and (
                episode_id in self._interview_skipped_episodes
                or episode_id in self._interview_rated_episodes
            ):
                return None
        if not client.configured:
            logger.warning(
                "MemOS: Feishu interview enabled but FEISHU_APP_ID/FEISHU_APP_SECRET "
                "are unavailable; rating card was not sent"
            )
            return None

        request_id = f"mfi_{uuid.uuid4().hex}"
        request = {
            "requestId": request_id,
            "sessionId": self._session_id,
            "episodeId": episode_id,
            "traceId": trace_id,
            "chatId": chat_id,
            "threadId": self._thread_id,
            "allowedUserIds": [
                value for value in (self._user_id, self._user_id_alt) if value
            ],
            "createdAt": int(time.time() * 1000),
            "rating": None,
            "reason": None,
            "manual": manual,
            "memoryRefs": list((candidate or {}).get("memoryRefs") or []),
            "reviewScore": ((candidate or {}).get("evaluation") or {}).get("score"),
            "reviewBreakdown": ((candidate or {}).get("evaluation") or {}).get(
                "breakdown"
            ),
        }
        if candidate is not None:
            request["candidateId"] = candidate.get("candidateId")
            candidate["requestId"] = request_id
        with self._interview_lock:
            self._prune_interview_state_locked()
            self._interview_requests[request_id] = request

        def _send() -> None:
            try:
                message_id = client.send_rating_card(
                    chat_id=chat_id,
                    request_id=request_id,
                    task_preview=user_text,
                )
                request["messageId"] = message_id
                with self._interview_lock:
                    if candidate is not None:
                        candidate["status"] = "sent"
                    if not manual:
                        self._auto_review_sent_at.append(int(time.time() * 1000))
                    if candidate is self._pending_review_candidate:
                        self._pending_review_candidate = None
                client.record_event({
                    "kind": "rating_card_sent",
                    **self._interview_context(request),
                    "messageId": message_id,
                    "manual": manual,
                })
                logger.info(
                    "MemOS: sent Feishu interview card request=%s episode=%s trace=%s",
                    request_id,
                    episode_id,
                    trace_id,
                )
            except Exception as err:
                with self._interview_lock:
                    self._interview_requests.pop(request_id, None)
                    if candidate is not None:
                        candidate["status"] = "send_failed"
                    if candidate is self._pending_review_candidate:
                        self._pending_review_candidate = None
                with contextlib.suppress(Exception):
                    client.record_event({
                        "kind": "rating_card_send_failed",
                        **self._interview_context(request),
                        "error": str(err),
                    })
                logger.warning("MemOS: Feishu interview card send failed — %s", err)

        self._start_interview_worker(_send, f"memos-feishu-card-{request_id[-8:]}")
        return request

    def _on_pre_gateway_dispatch(self, *, event: Any = None, **_kwargs: Any) -> dict[str, str] | None:
        """Consume PigMemory card actions before they invoke the LLM."""
        if event is None:
            return None
        source = getattr(event, "source", None)
        if source is None or not self._is_matching_feishu_source(source):
            return None
        text = str(getattr(event, "text", "") or "").strip()
        if self._try_resolve_location_name(text):
            return {"action": "skip", "reason": "pigmemory_location_named"}
        if self._feishu_interview is None:
            return None
        actor_ids = self._source_actor_ids(source)
        action = parse_interview_action(text)
        if action is not None:
            request_id = str(action.get("request_id") or "")
            with self._interview_lock:
                self._prune_interview_state_locked()
                request = self._interview_requests.get(request_id)
            if request is None:
                # It is still our command, so don't let an expired/restarted
                # card click waste an LLM turn.
                return {"action": "skip", "reason": "pigmemory_interview_expired"}
            if not self._interview_actor_allowed(request, actor_ids):
                self._record_interview_event(
                    "unauthorized_action",
                    request,
                    actorIds=sorted(actor_ids),
                )
                return {"action": "skip", "reason": "pigmemory_interview_unauthorized"}
            self._handle_interview_action(request, action, actor_ids)
            return {"action": "skip", "reason": "pigmemory_interview_action"}

        # Any real follow-up means the user is still working. Cancel a delayed
        # automatic prompt before it can interrupt the next turn.
        with self._interview_lock:
            self._cancel_pending_review_locked("cancelled_by_followup")
        if re.fullmatch(r"/review(?:@\S+)?", text.lower()):
            self._handle_manual_review(actor_ids)
            return {"action": "skip", "reason": "pigmemory_manual_review"}

        pending = self._matching_pending_free_text(source, actor_ids)
        if pending is None or not text or text.startswith("/"):
            return None
        request_id, request = pending
        with self._interview_lock:
            self._pending_free_text_reasons.pop(request_id, None)
            request["reason"] = text[:4000]
        self._record_interview_event(
            "free_text_reason",
            request,
            actorIds=sorted(actor_ids),
            text=text[:4000],
        )
        self._send_interview_followup(
            lambda client: client.send_thanks_card(
                chat_id=request["chatId"],
                request_id=request["requestId"],
                allow_more=False,
            ),
            name=f"memos-feishu-thanks-{request_id[-8:]}",
        )
        return {"action": "skip", "reason": "pigmemory_interview_free_text"}

    def _try_resolve_location_name(self, text: str) -> bool:
        """Consume only an exact `name|city` reply to a sent location card."""
        sender = self._feishu_proactive
        if (
            sender is None
            or not self._chat_id
            or not text
            or text.startswith("/")
            or ("|" not in text and "｜" not in text)
        ):
            return False
        try:
            resolved = self._bridge_request(
                "location.resolve_name",
                {
                    "channel": "feishu",
                    "targetId": self._chat_id,
                    "text": text,
                },
                timeout=15.0,
            )
        except Exception as err:
            logger.debug("PigMemory: location name resolution unavailable — %s", err)
            return False
        if not isinstance(resolved, dict) or not resolved.get("placeId"):
            return False
        name = str(resolved.get("name") or "")
        city = str(resolved.get("city") or "")

        def _send() -> None:
            try:
                sender.send_notice_card(
                    chat_id=self._chat_id,
                    title="地点名称已保存",
                    content=f"已记为 **{name}（{city}）**。只会在语义地点记忆中使用。",
                )
            except Exception as err:
                logger.warning("PigMemory: location naming confirmation failed — %s", err)

        threading.Thread(
            target=_send,
            daemon=True,
            name="pigmemory-location-name-confirmation",
        ).start()
        return True

    def _on_feishu_card_action(
        self,
        *,
        data: Any = None,
        action_value: Any = None,
        **_kwargs: Any,
    ) -> dict[str, Any] | None:
        """Resolve an interview button inline in Feishu's callback thread."""
        if self._feishu_interview is None or not isinstance(action_value, dict):
            return None
        if not action_value.get("pigmemory_interview_action"):
            return None

        event = getattr(data, "event", None)
        context = getattr(event, "context", None)
        chat_id = str(getattr(context, "open_chat_id", "") or "")
        if chat_id != self._chat_id:
            return None

        request_id = str(action_value.get("request_id") or "")
        with self._interview_lock:
            self._prune_interview_state_locked()
            request = self._interview_requests.get(request_id)
        if request is None:
            return {"action": "handled"}

        operator = getattr(event, "operator", None)
        actor_ids = {
            str(value)
            for value in (
                getattr(operator, "open_id", ""),
                getattr(operator, "user_id", ""),
                getattr(operator, "union_id", ""),
            )
            if value
        }
        if not self._interview_actor_allowed(request, actor_ids):
            self._record_interview_event(
                "unauthorized_action",
                request,
                actorIds=sorted(actor_ids),
            )
            return {"action": "handled"}

        card = self._handle_interview_action(
            request,
            action_value,
            actor_ids,
            inline=True,
        )
        return {"action": "handled", "card": card}

    def _handle_interview_action(
        self,
        request: dict[str, Any],
        action: dict[str, Any],
        actor_ids: set[str],
        *,
        inline: bool = False,
    ) -> dict[str, Any] | None:
        kind = str(action.get("pigmemory_interview_action") or "")
        request_id = str(request["requestId"])
        if request.get("skippedAt") is not None:
            return build_skipped_card() if inline else None

        if kind == "skip":
            with self._interview_lock:
                if request.get("rating") is not None:
                    return None
                skipped_at = int(time.time() * 1000)
                request["skippedAt"] = skipped_at
                self._pending_free_text_reasons.pop(request_id, None)
                episode_id = str(request.get("episodeId") or "")
                if episode_id:
                    self._interview_skipped_episodes.add(episode_id)
                candidate = self._last_review_candidate
                if candidate is not None and candidate.get("candidateId") == request.get(
                    "candidateId"
                ):
                    candidate["status"] = "skipped"
            self._record_interview_event(
                "rating_skipped",
                request,
                actorIds=sorted(actor_ids),
            )
            if inline:
                return build_skipped_card()
            self._send_interview_followup(
                lambda client: client.send_skipped_card(chat_id=request["chatId"]),
                name=f"memos-feishu-skipped-{request_id[-8:]}",
            )
            return None

        if kind == "rate":
            try:
                score = max(1, min(5, int(action.get("score"))))
            except (TypeError, ValueError):
                return
            with self._interview_lock:
                if request.get("rating") is not None:
                    return
                request["rating"] = score
                request["ratedAt"] = int(time.time() * 1000)
                episode_id = str(request.get("episodeId") or "")
                if episode_id:
                    self._interview_rated_episodes.add(episode_id)
                candidate = self._last_review_candidate
                if candidate is not None and candidate.get("candidateId") == request.get(
                    "candidateId"
                ):
                    candidate["status"] = "rated"
            self._record_interview_event(
                "rating",
                request,
                actorIds=sorted(actor_ids),
                score=score,
            )
            if score <= 3:
                if inline:
                    return build_reason_card(request_id=request_id, score=score)
                self._send_interview_followup(
                    lambda client: client.send_reason_card(
                        chat_id=request["chatId"],
                        request_id=request_id,
                        score=score,
                    ),
                    name=f"memos-feishu-reason-{request_id[-8:]}",
                )
            else:
                if inline:
                    return build_thanks_card(request_id=request_id, allow_more=True)
                self._send_interview_followup(
                    lambda client: client.send_thanks_card(
                        chat_id=request["chatId"],
                        request_id=request_id,
                        allow_more=True,
                    ),
                    name=f"memos-feishu-thanks-{request_id[-8:]}",
                )
            return None

        if kind == "ask_reason":
            score = int(request.get("rating") or 5)
            if inline:
                return build_reason_card(request_id=request_id, score=score)
            self._send_interview_followup(
                lambda client: client.send_reason_card(
                    chat_id=request["chatId"],
                    request_id=request_id,
                    score=score,
                ),
                name=f"memos-feishu-reason-{request_id[-8:]}",
            )
            return None

        if kind != "reason":
            return None
        reason = str(action.get("reason") or "").strip().lower()
        if reason not in {"incorrect", "incomplete", "requirements", "inefficient", "other"}:
            return None
        self._record_interview_event(
            "reason_choice",
            request,
            actorIds=sorted(actor_ids),
            reason=reason,
        )
        if reason == "other":
            with self._interview_lock:
                self._pending_free_text_reasons[request_id] = {
                    "requestId": request_id,
                    "chatId": request["chatId"],
                    "actorIds": sorted(actor_ids),
                    "expiresAt": time.time() + 10 * 60,
                }
            if inline:
                return build_free_text_prompt_card()
            self._send_interview_followup(
                lambda client: client.send_free_text_prompt(chat_id=request["chatId"]),
                name=f"memos-feishu-free-text-{request_id[-8:]}",
            )
            return None
        with self._interview_lock:
            request["reason"] = reason
        if inline:
            return build_thanks_card(request_id=request_id, allow_more=False)
        self._send_interview_followup(
            lambda client: client.send_thanks_card(
                chat_id=request["chatId"],
                request_id=request_id,
                allow_more=False,
            ),
            name=f"memos-feishu-thanks-{request_id[-8:]}",
        )
        return None

    def _send_interview_followup(
        self,
        send: Any,
        *,
        name: str,
    ) -> None:
        client = self._feishu_interview
        if client is None:
            return

        def _run() -> None:
            try:
                send(client)
            except Exception as err:
                logger.warning("MemOS: Feishu interview follow-up failed — %s", err)

        self._start_interview_worker(_run, name)

    @staticmethod
    def _start_interview_worker(fn: Any, name: str) -> None:
        threading.Thread(target=fn, daemon=True, name=name).start()

    def _record_interview_event(
        self,
        kind: str,
        request: dict[str, Any],
        **extra: Any,
    ) -> None:
        client = self._feishu_interview
        if client is None:
            return
        try:
            client.record_event({
                "kind": kind,
                **self._interview_context(request),
                **extra,
            })
        except Exception as err:
            logger.warning("MemOS: failed to record Feishu interview event — %s", err)

    @staticmethod
    def _interview_context(request: dict[str, Any]) -> dict[str, Any]:
        return {
            "requestId": request.get("requestId"),
            "sessionId": request.get("sessionId"),
            "episodeId": request.get("episodeId"),
            "traceId": request.get("traceId"),
            "chatId": request.get("chatId"),
            "candidateId": request.get("candidateId"),
            "memoryRefs": request.get("memoryRefs") or [],
            "reviewScore": request.get("reviewScore"),
            "reviewBreakdown": request.get("reviewBreakdown"),
            "manual": request.get("manual") is True,
        }

    def _is_matching_feishu_source(self, source: Any) -> bool:
        platform = getattr(source, "platform", "")
        platform_value = getattr(platform, "value", platform)
        chat_id = str(getattr(source, "chat_id", "") or "")
        return str(platform_value or "").lower() == "feishu" and chat_id == self._chat_id

    @staticmethod
    def _source_actor_ids(source: Any) -> set[str]:
        return {
            str(value)
            for value in (
                getattr(source, "user_id", ""),
                getattr(source, "user_id_alt", ""),
            )
            if value
        }

    @staticmethod
    def _interview_actor_allowed(request: dict[str, Any], actor_ids: set[str]) -> bool:
        allowed = {str(value) for value in request.get("allowedUserIds", []) if value}
        return not allowed or bool(allowed.intersection(actor_ids))

    def _matching_pending_free_text(
        self,
        source: Any,
        actor_ids: set[str],
    ) -> tuple[str, dict[str, Any]] | None:
        chat_id = str(getattr(source, "chat_id", "") or "")
        with self._interview_lock:
            self._prune_interview_state_locked()
            pending_items = list(self._pending_free_text_reasons.items())
            for request_id, pending in reversed(pending_items):
                pending_actor_ids = {str(v) for v in pending.get("actorIds", []) if v}
                if pending.get("chatId") != chat_id:
                    continue
                if pending_actor_ids and not pending_actor_ids.intersection(actor_ids):
                    continue
                request = self._interview_requests.get(request_id)
                if request is not None:
                    return request_id, request
        return None

    def _prune_interview_state_locked(self) -> None:
        now_seconds = time.time()
        expired_pending = [
            request_id
            for request_id, pending in self._pending_free_text_reasons.items()
            if float(pending.get("expiresAt") or 0) <= now_seconds
        ]
        for request_id in expired_pending:
            self._pending_free_text_reasons.pop(request_id, None)
        cutoff_ms = int((now_seconds - 24 * 60 * 60) * 1000)
        expired_requests = [
            request_id
            for request_id, request in self._interview_requests.items()
            if int(request.get("createdAt") or 0) < cutoff_ms
        ]
        for request_id in expired_requests:
            self._interview_requests.pop(request_id, None)
            self._pending_free_text_reasons.pop(request_id, None)

    def on_delegation(
        self,
        task: str,
        result: str,
        *,
        child_session_id: str = "",
        **kwargs: Any,
    ) -> None:  # type: ignore[override]
        """Record a subagent outcome.

        Hermes invokes this on the **parent** when a subagent finishes.
        We write it as a synthetic trace so decision-repair can see
        failure bursts and so Tier 2 retrieval can surface past
        delegations.
        """
        if not self._ensure_bridge(self._session_id, timeout=30.0):
            return
        try:
            if not self._episode_id and self._last_user_text:
                self._turn_start(self._last_user_text, session_id=self._session_id)
            namespace = self._record_namespace()
            hook_meta = {
                "hookKwargs": kwargs,
                "namespace": namespace,
            }
            self._bridge_request(
                "subagent.record",
                {
                    "agent": "hermes",
                    "namespace": namespace,
                    "sessionId": self._session_id,
                    "episodeId": self._episode_id or None,
                    "childSessionId": child_session_id or None,
                    "task": task,
                    "result": result,
                    "toolCalls": self._extract_child_tool_calls(child_session_id),
                    "ts": int(time.time() * 1000),
                    "meta": hook_meta,
                    "contextHints": {
                        "agentIdentity": self._agent_identity,
                        "namespace": namespace,
                        **self._host_runtime_context(),
                    },
                },
            )
        except Exception as err:
            logger.warning("MemOS: subagent.record failed — %s", err)

    def _extract_child_tool_calls(self, child_session_id: str = "") -> list[dict[str, Any]]:
        """Best-effort recovery of subagent tool calls from Hermes session JSON.

        Hermes invokes ``on_delegation`` on the parent and only passes the
        child task/result. The child transcript is still persisted under
        ``$HERMES_HOME/sessions/session_<id>.json``, so we read that file to
        preserve structured tool use in the MemOS child episode.
        """
        if not child_session_id:
            return []
        sessions_dir = (
            Path(self._hermes_home).expanduser() / "sessions"
            if self._hermes_home
            else Path.home() / ".hermes" / "sessions"
        )
        session_path = sessions_dir / f"session_{child_session_id}.json"
        try:
            payload = json.loads(session_path.read_text(encoding="utf-8"))
        except Exception as err:
            logger.debug("MemOS: child session tool extraction skipped — %s", err)
            return []

        messages = payload.get("messages")
        if not isinstance(messages, list):
            return []

        tool_outputs: dict[str, str] = {}
        for message in messages:
            if not isinstance(message, dict) or message.get("role") != "tool":
                continue
            tool_call_id = str(message.get("tool_call_id") or "")
            if tool_call_id:
                tool_outputs[tool_call_id] = str(message.get("content") or "")[:4000]

        base_ts = int(time.time() * 1000)
        calls: list[dict[str, Any]] = []
        for message in messages:
            if not isinstance(message, dict):
                continue
            raw_calls = message.get("tool_calls")
            if not isinstance(raw_calls, list):
                continue
            for raw_call in raw_calls:
                if not isinstance(raw_call, dict):
                    continue
                function = raw_call.get("function")
                if not isinstance(function, dict):
                    function = {}
                call_id = str(
                    raw_call.get("id")
                    or raw_call.get("call_id")
                    or raw_call.get("tool_call_id")
                    or ""
                )
                raw_args = function.get("arguments", raw_call.get("arguments", ""))
                output = tool_outputs.get(call_id, "")
                call: dict[str, Any] = {
                    "name": str(function.get("name") or raw_call.get("name") or "tool"),
                    "input": self._json_or_raw(raw_args),
                    "output": output,
                    "startedAt": base_ts + len(calls),
                    "endedAt": base_ts + len(calls),
                }
                parsed_output = self._json_or_raw(output)
                if isinstance(parsed_output, dict) and parsed_output.get("error"):
                    call["errorCode"] = "tool_error"
                calls.append(call)
        return calls

    @staticmethod
    def _json_or_raw(value: Any) -> Any:
        if not isinstance(value, str):
            return value
        try:
            return json.loads(value)
        except Exception:
            return value

    def on_pre_compress(self, messages: list[dict[str, Any]]) -> str:  # type: ignore[override]
        """Return the memory context injected by the current/previous turn.

        This hook must stay read-only. Calling ``turn.start`` here used to
        finalize the active lightweight episode and create a phantom episode
        on every compression pass. Reusing the exact context previously
        injected by ``prefetch`` also keeps the summary faithful to what the
        model actually saw.
        """
        with self._state_lock:
            context = self._last_injected_context.strip()
        if not context:
            return ""
        return f"PigMemory snapshot (preserved across compression):\n{context}"

    # ─── Tool surface ─────────────────────────────────────────────────────

    @staticmethod
    def _clip(value: Any, limit: int = 1200) -> str:
        text = "" if value is None else str(value)
        return text if len(text) <= limit else text[:limit] + "..."

    @staticmethod
    def _int_arg(args: dict[str, Any], key: str, default: int, lower: int, upper: int) -> int:
        try:
            value = int(args.get(key, default))
        except Exception:
            value = default
        return max(lower, min(upper, value))

    def get_tool_schemas(self) -> list[dict[str, Any]]:  # type: ignore[override]
        return [
            {
                "name": "memos_search",
                "description": (
                    "Search the local PigMemory memory (traces, policies, world models, skills). "
                    "Prefer this before claiming prior context is unavailable."
                ),
                "parameters": {
                    "type": "object",
                    "properties": {
                        "query": {
                            "type": "string",
                            "description": "Short natural-language query (2–5 key words).",
                        },
                        "maxResults": {
                            "type": "integer",
                            "default": 10,
                            "minimum": 1,
                            "maximum": 50,
                        },
                        "sessionScope": {
                            "type": "boolean",
                            "default": False,
                            "description": "Restrict results to the current Hermes session only.",
                        },
                        "includeCandidatePolicies": {
                            "type": "boolean",
                            "default": False,
                            "description": (
                                "Include unverified candidate policies. Candidate results are "
                                "explicitly marked as pending validation."
                            ),
                        },
                    },
                    "required": ["query"],
                },
            },
            {
                "name": "memos_get",
                "description": (
                    "Fetch the full body of a memory item by id. `kind` can be "
                    '"trace" (default), "policy", or "world_model".'
                ),
                "parameters": {
                    "type": "object",
                    "properties": {
                        "id": {"type": "string"},
                        "kind": {
                            "type": "string",
                            "enum": ["trace", "policy", "world_model"],
                            "default": "trace",
                        },
                    },
                    "required": ["id"],
                },
            },
            {
                "name": "memos_timeline",
                "description": "Return the ordered traces for an episode id.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "episodeId": {"type": "string"},
                        "limit": {"type": "integer", "default": 20, "maximum": 100},
                    },
                    "required": ["episodeId"],
                },
            },
            {
                "name": "memos_skill_list",
                "description": (
                    "List callable skills the agent can invoke. Filter by status "
                    "(candidate | active | archived)."
                ),
                "parameters": {
                    "type": "object",
                    "properties": {
                        "status": {
                            "type": "string",
                            "enum": ["candidate", "active", "archived"],
                        },
                        "limit": {
                            "type": "integer",
                            "default": 10,
                            "minimum": 1,
                            "maximum": 50,
                        },
                    },
                },
            },
            {
                "name": "memos_environment",
                "description": (
                    "Return accumulated environment knowledge (L3 world models): "
                    "structural facts, behavioral rules, and project constraints."
                ),
                "parameters": {
                    "type": "object",
                    "properties": {
                        "query": {
                            "type": "string",
                            "description": "Optional keyword query; omit to list recent world models.",
                        },
                        "limit": {
                            "type": "integer",
                            "default": 5,
                            "minimum": 1,
                            "maximum": 30,
                        },
                    },
                },
            },
            {
                "name": "memos_skill_get",
                "description": "Return the full invocation guide for a crystallized skill.",
                "parameters": {
                    "type": "object",
                    "properties": {"id": {"type": "string"}},
                    "required": ["id"],
                },
            },
        ]

    def handle_tool_call(self, tool_name: str, args: dict[str, Any], **_kwargs: Any) -> str:  # type: ignore[override]
        if not self._bridge:
            return json.dumps({"error": "bridge not connected"})
        try:
            if tool_name == "memos_search":
                query = (args.get("query") or "").strip()
                if not query:
                    return json.dumps({"error": "missing query"})
                max_results = self._int_arg(args, "maxResults", 10, 1, 50)
                params: dict[str, Any] = {
                    "agent": "hermes",
                    "namespace": self._runtime_namespace(),
                    "query": query,
                    "topK": {
                        "tier1": max_results,
                        "tier2": max_results,
                        "tier3": max_results,
                    },
                }
                if bool(args.get("sessionScope", False)):
                    params["sessionId"] = self._session_id
                if bool(args.get("includeCandidatePolicies", False)):
                    params["includeCandidatePolicies"] = True
                resp = self._bridge_request_with_retry(
                    "memory.search",
                    params,
                    timeout=_LONG_RPC_TIMEOUT,
                )
                hits = resp.get("hits", [])
                self._remember_retrieval_hits(hits)
                self._acknowledge_retrieval(resp, "hermes.search", hits)
                return json.dumps({"hits": hits})
            if tool_name == "memos_get":
                item_id = (args.get("id") or "").strip()
                if not item_id:
                    return json.dumps({"error": "missing id"})
                kind = args.get("kind") or "trace"
                methods = {
                    "trace": "memory.get_trace",
                    "policy": "memory.get_policy",
                    "world_model": "memory.get_world",
                }
                method = methods.get(kind)
                if method is None:
                    return json.dumps({"error": f"unknown memory kind: {kind}"})
                item = self._bridge_request_with_retry(
                    method, {"id": item_id, "namespace": self._runtime_namespace()}
                )
                if not item:
                    return json.dumps({"found": False, "kind": kind, "id": item_id})
                direct_kind = "experience" if kind == "policy" else kind.replace("_", "-")
                self._remember_direct_memory(str(item.get("id", item_id)), direct_kind)
                if kind == "trace":
                    body = self._clip(item.get("agentText") or item.get("body"))
                    meta = {
                        "episodeId": item.get("episodeId"),
                        "ts": item.get("ts"),
                        "value": item.get("value"),
                        "reflection": self._clip(item.get("reflection")),
                        "userText": self._clip(item.get("userText")),
                        "toolCalls": item.get("toolCalls") or [],
                    }
                elif kind == "policy":
                    body = self._clip(
                        "\n\n".join(
                            part for part in [item.get("title"), item.get("procedure")] if part
                        )
                    )
                    meta = {
                        "trigger": item.get("trigger"),
                        "verification": item.get("verification"),
                        "boundary": item.get("boundary"),
                        "gain": item.get("gain"),
                        "support": item.get("support"),
                        "status": item.get("status"),
                    }
                else:
                    body = self._clip(item.get("body"))
                    meta = {
                        "title": item.get("title"),
                        "policyIds": item.get("policyIds") or [],
                    }
                return json.dumps(
                    {
                        "found": True,
                        "kind": kind,
                        "id": item.get("id", item_id),
                        "body": body,
                        "meta": meta,
                    }
                )
            if tool_name == "memos_timeline":
                resp = self._bridge_request_with_retry(
                    "memory.timeline",
                    {
                        "episodeId": args.get("episodeId", self._episode_id),
                        "namespace": self._runtime_namespace(),
                    },
                )
                limit = self._int_arg(args, "limit", 20, 1, 100)
                traces = resp.get("traces", [])[:limit]
                if traces:
                    self._remember_direct_memory(
                        str(args.get("episodeId", self._episode_id)),
                        "episode",
                    )
                return json.dumps({"traces": traces})
            if tool_name == "memos_skill_list":
                limit = self._int_arg(args, "limit", 10, 1, 50)
                params = {"limit": limit, "namespace": self._runtime_namespace()}
                if args.get("status"):
                    params["status"] = args["status"]
                return json.dumps(self._bridge_request_with_retry("skill.list", params))
            if tool_name == "memos_environment":
                query = (args.get("query") or "").strip()
                limit = self._int_arg(args, "limit", 5, 1, 30)
                if not query:
                    resp = self._bridge_request_with_retry(
                        "memory.list_world_models",
                        {"limit": limit, "offset": 0, "namespace": self._runtime_namespace()},
                    )
                    world_models = resp.get("worldModels", [])
                    self._remember_retrieval_hits([
                        {
                            "refId": world.get("id"),
                            "refKind": "world-model",
                            "score": world.get("confidence", 0.5),
                        }
                        for world in world_models
                        if isinstance(world, dict)
                    ])
                    return json.dumps(
                        {
                            "worldModels": [
                                {
                                    **w,
                                    "body": self._clip(w.get("body")),
                                }
                                for w in world_models
                            ],
                            "queried": False,
                        }
                    )
                resp = self._bridge_request_with_retry(
                    "memory.search",
                    {
                        "agent": "hermes",
                        "namespace": self._runtime_namespace(),
                        "query": query,
                        "topK": {"tier1": 0, "tier2": 0, "tier3": limit},
                    },
                    timeout=_LONG_RPC_TIMEOUT,
                )
                hits = [
                    h
                    for h in resp.get("hits", [])
                    if h.get("tier") == 3 or h.get("refKind") == "world_model"
                ]
                self._remember_retrieval_hits(hits[:limit])
                self._acknowledge_retrieval(resp, "hermes.environment", hits[:limit])
                return json.dumps(
                    {
                        "worldModels": [
                            {
                                "id": h.get("refId") or h.get("id"),
                                "title": self._clip((h.get("snippet") or "").split("\n")[0]),
                                "body": self._clip(h.get("snippet")),
                                "policyIds": [],
                                "score": h.get("score"),
                            }
                            for h in hits[:limit]
                        ],
                        "queried": True,
                    }
                )
            if tool_name == "memos_skill_get":
                skill_id = (args.get("id") or "").strip()
                if not skill_id:
                    return json.dumps({"error": "missing id"})
                skill = self._bridge_request_with_retry(
                    "skill.get",
                    {
                        "id": skill_id,
                        "namespace": self._runtime_namespace(),
                        "recordTrial": True,
                        "sessionId": self._session_id,
                        "episodeId": self._episode_id or None,
                    },
                )
                if skill:
                    self._remember_direct_memory(
                        str(skill.get("id") or skill_id),
                        "skill",
                    )
                return json.dumps({"found": bool(skill), "skill": skill})
        except Exception as err:
            return json.dumps({"error": str(err)})
        return json.dumps({"error": f"unknown tool: {tool_name}"})

    # ─── Config schema (for `hermes memory setup`) ────────────────────────

    def get_config_schema(self) -> list[dict[str, Any]]:  # type: ignore[override]
        """Fields the host's `hermes memory setup` wizard will collect.

        Secrets go to .env; everything else to the provider config file
        written by ``save_config``.
        """
        return [
            {
                "key": "viewer_port",
                "description": "Local HTTP port for the PigMemory viewer.",
                "default": 18910,
                "required": False,
            },
            {
                "key": "llm_provider",
                "description": "LLM for V7 reward / l2.induction / l3.abstraction.",
                "choices": ["openai_compatible", "anthropic", "gemini", "host", "local_only"],
                "default": "openai_compatible",
                "required": False,
            },
            {
                "key": "llm_api_key",
                "description": "API key for the chosen LLM provider.",
                "secret": True,
                "env_var": "MEMOS_LLM_API_KEY",
                "required": False,
            },
            {
                "key": "embedding_provider",
                "description": "Embedding provider (local = MiniLM on-device).",
                "choices": [
                    "local",
                    "openai_compatible",
                    "gemini",
                    "cohere",
                    "voyage",
                    "mistral",
                ],
                "default": "local",
                "required": False,
            },
        ]

    def save_config(self, values: dict[str, Any], hermes_home: str) -> None:  # type: ignore[override]
        """Write non-secret config to `<hermes_home>/memos-plugin/config.yaml`."""
        if not hermes_home:
            return
        import yaml  # lazy import — hermes already ships pyyaml

        target_dir = Path(hermes_home) / "memos-plugin"
        target_dir.mkdir(parents=True, exist_ok=True)
        target = target_dir / "config.yaml"

        payload: dict[str, Any] = {"version": 1}
        if "viewer_port" in values:
            payload["viewer"] = {"port": int(values["viewer_port"])}
        if "llm_provider" in values:
            llm: dict[str, Any] = {"provider": values["llm_provider"]}
            if values.get("llm_provider") != "local_only":
                llm["apiKey"] = ""
            payload["llm"] = llm
        if "embedding_provider" in values:
            payload["embedding"] = {"provider": values["embedding_provider"]}

        target.write_text(yaml.safe_dump(payload, sort_keys=False), encoding="utf-8")
        target.chmod(0o600)

    # ─── Session-end ──────────────────────────────────────────────────────

    def on_session_end(self, messages: list[dict[str, Any]]) -> None:  # type: ignore[override]
        with self._state_lock:
            self._last_injected_context = ""
            self._active_turn_key = ""
        with self._interview_lock:
            self._cancel_pending_review_locked("session_ended")
        if not self._bridge:
            return
        # `sync_turn` already flushed completed turn data synchronously.
        # Closing the host session is not the same as ending the topic:
        # the core will pause or finalize the open episode according to
        # topic-boundary rules so interrupted Hermes sessions can resume
        # into the same task later.
        #
        # Fire session.close in a daemon thread — the response is unused, so
        # this is semantically fire-and-forget. Calling urlopen() inline blocks
        # the asyncio event loop (gateway/run.py calls us synchronously from
        # _handle_reset_command) and causes Discord heartbeat timeouts when the
        # bridge is unresponsive. 5 s timeout keeps it bounded.
        _sid = self._session_id
        if not _sid or self._session_close_requested_for == _sid:
            return
        self._session_close_requested_for = _sid

        def _close() -> None:
            try:
                self._bridge_request(
                    "session.close",
                    {"sessionId": _sid},
                    timeout=5.0,
                )
            except Exception as err:
                if self._session_close_requested_for == _sid:
                    self._session_close_requested_for = ""
                logger.debug("MemOS: session.close failed session=%s — %s", _sid, err)

        self._session_close_thread = threading.Thread(
            target=_close,
            daemon=True,
            name="memos-session-close",
        )
        self._session_close_thread.start()

    def __del__(self) -> None:
        # Safety net — if shutdown() was never called (e.g. caller forgot,
        # Hermes agent routed model change with self.agent = None), clean
        # up the bridge subprocess and keepalive thread on GC.
        if self._bridge is not None or (
            self._bridge_keepalive_thread is not None and self._bridge_keepalive_thread.is_alive()
        ) or (
            self._proactive_thread is not None and self._proactive_thread.is_alive()
        ) or (
            self._location_thread is not None and self._location_thread.is_alive()
        ):
            logger.warning(
                "MemOS: __del__ cleaning up leaked provider — shutdown() was never called"
            )
            with contextlib.suppress(Exception):
                self.shutdown()

    def shutdown(self) -> None:  # type: ignore[override]
        with self._state_lock:
            self._last_injected_context = ""
            self._active_turn_key = ""
        with self._interview_lock:
            self._cancel_pending_review_locked("provider_shutdown")
        HERMES_HOOK_DISPATCHER.unbind(self)
        self._hook_registered = False
        self._bridge_keepalive_stop.set()
        self._proactive_stop.set()
        self._location_stop.set()
        if self._bridge_keepalive_thread and self._bridge_keepalive_thread.is_alive():
            self._bridge_keepalive_thread.join(
                timeout=12.0
            )  # Increased to cover health check timeout (10s) + margin
        if self._proactive_thread and self._proactive_thread.is_alive():
            self._proactive_thread.join(timeout=6.0)
        if self._location_thread and self._location_thread.is_alive():
            self._location_thread.join(timeout=6.0)
        if self._prefetch_thread and self._prefetch_thread.is_alive():
            self._prefetch_thread.join(timeout=5.0)
        if self._bridge:
            self.on_session_end([])
            close_thread = self._session_close_thread
            if close_thread is not None and close_thread.is_alive():
                close_thread.join(timeout=5.5)
            pid = getattr(self._bridge, "pid", "?")
            action = (
                "releasing shared bridge lease" if self._shared_bridge else "shutting down bridge"
            )
            logger.info("MemOS: %s (pid=%s session=%s)", action, pid, self._session_id)
            with contextlib.suppress(Exception):
                self._bridge.close()
            self._bridge = None
            self._bridge_generation = 0
            logger.info("MemOS: provider bridge shutdown complete (pid=%s)", pid)

    # ─── Host LLM bridge (fallback for plugin-side model failures) ────────

    def _handle_host_llm_complete(self, params: dict[str, Any]) -> dict[str, Any]:
        """Run a fallback LLM call using the host (hermes) agent's models.

        Wired into the bridge's reverse-RPC channel under the
        ``host.llm.complete`` method. Triggered when the plugin's
        configured summary or skill-evolver model fails — instead of
        bubbling the error straight up (which would stall the V7
        capture / reflection / skill pipeline), we replay the prompt
        through ``agent.auxiliary_client.call_llm`` so hermes' own
        provider stack (including its OpenRouter / Codex / custom
        endpoint resolution) handles it.

        If the host LLM also fails this raises, the bridge converts
        that into a JSON-RPC error, the LlmClient ``markFail``s, and
        the Overview card flips red — exactly matching the spec
        "if the agent's main model is also down, stop falling back
        and surface red".
        """
        messages = params.get("messages")
        if not isinstance(messages, list) or not messages:
            raise ValueError("host.llm.complete: missing messages")

        # Lazy imports — these pull in heavy deps (openai client,
        # credential pool, …) that we don't want to load until a
        # fallback is actually requested.
        try:
            from agent.auxiliary_client import call_llm  # type: ignore[import-not-found]
            from hermes_cli.runtime_provider import (  # type: ignore[import-not-found]
                resolve_runtime_provider,
            )
        except Exception as err:
            raise RuntimeError(f"host LLM bridge unavailable: {err}") from err

        # Resolve hermes' MAIN conversation provider so the fallback
        # uses exactly what the user configured for chat. Walking the
        # generic auxiliary auto-detect chain would otherwise depend
        # on env vars (`OPENROUTER_API_KEY`, `OPENAI_API_KEY`, …) that
        # often don't propagate into the bridge subprocess and would
        # leave us with no working credential. Pinning to the resolved
        # main runtime guarantees we hit the same endpoint the user
        # already authenticated for chat.
        try:
            runtime = resolve_runtime_provider()
        except Exception as err:
            raise RuntimeError(f"could not resolve hermes main runtime: {err}") from err

        main_runtime: dict[str, str] = {}
        for field in ("provider", "model", "base_url", "api_key", "api_mode"):
            value = runtime.get(field) if isinstance(runtime, dict) else None
            if isinstance(value, str) and value.strip():
                main_runtime[field] = value.strip()

        normalized = [
            {
                "role": str(m.get("role", "user")),
                "content": str(m.get("content", "")),
            }
            for m in messages
            if isinstance(m, dict)
        ]
        timeout_ms = params.get("timeoutMs")
        timeout_s: float | None = None
        if isinstance(timeout_ms, int | float) and timeout_ms > 0:
            timeout_s = float(timeout_ms) / 1000.0

        max_tokens = params.get("maxTokens")
        temperature = params.get("temperature")

        kwargs: dict[str, Any] = {
            "messages": normalized,
            # `main_runtime` makes `_resolve_auto` prefer the user's
            # main conversation provider + model over the generic auto
            # chain. If the user's main provider is also down,
            # `call_llm` raises — which is exactly the "agent's own
            # model is broken too, stop falling back" semantic we want
            # (red light on Overview).
            "main_runtime": main_runtime,
        }
        if isinstance(max_tokens, int | float) and max_tokens > 0:
            kwargs["max_tokens"] = int(max_tokens)
        if isinstance(temperature, int | float):
            kwargs["temperature"] = float(temperature)
        if timeout_s is not None:
            kwargs["timeout"] = timeout_s

        started = time.time()
        try:
            response = call_llm(**kwargs)
        except Exception as err:
            # Surface the original failure verbatim — the LlmClient
            # will tag this as a "host fallback failed" terminal error
            # and the Overview red-light path takes over.
            raise RuntimeError(f"host LLM call failed: {err}") from err

        # `call_llm` returns an OpenAI ChatCompletion-shaped object.
        # Pluck the assistant text + token usage defensively so a
        # non-standard host (e.g. Anthropic native) still produces a
        # populated response.
        text = ""
        model = ""
        usage_dict: dict[str, int] = {}
        try:
            choices = getattr(response, "choices", None) or response.get("choices", [])  # type: ignore[union-attr]
            if choices:
                first = choices[0]
                msg = getattr(first, "message", None) or first.get("message", {})  # type: ignore[union-attr]
                content = getattr(msg, "content", None) or msg.get("content", "")  # type: ignore[union-attr]
                text = str(content or "")
            model = (
                getattr(response, "model", None)
                or response.get("model", "")  # type: ignore[union-attr]
                or ""
            )
            u = getattr(response, "usage", None) or response.get("usage", None)  # type: ignore[union-attr]
            if u is not None:
                pt = getattr(u, "prompt_tokens", None)
                ct = getattr(u, "completion_tokens", None)
                tt = getattr(u, "total_tokens", None)
                if pt is None and isinstance(u, dict):
                    pt = u.get("prompt_tokens")
                    ct = u.get("completion_tokens")
                    tt = u.get("total_tokens")
                if isinstance(pt, int):
                    usage_dict["promptTokens"] = pt
                if isinstance(ct, int):
                    usage_dict["completionTokens"] = ct
                if isinstance(tt, int):
                    usage_dict["totalTokens"] = tt
        except Exception:
            logger.debug("host.llm.complete: shape parse failed", exc_info=True)

        result: dict[str, Any] = {
            "text": text,
            "model": str(model or ""),
            "durationMs": int((time.time() - started) * 1000),
        }
        if usage_dict:
            result["usage"] = usage_dict
        return result

    # ─── Internals ────────────────────────────────────────────────────────

    def _host_runtime_context(self) -> dict[str, str]:
        """Best-effort snapshot of Hermes' main conversation runtime."""
        try:
            from hermes_cli.runtime_provider import (  # type: ignore[import-not-found]
                resolve_runtime_provider,
            )

            runtime = resolve_runtime_provider()
        except Exception:
            return dict(self._last_host_runtime)

        out: dict[str, str] = {}
        if isinstance(runtime, dict):
            for source, target in (
                ("provider", "hostProvider"),
                ("model", "hostModel"),
                ("api_mode", "hostApiMode"),
                ("base_url", "hostBaseUrl"),
            ):
                value = runtime.get(source)
                if isinstance(value, str) and value.strip():
                    out[target] = value.strip()
        if out:
            self._last_host_runtime = dict(out)
        return out

    def _bridge_request(
        self,
        method: str,
        params: Any = None,
        *,
        timeout: float | None = None,
        ensure_session: bool = True,
    ) -> dict[str, Any]:
        bridge = self._bridge
        if bridge is None:
            raise BridgeError("transport_closed", "bridge is not connected")
        if ensure_session and isinstance(bridge, SharedBridgeLease):
            generation = bridge.generation
            if generation != self._bridge_generation:
                with self._session_open_lock:
                    if bridge.generation != self._bridge_generation:
                        logger.info(
                            "MemOS: reopening logical session after shared bridge generation "
                            "change runtime=%s old_generation=%d new_generation=%d session=%s",
                            bridge.runtime_id,
                            self._bridge_generation,
                            bridge.generation,
                            self._session_id,
                        )
                        self._open_session(self._session_id, timeout=30.0)
        if timeout is None:
            return bridge.request(method, params)
        return bridge.request(method, params, timeout=timeout)

    def _open_session(self, session_id: str = "", *, timeout: float = 30.0) -> None:
        bridge = self._bridge
        assert bridge is not None
        requested_session = session_id or self._session_id or ""
        host_runtime = self._host_runtime_context()
        resp = bridge.request(
            "session.open",
            {
                "agent": "hermes",
                "sessionId": requested_session,
                "namespace": self._runtime_namespace(),
                "meta": {
                    "hermesHome": self._hermes_home,
                    "platform": self._platform,
                    "agentIdentity": self._agent_identity,
                    "profileId": self._runtime_namespace()["profileId"],
                    "namespace": self._runtime_namespace(),
                    **host_runtime,
                },
            },
            timeout=timeout,
        )
        self._session_id = resp.get("sessionId") or requested_session
        if isinstance(bridge, SharedBridgeLease):
            self._bridge_generation = bridge.generation
        else:
            self._bridge_generation += 1

    def _bridge_request_with_retry(
        self,
        method: str,
        params: Any,
        *,
        timeout: float | None = None,
    ) -> dict[str, Any]:
        """Read-path helper: reconnect + retry once on ``transport_closed``.

        Layer 4 (#2028): the read-path memory tools previously issued a
        single ``self._bridge.request(...)`` and surfaced any error
        verbatim to the model. When the Node bridge has died since the
        last user turn, that first call now raises
        ``transport_closed`` fast (thanks to Layer 1/2). This helper
        mirrors the pattern ``sync_turn`` already uses: reconnect the
        bridge once and re-issue the same request. A second failure is
        left to propagate — the ``except`` block in
        ``handle_tool_call`` will surface the error text verbatim.
        """
        assert self._bridge is not None
        try:
            return self._bridge_request(method, params, timeout=timeout)
        except BridgeError as err:
            if not self._is_transport_closed(err):
                raise
            logger.info(
                "MemOS: bridge transport closed on %s; reconnecting and retrying once — %s",
                method,
                err,
            )
            self._reconnect_bridge(self._session_id, timeout=30.0)
            assert self._bridge is not None
            return self._bridge_request(method, params, timeout=timeout)

    def _is_transport_closed(self, err: Exception) -> bool:
        if isinstance(err, BridgeError) and err.code == "transport_closed":
            return True
        msg = str(err).lower()
        return "broken pipe" in msg or "bridge closed" in msg or "transport_closed" in msg

    def _should_reconnect_after_keepalive_failure(self, err: Exception) -> bool:
        """Decide whether a keepalive failure warrants a bridge reconnect.

        Layer 3 (#2028): the keepalive previously reconnected only on
        ``BridgeError("transport_closed", …)``. A hung Node bridge
        surfaces instead as ``BridgeError("timeout", …)`` (the client
        gave up waiting for a response); that error was dropped at
        DEBUG and the stale client kept being reused, so every
        subsequent memory tool timed out for another 30 s. Reconnect
        also when the subprocess has already exited (belt-and-braces
        for hangs that didn't raise a transport error).

        A live subprocess raising a generic (non-transport) error must
        NOT trigger a reconnect — otherwise transient parse noise
        would create a reconnect storm.
        """
        if self._is_transport_closed(err):
            return True
        if isinstance(err, BridgeError) and err.code == "timeout":
            return True
        # Ask the underlying subprocess: is it still alive?
        bridge = self._bridge
        if bridge is not None:
            try:
                exit_code = bridge._proc.poll()  # type: ignore[attr-defined]
            except Exception:
                exit_code = None
            if exit_code is not None:
                return True
        return False

    def _reconnect_bridge(self, session_id: str = "", *, timeout: float = 30.0) -> None:
        # Don't reconnect if we're shutting down
        if self._bridge_keepalive_stop.is_set():
            logger.debug("MemOS: skipping reconnect during shutdown")
            return

        with self._reconnect_lock:
            # Double-check after acquiring lock
            if self._bridge_keepalive_stop.is_set():
                logger.debug("MemOS: skipping reconnect during shutdown (after lock)")
                return

            if self._shared_bridge:
                bridge = self._bridge
                acquired_here = bridge is None
                if bridge is None:
                    if self._runtime_home is None:
                        self._runtime_home = _resolved_memos_runtime_home()
                        self._runtime_env = _memos_runtime_env_snapshot(self._runtime_home)
                    runtime_home = self._runtime_home
                    runtime_env = dict(self._runtime_env)
                    bridge = SHARED_BRIDGE_REGISTRY.acquire(
                        _shared_bridge_runtime_key(runtime_home),
                        client_factory=lambda home=str(runtime_home), env=runtime_env: (
                            MemosBridgeClient(
                                runtime_home=home,
                                extra_env=env,
                            )
                        ),
                        before_spawn=_prepare_shared_bridge,
                        host_handlers={
                            "host.llm.complete": self._handle_host_llm_complete,
                        },
                    )
                    self._bridge = bridge
                if not isinstance(bridge, SharedBridgeLease):
                    raise BridgeError(
                        "internal",
                        "shared bridge mode has a non-shared bridge handle",
                    )
                try:
                    if acquired_here:
                        # acquire() already ensures and health-checks the shared
                        # client. Open this logical session directly; restarting
                        # here would disrupt every healthy provider using it.
                        acquired_generation = bridge.generation
                        try:
                            self._open_session(session_id, timeout=timeout)
                        except Exception as err:
                            if not self._is_transport_closed(err):
                                raise
                            bridge.reconnect(expected_generation=acquired_generation)
                            self._open_session(session_id, timeout=timeout)
                    else:
                        expected_generation = self._bridge_generation or bridge.generation
                        bridge.reconnect(expected_generation=expected_generation)
                        self._open_session(session_id, timeout=timeout)
                except Exception:
                    if acquired_here:
                        with contextlib.suppress(Exception):
                            bridge.close()
                        if self._bridge is bridge:
                            self._bridge = None
                        self._bridge_generation = 0
                    raise
                logger.info(
                    "MemOS: shared bridge session recovered runtime=%s generation=%d "
                    "pid=%s session=%s",
                    bridge.runtime_id,
                    bridge.generation,
                    bridge.pid,
                    self._session_id,
                )
                return

            old_bridge = self._bridge
            old_pid = getattr(old_bridge, "pid", None) if old_bridge else None

            if old_bridge:
                logger.info("MemOS: closing old bridge (pid=%s)", old_pid)
                with contextlib.suppress(Exception):
                    old_bridge.close()
                logger.info("MemOS: old bridge closed (pid=%s)", old_pid)

            _prepare_shared_bridge(cleanup_legacy_zombies=True)
            new_bridge: MemosBridgeClient | None = None
            try:
                runtime_home = self._runtime_home or _resolved_memos_runtime_home()
                runtime_env = dict(self._runtime_env or _memos_runtime_env_snapshot(runtime_home))
                new_bridge = MemosBridgeClient(
                    runtime_home=str(runtime_home),
                    extra_env=runtime_env,
                )
                logger.info(
                    "MemOS: new bridge created (pid=%s)",
                    getattr(new_bridge, "pid", "?"),
                )

                new_bridge.register_host_handler(
                    "host.llm.complete",
                    self._handle_host_llm_complete,
                )
                self._bridge = new_bridge
                self._open_session(session_id, timeout=timeout)
            except Exception:
                if new_bridge is not None:
                    with contextlib.suppress(Exception):
                        new_bridge.close()
                if self._bridge is new_bridge:
                    self._bridge = None
                raise

    def _ensure_bridge(self, session_id: str = "", *, timeout: float = 30.0) -> bool:
        if self._bridge:
            return True
        try:
            self._reconnect_bridge(session_id or self._session_id, timeout=timeout)
            logger.info(
                "MemOS: bridge reconnected session=%s platform=%s",
                self._session_id,
                self._platform,
            )
            return True
        except Exception as err:
            logger.warning("MemOS: bridge reconnect failed — %s", err)
            return False

    def _start_bridge_keepalive(self) -> None:
        if self._shared_bridge:
            # SharedBridgeRuntime owns the only keepalive/reconnect loop.
            return
        if self._bridge_keepalive_thread and self._bridge_keepalive_thread.is_alive():
            return
        self._bridge_keepalive_stop.clear()

        _self_ref = weakref.ref(self)

        def _run() -> None:
            while True:
                # Stop signal set (e.g. shutdown called by another thread).
                # When self is garbage-collected the weakref resolves to None
                # and we exit gracefully instead of keeping the thread + bridge
                # subprocess alive forever.
                provider = _self_ref()
                if provider is None:
                    break
                if provider._bridge_keepalive_stop.wait(5.0):
                    break
                if not provider._ensure_bridge(provider._session_id, timeout=10.0):
                    continue
                try:
                    assert provider._bridge is not None
                    provider._bridge.request("core.health", {}, timeout=10.0)
                except Exception as err:
                    if provider._should_reconnect_after_keepalive_failure(err):
                        logger.info(
                            "MemOS: bridge keepalive reconnecting after failure — %s",
                            err,
                        )
                        with contextlib.suppress(Exception):
                            provider._reconnect_bridge(provider._session_id, timeout=10.0)
                    else:
                        logger.debug("MemOS: bridge keepalive failed — %s", err)

        self._bridge_keepalive_thread = threading.Thread(
            target=_run,
            daemon=True,
            name="memos-bridge-keepalive",
        )
        self._bridge_keepalive_thread.start()

    def _start_proactive_worker(self) -> None:
        """Wake at the configured local send time and claim the outbox once."""
        sender = self._feishu_proactive
        if sender is None or not sender.configured or not self._chat_id:
            return
        if self._proactive_thread and self._proactive_thread.is_alive():
            return
        self._proactive_stop.clear()
        _self_ref = weakref.ref(self)

        def _run() -> None:
            retry_delay = 15.0
            while True:
                provider = _self_ref()
                if provider is None or provider._proactive_stop.is_set():
                    break
                try:
                    if not provider._ensure_bridge(provider._session_id, timeout=10.0):
                        if provider._proactive_stop.wait(retry_delay):
                            break
                        retry_delay = min(300.0, retry_delay * 2)
                        continue
                    config = provider._bridge_request(
                        "config.get",
                        {},
                        timeout=10.0,
                    )
                    profile_config = (
                        config.get("userProfile", {})
                        if isinstance(config, dict)
                        else {}
                    )
                    proactive_config = (
                        profile_config.get("proactiveInteraction", {})
                        if isinstance(profile_config, dict)
                        else {}
                    )
                    if not bool(profile_config.get("enabled", False)) or not bool(
                        proactive_config.get("enabled", False)
                    ):
                        logger.info(
                            "PigMemory: proactive Feishu schedule disabled; worker stopped"
                        )
                        break

                    send_time = str(proactive_config.get("sendTime", "09:30"))
                    schedule_config = profile_config.get("schedule", {})
                    timezone_name = (
                        str(schedule_config.get("timezone", "Asia/Shanghai"))
                        if isinstance(schedule_config, dict)
                        else "Asia/Shanghai"
                    )

                    # One startup claim recovers an eligible message if Hermes
                    # was offline at send time. Otherwise this is an inexpensive
                    # local no-op, followed by one sleep until the next due time.
                    claim = provider._bridge_request(
                        "user_profile.claim",
                        {
                            "namespace": provider._runtime_namespace(),
                            "subjectId": provider._user_profile_subject_id(),
                            "channel": "feishu",
                            "targetId": provider._chat_id,
                        },
                        timeout=15.0,
                    )
                    if isinstance(claim, dict) and isinstance(claim.get("interaction"), dict):
                        interaction = claim["interaction"]
                        claim_token = str(claim.get("claimToken") or "")
                        interaction_id = str(interaction.get("id") or "")
                        message = str(interaction.get("message") or "").strip()
                        if interaction_id and claim_token and message:
                            provider._deliver_proactive_interaction(
                                interaction_id=interaction_id,
                                claim_token=claim_token,
                                message=message,
                            )
                    delay = _seconds_until_daily_time(send_time, timezone_name)
                    retry_delay = 15.0
                    logger.debug(
                        "PigMemory: next proactive Feishu wake in %.0fs at %s (%s)",
                        delay,
                        send_time,
                        timezone_name,
                    )
                except Exception as err:
                    logger.warning(
                        "PigMemory: proactive scheduler failed; retrying in %.0fs — %s",
                        retry_delay,
                        err,
                    )
                    delay = retry_delay
                    retry_delay = min(300.0, retry_delay * 2)
                if provider._proactive_stop.wait(delay):
                    break

        self._proactive_thread = threading.Thread(
            target=_run,
            daemon=True,
            name="pigmemory-proactive-scheduler",
        )
        self._proactive_thread.start()

    def _deliver_proactive_interaction(
        self,
        *,
        interaction_id: str,
        claim_token: str,
        message: str,
    ) -> None:
        sender = self._feishu_proactive
        if sender is None:
            return
        try:
            external_id = sender.send_text(chat_id=self._chat_id, text=message)
        except Exception as err:
            with contextlib.suppress(Exception):
                self._bridge_request(
                    "user_profile.mark",
                    {
                        "id": interaction_id,
                        "claimToken": claim_token,
                        "status": "failed",
                        "error": str(err),
                    },
                    timeout=15.0,
                )
            logger.warning("PigMemory: proactive Feishu delivery failed — %s", err)
            return

        # Persist delivery before polling again. Retry the acknowledgement so
        # a transient bridge reconnect does not turn a successful external
        # send into a duplicate claim.
        last_error: Exception | None = None
        for _attempt in range(3):
            try:
                marked = self._bridge_request_with_retry(
                    "user_profile.mark",
                    {
                        "id": interaction_id,
                        "claimToken": claim_token,
                        "status": "sent",
                        "externalMessageId": external_id,
                    },
                    timeout=20.0,
                )
                if not isinstance(marked, dict) or marked.get("status") != "sent":
                    raise RuntimeError("proactive delivery acknowledgement was rejected")
                logger.info(
                    "PigMemory: proactive Feishu message sent interaction=%s message=%s",
                    interaction_id,
                    external_id,
                )
                return
            except Exception as err:
                last_error = err
                if self._proactive_stop.wait(1.0):
                    return
        logger.error(
            "PigMemory: proactive message sent but acknowledgement failed interaction=%s — %s",
            interaction_id,
            last_error,
        )

    def _start_location_worker(self) -> None:
        """Poll the deterministic semantic-location outbox while Feishu is live."""
        sender = self._feishu_proactive
        if sender is None or not sender.configured or not self._chat_id:
            return
        if self._location_thread and self._location_thread.is_alive():
            return
        self._location_stop.clear()
        _self_ref = weakref.ref(self)

        def _run() -> None:
            retry_delay = 15.0
            while True:
                provider = _self_ref()
                if provider is None or provider._location_stop.is_set():
                    break
                delay = 60.0
                try:
                    if not provider._ensure_bridge(provider._session_id, timeout=10.0):
                        delay = retry_delay
                        retry_delay = min(300.0, retry_delay * 2)
                    else:
                        config = provider._bridge_request("config.get", {}, timeout=10.0)
                        profile = config.get("userProfile", {}) if isinstance(config, dict) else {}
                        location = profile.get("location", {}) if isinstance(profile, dict) else {}
                        enabled = bool(profile.get("enabled", False)) and bool(
                            location.get("enabled", False)
                        )
                        if enabled:
                            claim = provider._bridge_request(
                                "location.claim",
                                {"channel": "feishu", "targetId": provider._chat_id},
                                timeout=15.0,
                            )
                            if isinstance(claim, dict) and isinstance(
                                claim.get("notification"), dict
                            ):
                                notification = claim["notification"]
                                claim_token = str(claim.get("claimToken") or "")
                                if claim_token:
                                    provider._deliver_location_notification(
                                        notification=notification,
                                        claim_token=claim_token,
                                    )
                            delay = 15.0
                        retry_delay = 15.0
                except Exception as err:
                    logger.warning(
                        "PigMemory: location notification worker failed; retrying in %.0fs — %s",
                        retry_delay,
                        err,
                    )
                    delay = retry_delay
                    retry_delay = min(300.0, retry_delay * 2)
                if provider._location_stop.wait(delay):
                    break

        self._location_thread = threading.Thread(
            target=_run,
            daemon=True,
            name="pigmemory-location-notifications",
        )
        self._location_thread.start()

    def _deliver_location_notification(
        self,
        *,
        notification: dict[str, Any],
        claim_token: str,
    ) -> None:
        sender = self._feishu_proactive
        notification_id = str(notification.get("id") or "")
        message = str(notification.get("message") or "").strip()
        kind = str(notification.get("kind") or "")
        if sender is None or not notification_id or not message:
            return
        try:
            if kind == "name_prompt":
                external_id = sender.send_card(
                    chat_id=self._chat_id,
                    card=build_location_name_card(content=message),
                )
            else:
                external_id = sender.send_text(chat_id=self._chat_id, text=message)
        except Exception as err:
            with contextlib.suppress(Exception):
                self._bridge_request(
                    "location.mark",
                    {
                        "id": notification_id,
                        "claimToken": claim_token,
                        "status": "failed",
                        "error": str(err),
                    },
                    timeout=15.0,
                )
            logger.warning("PigMemory: location notification delivery failed — %s", err)
            return

        last_error: Exception | None = None
        for _attempt in range(3):
            try:
                marked = self._bridge_request_with_retry(
                    "location.mark",
                    {
                        "id": notification_id,
                        "claimToken": claim_token,
                        "status": "sent",
                        "externalMessageId": external_id,
                    },
                    timeout=20.0,
                )
                if not isinstance(marked, dict) or marked.get("status") != "sent":
                    raise RuntimeError("location delivery acknowledgement was rejected")
                logger.info(
                    "PigMemory: location notification sent notification=%s message=%s",
                    notification_id,
                    external_id,
                )
                return
            except Exception as err:
                last_error = err
                if self._location_stop.wait(1.0):
                    return
        logger.error(
            "PigMemory: location notification sent but acknowledgement failed notification=%s — %s",
            notification_id,
            last_error,
        )

    def _turn_start(self, query: str, *, session_id: str = "") -> str:
        assert self._bridge is not None
        host_runtime = self._host_runtime_context()
        with self._state_lock:
            turn_key = self._active_turn_key
        payload: dict[str, Any] = {
            "agent": "hermes",
            "namespace": self._runtime_namespace(),
            "sessionId": session_id or self._session_id,
            "userText": query,
            "contextHints": {
                "agentIdentity": self._agent_identity,
                "namespace": self._runtime_namespace(),
                "userProfileSubjectId": self._user_profile_subject_id(),
                "userProfileSubjectLabel": self._user_id or self._user_id_alt or "",
                "platform": self._platform,
                **host_runtime,
            },
            "ts": int(time.time() * 1000),
        }
        if turn_key:
            payload["turnKey"] = turn_key
        resp = self._bridge_request_with_retry(
            "turn.start",
            payload,
            timeout=_LONG_RPC_TIMEOUT,
        )
        response_query = (resp or {}).get("query") or {}
        response_session = str(response_query.get("sessionId") or "")
        requested_session = str(payload["sessionId"])
        if response_session and response_session != requested_session:
            raise BridgeError(
                "session_mismatch",
                "turn.start returned a different session "
                f"(requested={requested_session}, returned={response_session})",
            )
        # Stash the real episode id the pipeline auto-created (V7
        # §0.1 may have boundary-cut the previous episode and started
        # a new one). `on_session_end` uses it to close the right
        # episode — see the "Episode tracking" comment block above.
        new_eid = response_query.get("episodeId") or ""
        if new_eid and new_eid != self._episode_id:
            self._episode_id = new_eid
            logger.debug("MemOS: stashed episode %s from turn.start", new_eid)
        context = (resp or {}).get("injectedContext") or ""
        hits = (resp or {}).get("hits", [])
        self._remember_retrieval_hits(hits)
        self._acknowledge_retrieval(resp, "hermes.turn_start", hits)
        profile_context = ""
        try:
            profile_resp = self._bridge_request_with_retry(
                "user_profile.context",
                {
                    "namespace": self._runtime_namespace(),
                    "subjectId": self._user_profile_subject_id(),
                },
                timeout=15.0,
            )
            profile_context = str((profile_resp or {}).get("context") or "")
        except Exception as err:
            logger.debug("PigMemory: user profile context unavailable — %s", err)
        parts: list[str] = []
        if context:
            parts.append(f"## Recalled Memories\n{context}")
        if profile_context:
            parts.append(profile_context)
        return "\n\n".join(parts)

    def _remember_retrieval_hits(
        self,
        hits: Any,
        *,
        direct: bool = False,
    ) -> None:
        """Keep only memories actually delivered to the current model turn."""
        if not isinstance(hits, list):
            return
        with self._interview_lock:
            for hit in hits:
                if not isinstance(hit, dict):
                    continue
                ref_id = str(hit.get("refId") or hit.get("id") or "").strip()
                if not ref_id:
                    continue
                ref_kind = str(hit.get("refKind") or hit.get("kind") or "trace").strip()
                if ref_kind == "world_model":
                    ref_kind = "world-model"
                raw_score = 1.0 if direct else hit.get("score", hit.get("relevance", 0))
                try:
                    relevance = max(0.0, min(1.0, float(raw_score)))
                except (TypeError, ValueError):
                    relevance = 1.0 if direct else 0.0
                key = f"{ref_kind}:{ref_id}"
                existing = self._turn_memory_refs.get(key)
                if existing is None or relevance > float(existing.get("relevance") or 0):
                    self._turn_memory_refs[key] = {
                        "refId": ref_id,
                        "refKind": ref_kind,
                        "relevance": relevance,
                    }

    def _remember_direct_memory(self, ref_id: str, ref_kind: str) -> None:
        self._remember_retrieval_hits(
            [{"refId": ref_id, "refKind": ref_kind, "score": 1.0}],
            direct=True,
        )

    def _acknowledge_retrieval(
        self,
        response: dict[str, Any] | None,
        source: str,
        hits: list[dict[str, Any]] | None,
    ) -> None:
        """Confirm only the memory ids this adapter actually assembled."""
        run_id = str((response or {}).get("retrievalRunId") or "")
        if not run_id or not self._bridge:
            return
        query = (response or {}).get("query") or {}
        delivered = [
            str(hit.get("refId") or hit.get("id") or "")
            for hit in (hits or [])
            if isinstance(hit, dict) and (hit.get("refId") or hit.get("id"))
        ]
        try:
            self._bridge_request(
                "retrieval.acknowledge",
                {
                    "retrievalRunId": run_id,
                    "source": source,
                    "sessionId": query.get("sessionId") or self._session_id,
                    "episodeId": query.get("episodeId") or self._episode_id,
                    "turnId": self._turn_number,
                    "deliveredRefIds": delivered,
                },
                timeout=10.0,
            )
        except Exception as err:
            logger.warning("MemOS: retrieval acknowledgement failed — %s", err)

    def _turn_end(
        self,
        user_content: str,
        assistant_content: str,
        tool_calls: list[dict[str, Any]],
        ts_ms: int,
        *,
        agent_thinking: str = "",
    ) -> str:
        if not self._bridge:
            return ""
        # Strip private book-keeping fields before sending.
        clean_tool_calls = [
            {k: v for k, v in tc.items() if k not in {"_id", "_ids"}} for tc in tool_calls
        ]
        payload: dict[str, Any] = {
            "agent": "hermes",
            "namespace": self._runtime_namespace(),
            "sessionId": self._session_id,
            "episodeId": self._episode_id,
            "agentText": assistant_content,
            "userText": user_content,
            "toolCalls": clean_tool_calls,
            "contextHints": {
                "agentIdentity": self._agent_identity,
                "namespace": self._runtime_namespace(),
                "userProfileSubjectId": self._user_profile_subject_id(),
                "userProfileSubjectLabel": self._user_id or self._user_id_alt or "",
                "platform": self._platform,
                **self._host_runtime_context(),
            },
            "ts": ts_ms,
        }
        if agent_thinking:
            payload["agentThinking"] = agent_thinking
        result = self._bridge_request("turn.end", payload, timeout=_LONG_RPC_TIMEOUT)
        # ``turn.end`` returns a singular ``traceId`` in the current bridge
        # contract.  Keep accepting the older ``traceIds`` array so installed
        # adapters remain compatible with either bridge shape.
        if result and isinstance(result, dict):
            trace_id = result.get("traceId")
            if not isinstance(trace_id, str) or not trace_id:
                trace_ids = result.get("traceIds", [])
                trace_id = (
                    trace_ids[-1]
                    if isinstance(trace_ids, list)
                    and trace_ids
                    and isinstance(trace_ids[-1], str)
                    else ""
                )
            if trace_id:
                self._last_trace_id = trace_id
                return trace_id
        return ""

    def _try_submit_verifier_feedback(
        self,
        user_content: str,
        assistant_content: str,
        ts_ms: int,
        *,
        trace_id: str = "",
        fallback: bool = False,
    ) -> bool:
        try:
            submitted = self._submit_verifier_feedback(
                user_content,
                assistant_content,
                ts_ms,
                trace_id=trace_id,
            )
            if submitted and fallback:
                logger.info("MemOS: submitted verifier feedback without trace binding")
            return submitted
        except Exception as err:
            logger.warning("MemOS: verifier feedback submit failed — %s", err)
            return False

    def _submit_verifier_feedback(
        self,
        user_content: str,
        assistant_content: str,
        ts_ms: int,
        *,
        trace_id: str = "",
    ) -> bool:
        if not self._bridge or not self._episode_id:
            return False
        polarity = _feedback_polarity(user_content)
        magnitude = _feedback_magnitude(user_content, polarity)
        raw = {
            "source": "hermes.verifier_feedback",
            "userText": user_content,
            "assistantText": assistant_content,
            "polarity": polarity,
        }
        payload: dict[str, Any] = {
            "episodeId": self._episode_id,
            "channel": "explicit",
            "polarity": polarity,
            "magnitude": magnitude,
            "rationale": user_content,
            "raw": raw,
            "ts": ts_ms,
        }
        if trace_id:
            payload["traceId"] = trace_id
        self._bridge_request("feedback.submit", payload, timeout=_LONG_RPC_TIMEOUT)
        return True


# ─── Discovery entry points ───────────────────────────────────────────────


# Pattern 1: `register(ctx)` — preferred by `plugins/memory/__init__.py`.
def register(ctx: Any) -> None:
    """hermes-agent plugin entry point."""
    ctx.register_memory_provider(MemTensorProvider())


# Pattern 2: exported class — fallback via `issubclass(MemoryProvider)`.
__all__ = ["PLUGIN_ID", "PLUGIN_VERSION", "MemTensorProvider", "register"]
