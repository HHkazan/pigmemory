import { describe, expect, it } from "vitest";

import { toPacket } from "../../core/retrieval/injector.js";
import type { RankedCandidate } from "../../core/retrieval/ranker.js";
import { runTier2Experience } from "../../core/retrieval/tier2-experience.js";
import type { ExperienceCandidate, RetrievalConfig } from "../../core/retrieval/types.js";
import { makeRepos, openDb, runMigrations } from "../../core/storage/index.js";
import type { PolicyRow } from "../../core/types.js";

const config = {
  tier1TopK: 5,
  tier2TopK: 5,
  tier3TopK: 5,
  candidatePoolFactor: 2,
  weightCosine: 1,
  weightPriority: 0,
  mmrLambda: 1,
  includeLowValue: true,
  rrfConstant: 60,
  minSkillEta: 0.1,
  minTraceSim: 0.2,
  tagFilter: "off",
  decayHalfLifeDays: 30,
  llmFilterEnabled: false,
  llmFilterMaxKeep: 5,
  llmFilterMinCandidates: 1,
} satisfies RetrievalConfig;

function policy(
  id: string,
  status: PolicyRow["status"],
  vec: Float32Array,
): PolicyRow {
  return {
    id,
    title: `${status} experience`,
    trigger: "When this retrieval test runs",
    procedure: "Use the matching experience.",
    verification: "Check the status label.",
    boundary: "Test only.",
    support: 2,
    gain: 0.3,
    status,
    confidence: 0.8,
    sourceEpisodeIds: [],
    inducedBy: "test",
    decisionGuidance: { preference: [], antiPattern: ["Do not hide status"] },
    vec,
    createdAt: 1,
    updatedAt: 1,
    contentVersion: 1,
    contentUpdatedAt: 1,
    statsUpdatedAt: 1,
    contentFingerprint: `fingerprint-${id}`,
  } as PolicyRow;
}

describe("candidate policy retrieval", () => {
  it("returns only active policies by default and exposes candidates only on explicit opt-in", async () => {
    const db = openDb({ filepath: ":memory:", agent: "test", wal: false });
    runMigrations(db);
    const repos = makeRepos(db);
    repos.policies.insert(policy("active", "active", new Float32Array([1, 0])));
    repos.policies.insert(policy("candidate", "candidate", new Float32Array([0.8, 0.6])));
    repos.policies.insert(policy("archived", "archived", new Float32Array([1, 0])));
    const deps = { repos: { policies: repos.policies }, config };

    const normal = await runTier2Experience(deps, {
      queryVec: new Float32Array([1, 0]),
    });
    expect(normal.map((row) => row.refId)).toEqual(["active"]);

    const explicit = await runTier2Experience(deps, {
      queryVec: new Float32Array([1, 0]),
      includeCandidates: true,
    });
    expect(explicit.map((row) => row.refId).sort()).toEqual(["active", "candidate"]);
    const candidateVec = explicit.find((row) => row.refId === "candidate")!.vec!;
    expect(candidateVec[0]).toBeCloseTo(0.8);
    expect(candidateVec[1]).toBeCloseTo(0.6);
    db.close();
  });

  it("marks candidate policy instructions as pending validation", () => {
    const candidate: ExperienceCandidate = {
      tier: "tier2",
      refKind: "experience",
      refId: "candidate",
      title: "Candidate experience",
      trigger: "When relevant",
      procedure: "Try the proposed repair.",
      verification: "Check it.",
      boundary: "Narrow scope.",
      support: 1,
      gain: 0.2,
      status: "candidate",
      experienceType: "repair_instruction",
      evidencePolarity: "negative",
      salience: 0.5,
      confidence: 0.5,
      skillEligible: false,
      sourceEpisodeIds: [],
      sourceFeedbackIds: [],
      sourceTraceIds: [],
      decisionGuidance: { preference: [], antiPattern: ["Avoid the old path"] },
      updatedAt: 1,
      cosine: 0.8,
      vec: null,
      ts: 1,
    } as ExperienceCandidate;
    const ranked: RankedCandidate = {
      candidate,
      relevance: 0.8,
      rrf: 0,
      score: 0.8,
      normSq: null,
    };
    const result = toPacket({
      ranked: [ranked],
      reason: "decision_repair",
      tierLatencyMs: { tier1: 0, tier2: 0, tier3: 0 },
      now: 1,
      sessionId: "session-1",
      episodeId: "episode-1",
    });
    const body = result.packet.snippets[0]?.body ?? "";
    expect(body).toContain("Status: candidate");
    expect(body).toContain("Pending validation suggestion");
    expect(body.indexOf("Pending validation suggestion")).toBeLessThan(body.indexOf("Do:"));
  });
});
