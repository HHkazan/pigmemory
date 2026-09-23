import {
  copyFileSync,
  mkdtempSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  parseShanghaiDateBoundary,
  startOfShanghaiDay,
} from "../../server/routes/monitor.js";
import { openDb } from "../../core/storage/connection.js";
import {
  defaultMigrationsDir,
  runMigrations,
} from "../../core/storage/migrator.js";
import { makeRepos } from "../../core/storage/repos/index.js";

describe("monitoring observability", () => {
  it("counts warning operations separately from nested warning details", () => {
    const db = openDb({ filepath: ":memory:", agent: "test", wal: false });
    try {
      runMigrations(db);
      const repos = makeRepos(db);
      repos.apiLogs.insert({
        toolName: "memory_add",
        input: {},
        output: { warnings: [{ message: "one" }, { message: "two" }, { message: "three" }] },
        durationMs: 1,
        success: true,
        level: "warn",
        calledAt: 1_000,
      });
      const summary = repos.observability.summary(2_000) as Record<string, unknown>;
      expect(summary).toMatchObject({ warningCount: 1, warningDetailCount: 3, errorCount: 0 });
    } finally {
      db.close();
    }
  });

  it("migrates explicit legacy context and creates honest lifecycle baselines", () => {
    const stagedDir = mkdtempSync(join(tmpdir(), "memos-monitor-migrations-"));
    const db = openDb({ filepath: ":memory:", agent: "test", wal: false });
    try {
      for (const filename of readdirSync(defaultMigrationsDir())) {
        if (/^0(0[1-9]|1[0-4])-.*\.sql$/.test(filename)) {
          copyFileSync(join(defaultMigrationsDir(), filename), join(stagedDir, filename));
        }
      }
      runMigrations(db, stagedDir);
      db.exec(`
        INSERT INTO sessions (id, agent, started_at, last_seen_at, meta_json)
        VALUES ('session-explicit', 'hermes', 900, 1500, '{}');
        INSERT INTO episodes (id, session_id, started_at, status, meta_json)
        VALUES ('episode-1', 'session-explicit', 1000, 'open', '{"topicState":"interrupted"}');
        INSERT INTO traces
          (id, episode_id, session_id, ts, user_text, agent_text, reflection, turn_id)
        VALUES
          ('trace-1', 'episode-1', 'session-explicit', 1100, 'user', 'agent', 'reviewed', 1100);
        INSERT INTO api_logs
          (tool_name, input_json, output_json, duration_ms, success, called_at)
        VALUES
          ('memos_search',
           '{"sessionId":"session-explicit","episodeId":"episode-1","turnId":1100,"phase":"done"}',
           '{"reason":"explicit evidence"}', 4, 1, 1200),
          ('system_probe', '{}', '', 2, 1, 1300);
      `);

      const result = runMigrations(db);
      expect(result.applied.map((item) => item.version)).toEqual([15, 16, 17, 18, 19]);

      const logs = db.raw.prepare(`
        SELECT session_id, episode_id, turn_id, category, phase, reason
          FROM api_logs ORDER BY id
      `).all() as Array<Record<string, unknown>>;
      expect(logs[0]).toMatchObject({
        session_id: "session-explicit",
        episode_id: "episode-1",
        turn_id: "1100",
        category: "retrieval",
        phase: "done",
        reason: "explicit evidence",
      });
      expect(logs[1]).toMatchObject({ session_id: null, episode_id: null, turn_id: null });

      const baselines = db.raw.prepare(`
        SELECT entity_kind, entity_id, old_state, new_state, event_at, reason, source
          FROM lifecycle_events ORDER BY entity_kind
      `).all() as Array<Record<string, unknown>>;
      expect(baselines).toEqual(expect.arrayContaining([
        expect.objectContaining({
          entity_kind: "episode",
          entity_id: "episode-1",
          old_state: null,
          new_state: "interrupted",
          reason: "migration_first_observation",
          source: "migration",
        }),
        expect.objectContaining({
          entity_kind: "trace",
          entity_id: "trace-1",
          old_state: null,
          new_state: "reflected",
          reason: "migration_first_observation",
          source: "migration",
        }),
      ]));
      expect(baselines.every((event) => Number(event.event_at) > 1500)).toBe(true);
    } finally {
      db.close();
      rmSync(stagedDir, { recursive: true, force: true });
    }
  });

  it("tracks every retrieval candidate, adapter receipt, and durable history", () => {
    const db = openDb({ filepath: ":memory:", agent: "test", wal: false });
    try {
      runMigrations(db);
      const repos = makeRepos(db);
      repos.observability.appendLifecycle({
        entityKind: "trace",
        entityId: "trace-1",
        newState: "captured",
        eventAt: 1000,
        reason: "capture_completed",
        sessionId: "session-1",
      });
      expect(() => repos.observability.appendLifecycle({
        entityKind: "skill",
        entityId: "skill-invalid",
        newState: "active",
        reason: "missing_previous_state",
      })).toThrow();
      expect(() => repos.observability.appendLifecycle({
        entityKind: "skill",
        entityId: "skill-1",
        oldState: "candidate",
        newState: "active",
        eventAt: 1500,
        reason: "verification_passed",
      })).not.toThrow();
      const runId = repos.observability.startRetrieval({
        id: "run-1",
        source: "turn_start",
        agent: "hermes",
        sessionId: "session-1",
        queryText: "q".repeat(1200),
        startedAt: 2000,
      });
      repos.observability.finishRetrieval({
        id: runId,
        status: "completed",
        completedAt: 2060,
        candidates: [
          {
            source: "local",
            tier: 1,
            refKind: "trace",
            refId: "trace-1",
            score: 0.91,
            relevance: 0.88,
            initialRank: 1,
            modelRank: 1,
            finalRank: 1,
            sentToModel: true,
            modelKept: true,
            finalReturned: true,
            decision: "returned",
            reason: "model_kept",
            summary: "kept",
          },
          {
            source: "shared",
            tier: 2,
            refKind: "experience",
            refId: "policy-1",
            score: 0.2,
            initialRank: 2,
            decision: "dropped",
            reason: "below_threshold",
            summary: "x".repeat(700),
          },
        ],
      });
      expect(repos.observability.acknowledge({
        runId,
        source: "hermes.adapter",
        sessionId: "session-1",
        deliveredRefIds: ["trace-1", "not-a-candidate"],
        at: 2100,
      })).toBe(true);
      expect(repos.observability.acknowledge({
        runId: "missing",
        source: "hermes.adapter",
        deliveredRefIds: [],
      })).toBe(false);

      const detail = repos.observability.retrievalRun(runId) as {
        queryText: string;
        rawCandidateCount: number;
        sentToModelCount: number;
        modelKeptCount: number;
        finalReturnedCount: number;
        adapterReceivedCount: number;
        candidates: Array<{ refId: string; adapterReceived: boolean; summary: string }>;
      };
      expect(detail.queryText).toHaveLength(1000);
      expect(detail).toMatchObject({
        rawCandidateCount: 2,
        sentToModelCount: 1,
        modelKeptCount: 1,
        finalReturnedCount: 1,
        adapterReceivedCount: 1,
      });
      expect(detail.candidates).toHaveLength(2);
      expect(detail.candidates.find((item) => item.refId === "trace-1")?.adapterReceived).toBe(true);
      expect(detail.candidates.find((item) => item.refId === "policy-1")?.summary).toHaveLength(500);

      const history = repos.observability.entityHistory("trace", "trace-1") as {
        lifecycle: unknown[];
        retrievalStats: Record<string, number>;
        retrievalRuns: unknown[];
      };
      expect(history.lifecycle).toHaveLength(1);
      expect(history.retrievalStats).toMatchObject({
        turnStartRuns: 1,
        searchRuns: 0,
        candidateCount: 1,
        sentToModelCount: 1,
        modelKeptCount: 1,
        finalReturnedCount: 1,
        adapterReceivedCount: 1,
      });
      expect(history.retrievalRuns).toHaveLength(1);
      expect(repos.observability.entityRetrievalStats("trace")).toMatchObject({
        "trace-1": {
          candidateCount: 1,
          finalReturnedCount: 1,
          adapterReceivedCount: 1,
        },
      });
      expect(repos.observability.entityRetrievalStats("policy")).toMatchObject({
        "policy-1": {
          candidateCount: 1,
          finalReturnedCount: 0,
        },
      });
    } finally {
      db.close();
    }
  });

  it("persists a Policy exposure only after final delivery is acknowledged", () => {
    const db = openDb({ filepath: ":memory:", agent: "test", wal: false });
    try {
      runMigrations(db);
      const repos = makeRepos(db);
      db.exec(`
        INSERT INTO sessions (id, agent, started_at, last_seen_at)
        VALUES ('session-policy', 'hermes', 1000, 2000);
        INSERT INTO episodes (id, session_id, started_at, status)
        VALUES ('episode-policy', 'session-policy', 1100, 'open');
        INSERT INTO policies
          (id, title, trigger, procedure, verification, boundary, created_at, updated_at)
        VALUES
          ('policy-delivered', 'Delivered', 'trigger', 'procedure', 'verify', 'boundary', 1200, 1200),
          ('policy-dropped', 'Dropped', 'trigger', 'procedure', 'verify', 'boundary', 1200, 1200);
      `);
      const runId = repos.observability.startRetrieval({
        id: "run-policy",
        source: "turn_start",
        agent: "hermes",
        sessionId: "session-policy",
        episodeId: "episode-policy",
        queryText: "policy query",
        startedAt: 1300,
      });
      repos.observability.finishRetrieval({
        id: runId,
        status: "completed",
        completedAt: 1400,
        candidates: [
          {
            tier: 2,
            refKind: "experience",
            refId: "policy-delivered",
            finalReturned: true,
          },
          {
            tier: 2,
            refKind: "experience",
            refId: "policy-dropped",
            finalReturned: false,
          },
        ],
      });

      expect(repos.policies.getExposedPolicyIdsForEpisode("episode-policy")).toEqual([]);
      expect(repos.observability.acknowledge({
        runId,
        source: "hermes.adapter",
        deliveredRefIds: ["policy-delivered", "policy-dropped"],
        at: 1500,
      })).toBe(true);
      expect(repos.policies.getExposedPolicyIdsForEpisode("episode-policy")).toEqual([
        "policy-delivered",
      ]);
    } finally {
      db.close();
    }
  });

  it("prunes 90-day operational detail without deleting lifecycle or audit history", () => {
    const db = openDb({ filepath: ":memory:", agent: "test", wal: false });
    try {
      runMigrations(db);
      const repos = makeRepos(db);
      repos.apiLogs.insert({
        toolName: "system_old",
        input: {},
        output: {},
        durationMs: 1,
        success: true,
        calledAt: 1000,
      });
      repos.observability.appendLifecycle({
        entityKind: "episode",
        entityId: "episode-old",
        newState: "closed",
        eventAt: 1000,
        reason: "episode_finalized",
      });
      repos.observability.startRetrieval({
        id: "old-run",
        source: "search",
        agent: "test",
        queryText: "old",
        startedAt: 1000,
      });
      db.exec(`
        INSERT INTO audit_events (ts, actor, kind, target, detail_json)
        VALUES (1000, 'system', 'monitor.test', 'episode-old', '{}')
      `);

      expect(repos.observability.pruneBefore(2000)).toEqual({
        apiLogs: 1,
        retrievalRuns: 1,
      });
      expect(db.raw.prepare("SELECT COUNT(*) AS n FROM lifecycle_events").get()).toEqual({ n: 1 });
      expect(db.raw.prepare("SELECT COUNT(*) AS n FROM audit_events").get()).toEqual({ n: 1 });
      expect(db.raw.prepare("SELECT COUNT(*) AS n FROM retrieval_candidates").get()).toEqual({ n: 0 });
    } finally {
      db.close();
    }
  });

  it("keeps session and log cursor pages stable, including tied timestamps", () => {
    const db = openDb({ filepath: ":memory:", agent: "test", wal: false });
    try {
      runMigrations(db);
      const repos = makeRepos(db);
      for (const id of ["session-1", "session-2", "session-3"] as const) {
        repos.sessions.upsert({
          id,
          agent: "hermes",
          startedAt: 10,
          lastSeenAt: 400,
          meta: {},
        });
      }
      db.exec(`
        INSERT INTO episodes (id, session_id, started_at, ended_at, status)
        VALUES ('episode-1', 'session-1', 20, 180, 'closed');
        INSERT INTO episodes (id, session_id, started_at, status)
        VALUES ('episode-2', 'session-2', 20, 'open');
      `);
      repos.apiLogs.insert({
        toolName: "system_probe",
        input: {},
        output: {},
        durationMs: 1,
        success: true,
        calledAt: 200,
        sessionId: "session-2",
      });
      repos.apiLogs.insert({
        toolName: "system_probe",
        input: {},
        output: {},
        durationMs: 1,
        success: false,
        calledAt: 200,
        sessionId: "session-2",
        level: "warn",
      });
      repos.apiLogs.insert({
        toolName: "system_probe",
        input: {},
        output: {},
        durationMs: 1,
        success: true,
        calledAt: 200,
        sessionId: "session-3",
      });
      repos.observability.startRetrieval({
        id: "session-1-run",
        source: "search",
        agent: "hermes",
        sessionId: "session-1",
        queryText: "latest",
        startedAt: 300,
      });

      const first = repos.observability.monitorSessions({ limit: 1 }) as {
        sessions: Array<Record<string, unknown>>;
        nextCursor?: string;
      };
      const second = repos.observability.monitorSessions({
        limit: 1,
        cursor: first.nextCursor,
      }) as typeof first;
      const third = repos.observability.monitorSessions({
        limit: 1,
        cursor: second.nextCursor,
      }) as typeof first;
      expect([
        first.sessions[0]?.sessionId,
        second.sessions[0]?.sessionId,
        third.sessions[0]?.sessionId,
      ]).toEqual(["session-1", "session-3", "session-2"]);
      expect(first.sessions[0]).toMatchObject({
        endedAt: 180,
        retrievalCount: 1,
        episodeCount: 1,
      });
      expect(third.sessions[0]).toMatchObject({
        endedAt: null,
        operationCount: 2,
        warningCount: 1,
        episodeCount: 1,
      });

      const logPage1 = repos.observability.monitorLogs({
        sessionId: "session-2",
        limit: 1,
      }) as { logs: Array<{ id: number }>; nextCursor?: string };
      const logPage2 = repos.observability.monitorLogs({
        sessionId: "session-2",
        limit: 1,
        cursor: logPage1.nextCursor,
      }) as typeof logPage1;
      expect(logPage1.logs[0]?.id).not.toBe(logPage2.logs[0]?.id);
    } finally {
      db.close();
    }
  });

  it("uses Beijing natural-day boundaries while keeping UTC epoch milliseconds", () => {
    expect(parseShanghaiDateBoundary("2026-08-07", false)).toBe(
      Date.UTC(2026, 7, 6, 16, 0, 0, 0),
    );
    expect(parseShanghaiDateBoundary("2026-08-07", true)).toBe(
      Date.UTC(2026, 7, 7, 16, 0, 0, 0),
    );
    expect(startOfShanghaiDay(Date.parse("2026-08-07T13:25:00.000+08:00"))).toBe(
      Date.parse("2026-08-07T00:00:00.000+08:00"),
    );
  });

  it("reports today's real creations separately from lifecycle transitions", () => {
    const db = openDb({ filepath: ":memory:", agent: "test", wal: false });
    try {
      runMigrations(db);
      const repos = makeRepos(db);
      db.exec(`
        INSERT INTO sessions (id, agent, started_at, last_seen_at)
        VALUES ('session-today', 'hermes', 1000, 1999);
        INSERT INTO episodes (id, session_id, started_at)
        VALUES ('episode-today', 'session-today', 1200);
        INSERT INTO traces
          (id, episode_id, session_id, ts, user_text, agent_text, turn_id)
        VALUES
          ('trace-today', 'episode-today', 'session-today', 1300, 'user', 'agent', 1300);
        INSERT INTO policies
          (id, title, trigger, procedure, verification, boundary, created_at, updated_at)
        VALUES
          ('policy-today', 'Policy', 'trigger', 'procedure', 'verify', 'boundary', 1400, 1400);
        INSERT INTO world_model (id, title, body, created_at, updated_at)
        VALUES ('world-today', 'World', 'body', 1500, 1500);
        INSERT INTO skills (id, name, invocation_guide, created_at, updated_at)
        VALUES ('skill-today', 'Skill', 'guide', 1600, 1600);
      `);
      repos.observability.appendLifecycle({
        entityKind: "policy",
        entityId: "policy-today",
        oldState: "candidate",
        newState: "active",
        eventAt: 1700,
        reason: "verification_passed",
      });
      repos.observability.appendLifecycle({
        entityKind: "skill",
        entityId: "skill-today",
        oldState: "candidate",
        newState: "active",
        eventAt: 1750,
        reason: "trial_passed",
      });
      repos.observability.appendLifecycle({
        entityKind: "world_model",
        entityId: "world-today",
        oldState: "active",
        newState: "active",
        oldVersion: 1,
        newVersion: 2,
        eventAt: 1800,
        reason: "cluster_updated",
      });
      repos.observability.appendLifecycle({
        entityKind: "policy",
        entityId: "policy-today",
        oldState: "active",
        newState: "archived",
        eventAt: 1850,
        reason: "superseded",
      });
      repos.observability.appendLifecycle({
        entityKind: "episode",
        entityId: "episode-today",
        oldState: "open",
        newState: "closed",
        eventAt: 1900,
        reason: "episode_finalized",
      });
      repos.observability.appendLifecycle({
        entityKind: "trace",
        entityId: "trace-today",
        newState: "captured",
        eventAt: 1950,
        reason: "migration_first_observation",
        source: "migration",
      });

      const changes = repos.observability.lifecycleChanges({
        fromMs: 1000,
        toMs: 2000,
      }) as {
        totals: Record<string, number>;
        byKind: Record<string, Record<string, number>>;
        hourly: Array<Record<string, number>>;
        recent: Array<{ source: string }>;
      };
      expect(changes.totals).toEqual({
        created: 5,
        activated: 2,
        archived: 1,
        evolved: 1,
        changed: 4,
        eventCount: 5,
      });
      expect(changes.byKind.policy).toMatchObject({
        created: 1,
        activated: 1,
        archived: 1,
        changed: 1,
        eventCount: 2,
      });
      expect(changes.byKind.trace).toMatchObject({
        created: 1,
        changed: 0,
        eventCount: 0,
      });
      expect(changes.byKind.world_model).toMatchObject({ created: 1, evolved: 1 });
      expect(changes.hourly).toEqual([{ hour: 0, created: 5, activated: 2, eventCount: 5 }]);
      expect(changes.recent.every((event) => event.source !== "migration")).toBe(true);
    } finally {
      db.close();
    }
  });
});
