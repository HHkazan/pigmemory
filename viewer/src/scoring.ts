export type EntityKind = "traces" | "policies" | "skills" | "world" | "episodes";
export type ScoreBand = "excellent" | "good" | "neutral" | "low" | "poor" | "unscored";

export interface ScoreMetric {
  label: string;
  value: string;
  hint?: string;
}

export interface ScoreSummary {
  band: ScoreBand;
  bandLabel: string;
  primaryLabel: string;
  primaryValue: string;
  metrics: ScoreMetric[];
}

const bandLabels: Record<ScoreBand, string> = {
  excellent: "优秀",
  good: "良好",
  neutral: "一般",
  low: "偏低",
  poor: "较差",
  unscored: "待评分",
};

export function scoreSummary(kind: EntityKind, item: Record<string, any>): ScoreSummary {
  if (kind === "traces") {
    const primary = finite(item.value);
    return makeSummary(primary == null ? null : (primary + 1) / 2, "价值分 V", signed(primary), [
      metric("价值分 V", signed(item.value), "约 -1 到 1"),
      metric("反思权重 α", percent(item.alpha), "0% 到 100%"),
      metric("检索优先级", decimal(item.priority)),
      metric("人工奖励", signed(item.rHuman)),
      metric("任务奖励", signed(item.episodeRTask)),
    ]);
  }
  if (kind === "policies") {
    const experienceType = String(item.experienceType ?? "success_pattern");
    const confidenceScored = item.confidenceScored === true ||
      (item.confidenceScored == null && finite(item.confidence) != null);
    if (experienceType === "success_pattern") {
      const gain = finite(item.gain);
      const baseGain = finite(item.baseGain) ?? gain;
      const actualGain = finite(item.actualGain);
      const actualUsageCount = Math.max(0, Math.round(finite(item.actualUsageCount) ?? 0));
      const actualGainLabel = actualUsageCount === 0
        ? "尚未调用"
        : actualUsageCount === 1
          ? "样本不足（1/2）"
          : signed(actualGain);
      return makeSummary(normalizeSigned(gain), "最终 Gain", signed(gain), [
        metric("基础 Gain", signed(baseGain), "原有相似任务算法"),
        metric("实际 Gain", actualGainLabel, `${actualUsageCount} 个送达 Episode`),
        metric("最终 Gain", signed(gain), "用于生命周期、检索、L3 与 Skill"),
        metric("实际权重", percent(item.actualGainWeight), actualUsageCount < 2 ? "0～1 次不修正" : undefined),
        metric("支持任务", integer(item.support), "个独立 Episode"),
        metric("生命周期", policyStatus(item.status)),
      ]);
    }
    const confidence = confidenceScored ? finite(item.confidence) : null;
    return makeSummary(confidence, "反馈置信度", percent(confidence), [
      metric("反馈置信度", percent(confidence)),
      metric("显著性", percent(item.salience)),
      metric("经验增益 ΔV", signed(item.gain)),
      metric("支持任务", integer(item.support), "个"),
      metric("生命周期", policyStatus(item.status)),
    ]);
  }
  if (kind === "skills") {
    const attempted = finite(item.trialsAttempted);
    const passed = finite(item.trialsPassed);
    const passRate = attempted != null && attempted > 0 && passed != null ? passed / attempted : null;
    return makeSummary(finite(item.eta), "采用率 η", percent(item.eta), [
      metric("采用率 η", percent(item.eta)),
      metric("经验增益 ΔV", signed(item.gain)),
      metric("支持任务", integer(item.support), "个"),
      metric("试用通过率", percent(passRate), attempted == null ? undefined : `${passed ?? 0}/${attempted}`),
    ]);
  }
  if (kind === "world") {
    return makeSummary(finite(item.confidence), "置信度", percent(item.confidence), [
      metric("置信度", percent(item.confidence)),
      metric("关联策略", integer(Array.isArray(item.policyIds) ? item.policyIds.length : null), "条"),
      metric("模型版本", integer(item.version)),
    ]);
  }
  const reward = finite(item.rTask);
  return makeSummary(reward == null ? null : (reward + 1) / 2, "任务奖励 R", signed(reward), [
    metric("任务奖励 R", signed(item.rTask), "约 -1 到 1"),
    metric("回合数", integer(item.turnCount), "轮"),
    metric("奖励状态", item.rewardSkipped ? "已跳过" : reward == null ? "待评分" : "已评分"),
    metric("技能结果", skillState(item.skillStatus)),
  ]);
}

export function bandFor(normalized: number | null): ScoreBand {
  if (normalized == null || !Number.isFinite(normalized)) return "unscored";
  if (normalized >= 0.8) return "excellent";
  if (normalized >= 0.6) return "good";
  if (normalized >= 0.4) return "neutral";
  if (normalized >= 0.2) return "low";
  return "poor";
}

/**
 * Numeric value behind the Policy list's "quality score" ordering.
 * Ordinary induced policies use ΔV. Feedback-shaped experiences use the
 * strongest scored feedback signal, matching Tier-2's quality boost.
 */
export function policyScoreForSort(item: Record<string, any>): number | null {
  const experienceType = String(item.experienceType ?? "success_pattern");
  if (experienceType === "success_pattern") return finite(item.gain);
  const confidenceScored = item.confidenceScored === true ||
    (item.confidenceScored == null && finite(item.confidence) != null);
  const signals = [
    confidenceScored ? finite(item.confidence) : null,
    finite(item.salience),
    finite(item.gain),
  ].filter((value): value is number => value != null);
  return signals.length > 0 ? Math.max(...signals) : null;
}

function makeSummary(normalized: number | null, primaryLabel: string, primaryValue: string, metrics: ScoreMetric[]): ScoreSummary {
  const band = bandFor(normalized);
  return { band, bandLabel: bandLabels[band], primaryLabel, primaryValue, metrics };
}

function metric(label: string, value: string, hint?: string): ScoreMetric {
  return { label, value, ...(hint ? { hint } : {}) };
}

function finite(value: unknown): number | null {
  const number = typeof value === "number" ? value : Number(value);
  return value !== null && value !== undefined && value !== "" && Number.isFinite(number) ? number : null;
}

function normalizeSigned(value: number | null): number | null {
  if (value == null) return null;
  return Math.max(0, Math.min(1, (value + 1) / 2));
}

function percent(value: unknown): string {
  const number = finite(value);
  return number == null ? "待评分" : `${Math.round(number * 100)}%`;
}

function signed(value: unknown): string {
  const number = finite(value);
  if (number == null) return "待评分";
  return `${number > 0 ? "+" : ""}${number.toFixed(3)}`;
}

function decimal(value: unknown): string {
  const number = finite(value);
  return number == null ? "待评分" : number.toFixed(3);
}

function integer(value: unknown): string {
  const number = finite(value);
  return number == null ? "—" : String(Math.round(number));
}

function skillState(value: unknown): string {
  return ({
    queued: "排队中",
    generating: "生成中",
    generated: "已生成",
    upgraded: "已升级",
    not_generated: "未生成",
    skipped: "已跳过",
  } as Record<string, string>)[String(value ?? "")] ?? "无记录";
}

function policyStatus(value: unknown): string {
  return ({
    candidate: "候选",
    active: "生效",
    archived: "已归档",
  } as Record<string, string>)[String(value ?? "")] ?? "未知";
}
