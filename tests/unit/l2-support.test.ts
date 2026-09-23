import { describe, expect, it } from "vitest";

import type { Logger } from "../../core/logger/types.js";
import {
  actualGainWeight,
  blendPolicyGains,
  computeGain,
} from "../../core/memory/l2/gain.js";
import { runL2 } from "../../core/memory/l2/l2.js";
import { makeRepos, openDb, runMigrations } from "../../core/storage/index.js";

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

describe("runL2 support", () => {
  it("starts actual correction at two uses and caps it at ninety percent", () => {
    expect(actualGainWeight(0)).toBe(0);
    expect(actualGainWeight(1)).toBe(0);
    expect(actualGainWeight(2)).toBeCloseTo(0.4);
    expect(actualGainWeight(3)).toBeCloseTo(2 / 3.5);
    expect(actualGainWeight(10)).toBeCloseTo(9 / 10.5);
    expect(actualGainWeight(10_000)).toBe(0.9);
    expect(blendPolicyGains({
      baseGain: 0.1,
      actualGain: 0.3,
      actualUsageCount: 2,
    }).gain).toBeCloseTo(0.18);
    expect(blendPolicyGains({
      baseGain: 0.1,
      actualGain: null,
      actualUsageCount: 1,
    }).gain).toBe(0.1);
  });

  it("gives each episode one gain observation regardless of trace count", () => {
    const result = computeGain({
      policyId: "policy-1" as never,
      withTraces: Array.from({ length: 20 }, () => ({
        episodeId: "episode-with" as never,
        value: 0.8,
      })),
      withoutTraces: [
        { episodeId: "episode-with" as never, value: -1 },
        { episodeId: "episode-without" as never, value: 0.2 },
      ],
    }, { tauSoftmax: 0.2 });

    expect(result.withCount).toBe(1);
    expect(result.withMean).toBeCloseTo(0.8);
    expect(result.withoutCount).toBe(1);
    expect(result.withoutMean).toBeCloseTo(0.2);
  });

  it("counts distinct episodes rather than trace links", async () => {
    const db = openDb({ filepath: ":memory:", agent: "test", wal: false });
    runMigrations(db);
    const repos = makeRepos(db);
    const vec = new Float32Array([1, 0]);
    const policyId = "policy-1" as Parameters<typeof repos.policies.getById>[0];

    repos.sessions.upsert({
      id: "session-1",
      agent: "hermes",
      startedAt: 1,
      lastSeenAt: 1,
      meta: {},
    } as Parameters<typeof repos.sessions.upsert>[0]);
    repos.episodes.insert({
      id: "episode-1",
      sessionId: "session-1",
      startedAt: 1,
      endedAt: 2,
      traceIds: Array.from({ length: 20 }, (_, index) => `trace-${index + 1}`),
      rTask: 0.8,
      status: "closed",
      meta: {},
    } as Parameters<typeof repos.episodes.insert>[0]);
    const makeTrace = (id: string, episodeId = "episode-1", ts = 1) => ({
      id,
      episodeId,
      sessionId: "session-1",
      ts,
      userText: "task",
      agentText: "done",
      summary: "done",
      toolCalls: [],
      reflection: "worked",
      value: 0.8,
      alpha: 1,
      rHuman: 0.8,
      priority: 0.8,
      tags: ["x"],
      errorSignatures: [],
      vecSummary: vec,
      vecAction: null,
      share: null,
      turnId: 1,
      schemaVersion: 1,
    }) as Parameters<typeof repos.traces.insert>[0];
    const traces = Array.from(
      { length: 20 },
      (_, index) => makeTrace(`trace-${index + 1}`, "episode-1", index + 1),
    );
    for (const trace of traces) repos.traces.insert(trace);
    repos.policies.insert({
      id: policyId,
      title: "Policy",
      trigger: "x task",
      procedure: "do it",
      verification: "done",
      boundary: "x",
      support: 0,
      gain: 0,
      status: "candidate",
      confidence: 0.8,
      sourceEpisodeIds: [],
      inducedBy: "test",
      decisionGuidance: { preference: [], antiPattern: [] },
      vec,
      createdAt: 1,
      updatedAt: 1,
    } as Parameters<typeof repos.policies.insert>[0]);
    repos.policies.insert({
      id: "policy-unlinked",
      title: "Legacy unlinked policy",
      trigger: "unrelated",
      procedure: "none",
      verification: "none",
      boundary: "none",
      support: 2,
      gain: 100,
      status: "candidate",
      confidence: 0.8,
      sourceEpisodeIds: ["episode-1"],
      inducedBy: "test",
      decisionGuidance: { preference: [], antiPattern: [] },
      vec: null,
      createdAt: 1,
      updatedAt: 1,
    } as Parameters<typeof repos.policies.insert>[0]);

    const deps = {
      repos,
      db,
      llm: null,
      log,
      config: {
        minSimilarity: 0.5,
        candidateTtlDays: 30,
        gamma: 0.9,
        tauSoftmax: 0.2,
        useLlm: false,
        minTraceValue: 0,
        minEpisodesForInduction: 2,
        inductionTraceCharCap: 4_000,
        gainEmaAlpha: 0.5,
      },
      thresholds: { minSupport: 99, minGain: 99, archiveGain: -1 },
    } as Parameters<typeof runL2>[1];
    const input = {
      episodeId: "episode-1",
      sessionId: "session-1",
      traces,
      trigger: "manual",
      now: 10,
    } as Parameters<typeof runL2>[0];

    await runL2(input, deps);
    expect(repos.policies.getById(policyId)?.support).toBe(1);
    expect(repos.tracePolicyLinks.getWithTraceIds(policyId)).toHaveLength(20);
    expect(repos.policies.getById("policy-unlinked")?.support).toBe(0);
    expect(repos.policies.getById("policy-unlinked")?.status).toBe("candidate");

    await runL2({ ...input, now: 20 }, deps);
    expect(repos.policies.getById(policyId)?.support).toBe(1);
    expect(repos.tracePolicyLinks.getWithTraceIds(policyId)).toHaveLength(20);

    repos.episodes.insert({
      id: "episode-2",
      sessionId: "session-1",
      startedAt: 30,
      endedAt: 31,
      traceIds: ["trace-21"],
      rTask: 0.8,
      status: "closed",
      meta: {},
    } as Parameters<typeof repos.episodes.insert>[0]);
    const secondEpisodeTrace = {
      ...makeTrace("trace-21", "episode-2", 30),
      episodeId: "episode-2",
    } as Parameters<typeof repos.traces.insert>[0];
    repos.traces.insert(secondEpisodeTrace);
    await runL2({
      ...input,
      episodeId: "episode-2",
      traces: [secondEpisodeTrace],
      now: 30,
    }, deps);
    expect(repos.policies.getById(policyId)?.support).toBe(2);
    expect(repos.tracePolicyLinks.countDistinctEpisodes(policyId)).toBe(2);
    expect(repos.traces.listRecentEpisodeValues()).toEqual([
      { episodeId: "episode-2", value: 0.8 },
      { episodeId: "episode-1", value: 0.8 },
    ]);
    const exposureOnlyPolicyId = "policy-exposure-only" as typeof policyId;
    repos.policies.insert({
      id: exposureOnlyPolicyId,
      title: "Exposure-only Policy",
      trigger: "delivered without a new similarity association",
      procedure: "keep the historical base Gain",
      verification: "base Gain is unchanged",
      boundary: "delivery-only refresh",
      support: 2,
      baseGain: 0.123,
      gain: 0.123,
      status: "candidate",
      confidence: 0.8,
      sourceEpisodeIds: ["episode-1", "episode-2"],
      inducedBy: "test",
      decisionGuidance: { preference: [], antiPattern: [] },
      vec: null,
      createdAt: 1,
      updatedAt: 1,
    } as Parameters<typeof repos.policies.insert>[0]);
    repos.tracePolicyLinks.link({
      traceId: "trace-1",
      policyId: exposureOnlyPolicyId,
      episodeId: "episode-1",
      now: 35,
    });
    repos.tracePolicyLinks.link({
      traceId: "trace-21",
      policyId: exposureOnlyPolicyId,
      episodeId: "episode-2",
      now: 36,
    });
    db.prepare<{
      policy_id: string;
      episode_id: string;
      delivered_at: number;
      retrieval_run_id: string;
    }>(
      `INSERT INTO policy_exposures
         (policy_id, episode_id, delivered_at, retrieval_run_id)
       VALUES (@policy_id, @episode_id, @delivered_at, @retrieval_run_id)`,
    ).run({
      policy_id: policyId,
      episode_id: "episode-1",
      delivered_at: 40,
      retrieval_run_id: "run-1",
    });
    db.prepare<{
      policy_id: string;
      episode_id: string;
      delivered_at: number;
      retrieval_run_id: string;
    }>(
      `INSERT INTO policy_exposures
         (policy_id, episode_id, delivered_at, retrieval_run_id)
       VALUES (@policy_id, @episode_id, @delivered_at, @retrieval_run_id)`,
    ).run({
      policy_id: policyId,
      episode_id: "episode-2",
      delivered_at: 41,
      retrieval_run_id: "run-2",
    });
    db.exec(`
      INSERT INTO policy_exposures
        (policy_id, episode_id, delivered_at, retrieval_run_id)
      VALUES
        ('policy-exposure-only', 'episode-1', 40, 'run-exposure-only-1'),
        ('policy-exposure-only', 'episode-2', 41, 'run-exposure-only-2')
    `);
    await runL2({
      ...input,
      episodeId: "episode-2",
      traces: [secondEpisodeTrace],
      now: 42,
    }, deps);
    const observed = repos.policies.getById(policyId)!;
    expect(observed.actualUsageCount).toBe(2);
    expect(observed.actualGain).not.toBeNull();
    expect(observed.gain).toBeCloseTo(
      0.6 * observed.baseGain! + 0.4 * observed.actualGain!,
    );
    const exposureOnly = repos.policies.getById(exposureOnlyPolicyId)!;
    expect(exposureOnly.baseGain).toBe(0.123);
    expect(exposureOnly.actualUsageCount).toBe(2);
    expect(exposureOnly.actualGain).not.toBeNull();
    expect(exposureOnly.gain).toBeCloseTo(
      0.6 * exposureOnly.baseGain! + 0.4 * exposureOnly.actualGain!,
    );
    db.close();
  });
});
