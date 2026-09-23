import { describe, expect, it } from "vitest";

import type { Logger } from "../../core/logger/types.js";
import { createL2EventBus } from "../../core/memory/l2/events.js";
import { createRewardEventBus } from "../../core/reward/events.js";
import { createSkillEventBus } from "../../core/skill/events.js";
import { attachSkillSubscriber } from "../../core/skill/subscriber.js";
import { makeRepos, openDb, runMigrations } from "../../core/storage/index.js";
import type { SkillRow } from "../../core/types.js";

const log = {
  channel: "test",
  child() { return this; },
  trace() {},
  debug() {},
  info() {},
  warn() {},
  error() {},
  fatal() {},
  audit() {},
  llm() {},
  timer() { return { end() {}, [Symbol.dispose]() {} }; },
  forward() {},
} as unknown as Logger;

function skill(id: string): SkillRow {
  return {
    id,
    name: id,
    status: "candidate",
    invocationGuide: "guide",
    procedureJson: {},
    eta: 0.8,
    support: 2,
    gain: 0.4,
    trialsAttempted: 0,
    trialsPassed: 0,
    sourcePolicyIds: [],
    sourceWorldModelIds: [],
    evidenceAnchors: [],
    vec: null,
    createdAt: 1,
    updatedAt: 1,
    version: 2,
    supersedesSkillId: null,
    sourcePolicyContentVersions: {},
    contentFingerprint: `fingerprint-${id}`,
    trialVersion: 2,
    usageCount: 0,
    lastUsedAt: null,
  } as SkillRow;
}

describe("skill trial versions", () => {
  it("invalidates pending trials from an older in-place candidate version", () => {
    const db = openDb({ filepath: ":memory:", agent: "test", wal: false });
    runMigrations(db);
    const repos = makeRepos(db);
    repos.skills.insert(skill("skill-rebuilt"));
    repos.sessions.upsert({
      id: "session-rebuilt",
      agent: "hermes",
      startedAt: 1,
      lastSeenAt: 1,
      meta: {},
    } as Parameters<typeof repos.sessions.upsert>[0]);
    repos.episodes.insert({
      id: "episode-old",
      sessionId: "session-rebuilt",
      startedAt: 1,
      endedAt: null,
      traceIds: [],
      rTask: 0,
      status: "open",
      meta: {},
    } as Parameters<typeof repos.episodes.insert>[0]);
    repos.skillTrials.createPending({
      id: "trial-old",
      skillId: "skill-rebuilt",
      sessionId: null,
      episodeId: "episode-old",
      traceId: null,
      turnId: null,
      toolCallId: null,
      status: "pending",
      createdAt: 1,
      resolvedAt: null,
      evidence: {},
      skillVersion: 1,
    } as Parameters<typeof repos.skillTrials.createPending>[0]);

    expect(repos.skillTrials.invalidatePendingForSkillVersion(
      "skill-rebuilt",
      2,
      10,
    )).toBe(1);
    const row = db.raw.prepare(
      "SELECT status, resolved_at, evidence_json FROM skill_trials WHERE id='trial-old'",
    ).get() as { status: string; resolved_at: number; evidence_json: string };
    expect(row.status).toBe("unknown");
    expect(row.resolved_at).toBe(10);
    expect(JSON.parse(row.evidence_json)).toEqual({ reason: "skill_version_rebuilt" });
    db.close();
  });

  it("activates only a current-version pass and resolves stale or neutral trials as unknown", async () => {
    const db = openDb({ filepath: ":memory:", agent: "test", wal: false });
    runMigrations(db);
    const repos = makeRepos(db);
    repos.sessions.upsert({
      id: "session-1",
      agent: "hermes",
      startedAt: 1,
      lastSeenAt: 1,
      meta: {},
    } as Parameters<typeof repos.sessions.upsert>[0]);
    const cases = [
      { skillId: "skill-pass", episodeId: "episode-pass", trialVersion: 2, reward: 1 },
      { skillId: "skill-neutral", episodeId: "episode-neutral", trialVersion: 2, reward: 0 },
      { skillId: "skill-stale", episodeId: "episode-stale", trialVersion: 1, reward: 1 },
    ];
    for (const item of cases) {
      repos.episodes.insert({
        id: item.episodeId,
        sessionId: "session-1",
        startedAt: 1,
        endedAt: 2,
        traceIds: [],
        rTask: item.reward,
        status: "closed",
        meta: {},
      } as Parameters<typeof repos.episodes.insert>[0]);
      repos.skills.insert(skill(item.skillId));
      repos.skillTrials.createPending({
        id: `trial-${item.skillId}`,
        skillId: item.skillId,
        sessionId: "session-1",
        episodeId: item.episodeId,
        traceId: null,
        turnId: null,
        toolCallId: null,
        status: "pending",
        createdAt: 1,
        resolvedAt: null,
        evidence: {},
        skillVersion: item.trialVersion,
      } as Parameters<typeof repos.skillTrials.createPending>[0]);
    }

    const rewardBus = createRewardEventBus();
    const subscriber = attachSkillSubscriber({
      repos,
      embedder: null,
      llm: null,
      log,
      bus: createSkillEventBus(),
      l2Bus: createL2EventBus(),
      rewardBus,
      config: {
        minSupport: 1,
        minGain: 0,
        candidateTrials: 1,
        candidateTtlDays: 30,
        cooldownMs: 0,
        traceCharCap: 500,
        evidenceLimit: 6,
        useLlm: false,
        etaDelta: 0.1,
        archiveEta: 0.1,
        minEtaForRetrieval: 0.1,
      },
    });

    for (const item of cases) {
      rewardBus.emit({
        kind: "reward.updated",
        result: {
          episodeId: item.episodeId,
          sessionId: "session-1",
          rHuman: item.reward,
          completedAt: 10,
        },
      } as never);
    }
    await subscriber.flush();

    expect(repos.skills.getById("skill-pass")?.status).toBe("active");
    expect(repos.skills.getById("skill-pass")?.trialsAttempted).toBe(1);
    expect(repos.skills.getById("skill-neutral")?.status).toBe("candidate");
    expect(repos.skills.getById("skill-neutral")?.trialsAttempted).toBe(0);
    expect(repos.skills.getById("skill-stale")?.status).toBe("candidate");
    expect(repos.skills.getById("skill-stale")?.trialsAttempted).toBe(0);
    const trialRows = db.raw.prepare(
      "SELECT skill_id, status FROM skill_trials ORDER BY skill_id",
    ).all();
    expect(trialRows).toEqual([
      { skill_id: "skill-neutral", status: "unknown" },
      { skill_id: "skill-pass", status: "pass" },
      { skill_id: "skill-stale", status: "unknown" },
    ]);
    subscriber.dispose();
    db.close();
  });
});
