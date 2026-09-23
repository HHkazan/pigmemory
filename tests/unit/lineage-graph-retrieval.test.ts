import { describe, expect, it } from "vitest";

import { runLineageGraph } from "../../core/retrieval/lineage-graph.js";
import type {
  RetrievalConfig,
  RetrievalRepos,
  TraceCandidate,
} from "../../core/retrieval/types.js";
import type { EpisodeId, SessionId } from "../../agent-contract/dto.js";
import type { PolicyId, SkillId, TraceId, WorldModelId } from "../../core/types.js";

const config: RetrievalConfig = {
  tier1TopK: 3,
  tier2TopK: 5,
  tier3TopK: 2,
  candidatePoolFactor: 4,
  weightCosine: 0.6,
  weightPriority: 0.4,
  mmrLambda: 0.7,
  includeLowValue: false,
  rrfConstant: 60,
  minSkillEta: 0.1,
  minTraceSim: 0.25,
  tagFilter: "off",
  decayHalfLifeDays: 30,
  llmFilterEnabled: false,
  llmFilterMaxKeep: 4,
  llmFilterMinCandidates: 1,
};

const traceId = "tr-seed" as TraceId;
const episodeId = "ep-seed" as EpisodeId;
const sessionId = "se-seed" as SessionId;
const policyId = "po-deploy" as PolicyId;
const skillId = "sk-deploy" as SkillId;
const oldSkillId = "sk-old" as SkillId;
const worldId = "wm-deploy" as WorldModelId;

function baselineTrace(): TraceCandidate {
  return {
    tier: "tier2",
    refKind: "trace",
    refId: traceId,
    cosine: 0.8,
    ts: 100,
    vec: new Float32Array([1, 0]),
    channels: [{ channel: "fts", rank: 0, score: 0.8 }],
    value: 0.8,
    priority: 0.8,
    episodeId,
    sessionId,
    vecKind: "summary",
    userText: "incident zxqv",
    agentText: "fixed",
    summary: "incident zxqv was fixed",
    reflection: null,
    tags: [],
  };
}

function repos(input: { withRepair?: boolean } = {}): RetrievalRepos {
  const policy = {
    id: policyId,
    title: "Safe deployment",
    trigger: "before release",
    procedure: "stage then deploy",
    verification: "health check",
    boundary: "production",
    support: 3,
    gain: 0.7,
    status: "active" as const,
    experienceType: "success_pattern" as const,
    evidencePolarity: "positive" as const,
    salience: 0.6,
    confidence: 0.9,
    skillEligible: true,
    sourceEpisodeIds: [episodeId],
    sourceFeedbackIds: [],
    sourceTraceIds: [traceId],
    decisionGuidance: { preference: [], antiPattern: [] },
    vec: null,
    updatedAt: 200,
  };
  const trace = {
    id: traceId,
    episodeId,
    sessionId,
    ts: 100,
    userText: "incident zxqv",
    agentText: "fixed",
    summary: "incident zxqv was fixed",
    reflection: null,
    value: 0.8,
    priority: 0.8,
    tags: [],
    vecSummary: new Float32Array([1, 0]),
    vecAction: null,
  };
  return {
    traces: {
      getManyByIds(ids) {
        return ids.includes(traceId) ? [trace] : [];
      },
    },
    policies: {
      list() {
        return [policy];
      },
      getById(id) {
        return id === policyId ? policy : null;
      },
    },
    lineage: {
      listSkills() {
        return [
          {
            id: skillId,
            name: "Deploy safely",
            status: "active",
            invocationGuide: "Stage, deploy, and verify health.",
            eta: 0.9,
            sourcePolicyIds: [policyId],
            sourceWorldModelIds: [worldId],
            evidenceAnchors: [traceId],
            supersedesSkillId: oldSkillId,
            updatedAt: 300,
            vec: null,
          },
          {
            id: oldSkillId,
            name: "Old deployment",
            status: "archived",
            invocationGuide: "Old process",
            eta: 0.5,
            sourcePolicyIds: [],
            sourceWorldModelIds: [],
            evidenceAnchors: [],
            updatedAt: 100,
            vec: null,
          },
        ];
      },
      listWorldModels() {
        return [{
          id: worldId,
          title: "Deployment topology",
          body: "Production uses staged releases.",
          policyIds: [policyId],
          sourceEpisodeIds: [episodeId],
          confidence: 0.9,
          status: "active",
          updatedAt: 250,
          vec: null,
        }];
      },
      listDecisionRepairs() {
        return input.withRepair
          ? [{
              id: "dr-blue",
              ts: 400,
              preference: "Use blue deployment",
              antiPattern: "Do not deploy directly",
              highValueTraceIds: [traceId],
              lowValueTraceIds: [],
              validated: true,
            }]
          : [];
      },
      getEpisodeById(id) {
        return id === episodeId
          ? {
              id: episodeId,
              sessionId,
              startedAt: 90,
              traceIds: [traceId],
              rTask: 1,
              status: "closed",
              meta: { summary: "deploy task" },
            }
          : null;
      },
      getTraceIdsForPolicy(id) {
        return id === policyId ? [traceId] : [];
      },
      getPolicyIdsForTrace(id) {
        return id === traceId ? [policyId] : [];
      },
      getPolicyIdsForEpisode(id) {
        return id === episodeId ? [policyId] : [];
      },
    },
  } as unknown as RetrievalRepos;
}

describe("deterministic lineage graph retrieval", () => {
  it("expands a matching Trace through Policy to Skill and World Model in two hops", () => {
    const result = runLineageGraph({
      queryText: "incident zxqv",
      repos: repos(),
      config,
      baseline: {
        tier1: [],
        tier2Traces: [baselineTrace()],
        tier2Episodes: [],
        tier2Experiences: [],
        tier3: [],
      },
      now: 500,
    });

    expect(result.seedCount).toBeGreaterThan(0);
    expect(result.candidates.some((candidate) => candidate.refId === policyId)).toBe(true);
    expect(result.candidates.some((candidate) => candidate.refId === skillId)).toBe(true);
    expect(result.candidates.some((candidate) => candidate.refId === worldId)).toBe(true);
    expect(result.candidates.some((candidate) => candidate.refId === oldSkillId)).toBe(false);

    const skill = result.candidates.find((candidate) => candidate.refId === skillId);
    expect(skill?.channels?.some((channel) => channel.channel === "graph")).toBe(true);
    expect(skill?.debug?.lineageGraph).toMatchObject({
      provenance: "pigmemory_storage",
      hops: 2,
      edgePath: ["SUPPORTS", "CRYSTALLIZED_AS"],
    });
  });

  it("surfaces Decision Repair guidance with a real evidence Trace id", () => {
    const result = runLineageGraph({
      queryText: "use blue deployment",
      repos: repos({ withRepair: true }),
      config,
      baseline: {
        tier1: [],
        tier2Traces: [],
        tier2Episodes: [],
        tier2Experiences: [],
        tier3: [],
      },
      now: 500,
    });

    const repair = result.candidates.find(
      (candidate) => candidate.refKind === "decision-repair",
    );
    expect(repair).toMatchObject({
      refId: traceId,
      repairId: "dr-blue",
      preference: "Use blue deployment",
      validated: true,
    });
    expect(repair?.debug?.lineageGraph).toMatchObject({
      evidenceRef: "decision_repairs:dr-blue",
      provenance: "pigmemory_storage",
    });
  });
});
