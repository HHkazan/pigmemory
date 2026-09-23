import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { LlmClient } from "../../core/llm/index.js";
import type { Logger } from "../../core/logger/types.js";
import { llmFilterCandidates } from "../../core/retrieval/llm-filter.js";
import type { RankedCandidate } from "../../core/retrieval/ranker.js";

const candidate = {
  candidate: {
    tier: "tier1",
    refKind: "skill",
    refId: "skill-1",
    skillName: "Unrelated skill",
    invocationGuide: "Does something unrelated to the query.",
    eta: 0.8,
    status: "candidate",
    cosine: 0.9,
    ts: 1,
    vec: null,
    channels: [],
  },
  relevance: 0.9,
  rrf: 0,
  score: 0.9,
  normSq: null,
} as unknown as RankedCandidate;

const log = {
  debug() {},
  warn() {},
} as unknown as Logger;

let previousHome: string | undefined;

beforeEach(() => {
  previousHome = process.env.MEMOS_HOME;
  process.env.MEMOS_HOME = "/tmp/memos-filter-unit-test-missing";
});

afterEach(() => {
  if (previousHome === undefined) delete process.env.MEMOS_HOME;
  else process.env.MEMOS_HOME = previousHome;
});

describe("llmFilterCandidates", () => {
  it("honours an empty LLM selection for a single candidate", async () => {
    let calls = 0;
    const llm = {
      completeJson: async () => {
        calls++;
        return { value: { ranked: [], sufficient: false } };
      },
    } as unknown as LlmClient;

    const result = await llmFilterCandidates(
      { query: "write a quicksort", ranked: [candidate] },
      {
        llm,
        log,
        config: {
          llmFilterEnabled: true,
          llmFilterMaxKeep: 4,
          llmFilterMinCandidates: 1,
          llmFilterCandidateBodyChars: 500,
        },
      },
    );

    expect(calls).toBe(1);
    expect(result).toEqual({
      kept: [],
      dropped: [candidate],
      outcome: "llm_filtered",
      sufficient: false,
    });
  });

  it("uses the mechanical cutoff only when the LLM call fails", async () => {
    const llm = {
      completeJson: async () => {
        throw new Error("provider unavailable");
      },
    } as unknown as LlmClient;

    const result = await llmFilterCandidates(
      { query: "write a quicksort", ranked: [candidate] },
      {
        llm,
        log,
        timeoutMs: 50,
        config: {
          llmFilterEnabled: true,
          llmFilterMaxKeep: 4,
          llmFilterMinCandidates: 1,
          llmFilterCandidateBodyChars: 500,
        },
      },
    );

    expect(result.kept).toEqual([candidate]);
    expect(result.dropped).toEqual([]);
    expect(result.outcome).toBe("llm_failed_safe_cutoff");
    expect(result.sufficient).toBeNull();
  });

  it("drops a single low-signal pattern hit but keeps independent channel agreement", async () => {
    const llm = {
      completeJson: async () => {
        throw new Error("provider unavailable");
      },
    } as unknown as LlmClient;
    const singlePattern = structuredClone(candidate) as RankedCandidate;
    singlePattern.candidate.refId = "single-pattern";
    singlePattern.candidate.cosine = 0;
    singlePattern.candidate.channels = [{ channel: "pattern", rank: 0, score: 0.3 }];
    const agreed = structuredClone(candidate) as RankedCandidate;
    agreed.candidate.refId = "agreed";
    agreed.candidate.cosine = 0;
    agreed.candidate.channels = [
      { channel: "pattern", rank: 0, score: 0.3 },
      { channel: "fts", rank: 2, score: 0.2 },
    ];

    const result = await llmFilterCandidates(
      { query: "write a quicksort", ranked: [singlePattern, agreed] },
      {
        llm,
        log,
        timeoutMs: 50,
        config: {
          llmFilterEnabled: true,
          llmFilterMaxKeep: 4,
          llmFilterMinCandidates: 1,
          llmFilterCandidateBodyChars: 500,
          minTraceSim: 0.25,
          candidateSkillTopK: 2,
        },
      },
    );

    expect(result.kept.map((row) => row.candidate.refId)).toEqual(["agreed"]);
    expect(result.dropped.map((row) => row.candidate.refId)).toEqual(["single-pattern"]);
    expect(singlePattern.candidate.debug?.llmFallbackReason).toBe("dropped");
    expect(agreed.candidate.debug?.llmFallbackReason).toBe("multi_channel_agreement");
  });
});
