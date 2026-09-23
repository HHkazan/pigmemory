import { describe, expect, it } from "vitest";

import { bandFor, policyScoreForSort, scoreSummary } from "../../viewer/src/scoring.js";

describe("viewer score presentation", () => {
  it("uses stable normalized score bands", () => {
    expect(bandFor(0.8)).toBe("excellent");
    expect(bandFor(0.6)).toBe("good");
    expect(bandFor(0.4)).toBe("neutral");
    expect(bandFor(0.2)).toBe("low");
    expect(bandFor(0.19)).toBe("poor");
    expect(bandFor(null)).toBe("unscored");
  });

  it("maps signed trace and episode rewards into the shared palette", () => {
    expect(scoreSummary("traces", { value: 0.7, alpha: 0.8, priority: 1 }).band).toBe("excellent");
    expect(scoreSummary("episodes", { rTask: -0.7, turnCount: 2 }).band).toBe("poor");
  });

  it("shows the native scoring fields for every entity kind", () => {
    expect(scoreSummary("traces", { value: 0.3, alpha: 0.5 }).metrics.map((item) => item.label)).toContain("反思权重 α");
    const policy = scoreSummary("policies", {
      experienceType: "success_pattern",
      confidence: 0.5,
      confidenceScored: false,
      baseGain: 0.1,
      actualGain: 0.3,
      actualUsageCount: 2,
      actualGainWeight: 0.4,
      gain: 0.2,
      support: 3,
      status: "active",
    });
    expect(policy.primaryLabel).toBe("最终 Gain");
    expect(policy.metrics.find((item) => item.label === "基础 Gain")?.value).toBe("+0.100");
    expect(policy.metrics.find((item) => item.label === "实际 Gain")?.value).toBe("+0.300");
    expect(policy.metrics.find((item) => item.label === "最终 Gain")?.value).toBe("+0.200");
    expect(scoreSummary("policies", {
      experienceType: "success_pattern",
      baseGain: 0.2,
      actualGain: null,
      actualUsageCount: 0,
      gain: 0.2,
    }).metrics.find((item) => item.label === "实际 Gain")?.value).toBe("尚未调用");
    expect(scoreSummary("policies", {
      experienceType: "success_pattern",
      baseGain: 0.2,
      actualGain: null,
      actualUsageCount: 1,
      gain: 0.2,
    }).metrics.find((item) => item.label === "实际 Gain")?.value).toBe("样本不足（1/2）");
    const repair = scoreSummary("policies", {
      experienceType: "repair_instruction",
      confidence: 0.7,
      confidenceScored: true,
      salience: 0.8,
      gain: 0.2,
    });
    expect(repair.primaryLabel).toBe("反馈置信度");
    expect(repair.metrics.find((item) => item.label === "显著性")?.value).toBe("80%");
    expect(scoreSummary("skills", { eta: 0.9, trialsAttempted: 4, trialsPassed: 3 }).metrics.find((item) => item.label === "试用通过率")?.value).toBe("75%");
    expect(scoreSummary("world", { confidence: 0.5, policyIds: ["p1", "p2"] }).metrics.find((item) => item.label === "关联策略")?.value).toBe("2");
    expect(scoreSummary("episodes", { rTask: null }).primaryValue).toBe("待评分");
  });

  it("sorts ordinary policies by gain and feedback experiences by scored signals", () => {
    expect(policyScoreForSort({
      experienceType: "success_pattern",
      gain: 0.42,
      confidence: 0.99,
      confidenceScored: false,
    })).toBe(0.42);
    expect(policyScoreForSort({
      experienceType: "repair_instruction",
      gain: 0.1,
      salience: 0.8,
      confidence: 0.7,
      confidenceScored: true,
    })).toBe(0.8);
  });
});
