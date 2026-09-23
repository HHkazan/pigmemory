import { describe, expect, it } from "vitest";

import type { Logger } from "../../core/logger/types.js";
import { createL2EventBus } from "../../core/memory/l2/events.js";
import { createL3EventBus } from "../../core/memory/l3/events.js";
import { attachL3Subscriber } from "../../core/memory/l3/subscriber.js";
import { createRewardEventBus } from "../../core/reward/events.js";
import { createSkillEventBus } from "../../core/skill/events.js";
import { attachSkillSubscriber } from "../../core/skill/subscriber.js";
import type { SkillConfig } from "../../core/skill/types.js";
import { makeRepos, openDb, runMigrations } from "../../core/storage/index.js";
import type { PolicyRow, WorldModelRow } from "../../core/types.js";

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

function policy(id: string): PolicyRow {
  return {
    id,
    title: id,
    trigger: "When testing event delivery",
    procedure: "Process this policy.",
    verification: "Observe the event.",
    boundary: "Test only.",
    support: 2,
    gain: 0.2,
    status: "active",
    confidence: 0.8,
    sourceEpisodeIds: [],
    inducedBy: "test",
    decisionGuidance: { preference: [], antiPattern: [] },
    vec: null,
    createdAt: 1,
    updatedAt: 1,
    contentVersion: 1,
    contentUpdatedAt: 1,
    statsUpdatedAt: 1,
    contentFingerprint: `fingerprint-${id}`,
  } as PolicyRow;
}

const skillConfig: SkillConfig = {
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
};

describe("evolution subscribers", () => {
  it("does not lose simultaneous policy activation events in the skill queue", async () => {
    const db = openDb({ filepath: ":memory:", agent: "test", wal: false });
    runMigrations(db);
    const repos = makeRepos(db);
    repos.policies.insert(policy("policy-a"));
    repos.policies.insert(policy("policy-b"));
    const l2Bus = createL2EventBus();
    const skillBus = createSkillEventBus();
    const eligibilityTotals: number[] = [];
    skillBus.on("skill.eligibility.checked", (event) => {
      if (event.kind === "skill.eligibility.checked") {
        eligibilityTotals.push(event.totalPolicies);
      }
    });
    const subscriber = attachSkillSubscriber({
      repos,
      embedder: null,
      llm: null,
      log,
      bus: skillBus,
      l2Bus,
      rewardBus: createRewardEventBus(),
      config: skillConfig,
    });

    for (const id of ["policy-a", "policy-b"]) {
      l2Bus.emit({
        kind: "l2.policy.updated",
        episodeId: "episode-1" as never,
        policyId: id as never,
        previousStatus: "candidate",
        nextStatus: "active",
        changeKind: "status",
        support: 2,
        gain: 0.2,
        contentVersion: 1,
      });
    }
    await subscriber.flush();
    expect(eligibilityTotals).toEqual([1, 1]);
    subscriber.dispose();
    db.close();
  });

  it("ignores active policy stats updates in L3 but responds to content updates", async () => {
    const db = openDb({ filepath: ":memory:", agent: "test", wal: false });
    runMigrations(db);
    const repos = makeRepos(db);
    repos.policies.insert(policy("policy-a"));
    repos.worldModel.insert({
      id: "world-a",
      title: "World A",
      body: "Body",
      structure: { environment: [], inference: [], constraints: [] },
      domainTags: ["test"],
      confidence: 0.8,
      policyIds: ["policy-a"],
      sourceEpisodeIds: [],
      inducedBy: "test",
      vec: null,
      createdAt: 1,
      updatedAt: 1,
      version: 1,
      status: "active",
      clusterFingerprint: "world-a-fingerprint",
      staleReason: null,
    } as WorldModelRow);
    const l2Bus = createL2EventBus();
    const l3Bus = createL3EventBus();
    let starts = 0;
    l3Bus.on("l3.abstraction.started", () => {
      starts += 1;
    });
    const subscriber = attachL3Subscriber({
      repos,
      l2Bus,
      l3Bus,
      llm: null,
      log,
      config: {
        minPolicies: 1,
        minPolicyGain: 0.1,
        minPolicySupport: 2,
        clusterMinSimilarity: 0.3,
        policyCharCap: 800,
        traceCharCap: 500,
        traceEvidencePerPolicy: 1,
        useLlm: false,
        cooldownDays: 0,
        confidenceDelta: 0.05,
        minConfidenceForRetrieval: 0.2,
      },
    });
    const base = {
      kind: "l2.policy.updated" as const,
      episodeId: "episode-1" as never,
      policyId: "policy-a" as never,
      previousStatus: "active" as const,
      nextStatus: "active" as const,
      support: 2,
      gain: 0.2,
      contentVersion: 1,
    };

    repos.policies.updateStats("policy-a", {
      support: 1,
      gain: 0.2,
      status: "active",
      sourceEpisodeIds: [],
      updatedAt: 2,
    });
    l2Bus.emit({ ...base, changeKind: "stats", support: 1 });
    await subscriber.drain();
    expect(starts).toBe(0);
    expect(repos.worldModel.getById("world-a")?.staleReason)
      .toBe("insufficient_valid_sources:0/1");

    l2Bus.emit({ ...base, changeKind: "content", contentVersion: 2 });
    await subscriber.drain();
    expect(starts).toBe(1);
    subscriber.detach();
    db.close();
  });
});
