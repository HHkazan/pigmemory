import { describe, expect, it } from "vitest";

import type { Logger } from "../../core/logger/types.js";
import { evaluateEligibility } from "../../core/skill/eligibility.js";
import { applyFeedback } from "../../core/skill/lifecycle.js";
import { buildSkillRow } from "../../core/skill/packager.js";
import type { SkillConfig, SkillCrystallizationDraft } from "../../core/skill/types.js";
import { makeRepos, openDb, runMigrations } from "../../core/storage/index.js";
import type { PolicyRow, SkillRow } from "../../core/types.js";

const config: SkillConfig = {
  minSupport: 2,
  minGain: 0.05,
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

const log = {
  debug() {},
  warn() {},
} as unknown as Logger;

function policy(contentVersion = 1): PolicyRow {
  return {
    id: "policy-1",
    title: "Policy",
    trigger: "When the task matches",
    procedure: "Perform the safe procedure.",
    verification: "Check the result.",
    boundary: "Only for matching tasks.",
    support: 2,
    gain: 0.4,
    status: "active",
    confidence: 0.8,
    sourceEpisodeIds: ["episode-1", "episode-2"],
    inducedBy: "test",
    decisionGuidance: { preference: [], antiPattern: [] },
    vec: null,
    createdAt: 1,
    updatedAt: contentVersion,
    contentVersion,
    contentUpdatedAt: contentVersion,
    statsUpdatedAt: contentVersion,
    contentFingerprint: `policy-fingerprint-${contentVersion}`,
  } as PolicyRow;
}

function skill(status: SkillRow["status"] = "candidate"): SkillRow {
  return {
    id: "skill-1",
    name: "safe_procedure",
    status,
    invocationGuide: "guide",
    procedureJson: {},
    eta: 0.8,
    support: 2,
    gain: 0.4,
    trialsAttempted: 0,
    trialsPassed: 0,
    sourcePolicyIds: ["policy-1"],
    sourceWorldModelIds: [],
    evidenceAnchors: [],
    vec: null,
    createdAt: 1,
    updatedAt: 1,
    version: 1,
    supersedesSkillId: null,
    sourcePolicyContentVersions: { "policy-1": 1 },
    contentFingerprint: "skill-fingerprint-1",
    trialVersion: 1,
    usageCount: 0,
    lastUsedAt: null,
  } as SkillRow;
}

const draft: SkillCrystallizationDraft = {
  name: "safe_procedure",
  displayTitle: "Safe procedure",
  summary: "Perform the procedure safely.",
  parameters: [],
  preconditions: [],
  steps: [{ title: "Run", body: "Perform the safe procedure." }],
  examples: [],
  tags: ["test"],
  decisionGuidance: { preference: [], antiPattern: [] },
  tools: [],
};

describe("skill evolution", () => {
  it("activates on the first pass, archives on the first clear failure, and ignores reward drift for status", () => {
    const passed = applyFeedback(skill("candidate"), "trial.pass", config);
    expect(passed.status).toBe("active");
    expect(passed.trialsAttempted).toBe(1);
    expect(passed.trialsPassed).toBe(1);

    const failed = applyFeedback(skill("candidate"), "trial.fail", config);
    expect(failed.status).toBe("archived");
    expect(failed.trialsAttempted).toBe(1);

    const lowActive = { ...skill("active"), eta: 0.01 };
    const drifted = applyFeedback(lowActive, "reward.updated", config, 0);
    expect(drifted.eta).toBeLessThan(config.archiveEta);
    expect(drifted.status).toBe("active");
  });

  it("rebuilds only when the source policy content version advances", () => {
    const existing = skill("active");
    const unchanged = evaluateEligibility({
      policies: [policy(1)],
      skillsByPolicy: new Map([["policy-1", existing]]),
    }, config);
    expect(unchanged.decisions[0]?.action).toBe("skip");

    const changed = evaluateEligibility({
      policies: [policy(2)],
      skillsByPolicy: new Map([["policy-1", existing]]),
    }, config);
    expect(changed.decisions[0]?.action).toBe("rebuild");

    const failedCurrentVersion = {
      ...existing,
      status: "archived" as const,
      sourcePolicyContentVersions: { "policy-1": 2 },
    };
    const alreadyTried = evaluateEligibility({
      policies: [policy(2)],
      skillsByPolicy: new Map([["policy-1", failedCurrentVersion]]),
    }, config);
    expect(alreadyTried.decisions[0]?.action).toBe("skip");
  });

  it("creates a shadow candidate and atomically switches it after a pass", async () => {
    const db = openDb({ filepath: ":memory:", agent: "test", wal: false });
    runMigrations(db);
    const repos = makeRepos(db);
    const active = skill("active");
    repos.skills.insert(active);

    const built = await buildSkillRow({
      draft,
      policy: policy(2),
      evidenceEpisodeIds: [],
      evidenceTraceIds: [],
      existing: active,
    }, {
      embedder: null,
      log,
      config,
    });
    expect(built.row.id).not.toBe(active.id);
    expect(built.row.status).toBe("candidate");
    expect(built.row.supersedesSkillId).toBe(active.id);
    expect(built.row.version).toBe(2);
    expect(built.row.trialVersion).toBe(2);
    expect(built.row.trialsAttempted).toBe(0);
    expect(built.row.sourcePolicyContentVersions["policy-1"]).toBe(2);

    repos.skills.insert(built.row);
    repos.skills.activateSuperseding(built.row.id, active.id, 10);
    expect(repos.skills.getById(active.id)?.status).toBe("archived");
    expect(repos.skills.getById(built.row.id)?.status).toBe("active");
    db.close();
  });

  it("rolls back a superseding activation when the old active row is missing", () => {
    const db = openDb({ filepath: ":memory:", agent: "test", wal: false });
    runMigrations(db);
    const repos = makeRepos(db);
    const candidate = skill("candidate");
    repos.skills.insert(candidate);

    expect(() => {
      repos.skills.activateSuperseding(candidate.id, "missing-active", 10);
    }).toThrow(/superseded active skill not found/);
    expect(repos.skills.getById(candidate.id)?.status).toBe("candidate");
    db.close();
  });
});
