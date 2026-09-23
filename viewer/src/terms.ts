export const terms: Record<string, string> = {
  trace: "记忆（Trace）",
  policy: "策略（Policy）",
  experience: "策略（Policy）",
  skill: "技能（Skill）",
  world_model: "世界模型（World Model）",
  "world-model": "世界模型（World Model）",
  "decision-repair": "决策修复（Decision Repair）",
  episode: "任务片段（Episode）",
  session: "会话（Session）",
  turn_start: "回合开始（Turn Start）",
  search: "检索（Search）",
  candidate: "候选（Candidate）",
  active: "生效（Active）",
  archived: "已归档（Archived）",
  open: "进行中（Open）",
  ended: "已结束（Ended）",
  paused: "已暂停（Paused）",
  interrupted: "已中断（Interrupted）",
  abandoned: "已放弃（Abandoned）",
  discarded: "已丢弃（Discarded）",
  captured: "已捕获（Captured）",
  summarized: "已摘要（Summarized）",
  vectorized: "已向量化（Vectorized）",
  reflected: "已反思（Reflected）",
  reflected_vectorized: "已反思并向量化（Reflected + Vectorized）",
  scored: "已评分（Scored）",
  capture_warning: "捕获警告（Capture Warning）",
  reward_calculated: "奖励已计算（Reward Calculated）",
  reward_failed: "奖励计算失败（Reward Failed）",
  reward_skipped: "奖励计算已跳过（Reward Skipped）",
  failed: "失败（Failed）",
  warning: "警告（Warning）",
  error: "错误（Error）",
  healthy: "健康（Healthy）",
  degraded: "降级（Degraded）",
  fault: "故障（Fault）",
  idle: "待首次验证（Awaiting First Check）",
};

export function term(value: unknown): string {
  const key = String(value ?? "");
  return terms[key] ?? (key.replaceAll("_", " ") || "—");
}

export const componentNames: Record<string, string> = {
  core: "核心（Core）",
  daemon: "守护进程（Daemon）",
  stdioBridge: "标准输入输出桥接器（stdio Bridge）",
  database: "数据库（Database）",
  summaryModel: "摘要模型（Summary Model）",
  embeddingModel: "向量模型（Embedding Model）",
  skillEvolverModel: "技能进化模型（Skill Evolver）",
};
