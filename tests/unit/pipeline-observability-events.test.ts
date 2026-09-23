import { describe, expect, it } from "vitest";

import type { Logger } from "../../core/logger/types.js";
import { createL2EventBus } from "../../core/memory/l2/events.js";
import { attachL2Subscriber } from "../../core/memory/l2/subscriber.js";
import type { L2Event } from "../../core/memory/l2/types.js";
import { createL3EventBus } from "../../core/memory/l3/events.js";
import { runL3 } from "../../core/memory/l3/l3.js";
import type { L3Event } from "../../core/memory/l3/types.js";
import { createRewardEventBus } from "../../core/reward/events.js";
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

describe("pipeline observability events", () => {
  it("records an explicit L2 start and skip when an episode has no trace input", async () => {
    const db = openDb({ filepath: ":memory:", agent: "test", wal: false });
    try {
      runMigrations(db);
      const bus = createL2EventBus();
      const events: L2Event[] = [];
      bus.onAny((event) => events.push(event));
      const subscriber = attachL2Subscriber({
        db,
        repos: makeRepos(db),
        rewardBus: createRewardEventBus(),
        l2Bus: bus,
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
        thresholds: { minSupport: 2, minGain: 0, archiveGain: -1 },
      });

      await subscriber.runOnce("episode-without-traces" as never);
      expect(events.map((event) => event.kind)).toEqual([
        "l2.run.started",
        "l2.run.skipped",
      ]);
      expect(events[1]).toMatchObject({ inputCount: 0, reason: "no_traces" });
      subscriber.detach();
    } finally {
      db.close();
    }
  });

  it("records an explicit L3 start and skip when no policy cluster is eligible", async () => {
    const db = openDb({ filepath: ":memory:", agent: "test", wal: false });
    try {
      runMigrations(db);
      const bus = createL3EventBus();
      const events: L3Event[] = [];
      bus.onAny((event) => events.push(event));
      await runL3({ trigger: "manual" }, {
        repos: makeRepos(db),
        llm: null,
        log,
        bus,
        config: {
          minPolicies: 2,
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
      expect(events.map((event) => event.kind)).toEqual([
        "l3.abstraction.started",
        "l3.abstraction.skipped",
      ]);
      expect(events[1]).toMatchObject({ inputCount: 0, reason: "no_eligible_clusters" });
    } finally {
      db.close();
    }
  });
});
