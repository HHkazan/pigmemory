import { describe, expect, it, vi } from "vitest";

import { buildQuery } from "../../core/retrieval/query-builder.js";
import { runTier2 } from "../../core/retrieval/tier2-trace.js";
import type { RetrievalConfig, RetrievalRepos } from "../../core/retrieval/types.js";
import type { EpisodeId, SessionId, TraceId } from "../../core/types.js";

const config = {
  tier1TopK: 3,
  tier2TopK: 5,
  tier3TopK: 2,
  candidatePoolFactor: 4,
  weightCosine: 1,
  weightPriority: 0,
  mmrLambda: 1,
  includeLowValue: true,
  rrfConstant: 60,
  minSkillEta: 0.1,
  minTraceSim: 0.25,
  tagFilter: "auto",
  keywordTopK: 20,
  relativeThresholdFloor: 0.2,
  decayHalfLifeDays: 30,
  lightweightMemory: true,
  llmFilterEnabled: false,
  llmFilterMaxKeep: 5,
  llmFilterMinCandidates: 1,
} satisfies RetrievalConfig;

describe("tier2 trace retrieval", () => {
  it("keeps turn-start runtime metadata out of the semantic query", () => {
    const compiled = buildQuery({
      reason: "turn_start",
      agent: "hermes",
      sessionId: "session-1" as SessionId,
      userText: "我晚上吃的什么",
      contextHints: {
        hostProvider: "zai",
        hostBaseUrl: "https://open.bigmodel.cn/api/coding/paas/v4",
        namespace: { agentKind: "hermes", profileId: "default" },
      },
      ts: 1,
    });

    expect(compiled.text).toBe("我晚上吃的什么");
    expect(compiled.tags).toEqual([]);
    expect(compiled.ftsMatch).toBe('"我晚上吃的什么"');
    expect(compiled.patternTerms).not.toContain("cn");
  });

  it("does not pre-cap vector scans and preserves a strong pattern hit in tier2 topK", async () => {
    const targetId = "target" as TraceId;
    const distractorIds = Array.from(
      { length: 5 },
      (_, index) => `distractor-${index + 1}` as TraceId,
    );
    const searchByVector = vi.fn<RetrievalRepos["traces"]["searchByVector"]>(
      (_query, _k, opts) => distractorIds.map((id, index) => ({
        id,
        score: 0.55 - index * 0.01,
        meta: {
          ts: 1,
          priority: 0,
          value: 0,
          episode_id: `episode-${id}` as EpisodeId,
          session_id: "session-old" as SessionId,
          tags_json: "[]",
        },
      })),
    );
    const traces = {
      searchByVector,
      searchByPattern: vi.fn(() => [{
        id: targetId,
        score: 1,
        meta: {
          ts: 1,
          priority: 0,
          value: 0,
          episode_id: "episode-target" as EpisodeId,
          session_id: "session-old" as SessionId,
          tags_json: "[]",
        },
      }]),
      getManyByIds: vi.fn((ids: readonly TraceId[]) => ids.map((id) => ({
        id,
        episodeId: `episode-${id}` as EpisodeId,
        sessionId: "session-old" as SessionId,
        ts: 1,
        userText: id === targetId ? "晚饭" : "unrelated",
        agentText: "",
        summary: null,
        reflection: null,
        value: 0,
        priority: 0,
        tags: [],
        vecSummary: new Float32Array([1, 0]),
        vecAction: null,
      }))),
      searchByErrorSignature: vi.fn(() => []),
    } as unknown as RetrievalRepos["traces"];

    const result = await runTier2(
      { repos: { traces }, config, now: () => 1 },
      {
        queryVec: new Float32Array([1, 0]),
        tags: [],
        patternTerms: ["晚饭"],
      },
    );

    expect(searchByVector).toHaveBeenCalledOnce();
    expect(searchByVector.mock.calls[0]?.[2]?.hardCap).toBeUndefined();
    expect(result.traces.map((trace) => trace.refId)).toContain(targetId);
    expect(result.traces[0]?.refId).toBe(targetId);
  });
});
