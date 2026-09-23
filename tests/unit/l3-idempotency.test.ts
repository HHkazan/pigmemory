import { describe, expect, it } from "vitest";

import type { LlmClient } from "../../core/llm/index.js";
import type { Logger } from "../../core/logger/types.js";
import { createL3EventBus } from "../../core/memory/l3/events.js";
import { runL3 } from "../../core/memory/l3/l3.js";
import type { L3Config, L3Event } from "../../core/memory/l3/types.js";
import { makeRepos, openDb, runMigrations } from "../../core/storage/index.js";
import type { PolicyRow } from "../../core/types.js";

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

const config: L3Config = {
  minPolicies: 1,
  minPolicyGain: 0.1,
  minPolicySupport: 1,
  clusterMinSimilarity: 0.3,
  policyCharCap: 800,
  traceCharCap: 500,
  traceEvidencePerPolicy: 0,
  useLlm: true,
  cooldownDays: 30,
  confidenceDelta: 0.05,
  minConfidenceForRetrieval: 0.2,
};

function policy(): PolicyRow {
  return {
    id: "policy-l3",
    title: "Docker deployment",
    trigger: "When deploying a Docker service",
    procedure: "Build and verify the container.",
    verification: "The container starts.",
    boundary: "Docker projects only.",
    support: 2,
    gain: 0.4,
    status: "active",
    confidence: 0.8,
    sourceEpisodeIds: [],
    inducedBy: "test",
    decisionGuidance: { preference: [], antiPattern: [] },
    vec: new Float32Array([1, 0]),
    createdAt: 1,
    updatedAt: 1,
    contentVersion: 1,
    contentUpdatedAt: 1,
    statsUpdatedAt: 1,
    contentFingerprint: "policy-l3-fingerprint",
  } as PolicyRow;
}

function llm(counter: { calls: number }): LlmClient {
  return {
    completeJson: async () => {
      counter.calls += 1;
      return {
        value: {
          title: "Docker runtime",
          domain_tags: ["docker"],
          environment: [{ label: "container", description: "Runs the service" }],
          inference: [],
          constraints: [],
          body: "Docker runtime model",
          confidence: 0.8,
          supersedes_world_ids: [],
        },
      };
    },
  } as unknown as LlmClient;
}

describe("L3 idempotency and cooldown", () => {
  it("does not call the LLM again for an identical cluster fingerprint", async () => {
    const db = openDb({ filepath: ":memory:", agent: "test", wal: false });
    runMigrations(db);
    const repos = makeRepos(db);
    repos.policies.insert(policy());
    const counter = { calls: 0 };
    const bus = createL3EventBus();
    const events: L3Event[] = [];
    bus.onAny((event) => events.push(event));
    const deps = { repos, llm: llm(counter), log, config, bus };

    const first = await runL3({ trigger: "manual", now: 100 }, deps);
    expect(first.abstractions.some((row) => row.createdNew)).toBe(true);
    expect(counter.calls).toBe(1);
    expect(events.map((event) => event.kind)).toEqual(expect.arrayContaining([
      "l3.abstraction.started",
      "l3.world-model.created",
      "l3.abstraction.completed",
    ]));
    expect(events.find((event) => event.kind === "l3.abstraction.completed")).toMatchObject({
      inputCount: 1,
      outputWorldModelIds: [expect.any(String)],
    });

    events.length = 0;
    const second = await runL3({ trigger: "manual", now: 200 }, deps);
    expect(counter.calls).toBe(1);
    expect(second.abstractions[0]?.skippedReason).toBe("duplicate_of");
    expect(events.some((event) => event.kind === "l3.abstraction.skipped")).toBe(true);
    db.close();
  });

  it("does not write cooldown state when persistence fails", async () => {
    const db = openDb({ filepath: ":memory:", agent: "test", wal: false });
    runMigrations(db);
    const repos = makeRepos(db);
    repos.policies.insert(policy());
    const counter = { calls: 0 };
    const failingWorldModel = {
      ...repos.worldModel,
      insert() {
        throw new Error("simulated persistence failure");
      },
    };

    const result = await runL3({ trigger: "manual", now: 100 }, {
      repos: { ...repos, worldModel: failingWorldModel },
      llm: llm(counter),
      log,
      config,
    });
    const cooldownRows = db.raw.prepare(
      "SELECT key FROM kv WHERE key LIKE 'l3.lastRun.%'",
    ).all();
    expect(counter.calls).toBe(1);
    expect(result.warnings.some((warning) => warning.stage === "insert")).toBe(true);
    expect(cooldownRows).toEqual([]);
    db.close();
  });
});
