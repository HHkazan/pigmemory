import { describe, expect, it } from "vitest";

import { rank } from "../../core/retrieval/ranker.js";
import type {
  ExperienceCandidate,
  RetrievalConfig,
  SkillCandidate,
  TraceCandidate,
} from "../../core/retrieval/types.js";

const config: RetrievalConfig = {
  tier1TopK: 10,
  tier2TopK: 10,
  tier3TopK: 10,
  candidatePoolFactor: 2,
  weightCosine: 1,
  weightPriority: 0,
  mmrLambda: 1,
  includeLowValue: true,
  rrfConstant: 60,
  minSkillEta: 0.1,
  minTraceSim: 0.2,
  tagFilter: "off",
  relativeThresholdFloor: 0,
  skillEtaBlend: 0,
  candidateSkillTopK: 2,
  candidateSkillPenalty: 0.08,
  smartSeed: false,
  decayHalfLifeDays: 30,
  llmFilterEnabled: false,
  llmFilterMaxKeep: 10,
  llmFilterMinCandidates: 1,
};

function skill(
  id: string,
  status: "active" | "candidate",
  score: number,
): SkillCandidate {
  return {
    tier: "tier1",
    refKind: "skill",
    refId: id,
    skillName: id,
    invocationGuide: `guide ${id}`,
    eta: 0.8,
    status,
    cosine: score,
    channels: [{ channel: "vec", rank: 0, score }],
    vec: new Float32Array([score, 1 - score]),
    ts: 1,
  } as SkillCandidate;
}

function experience(
  id: string,
  input: Partial<ExperienceCandidate> = {},
): ExperienceCandidate {
  return {
    tier: "tier2",
    refKind: "experience",
    refId: id,
    title: id,
    trigger: "when relevant",
    procedure: "do it",
    verification: "check it",
    boundary: "test",
    support: 1,
    gain: 0,
    status: "active",
    experienceType: "success_pattern",
    evidencePolarity: "positive",
    salience: 0,
    confidence: 0.99,
    skillEligible: true,
    sourceEpisodeIds: [],
    sourceFeedbackIds: [],
    sourceTraceIds: [],
    decisionGuidance: { preference: [], antiPattern: [] },
    updatedAt: 1,
    cosine: 0.5,
    channels: [{ channel: "vec", rank: 0, score: 0.5 }],
    vec: null,
    ts: 1,
    ...input,
  };
}

function trace(id: string, relevance: number, vec: Float32Array): TraceCandidate {
  return {
    tier: "tier2",
    refKind: "trace",
    refId: id,
    cosine: relevance,
    channels: [{ channel: "vec_summary", rank: 0, score: relevance }],
    vec,
    ts: 1,
    value: 0,
    priority: 0,
    episodeId: `episode-${id}`,
    sessionId: "session-1",
    vecKind: "summary",
    userText: "",
    agentText: "",
    summary: null,
    reflection: null,
    tags: [],
  } as TraceCandidate;
}

describe("retrieval ranker", () => {
  it("keeps at most two candidate skills without reserving candidate slots", () => {
    const result = rank({
      tier1: [
        skill("candidate-high", "candidate", 0.95),
        skill("candidate-mid", "candidate", 0.9),
        skill("candidate-low", "candidate", 0.85),
        skill("active", "active", 0.84),
      ],
      tier2Traces: [],
      tier2Episodes: [],
      tier3: [],
      limit: 4,
      config,
      now: 1,
    });
    const skills = result.ranked.map((row) => row.candidate as SkillCandidate);
    expect(skills.filter((row) => row.status === "candidate")).toHaveLength(2);
    expect(skills.map((row) => row.refId)).toContain("active");
    expect(skills.map((row) => row.refId)).not.toContain("candidate-low");
  });

  it("uses the candidate penalty to prefer a similarly relevant active skill", () => {
    const result = rank({
      tier1: [skill("candidate", "candidate", 0.8), skill("active", "active", 0.8)],
      tier2Traces: [],
      tier2Episodes: [],
      tier3: [],
      limit: 2,
      config,
      now: 1,
    });
    expect(result.ranked[0]?.candidate.refId).toBe("active");
    expect(result.ranked[0]?.relevance - result.ranked[1]!.relevance).toBeCloseTo(0.08);
  });

  it("penalizes near-duplicate candidate vectors and preserves a distinct topic", () => {
    const result = rank({
      tier1: [],
      tier2Traces: [
        trace("best", 1, new Float32Array([1, 0])),
        trace("duplicate", 0.95, new Float32Array([1, 0])),
        trace("distinct", 0.8, new Float32Array([0, 1])),
      ],
      tier2Episodes: [],
      tier3: [],
      limit: 2,
      config: { ...config, mmrLambda: 0.5 },
      now: 1,
    });
    expect(result.ranked.map((row) => row.candidate.refId).sort()).toEqual([
      "best",
      "distinct",
    ]);
  });

  it("ranks success patterns by gain and support instead of default confidence", () => {
    const result = rank({
      tier1: [],
      tier2Traces: [],
      tier2Episodes: [],
      tier2Experiences: [
        experience("weak", { support: 1, gain: 0, confidence: 0.99 }),
        experience("proven", { support: 9, gain: 0.4, confidence: undefined }),
      ],
      tier3: [],
      limit: 2,
      config,
      now: 1,
    });
    expect(result.ranked[0]?.candidate.refId).toBe("proven");
    expect(result.ranked[0]?.relevance).toBeGreaterThan(result.ranked[1]!.relevance);
    expect(result.ranked[0]?.candidate.debug?.qualityMode).toBe("gain_support_status");
  });
});
