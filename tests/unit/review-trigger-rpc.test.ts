import { describe, expect, it } from "vitest";

import type { MemoryCore } from "../../agent-contract/memory-core.js";
import { makeDispatcher } from "../../bridge/methods.js";
import { DEFAULT_CONFIG } from "../../core/config/defaults.js";

describe("review.evaluate RPC", () => {
  it("reads the latest resolved review config through the core", async () => {
    const configured = {
      ...DEFAULT_CONFIG,
      algorithm: {
        ...DEFAULT_CONFIG.algorithm,
        reviewInterview: {
          ...DEFAULT_CONFIG.algorithm.reviewInterview,
          enabled: true,
          threshold: 10,
        },
      },
    };
    const core = {
      getConfig: async () => configured,
    } as unknown as MemoryCore;
    const dispatch = makeDispatcher(core);

    const result = await dispatch("review.evaluate", {
      memories: [{
        refId: "trace-1",
        refKind: "trace",
        relevance: 0.9,
        ratingCount: 0,
      }],
      toolCalls: [],
    }) as { eligible: boolean; threshold: number };

    expect(result.eligible).toBe(true);
    expect(result.threshold).toBe(10);
  });
});
