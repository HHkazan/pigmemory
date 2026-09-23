import { randomUUID } from "node:crypto";

import type { StorageDb } from "../types.js";

export type LifecycleEntityKind =
  | "trace"
  | "policy"
  | "skill"
  | "world_model"
  | "episode";

export interface LifecycleEventInsert {
  entityKind: LifecycleEntityKind;
  entityId: string;
  oldState?: string | null;
  newState: string;
  eventAt?: number;
  reason: string;
  source?: string;
  sessionId?: string | null;
  episodeId?: string | null;
  turnId?: string | number | null;
  oldVersion?: number | null;
  newVersion?: number | null;
  detail?: Record<string, unknown>;
}

export interface RetrievalCandidateInsert {
  source?: "local" | "shared";
  tier: number;
  refKind: string;
  refId: string;
  score?: number;
  relevance?: number | null;
  initialRank?: number | null;
  modelRank?: number | null;
  finalRank?: number | null;
  sentToModel?: boolean;
  modelKept?: boolean;
  finalReturned?: boolean;
  decision?: string;
  reason?: string | null;
  summary?: string;
  detail?: Record<string, unknown>;
}

export interface RetrievalRunStart {
  id?: string;
  source: string;
  agent: string;
  sessionId?: string | null;
  episodeId?: string | null;
  turnId?: string | number | null;
  queryText: string;
  startedAt?: number;
  detail?: Record<string, unknown>;
}

export interface MonitorLogFilter {
  fromMs?: number;
  toMs?: number;
  sessionId?: string;
  episodeId?: string;
  level?: string;
  category?: string;
  cursor?: string;
  limit?: number;
}

export interface RetrievalRunFilter {
  fromMs?: number;
  toMs?: number;
  sessionId?: string;
  source?: string;
  cursor?: string;
  limit?: number;
}

export interface LifecycleChangeFilter {
  fromMs: number;
  toMs?: number;
  limit?: number;
}

export function makeObservabilityRepo(db: StorageDb) {
  return {
    appendLifecycle(input: LifecycleEventInsert): number {
      const result = db.prepare<Record<string, unknown>>(
        `INSERT INTO lifecycle_events
          (entity_kind, entity_id, old_state, new_state, event_at, reason, source,
           session_id, episode_id, turn_id, old_version, new_version, detail_json)
         VALUES
          (@entity_kind, @entity_id, @old_state, @new_state, @event_at, @reason, @source,
           @session_id, @episode_id, @turn_id, @old_version, @new_version, @detail_json)`,
      ).run({
        entity_kind: input.entityKind,
        entity_id: input.entityId,
        old_state: input.oldState ?? null,
        new_state: input.newState,
        event_at: input.eventAt ?? Date.now(),
        reason: input.reason,
        source: input.source ?? "core",
        session_id: input.sessionId ?? null,
        episode_id: input.episodeId ?? null,
        turn_id: input.turnId == null ? null : String(input.turnId),
        old_version: input.oldVersion ?? null,
        new_version: input.newVersion ?? null,
        detail_json: safeJson(input.detail ?? {}),
      });
      return Number(result.lastInsertRowid);
    },

    startRetrieval(input: RetrievalRunStart): string {
      const id = input.id ?? `rr_${randomUUID()}`;
      db.prepare<Record<string, unknown>>(
        `INSERT INTO retrieval_runs
          (id, source, agent, session_id, episode_id, turn_id, query_text,
           started_at, status, detail_json)
         VALUES
          (@id, @source, @agent, @session_id, @episode_id, @turn_id, @query_text,
           @started_at, 'running', @detail_json)`,
      ).run({
        id,
        source: input.source,
        agent: input.agent,
        session_id: input.sessionId ?? null,
        episode_id: input.episodeId ?? null,
        turn_id: input.turnId == null ? null : String(input.turnId),
        query_text: input.queryText.slice(0, 1_000),
        started_at: input.startedAt ?? Date.now(),
        detail_json: safeJson(input.detail ?? {}),
      });
      return id;
    },

    finishRetrieval(input: {
      id: string;
      status: "completed" | "failed";
      completedAt?: number;
      sessionId?: string | null;
      episodeId?: string | null;
      error?: string | null;
      detail?: Record<string, unknown>;
      candidates?: RetrievalCandidateInsert[];
    }): void {
      const completedAt = input.completedAt ?? Date.now();
      const candidates = dedupeCandidates(input.candidates ?? []);
      db.tx(() => {
        const started = db.prepare<{ id: string }, { started_at: number }>(
          `SELECT started_at FROM retrieval_runs WHERE id=@id`,
        ).get({ id: input.id })?.started_at ?? completedAt;
        db.prepare<Record<string, unknown>>(
          `UPDATE retrieval_runs
              SET status=@status,
                  completed_at=@completed_at,
                  duration_ms=@duration_ms,
                  session_id=COALESCE(@session_id, session_id),
                  episode_id=COALESCE(@episode_id, episode_id),
                  raw_candidate_count=@raw_count,
                  sent_to_model_count=@sent_count,
                  model_kept_count=@kept_count,
                  final_returned_count=@returned_count,
                  error=@error,
                  detail_json=@detail_json
            WHERE id=@id`,
        ).run({
          id: input.id,
          status: input.status,
          completed_at: completedAt,
          duration_ms: Math.max(0, completedAt - started),
          session_id: input.sessionId ?? null,
          episode_id: input.episodeId ?? null,
          raw_count: candidates.length,
          sent_count: candidates.filter((item) => item.sentToModel).length,
          kept_count: candidates.filter((item) => item.modelKept).length,
          returned_count: candidates.filter((item) => item.finalReturned).length,
          error: input.error?.slice(0, 1_000) ?? null,
          detail_json: safeJson(input.detail ?? {}),
        });
        const insert = db.prepare<Record<string, unknown>>(
          `INSERT INTO retrieval_candidates
            (run_id, source, tier, ref_kind, ref_id, score, relevance,
             initial_rank, model_rank, final_rank, sent_to_model, model_kept,
             final_returned, decision, reason, summary, detail_json)
           VALUES
            (@run_id, @source, @tier, @ref_kind, @ref_id, @score, @relevance,
             @initial_rank, @model_rank, @final_rank, @sent_to_model, @model_kept,
             @final_returned, @decision, @reason, @summary, @detail_json)`,
        );
        for (const item of candidates) {
          insert.run({
            run_id: input.id,
            source: item.source ?? "local",
            tier: item.tier,
            ref_kind: item.refKind,
            ref_id: item.refId,
            score: finite(item.score),
            relevance: nullableFinite(item.relevance),
            initial_rank: item.initialRank ?? null,
            model_rank: item.modelRank ?? null,
            final_rank: item.finalRank ?? null,
            sent_to_model: item.sentToModel ? 1 : 0,
            model_kept: item.modelKept ? 1 : 0,
            final_returned: item.finalReturned ? 1 : 0,
            decision: item.decision ?? "candidate",
            reason: item.reason?.slice(0, 500) ?? null,
            summary: (item.summary ?? "").slice(0, 500),
            detail_json: safeJson(item.detail ?? {}),
          });
        }
      });
    },

    acknowledge(input: {
      runId: string;
      source: string;
      sessionId?: string | null;
      episodeId?: string | null;
      deliveredRefIds: string[];
      at?: number;
    }): boolean {
      const requestedIds = [...new Set(input.deliveredRefIds.filter(Boolean))];
      const at = input.at ?? Date.now();
      return db.tx(() => {
        const found = db.prepare<{ id: string }, { id: string }>(
          `SELECT id FROM retrieval_runs WHERE id=@id`,
        ).get({ id: input.runId });
        if (!found) return false;
        const candidateIds = new Set(
          db.prepare<{ run_id: string }, { ref_id: string }>(
            `SELECT DISTINCT ref_id FROM retrieval_candidates WHERE run_id=@run_id`,
          ).all({ run_id: input.runId }).map((row) => row.ref_id),
        );
        const ids = requestedIds.filter((id) => candidateIds.has(id));
        db.prepare<Record<string, unknown>>(
          `UPDATE retrieval_runs
              SET acknowledged_at=@at,
                  acknowledged_by=@source,
                  session_id=COALESCE(@session_id, session_id),
                  episode_id=COALESCE(@episode_id, episode_id),
                  delivered_ids_json=@ids,
                  adapter_received_count=@count
            WHERE id=@id`,
        ).run({
          id: input.runId,
          at,
          source: input.source,
          session_id: input.sessionId ?? null,
          episode_id: input.episodeId ?? null,
          ids: safeJson(ids),
          count: ids.length,
        });
        if (ids.length > 0) {
          const params: Record<string, unknown> = { run_id: input.runId };
          const slots = ids.map((id, index) => {
            params[`id_${index}`] = id;
            return `@id_${index}`;
          });
          db.prepare<Record<string, unknown>>(
            `UPDATE retrieval_candidates
                SET adapter_received=1
              WHERE run_id=@run_id AND ref_id IN (${slots.join(",")})`,
          ).run(params);
          db.prepare<Record<string, unknown>>(
            `INSERT OR IGNORE INTO policy_exposures
               (policy_id, episode_id, delivered_at, retrieval_run_id)
             SELECT c.ref_id,
                    COALESCE(@episode_id, r.episode_id),
                    @delivered_at,
                    r.id
               FROM retrieval_candidates c
               JOIN retrieval_runs r ON r.id=c.run_id
               JOIN policies p ON p.id=c.ref_id
              WHERE c.run_id=@run_id
                AND c.ref_kind='experience'
                AND c.final_returned=1
                AND c.ref_id IN (${slots.join(",")})
                AND COALESCE(@episode_id, r.episode_id) IS NOT NULL`,
          ).run({
            ...params,
            episode_id: input.episodeId ?? null,
            delivered_at: at,
          });
        }
        return true;
      });
    },

    monitorLogs(filter: MonitorLogFilter = {}): Record<string, unknown> {
      const limit = clamp(filter.limit, 50, 500);
      const { where, params } = operationWhere(filter);
      const cursor = decodeCursor(filter.cursor);
      if (cursor) {
        where.push(`(called_at < @cursor_ts OR (called_at = @cursor_ts AND id < @cursor_id))`);
        params.cursor_ts = cursor.ts;
        params.cursor_id = cursor.id;
      }
      const clause = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
      const rows = db.prepare<Record<string, unknown>, OperationRaw>(
        `SELECT id, tool_name, input_json, output_json, duration_ms, success,
                called_at, session_id, episode_id, turn_id, level, category,
                phase, reason
           FROM api_logs ${clause}
          ORDER BY called_at DESC, id DESC LIMIT @limit`,
      ).all({ ...params, limit });
      return {
        logs: rows.map(mapOperation),
        nextCursor: rows.length === limit
          ? encodeCursor(rows[rows.length - 1]!.called_at, rows[rows.length - 1]!.id)
          : undefined,
      };
    },

    monitorSessions(filter: { fromMs?: number; toMs?: number; cursor?: string; limit?: number } = {}): Record<string, unknown> {
      const limit = clamp(filter.limit, 30, 200);
      const logWhere = ["session_id IS NOT NULL"];
      const retrievalWhere = ["session_id IS NOT NULL"];
      const params: Record<string, unknown> = { limit };
      if (filter.fromMs != null) {
        logWhere.push("called_at >= @from_ms");
        retrievalWhere.push("started_at >= @from_ms");
        params.from_ms = filter.fromMs;
      }
      if (filter.toMs != null) {
        logWhere.push("called_at < @to_ms");
        retrievalWhere.push("started_at < @to_ms");
        params.to_ms = filter.toMs;
      }
      const cursorWhere: string[] = [];
      const cursor = decodeTextCursor(filter.cursor);
      if (cursor) {
        cursorWhere.push(
          "(a.last_activity_at < @cursor_ts OR (a.last_activity_at=@cursor_ts AND a.session_id < @cursor_id))",
        );
        params.cursor_ts = cursor.ts;
        params.cursor_id = cursor.id;
      }
      const outerWhere = cursorWhere.length > 0 ? `WHERE ${cursorWhere.join(" AND ")}` : "";
      const rows = db.prepare<Record<string, unknown>, SessionSummaryRaw>(
        `WITH activity AS (
           SELECT session_id, called_at AS activity_at
             FROM api_logs WHERE ${logWhere.join(" AND ")}
           UNION ALL
           SELECT session_id, started_at AS activity_at
             FROM retrieval_runs WHERE ${retrievalWhere.join(" AND ")}
         ), active_sessions AS (
           SELECT session_id, MAX(activity_at) AS last_activity_at
             FROM activity GROUP BY session_id
         )
         SELECT a.session_id,
                s.started_at,
                a.last_activity_at,
                s.last_seen_at AS session_last_seen_at,
                CASE
                  WHEN EXISTS (SELECT 1 FROM episodes e WHERE e.session_id=a.session_id AND e.status='open')
                    THEN NULL
                  ELSE (SELECT MAX(e.ended_at) FROM episodes e WHERE e.session_id=a.session_id)
                END AS ended_at,
                (SELECT COUNT(*) FROM episodes e WHERE e.session_id=a.session_id) AS episode_count,
                (SELECT COUNT(*) FROM api_logs l
                  WHERE l.session_id=a.session_id AND ${logWhere.map((item) => item.replaceAll("session_id", "l.session_id").replaceAll("called_at", "l.called_at")).join(" AND ")}) AS operation_count,
                (SELECT COUNT(*) FROM retrieval_runs r
                  WHERE r.session_id=a.session_id AND ${retrievalWhere.map((item) => item.replaceAll("session_id", "r.session_id").replaceAll("started_at", "r.started_at")).join(" AND ")}) AS retrieval_count,
                (SELECT COUNT(*) FROM api_logs l
                  WHERE l.session_id=a.session_id AND l.level='warn' AND ${logWhere.map((item) => item.replaceAll("session_id", "l.session_id").replaceAll("called_at", "l.called_at")).join(" AND ")}) AS warning_count,
                (SELECT COUNT(*) FROM api_logs l
                  WHERE l.session_id=a.session_id AND l.level IN ('error','fatal') AND ${logWhere.map((item) => item.replaceAll("session_id", "l.session_id").replaceAll("called_at", "l.called_at")).join(" AND ")}) AS error_count
           FROM active_sessions a
           LEFT JOIN sessions s ON s.id=a.session_id
           ${outerWhere}
          ORDER BY a.last_activity_at DESC, a.session_id DESC
          LIMIT @limit`,
      ).all(params);
      return {
        sessions: rows.map((row) => ({
          sessionId: row.session_id,
          startedAt: row.started_at ?? row.last_activity_at,
          endedAt: row.ended_at,
          lastActivityAt: row.last_activity_at,
          episodeCount: row.episode_count,
          operationCount: row.operation_count,
          retrievalCount: row.retrieval_count,
          warningCount: row.warning_count,
          errorCount: row.error_count,
        })),
        nextCursor: rows.length === limit
          ? encodeTextCursor(
              rows[rows.length - 1]!.last_activity_at,
              rows[rows.length - 1]!.session_id,
            )
          : undefined,
      };
    },

    retrievalRuns(filter: RetrievalRunFilter = {}): Record<string, unknown> {
      const limit = clamp(filter.limit, 30, 200);
      const where: string[] = [];
      const params: Record<string, unknown> = { limit };
      if (filter.fromMs != null) { where.push("started_at >= @from_ms"); params.from_ms = filter.fromMs; }
      if (filter.toMs != null) { where.push("started_at < @to_ms"); params.to_ms = filter.toMs; }
      if (filter.sessionId) { where.push("session_id=@session_id"); params.session_id = filter.sessionId; }
      if (filter.source) { where.push("source=@source"); params.source = filter.source; }
      const cursor = decodeTextCursor(filter.cursor);
      if (cursor) {
        where.push("(started_at < @cursor_ts OR (started_at=@cursor_ts AND id < @cursor_id))");
        params.cursor_ts = cursor.ts;
        params.cursor_id = cursor.id;
      }
      const clause = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
      const rows = db.prepare<Record<string, unknown>, RetrievalRunRaw>(
        `SELECT * FROM retrieval_runs ${clause}
          ORDER BY started_at DESC, id DESC LIMIT @limit`,
      ).all(params);
      return {
        runs: rows.map(mapRetrievalRun),
        nextCursor: rows.length === limit
          ? encodeTextCursor(rows[rows.length - 1]!.started_at, rows[rows.length - 1]!.id)
          : undefined,
      };
    },

    retrievalRun(id: string): Record<string, unknown> | null {
      const run = db.prepare<{ id: string }, RetrievalRunRaw>(
        `SELECT * FROM retrieval_runs WHERE id=@id`,
      ).get({ id });
      if (!run) return null;
      const candidates = db.prepare<{ id: string }, RetrievalCandidateRaw>(
        `SELECT * FROM retrieval_candidates WHERE run_id=@id ORDER BY initial_rank, id`,
      ).all({ id });
      return { ...mapRetrievalRun(run), candidates: candidates.map(mapRetrievalCandidate) };
    },

    entityHistory(kind: string, id: string): Record<string, unknown> {
      const lifecycle = db.prepare<{ kind: string; id: string }, LifecycleRaw>(
        `SELECT * FROM lifecycle_events
          WHERE entity_kind=@kind AND entity_id=@id
          ORDER BY event_at DESC, id DESC`,
      ).all({ kind, id }).map(mapLifecycle);
      const stats = db.prepare<{ kind: string; id: string }, EntityRetrievalStatsRaw>(
        `SELECT
           SUM(CASE WHEN r.source='turn_start' THEN 1 ELSE 0 END) AS turn_start_runs,
           SUM(CASE WHEN r.source!='turn_start' THEN 1 ELSE 0 END) AS search_runs,
           COUNT(*) AS candidate_count,
           SUM(c.sent_to_model) AS sent_to_model_count,
           SUM(c.model_kept) AS model_kept_count,
           SUM(c.final_returned) AS final_returned_count,
           SUM(c.adapter_received) AS adapter_received_count
         FROM retrieval_candidates c
         JOIN retrieval_runs r ON r.id=c.run_id
        WHERE c.ref_kind=@kind AND c.ref_id=@id`,
      ).get({ kind: normalizeRefKind(kind), id });
      const runs = db.prepare<{ kind: string; id: string }, RetrievalRunRaw>(
        `SELECT DISTINCT r.* FROM retrieval_runs r
         JOIN retrieval_candidates c ON c.run_id=r.id
        WHERE c.ref_kind=@kind AND c.ref_id=@id
        ORDER BY r.started_at DESC LIMIT 100`,
      ).all({ kind: normalizeRefKind(kind), id }).map(mapRetrievalRun);
      return {
        entityKind: kind,
        entityId: id,
        lifecycle,
        retrievalStats: {
          turnStartRuns: stats?.turn_start_runs ?? 0,
          searchRuns: stats?.search_runs ?? 0,
          candidateCount: stats?.candidate_count ?? 0,
          sentToModelCount: stats?.sent_to_model_count ?? 0,
          modelKeptCount: stats?.model_kept_count ?? 0,
          finalReturnedCount: stats?.final_returned_count ?? 0,
          adapterReceivedCount: stats?.adapter_received_count ?? 0,
        },
        retrievalRuns: runs,
      };
    },

    /**
     * Aggregate retrieval counters for every entity of one kind in a single
     * query. List views use this instead of issuing one `entityHistory`
     * request per card.
     */
    entityRetrievalStats(kind: string): Record<string, EntityRetrievalStats> {
      const rows = db.prepare<{ kind: string }, EntityRetrievalStatsRaw & { ref_id: string }>(
        `SELECT
           c.ref_id AS ref_id,
           SUM(CASE WHEN r.source='turn_start' THEN 1 ELSE 0 END) AS turn_start_runs,
           SUM(CASE WHEN r.source!='turn_start' THEN 1 ELSE 0 END) AS search_runs,
           COUNT(*) AS candidate_count,
           SUM(c.sent_to_model) AS sent_to_model_count,
           SUM(c.model_kept) AS model_kept_count,
           SUM(c.final_returned) AS final_returned_count,
           SUM(c.adapter_received) AS adapter_received_count
         FROM retrieval_candidates c
         JOIN retrieval_runs r ON r.id=c.run_id
        WHERE c.ref_kind=@kind
        GROUP BY c.ref_id`,
      ).all({ kind: normalizeRefKind(kind) });
      return Object.fromEntries(rows.map((row) => [row.ref_id, mapEntityRetrievalStats(row)]));
    },

    lifecycleChanges(filter: LifecycleChangeFilter): Record<string, unknown> {
      const toMs = filter.toMs ?? Date.now();
      const params = { from_ms: filter.fromMs, to_ms: toMs };
      const rows = db.prepare<typeof params, LifecycleChangeAggregateRaw>(
        `SELECT entity_kind,
                COUNT(DISTINCT CASE
                  WHEN old_state IS NOT NULL AND old_state!='active' AND new_state='active'
                  THEN entity_id END) AS activated,
                COUNT(DISTINCT CASE WHEN new_state='archived' AND old_state!='archived' THEN entity_id END) AS archived,
                COUNT(DISTINCT CASE
                  WHEN old_version IS NOT NULL AND new_version IS NOT NULL AND old_version!=new_version
                  THEN entity_id END) AS evolved,
                COUNT(DISTINCT entity_id) AS changed,
                COUNT(*) AS event_count
           FROM lifecycle_events
          WHERE event_at>=@from_ms AND event_at<@to_ms AND source!='migration'
          GROUP BY entity_kind`,
      ).all(params);
      const kinds: LifecycleEntityKind[] = ["trace", "episode", "policy", "world_model", "skill"];
      const byKind = Object.fromEntries(kinds.map((kind) => {
        const row = rows.find((item) => item.entity_kind === kind);
        return [kind, {
          created: 0,
          activated: row?.activated ?? 0,
          archived: row?.archived ?? 0,
          evolved: row?.evolved ?? 0,
          changed: row?.changed ?? 0,
          eventCount: row?.event_count ?? 0,
        }];
      })) as Record<LifecycleEntityKind, LifecycleChangeCounts>;
      // Creation counts come from the source tables, not lifecycle baselines.
      // This includes freshly-created active World Models and Skills without
      // confusing a migration's first observation with a new object.
      const creationRows = db.prepare<typeof params, { entity_kind: LifecycleEntityKind; created: number }>(
        `SELECT entity_kind, COUNT(*) AS created FROM (
           SELECT 'trace' AS entity_kind, ts AS created_at FROM traces
           UNION ALL SELECT 'episode', started_at FROM episodes
           UNION ALL SELECT 'policy', created_at FROM policies
           UNION ALL SELECT 'world_model', created_at FROM world_model
           UNION ALL SELECT 'skill', created_at FROM skills
         )
         WHERE created_at>=@from_ms AND created_at<@to_ms
         GROUP BY entity_kind`,
      ).all(params);
      for (const row of creationRows) byKind[row.entity_kind].created = row.created;
      const totals = Object.values(byKind).reduce((out, row) => ({
        created: out.created + row.created,
        activated: out.activated + row.activated,
        archived: out.archived + row.archived,
        evolved: out.evolved + row.evolved,
        changed: out.changed + row.changed,
        eventCount: out.eventCount + row.eventCount,
      }), { created: 0, activated: 0, archived: 0, evolved: 0, changed: 0, eventCount: 0 });
      const hourlyRows = db.prepare<typeof params, LifecycleHourlyRaw>(
        `SELECT CAST((event_at-@from_ms)/3600000 AS INTEGER) AS hour_index,
                COUNT(DISTINCT CASE
                  WHEN old_state IS NOT NULL AND old_state!='active' AND new_state='active'
                  THEN entity_kind || ':' || entity_id END) AS activated,
                COUNT(*) AS event_count
           FROM lifecycle_events
          WHERE event_at>=@from_ms AND event_at<@to_ms AND source!='migration'
          GROUP BY hour_index ORDER BY hour_index`,
      ).all(params);
      const creationHourlyRows = db.prepare<typeof params, { hour_index: number; created: number }>(
        `SELECT CAST((created_at-@from_ms)/3600000 AS INTEGER) AS hour_index,
                COUNT(*) AS created
           FROM (
             SELECT ts AS created_at FROM traces
             UNION ALL SELECT started_at FROM episodes
             UNION ALL SELECT created_at FROM policies
             UNION ALL SELECT created_at FROM world_model
             UNION ALL SELECT created_at FROM skills
           )
          WHERE created_at>=@from_ms AND created_at<@to_ms
          GROUP BY hour_index ORDER BY hour_index`,
      ).all(params);
      const currentHour = Math.max(0, Math.min(23, Math.floor((toMs - filter.fromMs) / 3_600_000)));
      const hourly = Array.from({ length: currentHour + 1 }, (_, hour) => {
        const row = hourlyRows.find((item) => item.hour_index === hour);
        const creation = creationHourlyRows.find((item) => item.hour_index === hour);
        return {
          hour,
          created: creation?.created ?? 0,
          activated: row?.activated ?? 0,
          eventCount: row?.event_count ?? 0,
        };
      });
      const recent = db.prepare<{ from_ms: number; to_ms: number; limit: number }, LifecycleRaw>(
        `SELECT * FROM lifecycle_events
          WHERE event_at>=@from_ms AND event_at<@to_ms AND source!='migration'
          ORDER BY event_at DESC, id DESC LIMIT @limit`,
      ).all({ ...params, limit: clamp(filter.limit, 100, 300) }).map(mapLifecycle);
      return {
        timezone: "Asia/Shanghai",
        fromMs: filter.fromMs,
        toMs,
        totals,
        byKind,
        hourly,
        recent,
      };
    },

    summary(now = Date.now()): Record<string, unknown> {
      const since = now - 24 * 60 * 60 * 1_000;
      const counts = db.prepare<{ since: number }, { warnings: number; errors: number }>(
        `SELECT
           SUM(CASE WHEN level='warn' THEN 1 ELSE 0 END) AS warnings,
           SUM(CASE WHEN level IN ('error','fatal') THEN 1 ELSE 0 END) AS errors
         FROM api_logs WHERE called_at >= @since`,
      ).get({ since });
      const warningRows = db.prepare<{ since: number }, { output_json: string }>(
        `SELECT output_json FROM api_logs WHERE called_at >= @since AND level='warn'`,
      ).all({ since });
      const warningDetailCount = warningRows.reduce((total, row) => {
        const output = parseJson<Record<string, unknown>>(row.output_json, {});
        const warnings = Array.isArray(output.warnings) ? output.warnings.length : 0;
        return total + Math.max(1, warnings);
      }, 0);
      const recent = db.prepare<{ since: number }, OperationRaw>(
        `SELECT id, tool_name, input_json, output_json, duration_ms, success,
                called_at, session_id, episode_id, turn_id, level, category,
                phase, reason
           FROM api_logs
          WHERE called_at >= @since AND level IN ('warn','error','fatal')
          ORDER BY called_at DESC, id DESC LIMIT 100`,
      ).all({ since });
      return {
        since,
        warningCount: counts?.warnings ?? 0,
        warningDetailCount,
        errorCount: counts?.errors ?? 0,
        recentIssues: recent.map(mapOperation),
      };
    },

    pruneBefore(cutoffMs: number): { apiLogs: number; retrievalRuns: number } {
      return db.tx(() => {
        const apiLogs = db.prepare<{ cutoff: number }>(
          `DELETE FROM api_logs WHERE called_at < @cutoff`,
        ).run({ cutoff: cutoffMs }).changes;
        const retrievalRuns = db.prepare<{ cutoff: number }>(
          `DELETE FROM retrieval_runs WHERE started_at < @cutoff`,
        ).run({ cutoff: cutoffMs }).changes;
        return { apiLogs, retrievalRuns };
      });
    },
  };
}

function operationWhere(filter: MonitorLogFilter): { where: string[]; params: Record<string, unknown> } {
  const where: string[] = [];
  const params: Record<string, unknown> = {};
  if (filter.fromMs != null) { where.push("called_at >= @from_ms"); params.from_ms = filter.fromMs; }
  if (filter.toMs != null) { where.push("called_at < @to_ms"); params.to_ms = filter.toMs; }
  if (filter.sessionId) {
    if (filter.sessionId === "__system__") where.push("session_id IS NULL");
    else { where.push("session_id=@session_id"); params.session_id = filter.sessionId; }
  }
  if (filter.episodeId) { where.push("episode_id=@episode_id"); params.episode_id = filter.episodeId; }
  if (filter.level) { where.push("level=@level"); params.level = filter.level; }
  if (filter.category) { where.push("category=@category"); params.category = filter.category; }
  return { where, params };
}

function dedupeCandidates(items: RetrievalCandidateInsert[]): RetrievalCandidateInsert[] {
  const out = new Map<string, RetrievalCandidateInsert>();
  for (const item of items) {
    const key = `${item.source ?? "local"}:${item.refKind}:${item.refId}`;
    const previous = out.get(key);
    out.set(key, previous ? {
      ...previous,
      ...item,
      sentToModel: previous.sentToModel || item.sentToModel,
      modelKept: previous.modelKept || item.modelKept,
      finalReturned: previous.finalReturned || item.finalReturned,
    } : item);
  }
  return [...out.values()];
}

function mapOperation(row: OperationRaw): Record<string, unknown> {
  return {
    id: row.id,
    toolName: row.tool_name,
    input: parseJson(row.input_json, {}),
    output: parseJson(row.output_json, row.output_json),
    durationMs: row.duration_ms,
    success: !!row.success,
    calledAt: row.called_at,
    sessionId: row.session_id,
    episodeId: row.episode_id,
    turnId: row.turn_id,
    level: row.level,
    category: row.category,
    phase: row.phase,
    reason: row.reason,
  };
}

function mapRetrievalRun(row: RetrievalRunRaw): Record<string, unknown> {
  return {
    id: row.id,
    source: row.source,
    agent: row.agent,
    sessionId: row.session_id,
    episodeId: row.episode_id,
    turnId: row.turn_id,
    queryText: row.query_text,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    durationMs: row.duration_ms,
    status: row.status,
    rawCandidateCount: row.raw_candidate_count,
    sentToModelCount: row.sent_to_model_count,
    modelKeptCount: row.model_kept_count,
    finalReturnedCount: row.final_returned_count,
    adapterReceivedCount: row.adapter_received_count,
    acknowledgedAt: row.acknowledged_at,
    acknowledgedBy: row.acknowledged_by,
    deliveredRefIds: parseJson<string[]>(row.delivered_ids_json, []),
    error: row.error,
    detail: parseJson(row.detail_json, {}),
  };
}

function mapRetrievalCandidate(row: RetrievalCandidateRaw): Record<string, unknown> {
  return {
    id: row.id,
    source: row.source,
    tier: row.tier,
    refKind: row.ref_kind,
    refId: row.ref_id,
    score: row.score,
    relevance: row.relevance,
    initialRank: row.initial_rank,
    modelRank: row.model_rank,
    finalRank: row.final_rank,
    sentToModel: !!row.sent_to_model,
    modelKept: !!row.model_kept,
    finalReturned: !!row.final_returned,
    adapterReceived: !!row.adapter_received,
    decision: row.decision,
    reason: row.reason,
    summary: row.summary,
    detail: parseJson(row.detail_json, {}),
  };
}

function mapLifecycle(row: LifecycleRaw): Record<string, unknown> {
  return {
    id: row.id,
    entityKind: row.entity_kind,
    entityId: row.entity_id,
    oldState: row.old_state,
    newState: row.new_state,
    eventAt: row.event_at,
    reason: row.reason,
    source: row.source,
    sessionId: row.session_id,
    episodeId: row.episode_id,
    turnId: row.turn_id,
    oldVersion: row.old_version,
    newVersion: row.new_version,
    detail: parseJson(row.detail_json, {}),
  };
}

function parseJson<T>(text: string, fallback: T): T {
  try { return JSON.parse(text) as T; } catch { return fallback; }
}

function safeJson(value: unknown): string {
  try { return JSON.stringify(value ?? {}); } catch { return "{}"; }
}

function finite(value: number | undefined): number {
  return Number.isFinite(value) ? Number(value) : 0;
}

function nullableFinite(value: number | null | undefined): number | null {
  return Number.isFinite(value) ? Number(value) : null;
}

function clamp(value: number | undefined, fallback: number, max: number): number {
  return Math.max(1, Math.min(max, Math.floor(value ?? fallback)));
}

function encodeCursor(ts: number, id: number): string {
  return Buffer.from(`${ts}:${id}`, "utf8").toString("base64url");
}

function decodeCursor(value?: string): { ts: number; id: number } | null {
  if (!value) return null;
  try {
    const [ts, id] = Buffer.from(value, "base64url").toString("utf8").split(":").map(Number);
    return Number.isFinite(ts) && Number.isFinite(id) ? { ts: ts!, id: id! } : null;
  } catch { return null; }
}

function encodeTextCursor(ts: number, id: string): string {
  return Buffer.from(JSON.stringify([ts, id]), "utf8").toString("base64url");
}

function decodeTextCursor(value?: string): { ts: number; id: string } | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    return Array.isArray(parsed) && Number.isFinite(parsed[0]) && typeof parsed[1] === "string"
      ? { ts: parsed[0], id: parsed[1] }
      : null;
  } catch { return null; }
}

function normalizeRefKind(kind: string): string {
  if (kind === "world_model") return "world-model";
  if (kind === "policy") return "experience";
  return kind;
}

interface OperationRaw {
  id: number; tool_name: string; input_json: string; output_json: string;
  duration_ms: number; success: number; called_at: number; session_id: string | null;
  episode_id: string | null; turn_id: string | null; level: string; category: string;
  phase: string | null; reason: string | null;
}

interface SessionSummaryRaw {
  session_id: string; started_at: number | null; last_activity_at: number;
  session_last_seen_at: number | null; ended_at: number | null;
  episode_count: number; operation_count: number;
  retrieval_count: number; warning_count: number; error_count: number;
}

interface RetrievalRunRaw {
  id: string; source: string; agent: string; session_id: string | null;
  episode_id: string | null; turn_id: string | null; query_text: string;
  started_at: number; completed_at: number | null; duration_ms: number; status: string;
  raw_candidate_count: number; sent_to_model_count: number; model_kept_count: number;
  final_returned_count: number; adapter_received_count: number;
  acknowledged_at: number | null; acknowledged_by: string | null;
  delivered_ids_json: string; error: string | null; detail_json: string;
}

interface RetrievalCandidateRaw {
  id: number; source: string; tier: number; ref_kind: string; ref_id: string;
  score: number; relevance: number | null; initial_rank: number | null;
  model_rank: number | null; final_rank: number | null; sent_to_model: number;
  model_kept: number; final_returned: number; adapter_received: number;
  decision: string; reason: string | null; summary: string; detail_json: string;
}

interface LifecycleRaw {
  id: number; entity_kind: string; entity_id: string; old_state: string | null;
  new_state: string; event_at: number; reason: string; source: string;
  session_id: string | null; episode_id: string | null; turn_id: string | null;
  old_version: number | null; new_version: number | null; detail_json: string;
}

interface EntityRetrievalStatsRaw {
  turn_start_runs: number | null; search_runs: number | null; candidate_count: number;
  sent_to_model_count: number | null; model_kept_count: number | null;
  final_returned_count: number | null; adapter_received_count: number | null;
}

interface LifecycleChangeAggregateRaw {
  entity_kind: LifecycleEntityKind;
  activated: number;
  archived: number;
  evolved: number;
  changed: number;
  event_count: number;
}

interface LifecycleHourlyRaw {
  hour_index: number;
  activated: number;
  event_count: number;
}

interface LifecycleChangeCounts {
  created: number;
  activated: number;
  archived: number;
  evolved: number;
  changed: number;
  eventCount: number;
}

export interface EntityRetrievalStats {
  turnStartRuns: number;
  searchRuns: number;
  candidateCount: number;
  sentToModelCount: number;
  modelKeptCount: number;
  finalReturnedCount: number;
  adapterReceivedCount: number;
}

function mapEntityRetrievalStats(row?: EntityRetrievalStatsRaw): EntityRetrievalStats {
  return {
    turnStartRuns: row?.turn_start_runs ?? 0,
    searchRuns: row?.search_runs ?? 0,
    candidateCount: row?.candidate_count ?? 0,
    sentToModelCount: row?.sent_to_model_count ?? 0,
    modelKeptCount: row?.model_kept_count ?? 0,
    finalReturnedCount: row?.final_returned_count ?? 0,
    adapterReceivedCount: row?.adapter_received_count ?? 0,
  };
}
