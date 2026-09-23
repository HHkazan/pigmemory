import type {
  ReviewTriggerInputDTO,
  ReviewTriggerResultDTO,
} from "../../agent-contract/dto.js";
import type { ResolvedConfig } from "../config/schema.js";

export type ReviewInterviewConfig = ResolvedConfig["algorithm"]["reviewInterview"];

export function evaluateReviewTrigger(
  input: ReviewTriggerInputDTO,
  config: ReviewInterviewConfig,
): ReviewTriggerResultDTO {
  const memories = input.memories.filter((memory) => memory.refId.trim().length > 0);
  const threshold = clamp(config.threshold, 0, 100);
  const delivery = {
    sendDelaySeconds: Math.max(0, config.sendDelaySeconds),
    cooldownMinutes: Math.max(0, config.cooldownMinutes),
    dailyLimit: Math.max(0, Math.floor(config.dailyLimit)),
  };
  if (memories.length === 0) {
    return {
      eligible: false,
      score: null,
      threshold,
      reason: "no_referenced_memory",
      breakdown: {
        tool: 0,
        difficulty: 0,
        memory: 0,
        effectiveToolCalls: 0,
        referencedMemories: 0,
        signals: {
          mutation: false,
          verification: false,
          externalSideEffect: false,
          retry: false,
          multiStep: false,
          longRunning: false,
        },
      },
      delivery,
    };
  }
  const effectiveTools = input.toolCalls.filter((tool) =>
    !matchesAny(toolText(tool), config.tool.ignoredPatterns)
  );
  const combinedToolText = effectiveTools.map(toolText);
  const mutation = combinedToolText.some((value) =>
    matchesAny(value, config.tool.mutationPatterns)
  );
  const verification = combinedToolText.some((value) =>
    matchesAny(value, config.tool.verificationPatterns)
  );
  const externalSideEffect = combinedToolText.some((value) =>
    matchesAny(value, config.tool.externalSideEffectPatterns)
  );
  const retry = effectiveTools.some((tool) =>
    tool.isError === true || matchesAny(serialise(tool.output), config.tool.failurePatterns)
  );
  const multiStep = effectiveTools.length >= config.difficulty.multiStepMinToolCalls;
  const durationMs = Math.max(0, (input.completedAt ?? 0) - (input.startedAt ?? 0));
  const longRunning = config.difficulty.longRunningMs > 0 &&
    durationMs >= config.difficulty.longRunningMs;

  const tool = clamp(
    scoreToolCount(effectiveTools.length, config.tool.callBands) +
      (mutation ? config.tool.mutationBonus : 0) +
      (verification ? config.tool.verificationBonus : 0),
    0,
    100,
  );
  const difficulty = clamp(
    (multiStep ? config.difficulty.multiStepPoints : 0) +
      (mutation ? config.difficulty.artifactPoints : 0) +
      (externalSideEffect ? config.difficulty.externalSideEffectPoints : 0) +
      (retry ? config.difficulty.retryPoints : 0) +
      (verification ? config.difficulty.verificationPoints : 0) +
      (longRunning ? config.difficulty.longRunningPoints : 0),
    0,
    100,
  );
  const memory = scoreMemories(memories, config);
  const breakdown = {
    tool: round(tool),
    difficulty: round(difficulty),
    memory: round(memory),
    effectiveToolCalls: effectiveTools.length,
    referencedMemories: memories.length,
    signals: {
      mutation,
      verification,
      externalSideEffect,
      retry,
      multiStep,
      longRunning,
    },
  };

  const score = round(weightedAverage(
    [tool, difficulty, memory],
    [config.weights.tool, config.weights.difficulty, config.weights.memory],
  ));
  if (input.manual) {
    return {
      eligible: config.manualEnabled,
      score,
      threshold,
      reason: config.manualEnabled ? "eligible" : "manual_disabled",
      breakdown,
      delivery,
    };
  }
  if (!config.enabled) {
    return {
      eligible: false,
      score,
      threshold,
      reason: "disabled",
      breakdown,
      delivery,
    };
  }
  return {
    eligible: score >= threshold,
    score,
    threshold,
    reason: score >= threshold ? "eligible" : "below_threshold",
    breakdown,
    delivery,
  };
}

function scoreToolCount(
  count: number,
  bands: ReviewInterviewConfig["tool"]["callBands"],
): number {
  let score = 0;
  for (const band of [...bands].sort((a, b) => a.minCalls - b.minCalls)) {
    if (count >= band.minCalls) score = band.score;
  }
  return score;
}

function scoreMemories(
  memories: ReviewTriggerInputDTO["memories"],
  config: ReviewInterviewConfig,
): number {
  if (memories.length === 0) return 0;
  const relevanceWeight = Math.max(0, config.memory.relevanceWeight);
  const uncertaintyWeight = Math.max(0, config.memory.uncertaintyWeight);
  const componentWeight = relevanceWeight + uncertaintyWeight;
  const values = memories.map((memory) => {
    const relevance = clamp(memory.relevance, 0, 1);
    const uncertainty = 1 / Math.sqrt(1 + Math.max(0, memory.ratingCount));
    const value = componentWeight > 0
      ? (relevance * relevanceWeight + uncertainty * uncertaintyWeight) / componentWeight
      : 0;
    return { relevance, value };
  });
  const relevanceSum = values.reduce((sum, item) => sum + item.relevance, 0);
  const aggregate = relevanceSum > 0
    ? values.reduce((sum, item) => sum + item.relevance * item.value, 0) / relevanceSum
    : values.reduce((sum, item) => sum + item.value, 0) / values.length;
  return clamp(aggregate * 100, 0, 100);
}

function weightedAverage(values: number[], weights: number[]): number {
  const total = weights.reduce((sum, weight) => sum + Math.max(0, weight), 0);
  if (total <= 0) return 0;
  return values.reduce(
    (sum, value, index) => sum + value * Math.max(0, weights[index] ?? 0),
    0,
  ) / total;
}

function toolText(tool: ReviewTriggerInputDTO["toolCalls"][number]): string {
  return `${tool.name ?? ""}\n${serialise(tool.input)}`.toLowerCase();
}

function serialise(value: unknown): string {
  if (typeof value === "string") return value.toLowerCase();
  try {
    return JSON.stringify(value ?? "").toLowerCase();
  } catch {
    return String(value ?? "").toLowerCase();
  }
}

function matchesAny(value: string, patterns: readonly string[]): boolean {
  const normalized = value.toLowerCase();
  return patterns.some((pattern) => {
    const needle = pattern.trim().toLowerCase();
    return needle.length > 0 && normalized.includes(needle);
  });
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Number.isFinite(value) ? value : min));
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}
