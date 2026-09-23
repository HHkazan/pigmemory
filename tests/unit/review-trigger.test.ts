import { describe, expect, it } from "vitest";

import { DEFAULT_CONFIG } from "../../core/config/defaults.js";
import { evaluateReviewTrigger } from "../../core/review/trigger.js";

const config = {
  ...DEFAULT_CONFIG.algorithm.reviewInterview,
  enabled: true,
};

describe("memory review trigger", () => {
  it("hard-gates turns that did not reference memory", () => {
    const result = evaluateReviewTrigger({
      memories: [],
      toolCalls: Array.from({ length: 20 }, () => ({ name: "write_file" })),
    }, config);

    expect(result.eligible).toBe(false);
    expect(result.score).toBeNull();
    expect(result.reason).toBe("no_referenced_memory");
  });

  it("combines tools, deterministic difficulty, and memory review value", () => {
    const result = evaluateReviewTrigger({
      memories: [{
        refId: "trace-1",
        refKind: "trace",
        relevance: 0.9,
        ratingCount: 0,
      }],
      toolCalls: [
        { name: "read_file", input: { path: "a.ts" }, output: "ok" },
        { name: "apply_patch", input: { path: "a.ts" }, output: "ok" },
        { name: "exec", input: { cmd: "npm test" }, output: "passed" },
        { name: "exec", input: { cmd: "npm run lint" }, output: "passed" },
      ],
      startedAt: 1_000,
      completedAt: 200_000,
    }, config);

    expect(result.breakdown.tool).toBe(70);
    expect(result.breakdown.difficulty).toBe(65);
    expect(result.breakdown.memory).toBe(93);
    expect(result.score).toBe(77.7);
    expect(result.eligible).toBe(true);
  });

  it("uses uncertainty instead of historical rating quality", () => {
    const newMemory = evaluateReviewTrigger({
      memories: [{ refId: "new", refKind: "trace", relevance: 0.8, ratingCount: 0 }],
      toolCalls: [],
    }, config);
    const establishedMemory = evaluateReviewTrigger({
      memories: [{ refId: "old", refKind: "trace", relevance: 0.8, ratingCount: 24 }],
      toolCalls: [],
    }, config);

    expect(newMemory.breakdown.memory).toBeGreaterThan(establishedMemory.breakdown.memory);
  });

  it("lets manual review bypass the automatic threshold but not the memory gate", () => {
    const result = evaluateReviewTrigger({
      memories: [{ refId: "trace-1", refKind: "trace", relevance: 0.2, ratingCount: 8 }],
      toolCalls: [],
      manual: true,
    }, { ...config, enabled: false, threshold: 100 });

    expect(result.eligible).toBe(true);
    expect(result.reason).toBe("eligible");
  });
});
