import { describe, expect, it } from "vitest";

import { resolveConfig } from "../../core/config/index.js";
import type { Logger } from "../../core/logger/types.js";
import { createL2EventBus } from "../../core/memory/l2/events.js";
import { createRewardEventBus } from "../../core/reward/events.js";
import { createSkillEventBus } from "../../core/skill/events.js";
import { attachSkillSubscriber } from "../../core/skill/subscriber.js";
import type {
  SkillArchiveReason,
  SkillConfig,
  SkillEvent,
} from "../../core/skill/types.js";
import { makeRepos, openDb, runMigrations } from "../../core/storage/index.js";
import { setNow } from "../../core/time.js";
import type { PolicyRow, SkillRow } from "../../core/types.js";

const DAY_MS = 24 * 60 * 60 * 1_000;
const FIXED_NOW = 1_800_000_000_000;

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

const skillConfig: SkillConfig = {
  minSupport: 4,
  minGain: 0.1,
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

function policy(
  id: string,
  patch: Partial<Pick<PolicyRow, "status" | "support" | "gain">> = {},
): PolicyRow {
  return {
    id,
    title: id,
    trigger: "When testing candidate lifecycle",
    procedure: "Apply the policy.",
    verification: "Check the result.",
    boundary: "Test only.",
    support: patch.support ?? 4,
    gain: patch.gain ?? 0.1,
    status: patch.status ?? "active",
    confidence: 0.8,
    sourceEpisodeIds: [],
    inducedBy: "test",
    decisionGuidance: { preference: [], antiPattern: [] },
    vec: null,
    createdAt: FIXED_NOW - DAY_MS,
    updatedAt: FIXED_NOW - DAY_MS,
    contentVersion: 1,
    contentUpdatedAt: FIXED_NOW - DAY_MS,
    statsUpdatedAt: FIXED_NOW - DAY_MS,
    contentFingerprint: `fingerprint-${id}`,
  } as PolicyRow;
}

function skill(
  id: string,
  sourcePolicyIds: string[],
  patch: Partial<Pick<
    SkillRow,
    "status" | "createdAt" | "updatedAt" | "usageCount" | "trialsAttempted" | "trialsPassed"
  >> = {},
): SkillRow {
  return {
    id,
    name: id,
    status: patch.status ?? "candidate",
    invocationGuide: "guide",
    procedureJson: {},
    eta: 0.8,
    support: 4,
    gain: 0.1,
    trialsAttempted: patch.trialsAttempted ?? 0,
    trialsPassed: patch.trialsPassed ?? 0,
    sourcePolicyIds,
    sourceWorldModelIds: [],
    evidenceAnchors: [],
    vec: null,
    createdAt: patch.createdAt ?? FIXED_NOW - DAY_MS,
    updatedAt: patch.updatedAt ?? FIXED_NOW - DAY_MS,
    version: 1,
    supersedesSkillId: null,
    sourcePolicyContentVersions: Object.fromEntries(sourcePolicyIds.map((id) => [id, 1])),
    contentFingerprint: `fingerprint-${id}`,
    trialVersion: 1,
    usageCount: patch.usageCount ?? 0,
    lastUsedAt: null,
  } as SkillRow;
}

function archiveReasons(events: SkillEvent[]): Map<string, SkillArchiveReason> {
  return new Map(events.flatMap((event) =>
    event.kind === "skill.archived" ? [[event.skillId, event.reason]] : []));
}

describe("skill candidate lifecycle", () => {
  it("parses the stricter generation gate and candidate TTL configuration", () => {
    const defaults = resolveConfig({});
    expect(defaults.algorithm.skill).toMatchObject({
      minSupport: 4,
      minGain: 0.1,
      candidateTrials: 1,
      candidateTtlDays: 30,
    });

    const configured = resolveConfig({
      algorithm: { skill: { candidateTtlDays: 45 } },
    });
    expect(configured.algorithm.skill.candidateTtlDays).toBe(45);
    expect(() => resolveConfig({
      algorithm: { skill: { candidateTtlDays: 0 } },
    })).toThrow(/config failed schema validation/);
  });

  it("archives candidates unless at least one active source clears the full gate", async () => {
    const db = openDb({ filepath: ":memory:", agent: "test", wal: false });
    const restoreNow = setNow(() => FIXED_NOW);
    try {
      runMigrations(db);
      const repos = makeRepos(db);
      for (const row of [
        policy("low-support", { support: 3, gain: 0.5 }),
        policy("low-gain", { support: 8, gain: 0.09 }),
        policy("inactive", { status: "archived", support: 8, gain: 0.5 }),
        policy("eligible"),
      ]) {
        repos.policies.insert(row);
      }
      for (const row of [
        skill("skill-low-support", ["low-support"]),
        skill("skill-low-gain", ["low-gain"]),
        skill("skill-inactive", ["inactive"]),
        skill("skill-eligible", ["eligible"]),
        skill("skill-multi-source", ["low-support", "eligible"]),
      ]) {
        repos.skills.insert(row);
      }

      const bus = createSkillEventBus();
      const events: SkillEvent[] = [];
      bus.onAny((event) => events.push(event));
      const subscriber = attachSkillSubscriber({
        repos,
        embedder: null,
        llm: null,
        log,
        bus,
        l2Bus: createL2EventBus(),
        rewardBus: createRewardEventBus(),
        config: skillConfig,
      });

      await subscriber.lifecycleTick();

      for (const id of ["skill-low-support", "skill-low-gain", "skill-inactive"]) {
        expect(repos.skills.getById(id)?.status).toBe("archived");
      }
      expect(repos.skills.getById("skill-eligible")?.status).toBe("candidate");
      expect(repos.skills.getById("skill-multi-source")?.status).toBe("candidate");
      expect(archiveReasons(events)).toEqual(new Map([
        ["skill-inactive", "below-generation-gate"],
        ["skill-low-gain", "below-generation-gate"],
        ["skill-low-support", "below-generation-gate"],
      ]));
      expect(events.filter((event) => event.kind === "skill.status.changed"))
        .toEqual(expect.arrayContaining([
          expect.objectContaining({
            skillId: "skill-low-support",
            next: "archived",
            reason: "below-generation-gate",
          }),
        ]));
      subscriber.dispose();
    } finally {
      restoreNow();
      db.close();
    }
  });

  it("expires only unused, unfinished candidates based on createdAt", async () => {
    const db = openDb({ filepath: ":memory:", agent: "test", wal: false });
    const restoreNow = setNow(() => FIXED_NOW);
    try {
      runMigrations(db);
      const repos = makeRepos(db);
      repos.policies.insert(policy("eligible"));
      const oldCreatedAt = FIXED_NOW - 31 * DAY_MS;
      for (const row of [
        skill("expired", ["eligible"], {
          createdAt: oldCreatedAt,
          updatedAt: FIXED_NOW,
        }),
        skill("used", ["eligible"], {
          createdAt: oldCreatedAt,
          usageCount: 1,
        }),
        skill("fresh", ["eligible"]),
        skill("active", ["eligible"], {
          status: "active",
          createdAt: oldCreatedAt,
        }),
      ]) {
        repos.skills.insert(row);
      }

      const bus = createSkillEventBus();
      const events: SkillEvent[] = [];
      bus.onAny((event) => events.push(event));
      const subscriber = attachSkillSubscriber({
        repos,
        embedder: null,
        llm: null,
        log,
        bus,
        l2Bus: createL2EventBus(),
        rewardBus: createRewardEventBus(),
        config: skillConfig,
      });

      await subscriber.lifecycleTick();

      expect(repos.skills.getById("expired")?.status).toBe("archived");
      expect(repos.skills.getById("used")?.status).toBe("candidate");
      expect(repos.skills.getById("fresh")?.status).toBe("candidate");
      expect(repos.skills.getById("active")?.status).toBe("active");
      expect(archiveReasons(events)).toEqual(new Map([
        ["expired", "candidate-expired"],
      ]));
      subscriber.dispose();
    } finally {
      restoreNow();
      db.close();
    }
  });
});
