import { randomUUID } from "node:crypto";

import type { RuntimeNamespace } from "../../../agent-contract/dto.js";
import type { OwnerFields } from "../../runtime/namespace.js";
import { ownerFromNamespace } from "../../runtime/namespace.js";
import type {
  ProactiveInteractionRow,
  UserContextInboxRow,
  UserDailyMemoryRow,
  UserProfileFactRow,
  UserProfileJobRow,
  UserProfileOwnerSubject,
} from "../../user-profile/types.js";
import type { StorageDb } from "../types.js";
import { fromJsonText, toJsonText } from "./_helpers.js";

type Raw = Record<string, unknown>;

export function makeUserProfileRepo(db: StorageDb) {
  return {
    enqueue(row: UserContextInboxRow): void {
      db.prepare(
        `INSERT INTO user_context_inbox (
          id, owner_agent_kind, owner_profile_id, owner_workspace_id, subject_id,
          session_id, episode_id, trace_id, local_date, ts, user_text, agent_text,
          context_json, processed_at, created_at
        ) VALUES (
          @id, @owner_agent_kind, @owner_profile_id, @owner_workspace_id, @subject_id,
          @session_id, @episode_id, @trace_id, @local_date, @ts, @user_text, @agent_text,
          @context_json, @processed_at, @created_at
        ) ON CONFLICT(id) DO NOTHING`,
      ).run(inboxParams(row));
    },

    pendingDatesThrough(maxDate: string): UserProfileOwnerSubjectAndDate[] {
      return db.prepare<{ max_date: string }, Raw>(
        `SELECT owner_agent_kind, owner_profile_id, owner_workspace_id, subject_id, local_date
           FROM user_context_inbox
          WHERE processed_at IS NULL AND local_date <= @max_date
          GROUP BY owner_agent_kind, owner_profile_id, owner_workspace_id, subject_id, local_date
          ORDER BY local_date ASC`,
      ).all({ max_date: maxDate }).map((row) => ({
        ...ownerFromRaw(row),
        subjectId: text(row.subject_id, "default"),
        memoryDate: text(row.local_date),
      }));
    },

    listPending(input: UserProfileOwnerSubject & { memoryDate: string; limit?: number }): UserContextInboxRow[] {
      return db.prepare<Record<string, unknown>, Raw>(
        `SELECT * FROM user_context_inbox
          WHERE owner_agent_kind=@owner_agent_kind
            AND owner_profile_id=@owner_profile_id
            AND subject_id=@subject_id
            AND local_date=@local_date
            AND processed_at IS NULL
          ORDER BY ts ASC
          LIMIT @limit`,
      ).all({
        ...ownerParams(input),
        subject_id: input.subjectId,
        local_date: input.memoryDate,
        limit: Math.max(1, Math.min(2_000, input.limit ?? 500)),
      }).map(mapInbox);
    },

    markProcessed(ids: readonly string[], processedAt: number): void {
      if (ids.length === 0) return;
      const update = db.prepare<{ id: string; processed_at: number }>(
        `UPDATE user_context_inbox SET processed_at=@processed_at WHERE id=@id`,
      );
      db.tx(() => {
        for (const id of ids) update.run({ id, processed_at: processedAt });
      });
    },

    deleteProcessedInboxBefore(processedBefore: number): number {
      const result = db.prepare<{ processed_before: number }>(
        `DELETE FROM user_context_inbox
          WHERE processed_at IS NOT NULL
            AND processed_at < @processed_before`,
      ).run({ processed_before: processedBefore });
      return Number(result.changes);
    },

    checkpointWalTruncate(): void {
      db.raw.pragma("wal_checkpoint(TRUNCATE)");
    },

    listFacts(input: UserProfileOwnerSubject, includeArchived = false): UserProfileFactRow[] {
      const status = includeArchived ? "" : "AND status='active'";
      return db.prepare<Record<string, unknown>, Raw>(
        `SELECT * FROM user_profile_facts
          WHERE owner_agent_kind=@owner_agent_kind
            AND owner_profile_id=@owner_profile_id
            AND subject_id=@subject_id ${status}
          ORDER BY confidence DESC, updated_at DESC`,
      ).all({ ...ownerParams(input), subject_id: input.subjectId }).map(mapFact);
    },

    getFact(id: string): UserProfileFactRow | null {
      const row = db.prepare<{ id: string }, Raw>(
        `SELECT * FROM user_profile_facts WHERE id=@id`,
      ).get({ id });
      return row ? mapFact(row) : null;
    },

    findFact(input: UserProfileOwnerSubject & { dimension: string; claim: string }): UserProfileFactRow | null {
      const row = db.prepare<Record<string, unknown>, Raw>(
        `SELECT * FROM user_profile_facts
          WHERE owner_agent_kind=@owner_agent_kind
            AND owner_profile_id=@owner_profile_id
            AND subject_id=@subject_id
            AND dimension=@dimension AND claim=@claim
          LIMIT 1`,
      ).get({
        ...ownerParams(input),
        subject_id: input.subjectId,
        dimension: input.dimension,
        claim: input.claim,
      });
      return row ? mapFact(row) : null;
    },

    upsertFact(row: UserProfileFactRow): void {
      db.prepare(
        `INSERT INTO user_profile_facts (
          id, owner_agent_kind, owner_profile_id, owner_workspace_id, subject_id,
          dimension, claim, evidence_kind, confidence, source_inbox_ids_json,
          first_seen_at, last_confirmed_at, updated_at, status, edited_at
        ) VALUES (
          @id, @owner_agent_kind, @owner_profile_id, @owner_workspace_id, @subject_id,
          @dimension, @claim, @evidence_kind, @confidence, @source_inbox_ids_json,
          @first_seen_at, @last_confirmed_at, @updated_at, @status, @edited_at
        ) ON CONFLICT(owner_agent_kind, owner_profile_id, subject_id, dimension, claim)
        DO UPDATE SET
          confidence=excluded.confidence,
          evidence_kind=CASE
            WHEN user_profile_facts.evidence_kind='user_edited' THEN user_profile_facts.evidence_kind
            WHEN excluded.evidence_kind='explicit' THEN 'explicit'
            ELSE user_profile_facts.evidence_kind END,
          source_inbox_ids_json=excluded.source_inbox_ids_json,
          last_confirmed_at=excluded.last_confirmed_at,
          updated_at=excluded.updated_at,
          status='active'`,
      ).run(factParams(row));
    },

    updateFact(id: string, patch: { dimension?: string; claim?: string; confidence?: number; status?: "active" | "archived" }, now: number): UserProfileFactRow | null {
      const current = this.getFact(id);
      if (!current) return null;
      db.prepare(
        `UPDATE user_profile_facts SET
          dimension=@dimension, claim=@claim, confidence=@confidence, status=@status,
          evidence_kind='user_edited', edited_at=@edited_at, updated_at=@updated_at
        WHERE id=@id`,
      ).run({
        id,
        dimension: patch.dimension?.trim() || current.dimension,
        claim: patch.claim?.trim() || current.claim,
        confidence: patch.confidence == null ? current.confidence : clamp01(patch.confidence),
        status: patch.status ?? current.status,
        edited_at: now,
        updated_at: now,
      });
      return this.getFact(id);
    },

    deleteFact(id: string): boolean {
      return Number(db.prepare<{ id: string }>(
        `DELETE FROM user_profile_facts WHERE id=@id`,
      ).run({ id }).changes) > 0;
    },

    upsertDaily(row: UserDailyMemoryRow): UserDailyMemoryRow {
      db.prepare(
        `INSERT INTO user_daily_memories (
          id, owner_agent_kind, owner_profile_id, owner_workspace_id, subject_id,
          memory_date, summary, highlights_json, events_json, open_loops_json,
          mood_signals_json, source_inbox_ids_json, created_at, updated_at
        ) VALUES (
          @id, @owner_agent_kind, @owner_profile_id, @owner_workspace_id, @subject_id,
          @memory_date, @summary, @highlights_json, @events_json, @open_loops_json,
          @mood_signals_json, @source_inbox_ids_json, @created_at, @updated_at
        ) ON CONFLICT(owner_agent_kind, owner_profile_id, subject_id, memory_date)
        DO UPDATE SET
          summary=excluded.summary,
          highlights_json=excluded.highlights_json,
          events_json=excluded.events_json,
          open_loops_json=excluded.open_loops_json,
          mood_signals_json=excluded.mood_signals_json,
          source_inbox_ids_json=excluded.source_inbox_ids_json,
          updated_at=excluded.updated_at`,
      ).run(dailyParams(row));
      return this.getDaily({ ...row, memoryDate: row.memoryDate })!;
    },

    getDaily(input: UserProfileOwnerSubject & { memoryDate: string }): UserDailyMemoryRow | null {
      const row = db.prepare<Record<string, unknown>, Raw>(
        `SELECT * FROM user_daily_memories
          WHERE owner_agent_kind=@owner_agent_kind
            AND owner_profile_id=@owner_profile_id
            AND subject_id=@subject_id
            AND memory_date=@memory_date`,
      ).get({
        ...ownerParams(input),
        subject_id: input.subjectId,
        memory_date: input.memoryDate,
      });
      return row ? mapDaily(row) : null;
    },

    listDaily(input: UserProfileOwnerSubject & { fromDate?: string; toDate?: string; limit?: number }): UserDailyMemoryRow[] {
      const parts = [
        "owner_agent_kind=@owner_agent_kind",
        "owner_profile_id=@owner_profile_id",
        "subject_id=@subject_id",
      ];
      const params: Record<string, unknown> = {
        ...ownerParams(input), subject_id: input.subjectId,
        limit: Math.max(1, Math.min(500, input.limit ?? 90)),
      };
      if (input.fromDate) { parts.push("memory_date>=@from_date"); params.from_date = input.fromDate; }
      if (input.toDate) { parts.push("memory_date<=@to_date"); params.to_date = input.toDate; }
      return db.prepare<Record<string, unknown>, Raw>(
        `SELECT * FROM user_daily_memories WHERE ${parts.join(" AND ")}
          ORDER BY memory_date DESC LIMIT @limit`,
      ).all(params).map(mapDaily);
    },

    listSubjects(ns: RuntimeNamespace): Array<{
      subjectId: string;
      lastActivityAt: number;
      factCount: number;
      dailyMemoryCount: number;
    }> {
      const owner = ownerFromNamespace(ns);
      return db.prepare<Record<string, unknown>, Raw>(
        `WITH subject_activity AS (
          SELECT subject_id, MAX(ts) AS last_activity_at
            FROM user_context_inbox
           WHERE owner_agent_kind=@owner_agent_kind AND owner_profile_id=@owner_profile_id
           GROUP BY subject_id
          UNION ALL
          SELECT subject_id, MAX(updated_at) AS last_activity_at
            FROM user_profile_facts
           WHERE owner_agent_kind=@owner_agent_kind AND owner_profile_id=@owner_profile_id
           GROUP BY subject_id
          UNION ALL
          SELECT subject_id, MAX(updated_at) AS last_activity_at
            FROM user_daily_memories
           WHERE owner_agent_kind=@owner_agent_kind AND owner_profile_id=@owner_profile_id
           GROUP BY subject_id
        ), subjects AS (
          SELECT subject_id, MAX(last_activity_at) AS last_activity_at
            FROM subject_activity GROUP BY subject_id
        )
        SELECT s.subject_id, s.last_activity_at,
          (SELECT COUNT(*) FROM user_profile_facts f
            WHERE f.owner_agent_kind=@owner_agent_kind AND f.owner_profile_id=@owner_profile_id
              AND f.subject_id=s.subject_id AND f.status='active') AS fact_count,
          (SELECT COUNT(*) FROM user_daily_memories d
            WHERE d.owner_agent_kind=@owner_agent_kind AND d.owner_profile_id=@owner_profile_id
              AND d.subject_id=s.subject_id) AS daily_memory_count
        FROM subjects s ORDER BY s.last_activity_at DESC`,
      ).all(ownerParams(owner)).map((row) => ({
        subjectId: text(row.subject_id, "default"),
        lastActivityAt: num(row.last_activity_at),
        factCount: num(row.fact_count),
        dailyMemoryCount: num(row.daily_memory_count),
      }));
    },

    acquireJob(input: UserProfileOwnerSubject & { memoryDate: string }, now: number, leaseMs = 30 * 60_000): boolean {
      return db.tx(() => {
        db.prepare(
          `INSERT INTO user_profile_jobs (
            owner_agent_kind, owner_profile_id, owner_workspace_id, subject_id, memory_date,
            status, attempts, started_at, completed_at, lease_expires_at, error, model,
            stats_json, updated_at
          ) VALUES (
            @owner_agent_kind, @owner_profile_id, @owner_workspace_id, @subject_id, @memory_date,
            'failed', 0, NULL, NULL, NULL, NULL, NULL, '{}', @updated_at
          ) ON CONFLICT(owner_agent_kind, owner_profile_id, subject_id, memory_date) DO NOTHING`,
        ).run({ ...ownerParams(input), subject_id: input.subjectId, memory_date: input.memoryDate, updated_at: now });
        const result = db.prepare(
          `UPDATE user_profile_jobs SET
            status='running', attempts=attempts+1, started_at=@started_at,
            completed_at=NULL, lease_expires_at=@lease_expires_at, error=NULL, updated_at=@started_at
          WHERE owner_agent_kind=@owner_agent_kind AND owner_profile_id=@owner_profile_id
            AND subject_id=@subject_id AND memory_date=@memory_date
            AND (status!='running' OR lease_expires_at IS NULL OR lease_expires_at<@started_at)`,
        ).run({
          ...ownerParams(input), subject_id: input.subjectId, memory_date: input.memoryDate,
          started_at: now, lease_expires_at: now + leaseMs,
        });
        return Number(result.changes) > 0;
      });
    },

    finishJob(input: UserProfileOwnerSubject & { memoryDate: string }, detail: { model: string; stats: Record<string, unknown> }, now: number): void {
      db.prepare(
        `UPDATE user_profile_jobs SET status='completed', completed_at=@completed_at,
          lease_expires_at=NULL, error=NULL, model=@model, stats_json=@stats_json,
          updated_at=@completed_at
        WHERE owner_agent_kind=@owner_agent_kind AND owner_profile_id=@owner_profile_id
          AND subject_id=@subject_id AND memory_date=@memory_date`,
      ).run({
        ...ownerParams(input), subject_id: input.subjectId, memory_date: input.memoryDate,
        completed_at: now, model: detail.model, stats_json: toJsonText(detail.stats),
      });
    },

    failJob(input: UserProfileOwnerSubject & { memoryDate: string }, error: string, now: number): void {
      db.prepare(
        `UPDATE user_profile_jobs SET status='failed', completed_at=@completed_at,
          lease_expires_at=NULL, error=@error, updated_at=@completed_at
        WHERE owner_agent_kind=@owner_agent_kind AND owner_profile_id=@owner_profile_id
          AND subject_id=@subject_id AND memory_date=@memory_date`,
      ).run({
        ...ownerParams(input), subject_id: input.subjectId, memory_date: input.memoryDate,
        completed_at: now, error: error.slice(0, 2_000),
      });
    },

    latestJob(input: UserProfileOwnerSubject): UserProfileJobRow | null {
      const row = db.prepare<Record<string, unknown>, Raw>(
        `SELECT * FROM user_profile_jobs
          WHERE owner_agent_kind=@owner_agent_kind AND owner_profile_id=@owner_profile_id
            AND subject_id=@subject_id
          ORDER BY updated_at DESC LIMIT 1`,
      ).get({ ...ownerParams(input), subject_id: input.subjectId });
      return row ? mapJob(row) : null;
    },

    upsertProactive(row: ProactiveInteractionRow): void {
      db.prepare(
        `INSERT INTO proactive_interactions (
          id, owner_agent_kind, owner_profile_id, owner_workspace_id, subject_id,
          source_date, reason, message, score, due_date, due_time, status,
          claim_token, claimed_at, lease_expires_at, sent_at, channel, target_id,
          external_message_id, error, created_at, updated_at
        ) VALUES (
          @id, @owner_agent_kind, @owner_profile_id, @owner_workspace_id, @subject_id,
          @source_date, @reason, @message, @score, @due_date, @due_time, @status,
          @claim_token, @claimed_at, @lease_expires_at, @sent_at, @channel, @target_id,
          @external_message_id, @error, @created_at, @updated_at
        ) ON CONFLICT(owner_agent_kind, owner_profile_id, subject_id, source_date)
        DO UPDATE SET reason=excluded.reason, message=excluded.message, score=excluded.score,
          due_date=excluded.due_date, due_time=excluded.due_time, status='pending',
          claim_token=NULL, claimed_at=NULL, lease_expires_at=NULL, error=NULL,
          updated_at=excluded.updated_at
        WHERE proactive_interactions.status IN ('pending','failed')`,
      ).run(proactiveParams(row));
    },

    listProactive(input: UserProfileOwnerSubject & { limit?: number }): ProactiveInteractionRow[] {
      return db.prepare<Record<string, unknown>, Raw>(
        `SELECT * FROM proactive_interactions
          WHERE owner_agent_kind=@owner_agent_kind AND owner_profile_id=@owner_profile_id
            AND subject_id=@subject_id
          ORDER BY created_at DESC LIMIT @limit`,
      ).all({
        ...ownerParams(input), subject_id: input.subjectId,
        limit: Math.max(1, Math.min(200, input.limit ?? 30)),
      }).map(mapProactive);
    },

    claimDue(input: UserProfileOwnerSubject & { localDate: string; localTime: string; channel: string; targetId: string }, now: number): ProactiveInteractionRow | null {
      return db.tx(() => {
        db.prepare(
          `UPDATE proactive_interactions SET status='pending', claim_token=NULL,
            claimed_at=NULL, lease_expires_at=NULL, updated_at=@now
          WHERE status='claimed' AND lease_expires_at<@now`,
        ).run({ now });
        db.prepare(
          `UPDATE proactive_interactions SET status='expired', updated_at=@now
          WHERE owner_agent_kind=@owner_agent_kind AND owner_profile_id=@owner_profile_id
            AND subject_id=@subject_id AND status='pending' AND due_date<@local_date`,
        ).run({
          ...ownerParams(input), subject_id: input.subjectId,
          local_date: input.localDate, now,
        });
        const row = db.prepare<Record<string, unknown>, Raw>(
          `SELECT * FROM proactive_interactions
            WHERE owner_agent_kind=@owner_agent_kind AND owner_profile_id=@owner_profile_id
              AND subject_id=@subject_id AND status='pending'
              AND due_date=@local_date AND due_time<=@local_time
            ORDER BY score DESC, due_date ASC, due_time ASC LIMIT 1`,
        ).get({
          ...ownerParams(input), subject_id: input.subjectId,
          local_date: input.localDate, local_time: input.localTime,
        });
        if (!row) return null;
        const id = text(row.id);
        const claimToken = randomUUID();
        const result = db.prepare(
          `UPDATE proactive_interactions SET status='claimed', claim_token=@claim_token,
            claimed_at=@claimed_at, lease_expires_at=@lease_expires_at,
            channel=@channel, target_id=@target_id, error=NULL, updated_at=@claimed_at
          WHERE id=@id AND status='pending'`,
        ).run({
          // A claim can cross an external send boundary. Keep it for a full
          // day so a crash after Feishu accepted the message cannot cause a
          // duplicate five minutes later; stale claims expire with due_date.
          id, claim_token: claimToken, claimed_at: now, lease_expires_at: now + 24 * 60 * 60_000,
          channel: input.channel, target_id: input.targetId,
        });
        if (Number(result.changes) === 0) return null;
        const claimed = db.prepare<{ id: string }, Raw>(
          `SELECT * FROM proactive_interactions WHERE id=@id`,
        ).get({ id });
        return claimed ? mapProactive(claimed) : null;
      });
    },

    markProactive(input: { id: string; claimToken: string; status: "sent" | "failed" | "skipped"; externalMessageId?: string; error?: string }, now: number): ProactiveInteractionRow | null {
      const updated = db.prepare(
        `UPDATE proactive_interactions SET status=@status,
          sent_at=CASE WHEN @status='sent' THEN @now ELSE sent_at END,
          external_message_id=@external_message_id, error=@error,
          lease_expires_at=NULL, updated_at=@now
        WHERE id=@id AND claim_token=@claim_token AND status='claimed'`,
      ).run({
        id: input.id, claim_token: input.claimToken, status: input.status, now,
        external_message_id: input.externalMessageId ?? null,
        error: input.error?.slice(0, 2_000) ?? null,
      });
      if (Number(updated.changes) === 0) return null;
      const row = db.prepare<{ id: string }, Raw>(
        `SELECT * FROM proactive_interactions WHERE id=@id`,
      ).get({ id: input.id });
      return row ? mapProactive(row) : null;
    },

    markResponded(id: string, now: number): void {
      db.prepare(
        `UPDATE proactive_interactions SET status='responded', updated_at=@now
          WHERE id=@id AND status='sent'`,
      ).run({ id, now });
    },

    sentCount(input: UserProfileOwnerSubject & { dueDate: string }): number {
      return num(db.prepare<Record<string, unknown>, Raw>(
        `SELECT COUNT(*) AS n FROM proactive_interactions
          WHERE owner_agent_kind=@owner_agent_kind AND owner_profile_id=@owner_profile_id
            AND subject_id=@subject_id AND due_date=@due_date AND status='sent'`,
      ).get({ ...ownerParams(input), subject_id: input.subjectId, due_date: input.dueDate })?.n);
    },
  };
}

interface UserProfileOwnerSubjectAndDate extends UserProfileOwnerSubject {
  memoryDate: string;
}

function ownerParams(owner: Partial<OwnerFields>): Record<string, unknown> {
  return {
    owner_agent_kind: owner.ownerAgentKind ?? "unknown",
    owner_profile_id: owner.ownerProfileId ?? "default",
    owner_workspace_id: owner.ownerWorkspaceId ?? null,
  };
}

function ownerFromRaw(row: Raw): OwnerFields {
  return {
    ownerAgentKind: text(row.owner_agent_kind, "unknown"),
    ownerProfileId: text(row.owner_profile_id, "default"),
    ownerWorkspaceId: row.owner_workspace_id == null ? null : text(row.owner_workspace_id),
  };
}

function inboxParams(row: UserContextInboxRow): Record<string, unknown> {
  return {
    id: row.id, ...ownerParams(row), subject_id: row.subjectId,
    session_id: row.sessionId, episode_id: row.episodeId, trace_id: row.traceId,
    local_date: row.localDate, ts: row.ts, user_text: row.userText,
    agent_text: row.agentText, context_json: toJsonText(row.context),
    processed_at: row.processedAt, created_at: row.createdAt,
  };
}

function factParams(row: UserProfileFactRow): Record<string, unknown> {
  return {
    id: row.id, ...ownerParams(row), subject_id: row.subjectId,
    dimension: row.dimension, claim: row.claim, evidence_kind: row.evidenceKind,
    confidence: clamp01(row.confidence), source_inbox_ids_json: toJsonText(row.sourceInboxIds),
    first_seen_at: row.firstSeenAt, last_confirmed_at: row.lastConfirmedAt,
    updated_at: row.updatedAt, status: row.status, edited_at: row.editedAt ?? null,
  };
}

function dailyParams(row: UserDailyMemoryRow): Record<string, unknown> {
  return {
    id: row.id, ...ownerParams(row), subject_id: row.subjectId,
    memory_date: row.memoryDate, summary: row.summary,
    highlights_json: toJsonText(row.highlights), events_json: toJsonText(row.events),
    open_loops_json: toJsonText(row.openLoops), mood_signals_json: toJsonText(row.moodSignals),
    source_inbox_ids_json: toJsonText(row.sourceInboxIds),
    created_at: row.createdAt, updated_at: row.updatedAt,
  };
}

function proactiveParams(row: ProactiveInteractionRow): Record<string, unknown> {
  return {
    id: row.id, ...ownerParams(row), subject_id: row.subjectId,
    source_date: row.sourceDate, reason: row.reason, message: row.message,
    score: clamp01(row.score), due_date: row.dueDate, due_time: row.dueTime,
    status: row.status, claim_token: row.claimToken, claimed_at: row.claimedAt ?? null,
    lease_expires_at: row.leaseExpiresAt, sent_at: row.sentAt ?? null,
    channel: row.channel ?? null, target_id: row.targetId ?? null,
    external_message_id: row.externalMessageId ?? null, error: row.error ?? null,
    created_at: row.createdAt, updated_at: row.updatedAt,
  };
}

function mapInbox(row: Raw): UserContextInboxRow {
  return {
    id: text(row.id), ...ownerFromRaw(row), subjectId: text(row.subject_id, "default"),
    sessionId: text(row.session_id), episodeId: nullableText(row.episode_id),
    traceId: nullableText(row.trace_id), localDate: text(row.local_date), ts: num(row.ts),
    userText: text(row.user_text), agentText: text(row.agent_text),
    context: fromJsonText(text(row.context_json, "{}"), {}),
    processedAt: nullableNum(row.processed_at), createdAt: num(row.created_at),
  };
}

function mapFact(row: Raw): UserProfileFactRow {
  return {
    id: text(row.id), ...ownerFromRaw(row), subjectId: text(row.subject_id, "default"),
    dimension: text(row.dimension), claim: text(row.claim),
    evidenceKind: text(row.evidence_kind, "inferred") as UserProfileFactRow["evidenceKind"],
    confidence: clamp01(num(row.confidence, 0.5)),
    sourceInboxIds: fromJsonText(text(row.source_inbox_ids_json, "[]"), []),
    firstSeenAt: num(row.first_seen_at), lastConfirmedAt: num(row.last_confirmed_at),
    updatedAt: num(row.updated_at), status: text(row.status, "active") as UserProfileFactRow["status"],
    editedAt: nullableNum(row.edited_at),
  };
}

function mapDaily(row: Raw): UserDailyMemoryRow {
  return {
    id: text(row.id), ...ownerFromRaw(row), subjectId: text(row.subject_id, "default"),
    memoryDate: text(row.memory_date), summary: text(row.summary),
    highlights: fromJsonText(text(row.highlights_json, "[]"), []),
    events: fromJsonText(text(row.events_json, "[]"), []),
    openLoops: fromJsonText(text(row.open_loops_json, "[]"), []),
    moodSignals: fromJsonText(text(row.mood_signals_json, "[]"), []),
    sourceInboxIds: fromJsonText(text(row.source_inbox_ids_json, "[]"), []),
    createdAt: num(row.created_at), updatedAt: num(row.updated_at),
  };
}

function mapProactive(row: Raw): ProactiveInteractionRow {
  return {
    id: text(row.id), ...ownerFromRaw(row), subjectId: text(row.subject_id, "default"),
    sourceDate: text(row.source_date), reason: text(row.reason), message: text(row.message),
    score: clamp01(num(row.score)), dueDate: text(row.due_date), dueTime: text(row.due_time),
    status: text(row.status, "pending") as ProactiveInteractionRow["status"],
    claimToken: nullableText(row.claim_token), claimedAt: nullableNum(row.claimed_at),
    leaseExpiresAt: nullableNum(row.lease_expires_at), sentAt: nullableNum(row.sent_at),
    channel: nullableText(row.channel), targetId: nullableText(row.target_id),
    externalMessageId: nullableText(row.external_message_id), error: nullableText(row.error),
    createdAt: num(row.created_at), updatedAt: num(row.updated_at),
  };
}

function mapJob(row: Raw): UserProfileJobRow {
  return {
    ...ownerFromRaw(row), subjectId: text(row.subject_id, "default"), memoryDate: text(row.memory_date),
    status: text(row.status, "failed") as UserProfileJobRow["status"], attempts: num(row.attempts),
    startedAt: nullableNum(row.started_at), completedAt: nullableNum(row.completed_at),
    leaseExpiresAt: nullableNum(row.lease_expires_at), error: nullableText(row.error),
    model: nullableText(row.model), stats: fromJsonText(text(row.stats_json, "{}"), {}),
    updatedAt: num(row.updated_at),
  };
}

function text(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : value == null ? fallback : String(value);
}

function nullableText(value: unknown): string | null {
  return value == null ? null : text(value);
}

function num(value: unknown, fallback = 0): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function nullableNum(value: unknown): number | null {
  return value == null ? null : num(value);
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));
}
