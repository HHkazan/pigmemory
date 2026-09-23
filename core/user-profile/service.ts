import type {
  ProactiveInteractionDTO,
  RuntimeNamespace,
  UserDailyMemoryDTO,
  UserProfileFactDTO,
  UserProfileSnapshotDTO,
  UserProfileSubjectDTO,
} from "../../agent-contract/dto.js";
import { ids } from "../id.js";
import type { ResolvedConfig, ResolvedHome } from "../config/index.js";
import { loadConfig } from "../config/index.js";
import type { LlmClient } from "../llm/types.js";
import type { Logger } from "../logger/types.js";
import { normalizeNamespace, ownerFromNamespace } from "../runtime/namespace.js";
import type { Repos } from "../storage/repos/index.js";
import type {
  ProactiveInteractionRow,
  UserContextInboxRow,
  UserDailyMemoryRow,
  UserProfileExtraction,
  UserProfileFactRow,
  UserProfileOwnerSubject,
} from "./types.js";
import { addLocalDays, isTimeAtOrAfter, isWithinQuietHours, zonedClock } from "./time.js";

const PROFILE_DIMENSIONS = new Set([
  "personality",
  "communication_style",
  "work_style",
  "interest",
  "long_term_goal",
  "habit",
  "boundary",
  "other",
]);
const EVENT_KINDS = new Set(["activity", "decision", "plan", "commitment", "emotion", "other"]);
const EVENT_STATES = new Set(["observed", "open", "done", "cancelled", "unknown"]);
const DAY_MS = 24 * 60 * 60_000;

export interface UserProfileService {
  start(): void;
  stop(): void;
  captureTurn(input: {
    namespace: RuntimeNamespace;
    subjectId?: string;
    sessionId: string;
    episodeId?: string | null;
    traceId?: string | null;
    userText: string;
    agentText: string;
    ts: number;
    context?: Record<string, unknown>;
  }): Promise<boolean>;
  context(namespace: RuntimeNamespace, subjectId?: string): Promise<string>;
  snapshot(namespace: RuntimeNamespace, subjectId?: string): Promise<UserProfileSnapshotDTO>;
  subjects(namespace: RuntimeNamespace): Promise<UserProfileSubjectDTO[]>;
  daily(namespace: RuntimeNamespace, input: { subjectId?: string; fromDate?: string; toDate?: string; limit?: number }): Promise<UserDailyMemoryDTO[]>;
  proactive(namespace: RuntimeNamespace, subjectId?: string, limit?: number): Promise<ProactiveInteractionDTO[]>;
  updateFact(namespace: RuntimeNamespace, id: string, patch: { dimension?: string; claim?: string; confidence?: number; status?: "active" | "archived" }): Promise<UserProfileFactDTO | null>;
  deleteFact(namespace: RuntimeNamespace, id: string): Promise<boolean>;
  runNow(input?: { namespace?: RuntimeNamespace; subjectId?: string; memoryDate?: string }): Promise<UserProfileRunSummary>;
  claimDue(input: { namespace: RuntimeNamespace; subjectId?: string; channel: string; targetId: string }): Promise<{ interaction: ProactiveInteractionDTO; claimToken: string } | null>;
  markDelivery(input: { id: string; claimToken: string; status: "sent" | "failed" | "skipped"; externalMessageId?: string; error?: string }): Promise<ProactiveInteractionDTO | null>;
}

export interface UserProfileRunSummary {
  processed: number;
  skipped: number;
  failed: number;
  dates: string[];
}

export function createUserProfileService(deps: {
  repos: Pick<Repos, "userProfile">;
  llm: LlmClient | null;
  home: ResolvedHome;
  defaultNamespace: RuntimeNamespace;
  config: ResolvedConfig;
  log: Logger;
  now?: () => number;
  readConfig?: () => Promise<ResolvedConfig>;
}): UserProfileService {
  const repo = deps.repos.userProfile;
  const now = deps.now ?? Date.now;
  const log = deps.log.child({ channel: "core.user-profile" });
  let timer: ReturnType<typeof setInterval> | null = null;
  let stopped = false;
  let running: Promise<UserProfileRunSummary> | null = null;
  let lastScheduledCleanupDate: string | null = null;

  async function config(): Promise<ResolvedConfig> {
    if (deps.readConfig) return deps.readConfig();
    try {
      return (await loadConfig(deps.home)).config;
    } catch (err) {
      log.warn("config.reload_failed", { err: messageOf(err) });
      return deps.config;
    }
  }

  function start(): void {
    if (timer || stopped) return;
    timer = setInterval(() => {
      void tick(false).catch((err) => log.warn("schedule.tick_failed", { err: messageOf(err) }));
    }, 60_000);
    timer.unref?.();
    void tick(true).catch((err) => log.warn("schedule.startup_failed", { err: messageOf(err) }));
  }

  function stop(): void {
    stopped = true;
    if (timer) clearInterval(timer);
    timer = null;
  }

  async function tick(startup: boolean): Promise<UserProfileRunSummary> {
    const cfg = await config();
    const clock = zonedClock(now(), cfg.userProfile.schedule.timezone);
    const due = isTimeAtOrAfter(clock.time, cfg.userProfile.schedule.time);

    // Retention is independent of the profile privacy and consolidation
    // switches. Existing processed rows still expire when capture is off.
    if (startup) cleanupInbox(cfg);
    if (!cfg.userProfile.enabled || !cfg.userProfile.schedule.enabled) {
      if (due) scheduledCleanup(clock.date, cfg);
      return emptyRun();
    }
    if (!due && !(startup && cfg.userProfile.schedule.catchUpOnStartup)) return emptyRun();
    const maxDate = due ? clock.date : addLocalDays(clock.date, -1);
    try {
      return await runOnce({ maxDate, cfg });
    } finally {
      if (due) scheduledCleanup(clock.date, cfg);
    }
  }

  function scheduledCleanup(localDate: string, cfg: ResolvedConfig): void {
    if (lastScheduledCleanupDate === localDate) return;
    if (cleanupInbox(cfg)) lastScheduledCleanupDate = localDate;
  }

  function cleanupInbox(cfg: ResolvedConfig): boolean {
    const processedBefore = now() - cfg.userProfile.inboxRetentionDays * DAY_MS;
    let deleted: number;
    try {
      deleted = repo.deleteProcessedInboxBefore(processedBefore);
    } catch (err) {
      log.warn("inbox.cleanup_failed", {
        processedBefore,
        retentionDays: cfg.userProfile.inboxRetentionDays,
        err: messageOf(err),
      });
      return false;
    }
    if (deleted === 0) return true;
    log.info("inbox.cleanup_completed", {
      deleted,
      processedBefore,
      retentionDays: cfg.userProfile.inboxRetentionDays,
    });
    try {
      repo.checkpointWalTruncate();
    } catch (err) {
      log.warn("inbox.checkpoint_failed", { deleted, err: messageOf(err) });
    }
    return true;
  }

  async function runOnce(input: {
    maxDate: string;
    cfg: ResolvedConfig;
    namespace?: RuntimeNamespace;
    subjectId?: string;
    exactDate?: string;
  }): Promise<UserProfileRunSummary> {
    if (running) return running;
    running = (async () => {
      const summary = emptyRun();
      if (!input.cfg.userProfile.enabled) return summary;
      const pending = repo.pendingDatesThrough(input.maxDate).filter((item) => {
        if (input.exactDate && item.memoryDate !== input.exactDate) return false;
        if (input.subjectId && item.subjectId !== normalizeSubject(input.subjectId)) return false;
        if (input.namespace) {
          const owner = ownerFromNamespace(input.namespace);
          return item.ownerAgentKind === owner.ownerAgentKind && item.ownerProfileId === owner.ownerProfileId;
        }
        return true;
      });
      for (const item of pending) {
        try {
          const outcome = await consolidate(item, input.cfg);
          if (outcome) {
            summary.processed++;
            summary.dates.push(item.memoryDate);
          } else {
            summary.skipped++;
          }
        } catch (err) {
          summary.failed++;
          log.warn("consolidation.failed", {
            ownerAgentKind: item.ownerAgentKind,
            ownerProfileId: item.ownerProfileId,
            subjectId: item.subjectId,
            memoryDate: item.memoryDate,
            err: messageOf(err),
          });
        }
      }
      return summary;
    })().finally(() => { running = null; });
    return running;
  }

  async function consolidate(
    item: UserProfileOwnerSubject & { memoryDate: string },
    cfg: ResolvedConfig,
  ): Promise<boolean> {
    const startedAt = now();
    if (!repo.acquireJob(item, startedAt)) return false;
    try {
      if (!deps.llm) throw new Error("user-profile consolidation requires an available LLM");
      const rows = limitRowsByChars(
        repo.listPending({ ...item, limit: 500 }),
        cfg.userProfile.maxBatchChars,
      );
      if (rows.length === 0) {
        repo.finishJob(item, { model: deps.llm.model, stats: { inboxRows: 0 } }, now());
        return false;
      }
      const previous = repo.getDaily(item);
      const prompt = buildPrompt(item.memoryDate, rows, previous, cfg.userProfile.maxBatchChars);
      const completion = await deps.llm.completeJson<unknown>(prompt, {
        op: "user-profile.consolidate",
        phase: "nightly",
        temperature: 0,
        maxTokens: 5_000,
        timeoutMs: Math.max(60_000, cfg.llm.timeoutMs),
        malformedRetries: 2,
        schemaHint: USER_PROFILE_SCHEMA_HINT,
      });
      const extracted = normalizeExtraction(
        completion.value,
        new Set([...(previous?.sourceInboxIds ?? []), ...rows.map((row) => row.id)]),
      );
      const completedAt = now();
      persistExtraction(item, rows, previous, extracted, cfg, completedAt);
      repo.markProcessed(rows.map((row) => row.id), completedAt);
      repo.finishJob(item, {
        model: completion.model,
        stats: {
          inboxRows: rows.length,
          facts: extracted.profileFacts.length,
          events: extracted.events.length,
          durationMs: completedAt - startedAt,
        },
      }, completedAt);
      log.info("consolidation.completed", {
        subjectId: item.subjectId,
        memoryDate: item.memoryDate,
        inboxRows: rows.length,
        facts: extracted.profileFacts.length,
        events: extracted.events.length,
        model: completion.model,
      });
      return true;
    } catch (err) {
      repo.failJob(item, messageOf(err), now());
      throw err;
    }
  }

  function persistExtraction(
    item: UserProfileOwnerSubject & { memoryDate: string },
    rows: UserContextInboxRow[],
    previous: UserDailyMemoryRow | null,
    extracted: UserProfileExtraction,
    cfg: ResolvedConfig,
    completedAt: number,
  ): void {
    for (const fact of extracted.profileFacts) {
      const current = repo.findFact({ ...item, dimension: fact.dimension, claim: fact.claim });
      const sourceInboxIds = unique([...(current?.sourceInboxIds ?? []), ...fact.evidenceInboxIds]);
      const confidence = current
        ? Math.max(current.confidence, fact.confidence)
        : fact.confidence;
      repo.upsertFact({
        id: current?.id ?? ids.userProfileFact(),
        ...item,
        dimension: fact.dimension,
        claim: fact.claim,
        evidenceKind: current?.evidenceKind === "user_edited" ? "user_edited" : fact.evidenceKind,
        confidence,
        sourceInboxIds,
        firstSeenAt: current?.firstSeenAt ?? completedAt,
        lastConfirmedAt: completedAt,
        updatedAt: completedAt,
        status: "active",
        editedAt: current?.editedAt ?? null,
      });
    }

    const sourceInboxIds = unique([...(previous?.sourceInboxIds ?? []), ...rows.map((row) => row.id)]);
    repo.upsertDaily({
      id: previous?.id ?? ids.userDailyMemory(),
      ...item,
      summary: extracted.summary || previous?.summary || "当天没有形成可确认的摘要。",
      highlights: extracted.highlights,
      events: extracted.events,
      openLoops: extracted.openLoops,
      moodSignals: extracted.moodSignals,
      sourceInboxIds,
      createdAt: previous?.createdAt ?? completedAt,
      updatedAt: completedAt,
    });

    if (cfg.userProfile.proactiveInteraction.enabled && extracted.proactiveCandidate) {
      repo.upsertProactive({
        id: ids.proactiveInteraction(),
        ...item,
        sourceDate: item.memoryDate,
        reason: extracted.proactiveCandidate.reason,
        message: extracted.proactiveCandidate.message,
        score: extracted.proactiveCandidate.score,
        dueDate: addLocalDays(item.memoryDate, 1),
        dueTime: cfg.userProfile.proactiveInteraction.sendTime,
        status: "pending",
        claimToken: null,
        claimedAt: null,
        leaseExpiresAt: null,
        sentAt: null,
        channel: null,
        targetId: null,
        externalMessageId: null,
        error: null,
        createdAt: completedAt,
        updatedAt: completedAt,
      });
    }
  }

  async function captureTurn(input: Parameters<UserProfileService["captureTurn"]>[0]): Promise<boolean> {
    const cfg = await config();
    if (!cfg.userProfile.enabled) return false;
    const namespace = normalizeNamespace(input.namespace, input.namespace.agentKind);
    const owner = ownerFromNamespace(namespace);
    const subjectId = normalizeSubject(input.subjectId);
    const createdAt = now();
    const recentProactive = repo.listProactive({ ...owner, subjectId, limit: 5 })
      .find((interaction) =>
        interaction.status === "sent" &&
        interaction.sentAt != null &&
        createdAt - interaction.sentAt <= 48 * 60 * 60_000
      );
    repo.enqueue({
      id: ids.userContextInbox(),
      ...owner,
      subjectId,
      sessionId: input.sessionId,
      episodeId: input.episodeId ?? null,
      traceId: input.traceId ?? null,
      localDate: zonedClock(input.ts, cfg.userProfile.schedule.timezone).date,
      ts: input.ts,
      userText: clip(input.userText, 16_000),
      agentText: clip(input.agentText, 16_000),
      context: {
        ...sanitizeContext(input.context),
        ...(recentProactive ? {
          proactiveInteractionId: recentProactive.id,
          proactiveMessage: recentProactive.message,
        } : {}),
      },
      processedAt: null,
      createdAt,
    });
    if (recentProactive) repo.markResponded(recentProactive.id, createdAt);
    return true;
  }

  async function context(namespace: RuntimeNamespace, subjectId = "default"): Promise<string> {
    const cfg = await config();
    if (!cfg.userProfile.enabled) return "";
    const owner = subjectOwner(namespace, subjectId);
    const facts = repo.listFacts(owner).slice(0, 16);
    const recentProactive = repo.listProactive({ ...owner, limit: 5 })
      .find((interaction) =>
        (interaction.status === "sent" || interaction.status === "responded") &&
        interaction.sentAt != null &&
        now() - interaction.sentAt <= 48 * 60 * 60_000
      );
    const clock = zonedClock(now(), cfg.userProfile.schedule.timezone);
    const yesterday = repo.getDaily({ ...owner, memoryDate: addLocalDays(clock.date, -1) });
    if (facts.length === 0 && !yesterday && !recentProactive) return "";
    const lines = ["## User Context", "This sidecar context is user-editable and separate from recalled L1/L2/L3 memory."];
    if (facts.length > 0) {
      lines.push("", "Current profile:");
      for (const fact of facts) {
        const qualifier = fact.evidenceKind === "inferred" ? `inferred ${fact.confidence.toFixed(2)}` : fact.evidenceKind;
        lines.push(`- [${fact.dimension}; ${qualifier}] ${fact.claim}`);
      }
    }
    if (yesterday) {
      lines.push("", `Yesterday (${yesterday.memoryDate}): ${yesterday.summary}`);
      for (const loop of yesterday.openLoops.slice(0, 4)) lines.push(`- Open loop: ${loop}`);
    }
    if (recentProactive) {
      lines.push("", `Recent proactive message from Hermes: ${recentProactive.message}`);
      lines.push("Treat a short user reply as potentially answering that message.");
    }
    return clip(lines.join("\n"), cfg.userProfile.maxContextChars);
  }

  async function snapshot(namespace: RuntimeNamespace, subjectId = "default"): Promise<UserProfileSnapshotDTO> {
    const cfg = await config();
    const owner = subjectOwner(namespace, subjectId);
    const clock = zonedClock(now(), cfg.userProfile.schedule.timezone);
    const job = repo.latestJob(owner);
    return {
      enabled: cfg.userProfile.enabled,
      subjectId: owner.subjectId,
      timezone: cfg.userProfile.schedule.timezone,
      facts: repo.listFacts(owner),
      yesterday: repo.getDaily({ ...owner, memoryDate: addLocalDays(clock.date, -1) }),
      latestJob: job ? {
        memoryDate: job.memoryDate,
        status: job.status,
        attempts: job.attempts,
        startedAt: job.startedAt,
        completedAt: job.completedAt,
        error: job.error,
        model: job.model,
      } : null,
    };
  }

  async function subjects(namespace: RuntimeNamespace): Promise<UserProfileSubjectDTO[]> {
    const ns = normalizeNamespace(namespace, namespace.agentKind);
    const owner = ownerFromNamespace(ns);
    return repo.listSubjects(ns).map((subject) => ({ ...owner, ...subject }));
  }

  async function daily(namespace: RuntimeNamespace, input: { subjectId?: string; fromDate?: string; toDate?: string; limit?: number }): Promise<UserDailyMemoryDTO[]> {
    return repo.listDaily({
      ...subjectOwner(namespace, input.subjectId),
      fromDate: input.fromDate,
      toDate: input.toDate,
      limit: input.limit,
    });
  }

  async function proactive(namespace: RuntimeNamespace, subjectId = "default", limit = 30): Promise<ProactiveInteractionDTO[]> {
    return repo.listProactive({ ...subjectOwner(namespace, subjectId), limit });
  }

  async function updateFact(
    namespace: RuntimeNamespace,
    id: string,
    patch: { dimension?: string; claim?: string; confidence?: number; status?: "active" | "archived" },
  ): Promise<UserProfileFactDTO | null> {
    const existing = repo.getFact(id);
    if (!existing || !sameOwner(existing, ownerFromNamespace(namespace))) return null;
    return repo.updateFact(id, patch, now());
  }

  async function deleteFact(namespace: RuntimeNamespace, id: string): Promise<boolean> {
    const existing = repo.getFact(id);
    if (!existing || !sameOwner(existing, ownerFromNamespace(namespace))) return false;
    return repo.deleteFact(id);
  }

  async function runNow(input: { namespace?: RuntimeNamespace; subjectId?: string; memoryDate?: string } = {}): Promise<UserProfileRunSummary> {
    const cfg = await config();
    const clock = zonedClock(now(), cfg.userProfile.schedule.timezone);
    const date = input.memoryDate ?? clock.date;
    try {
      return await runOnce({
        maxDate: date,
        exactDate: date,
        namespace: input.namespace,
        subjectId: input.subjectId,
        cfg,
      });
    } finally {
      cleanupInbox(cfg);
    }
  }

  async function claimDue(input: Parameters<UserProfileService["claimDue"]>[0]): Promise<{ interaction: ProactiveInteractionDTO; claimToken: string } | null> {
    const cfg = await config();
    if (!cfg.userProfile.enabled || !cfg.userProfile.proactiveInteraction.enabled) return null;
    const clock = zonedClock(now(), cfg.userProfile.schedule.timezone);
    const proactiveCfg = cfg.userProfile.proactiveInteraction;
    if (proactiveCfg.dailyLimit <= 0) return null;
    if (isWithinQuietHours(clock.time, proactiveCfg.quietHours.start, proactiveCfg.quietHours.end)) return null;
    const owner = subjectOwner(input.namespace, input.subjectId);
    if (repo.sentCount({ ...owner, dueDate: clock.date }) >= proactiveCfg.dailyLimit) return null;
    const interaction = repo.claimDue({
      ...owner,
      localDate: clock.date,
      localTime: clock.time,
      channel: input.channel,
      targetId: input.targetId,
    }, now());
    if (!interaction?.claimToken) return null;
    return { interaction, claimToken: interaction.claimToken };
  }

  async function markDelivery(input: Parameters<UserProfileService["markDelivery"]>[0]): Promise<ProactiveInteractionDTO | null> {
    return repo.markProactive(input, now());
  }

  return {
    start,
    stop,
    captureTurn,
    context,
    snapshot,
    subjects,
    daily,
    proactive,
    updateFact,
    deleteFact,
    runNow,
    claimDue,
    markDelivery,
  };
}

const USER_PROFILE_SCHEMA_HINT = `{
  "profileFacts": [{
    "dimension": "personality|communication_style|work_style|interest|long_term_goal|habit|boundary|other",
    "claim": "short factual Chinese sentence",
    "evidenceKind": "explicit|inferred",
    "confidence": 0.0,
    "evidenceInboxIds": ["uci_id"]
  }],
  "summary": "one concise daily summary",
  "highlights": ["..."],
  "events": [{
    "kind": "activity|decision|plan|commitment|emotion|other",
    "summary": "...",
    "state": "observed|open|done|cancelled|unknown",
    "salience": 0.0,
    "confidence": 0.0,
    "evidenceInboxIds": ["uci_id"]
  }],
  "openLoops": ["..."],
  "moodSignals": ["only when directly supported"],
  "proactiveCandidate": null | {"reason":"...","message":"...","score":0.0}
}`;

function buildPrompt(
  memoryDate: string,
  rows: UserContextInboxRow[],
  previous: UserDailyMemoryRow | null,
  maxChars: number,
): Array<{ role: "system" | "user"; content: string }> {
  const system = `You maintain a private, user-editable sidecar profile for Hermes.
This output MUST NOT describe the agent, project environment, generic technical facts, or learned procedures.
Extract only facts about the human user and dated things the human did, felt, decided, or planned.
Do not diagnose mental health or infer protected/sensitive attributes. Personality claims require repeated behavioral evidence; use low confidence for inference.
Explicit user statements outrank inference. Never invent a detail. Return one JSON object matching the schema.
For proactiveCandidate, choose at most one high-value, non-sensitive follow-up. Return null when silence is better. The message must be warm, short, and not mention memory systems or profiling.`;
  const lines: string[] = [
    `LOCAL DATE: ${memoryDate}`,
    `PREVIOUS DAILY MEMORY (if this is a late incremental run): ${previous ? JSON.stringify(previous) : "none"}`,
    "COMPLETED TURNS:",
  ];
  for (const row of rows) {
    lines.push(`\n[${row.id}] ${new Date(row.ts).toISOString()}`);
    lines.push(`USER: ${row.userText}`);
    lines.push(`HERMES: ${row.agentText}`);
    if (Object.keys(row.context).length > 0) lines.push(`CONTEXT: ${JSON.stringify(row.context)}`);
    if (lines.join("\n").length >= maxChars) break;
  }
  lines.push("\nReturn the full updated daily memory, merging the previous daily memory with these late turns when present.");
  lines.push(`JSON SCHEMA:\n${USER_PROFILE_SCHEMA_HINT}`);
  return [{ role: "system", content: system }, { role: "user", content: clip(lines.join("\n"), maxChars) }];
}

function limitRowsByChars(rows: UserContextInboxRow[], maxChars: number): UserContextInboxRow[] {
  const kept: UserContextInboxRow[] = [];
  let used = 0;
  for (const row of rows) {
    const size = row.userText.length + row.agentText.length + 160;
    if (kept.length > 0 && used + size > maxChars) break;
    kept.push(row);
    used += size;
  }
  return kept;
}

function normalizeExtraction(value: unknown, validEvidence: Set<string>): UserProfileExtraction {
  const raw = record(value);
  const facts = array(raw.profileFacts).flatMap((entry) => {
    const item = record(entry);
    const claim = clean(item.claim, 500);
    if (!claim) return [];
    const dimensionRaw = clean(item.dimension, 80);
    const dimension = PROFILE_DIMENSIONS.has(dimensionRaw) ? dimensionRaw : "other";
    const evidenceKind: "explicit" | "inferred" =
      item.evidenceKind === "explicit" ? "explicit" : "inferred";
    const confidence = clamp01(number(item.confidence, evidenceKind === "explicit" ? 0.85 : 0.55));
    const sourceIds = evidenceIds(item.evidenceInboxIds, validEvidence);
    if (sourceIds.length === 0) return [];
    if (evidenceKind === "inferred" && confidence > 0.8) return [];
    if (dimension === "personality" && evidenceKind === "inferred" && sourceIds.length < 2) return [];
    return [{
      dimension,
      claim,
      evidenceKind,
      confidence,
      evidenceInboxIds: sourceIds,
    }];
  }).slice(0, 24);
  const events = array(raw.events).flatMap((entry) => {
    const item = record(entry);
    const summary = clean(item.summary, 600);
    if (!summary) return [];
    const kindRaw = clean(item.kind, 40);
    const stateRaw = clean(item.state, 40);
    return [{
      kind: (EVENT_KINDS.has(kindRaw) ? kindRaw : "other") as UserDailyMemoryDTO["events"][number]["kind"],
      summary,
      state: (EVENT_STATES.has(stateRaw) ? stateRaw : "unknown") as UserDailyMemoryDTO["events"][number]["state"],
      salience: clamp01(number(item.salience, 0.5)),
      confidence: clamp01(number(item.confidence, 0.7)),
      evidenceInboxIds: evidenceIds(item.evidenceInboxIds, validEvidence),
    }];
  }).slice(0, 40);
  const proactive = record(raw.proactiveCandidate);
  const proactiveMessage = clean(proactive.message, 500);
  const proactiveScore = clamp01(number(proactive.score, 0));
  return {
    profileFacts: facts,
    summary: clean(raw.summary, 1_200),
    highlights: strings(raw.highlights, 12, 500),
    events,
    openLoops: strings(raw.openLoops, 12, 500),
    moodSignals: strings(raw.moodSignals, 8, 300),
    proactiveCandidate: proactiveMessage && proactiveScore >= 0.65 ? {
      reason: clean(proactive.reason, 500) || "值得轻量跟进",
      message: proactiveMessage,
      score: proactiveScore,
    } : null,
  };
}

function subjectOwner(namespace: RuntimeNamespace, subjectId?: string): UserProfileOwnerSubject {
  return { ...ownerFromNamespace(normalizeNamespace(namespace, namespace.agentKind)), subjectId: normalizeSubject(subjectId) };
}

function normalizeSubject(value?: string): string {
  const normalized = String(value ?? "").trim().toLowerCase().replace(/[^a-z0-9._:@-]+/g, "-").replace(/^-+|-+$/g, "");
  return normalized.slice(0, 160) || "default";
}

function sanitizeContext(value?: Record<string, unknown>): Record<string, unknown> {
  if (!value) return {};
  const allowed = ["platform", "threadId", "userProfileSubjectLabel", "origin"];
  return Object.fromEntries(allowed.flatMap((key) => key in value ? [[key, value[key]]] : []));
}

function sameOwner(a: { ownerAgentKind: string; ownerProfileId: string }, b: { ownerAgentKind: string; ownerProfileId: string }): boolean {
  return a.ownerAgentKind === b.ownerAgentKind && a.ownerProfileId === b.ownerProfileId;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function strings(value: unknown, limit: number, maxChars: number): string[] {
  return unique(array(value).map((item) => clean(item, maxChars)).filter(Boolean)).slice(0, limit);
}

function evidenceIds(value: unknown, valid: Set<string>): string[] {
  return unique(array(value).map((item) => clean(item, 100)).filter((id) => valid.has(id))).slice(0, 30);
}

function clean(value: unknown, maxChars: number): string {
  return clip(typeof value === "string" ? value.trim() : "", maxChars);
}

function clip(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, Math.max(0, maxChars - 1))}…`;
}

function number(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function emptyRun(): UserProfileRunSummary {
  return { processed: 0, skipped: 0, failed: 0, dates: [] };
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
