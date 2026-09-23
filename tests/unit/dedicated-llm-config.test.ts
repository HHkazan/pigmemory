import { describe, expect, it } from "vitest";

import { resolveConfig } from "../../core/config/index.js";

describe("dedicated LLM retry configuration", () => {
  it("accepts and preserves independent retry counts", () => {
    const warnings: string[] = [];
    const config = resolveConfig(
      {
        skillEvolver: { maxRetries: 2 },
        l3Llm: { maxRetries: 1 },
      },
      warnings,
    );

    expect(config.skillEvolver.maxRetries).toBe(2);
    expect(config.l3Llm.maxRetries).toBe(1);
    expect(warnings).not.toContain(
      "unknown config key 'skillEvolver.maxRetries' (kept as-is for forward compatibility)",
    );
    expect(warnings).not.toContain(
      "unknown config key 'l3Llm.maxRetries' (kept as-is for forward compatibility)",
    );
  });

  it("defaults both dedicated model slots to three retries", () => {
    const config = resolveConfig({});
    expect(config.skillEvolver.maxRetries).toBe(3);
    expect(config.l3Llm.maxRetries).toBe(3);
  });

  it("rejects retry counts outside the supported range", () => {
    expect(() =>
      resolveConfig({ skillEvolver: { maxRetries: 11 } }),
    ).toThrow(/config failed schema validation/);
  });
});
