import { describe, expect, it } from "vitest";

import { modelMonitorComponent } from "../../core/pipeline/memory-core.js";

function model(patch: Record<string, unknown> = {}) {
  return {
    available: true,
    provider: "openai_compatible",
    model: "test-model",
    lastOkAt: null,
    lastFallbackAt: null,
    lastError: null,
    ...patch,
  } as never;
}

describe("monitor model health", () => {
  it("keeps an initialized model neutral until its first call", () => {
    expect(modelMonitorComponent(model(), 1000)).toMatchObject({
      status: "idle",
      lastSuccessAt: null,
      lastError: null,
    });
  });

  it("still reports success, fallback, failure, and unavailability", () => {
    expect(modelMonitorComponent(model({ lastOkAt: 100 }), 1000)).toMatchObject({
      status: "ok",
    });
    expect(modelMonitorComponent(model({ lastFallbackAt: 200 }), 1000)).toMatchObject({
      status: "warning",
      fallback: true,
    });
    expect(modelMonitorComponent(model({ lastError: { at: 300, message: "failed" } }), 1000))
      .toMatchObject({ status: "error", lastError: "failed" });
    expect(modelMonitorComponent(model({ available: false }), 1000)).toMatchObject({
      status: "warning",
    });
  });
});
