#!/usr/bin/env node

const { mkdirSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");

const OUT_DIR = join(process.cwd(), "viewer", "public", "assets", "pigmemory-guide");
mkdirSync(OUT_DIR, { recursive: true });

const W = 1600;
const H = 1100;
const FONT = "Noto Sans CJK SC, Source Han Sans SC, Microsoft YaHei, sans-serif";

const tones = {
  coral: { fill: "#fff0eb", stroke: "#e98b79", title: "#9b3f31", badge: "#d86554" },
  teal: { fill: "#eaf8f3", stroke: "#66b79b", title: "#1c725a", badge: "#339475" },
  blue: { fill: "#edf5ff", stroke: "#73a7d9", title: "#285f91", badge: "#4c88c5" },
  gold: { fill: "#fff8df", stroke: "#d8b45f", title: "#80611b", badge: "#b98b25" },
  purple: { fill: "#f5efff", stroke: "#9f83d5", title: "#624196", badge: "#8064bb" },
  gray: { fill: "#f5f6f7", stroke: "#a8b0b6", title: "#4e5961", badge: "#77838c" },
  red: { fill: "#fff0f1", stroke: "#df7078", title: "#9e303b", badge: "#ca4c57" },
  green: { fill: "#eef8e9", stroke: "#83b86b", title: "#40732e", badge: "#619b49" },
};

function esc(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function charUnits(ch) {
  return /[\u2e80-\u9fff\uf900-\ufaff\uff00-\uffef]/u.test(ch) ? 2 : 1;
}

function wrapLine(text, maxUnits) {
  const out = [];
  let line = "";
  let units = 0;
  for (const ch of String(text)) {
    const next = charUnits(ch);
    if (units + next > maxUnits && line) {
      out.push(line);
      line = ch;
      units = next;
    } else {
      line += ch;
      units += next;
    }
  }
  if (line) out.push(line);
  return out;
}

function textBlock(x, y, lines, opts = {}) {
  const size = opts.size ?? 19;
  const color = opts.color ?? "#46515a";
  const weight = opts.weight ?? 450;
  const lineHeight = opts.lineHeight ?? Math.round(size * 1.55);
  const maxUnits = opts.maxUnits ?? 78;
  const anchor = opts.anchor ?? "start";
  const family = opts.mono
    ? "JetBrains Mono, SFMono-Regular, Consolas, Noto Sans Mono CJK SC, monospace"
    : FONT;
  const expanded = [];
  for (const line of lines) {
    if (line === "") expanded.push("");
    else expanded.push(...wrapLine(line, maxUnits));
  }
  return `<text x="${x}" y="${y}" text-anchor="${anchor}" font-family="${family}" font-size="${size}" font-weight="${weight}" fill="${color}">${expanded
    .map((line, index) => `<tspan x="${x}" dy="${index === 0 ? 0 : lineHeight}">${esc(line || " ")}</tspan>`)
    .join("")}</text>`;
}

function box(b) {
  const t = tones[b.tone ?? "gray"];
  const radius = b.radius ?? 22;
  const titleSize = b.titleSize ?? 24;
  const bodySize = b.bodySize ?? 18;
  const pad = b.pad ?? 24;
  const titleY = b.y + 42;
  const bodyY = b.y + (b.title ? 78 : 40);
  const maxUnits = b.maxUnits ?? Math.max(18, Math.floor((b.w - pad * 2) / (bodySize * 0.54)));
  return [
    `<g>`,
    `<rect x="${b.x}" y="${b.y}" width="${b.w}" height="${b.h}" rx="${radius}" fill="${t.fill}" stroke="${t.stroke}" stroke-width="2"/>`,
    b.number
      ? `<circle cx="${b.x + 30}" cy="${b.y + 32}" r="20" fill="${t.badge}"/><text x="${b.x + 30}" y="${b.y + 39}" text-anchor="middle" font-family="${FONT}" font-size="19" font-weight="800" fill="#fff">${esc(b.number)}</text>`
      : "",
    b.title
      ? `<text x="${b.x + pad + (b.number ? 34 : 0)}" y="${titleY}" font-family="${FONT}" font-size="${titleSize}" font-weight="800" fill="${t.title}">${esc(b.title)}</text>`
      : "",
    textBlock(b.x + pad, bodyY, b.lines ?? [], {
      size: bodySize,
      color: b.color ?? "#45515a",
      lineHeight: b.lineHeight,
      maxUnits,
      mono: b.mono,
    }),
    `</g>`,
  ].join("");
}

function pill(x, y, label, tone = "gray") {
  const t = tones[tone];
  const width = Math.max(92, 30 + Array.from(label).reduce((n, ch) => n + charUnits(ch) * 9, 0));
  return `<g><rect x="${x}" y="${y}" width="${width}" height="36" rx="18" fill="${t.fill}" stroke="${t.stroke}"/><text x="${x + width / 2}" y="${y + 25}" text-anchor="middle" font-family="${FONT}" font-size="16" font-weight="700" fill="${t.title}">${esc(label)}</text></g>`;
}

function arrow(x1, y1, x2, y2, label = "", tone = "gray", bend = 0) {
  const t = tones[tone];
  const midX = (x1 + x2) / 2;
  const midY = (y1 + y2) / 2;
  const path = bend === 0
    ? `M ${x1} ${y1} L ${x2} ${y2}`
    : `M ${x1} ${y1} Q ${midX} ${midY + bend} ${x2} ${y2}`;
  return `<g><path d="${path}" fill="none" stroke="${t.badge}" stroke-width="3" stroke-linecap="round" marker-end="url(#arrow-${tone})"/>${label ? `<rect x="${midX - 74}" y="${midY - 16 + bend / 2}" width="148" height="31" rx="15" fill="#fffdf9" opacity="0.94"/><text x="${midX}" y="${midY + 6 + bend / 2}" text-anchor="middle" font-family="${FONT}" font-size="15" font-weight="700" fill="${t.title}">${esc(label)}</text>` : ""}</g>`;
}

function lane(y, label, tone = "gray") {
  const t = tones[tone];
  return `<g><rect x="36" y="${y}" width="1528" height="1" fill="${t.stroke}" opacity="0.5"/><rect x="38" y="${y - 21}" width="160" height="42" rx="21" fill="${t.badge}"/><text x="118" y="${y + 7}" text-anchor="middle" font-family="${FONT}" font-size="17" font-weight="800" fill="#fff">${esc(label)}</text></g>`;
}

function note(x, y, w, lines, tone = "gold") {
  const t = tones[tone];
  const h = 28 + lines.length * 31;
  return `<g><rect x="${x}" y="${y}" width="${w}" height="${h}" rx="16" fill="${t.fill}" stroke="${t.stroke}" stroke-width="2" stroke-dasharray="7 6"/>${textBlock(x + 20, y + 31, lines, { size: 17, color: t.title, weight: 650, maxUnits: Math.floor((w - 40) / 9) })}</g>`;
}

function header(index, title, subtitle) {
  return [
    `<text x="58" y="70" font-family="${FONT}" font-size="18" font-weight="800" letter-spacing="2" fill="#d45f50">PIGMEMORY · 原理图 ${String(index).padStart(2, "0")}/12</text>`,
    `<text x="58" y="126" font-family="${FONT}" font-size="38" font-weight="900" fill="#3e3635">${esc(title)}</text>`,
    textBlock(60, 166, [subtitle], { size: 18, color: "#786b67", maxUnits: 150 }),
    `<line x1="58" y1="204" x2="1542" y2="204" stroke="#eadbd4" stroke-width="2"/>`,
  ].join("");
}

function defs() {
  return `<defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#fffdf9"/><stop offset="0.55" stop-color="#fff9f3"/><stop offset="1" stop-color="#eef8f4"/></linearGradient>
    <filter id="shadow" x="-20%" y="-20%" width="140%" height="140%"><feDropShadow dx="0" dy="8" stdDeviation="10" flood-color="#5e4037" flood-opacity="0.10"/></filter>
    ${Object.entries(tones).map(([name, t]) => `<marker id="arrow-${name}" markerWidth="10" markerHeight="10" refX="8" refY="3" orient="auto"><path d="M0,0 L0,6 L9,3 z" fill="${t.badge}"/></marker>`).join("")}
  </defs>`;
}

function frame(index, title, subtitle, body, footer) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
    ${defs()}
    <rect width="${W}" height="${H}" fill="url(#bg)"/>
    ${header(index, title, subtitle)}
    ${body}
    <text x="1540" y="1070" text-anchor="end" font-family="${FONT}" font-size="15" fill="#9a8c87">${esc(footer ?? "依据当前源码执行链绘制 · 2026-08-07")}</text>
  </svg>`;
}

const diagrams = [];

diagrams.push({
  file: "01-system-overview",
  svg: frame(1, "总览：一次对话怎样变成下一次可用的记忆", "先看完整闭环；后面 11 张图逐段放大。", [
    box({ x: 55, y: 245, w: 285, h: 250, number: "1", title: "实时回合", tone: "coral", lines: ["用户消息进入", "→ 判断主题关系", "→ 检索旧记忆", "→ 安全注入上下文", "→ Agent 回复/调用工具"] }),
    box({ x: 410, y: 245, w: 285, h: 250, number: "2", title: "L1 即时落盘", tone: "blue", lines: ["每回合拆成决策点", "工具调用各是一条 Trace", "最终回答另是一条 Trace", "先写 summary + 向量", "reflection=null，α=0"] }),
    box({ x: 765, y: 245, w: 355, h: 250, number: "3", title: "主题结束后评分", tone: "gold", lines: ["批量反思并判断可用性 α", "等待反馈窗口（默认 30 秒）", "计算 R_human", "从末步向前回传 V", "按时间衰减得到 priority"] }),
    box({ x: 1190, y: 245, w: 355, h: 250, number: "4", title: "跨任务演化", tone: "purple", lines: ["L2：Trace → Policy", "L3：Policy 簇 → World Model", "Skill：高质量 Policy → 可调用技能", "反馈失败 → 修复经验", "所有对象都保留证据链"] }),
    arrow(340, 370, 410, 370, "回合结束", "coral"),
    arrow(695, 370, 765, 370, "主题边界", "blue"),
    arrow(1120, 370, 1190, 370, "reward.updated", "gold"),
    lane(565, "下一回合", "teal"),
    box({ x: 145, y: 625, w: 355, h: 235, title: "并行召回", tone: "teal", lines: ["Tier 1：Skill", "Tier 2：Trace / Episode / Experience", "Tier 3：World Model", "向量、FTS、模式、结构错误通道并行"] }),
    box({ x: 625, y: 625, w: 355, h: 235, title: "融合与精排", tone: "blue", lines: ["最佳通道分 + RRF", "+ priority / η / confidence", "相对阈值 + 多通道豁免", "MMR 去冗余", "LLM 相关性过滤（失败时放行机械排序）"] }),
    box({ x: 1105, y: 625, w: 355, h: 235, title: "安全注入", tone: "coral", lines: ["按 Skills / Memories / Experiences / Environment 分组", "只给技能摘要，按需再取完整指南", "包在 <relevant-memories>", "明确标记为不可信历史数据", "交给 Agent 本回合使用"] }),
    arrow(500, 742, 625, 742, "候选集", "teal"),
    arrow(980, 742, 1105, 742, "最终片段", "blue"),
    arrow(1280, 860, 255, 870, "新产生的结果再次进入 L1", "coral", 120),
    note(330, 935, 940, ["关键时钟：回合结束只做轻量捕获；主题结束才做反思、奖励、L2/L3/Skill。", "所以刚写入的 Trace 可以马上被检索，但其 α / V 要等主题闭环后才可靠。"], "gold"),
  ].join("")),
});

diagrams.push({
  file: "02-turn-topic-lifecycle",
  svg: frame(2, "回合与主题边界：什么时候只记录，什么时候开始进化", "Session 是会话容器；Episode 是同一主题的任务片段；Turn 是一次用户—助手交互。", [
    lane(255, "Turn Start", "coral"),
    box({ x: 65, y: 295, w: 285, h: 215, number: "1", title: "接收用户消息", tone: "coral", lines: ["沿用 sessionId", "读取当前 open episode", "若没有则创建新 Episode"] }),
    box({ x: 410, y: 295, w: 350, h: 215, number: "2", title: "关系分类", tone: "gold", lines: ["输入：上一主题首尾文本 + 新消息 + gapMs", "输出：revision / follow_up / unknown / new_task", "超时则用保守默认"] }),
    box({ x: 820, y: 295, w: 320, h: 215, number: "3", title: "决定边界", tone: "purple", lines: ["同题且未超窗口：追加", "新任务/超时/达到回合上限：", "先 finalize 旧 Episode", "再创建新 Episode"] }),
    box({ x: 1200, y: 295, w: 335, h: 215, number: "4", title: "检索并注入", tone: "teal", lines: ["意图调度决定 Tier", "执行 turn_start 检索", "返回 InjectionPacket", "适配器交给 Agent"] }),
    arrow(350, 402, 410, 402, "有上下文", "coral"),
    arrow(760, 402, 820, 402, "relation", "gold"),
    arrow(1140, 402, 1200, 402, "当前 Episode", "purple"),
    lane(575, "Turn End", "blue"),
    box({ x: 65, y: 620, w: 350, h: 230, number: "5", title: "记录本回合结果", tone: "blue", lines: ["追加 assistant 与 tool turns", "保留 tool input/output/error/timing", "完整 Episode 快照仍在内存/存储中"] }),
    box({ x: 485, y: 620, w: 350, h: 230, number: "6", title: "runLite 即时捕获", tone: "teal", lines: ["只提取本回合新增步骤", "摘要 + 向量 + 去重 + 写 Trace", "不做反思，不触发 reward", "页面立即可见"] }),
    box({ x: 905, y: 620, w: 310, h: 230, number: "7A", title: "主题继续", tone: "green", lines: ["Episode 保持 open", "下一回合继续追加", "不启动完整演化链"] }),
    box({ x: 1270, y: 620, w: 265, h: 230, number: "7B", title: "主题结束", tone: "red", lines: ["episode.finalized", "→ runReflect", "→ Reward", "→ L2 / L3 / Skill"] }),
    arrow(415, 735, 485, 735, "本回合快照", "blue"),
    arrow(835, 735, 905, 735, "同一主题", "green"),
    arrow(1215, 735, 1270, 735, "边界事件", "red"),
    note(300, 915, 1000, ["主题边界不是“每次回复结束”。它通常在下一条用户消息被判定为 new_task、间隔过长、达到回合上限或会话关闭时发生。", "这解释了为什么有些 Trace 已经出现，但反思、V、Policy、Skill 仍稍后才补齐。"], "gold"),
  ].join("")),
});

diagrams.push({
  file: "03-trace-extraction",
  svg: frame(3, "Trace 如何收集：把一轮对话拆成“决策点”", "粒度不是整段聊天，也不是每条数据库消息；一次工具决策是一条 Trace，最终文字答复再单独一条。", [
    box({ x: 55, y: 250, w: 350, h: 330, title: "原始 Episode 片段", tone: "coral", lines: ["User：请检查并修复配置", "Assistant meta：thinking…", "Tool ① read_file(input)", "Tool result ①：文件内容", "Tool ② apply_patch(input)", "Tool result ②：成功", "Assistant：已修复，并说明验证结果"] }),
    box({ x: 485, y: 250, w: 300, h: 330, number: "1", title: "按 User 分段", tone: "gold", lines: ["遇到 user role 开新 segment", "合并该段的 user 文本", "收集 assistant thinking/reflection", "识别 tool role", "若主机没写 tool role，则从 assistant.meta.toolCalls 兜底"] }),
    box({ x: 865, y: 250, w: 680, h: 330, number: "2", title: "一个回合拆成 3 个 StepCandidate", tone: "blue", lines: ["Step A / tool：userText=原问题；toolCalls=[read_file]；agentText=空", "Step B / tool：userText=空；toolCalls=[apply_patch]；agentText=空", "Step C / response：userText=空；toolCalls=[]；agentText=最终答复", "三个步骤共享 turnId（首个 user turn 的时间戳）", "算法按步骤评分；查看器可按 turnId 折叠成“一轮一张卡”"] }),
    arrow(405, 415, 485, 415, "segment", "coral"),
    arrow(785, 415, 865, 415, "拆子步骤", "gold"),
    lane(640, "TraceRow 字段", "teal"),
    box({ x: 55, y: 690, w: 355, h: 280, title: "身份与原文", tone: "gray", lines: ["id / episodeId / sessionId", "ownerAgentKind / profile / workspace", "ts / turnId", "userText / agentText / agentThinking", "toolCalls：name,input,output,errorCode, timing"] }),
    box({ x: 455, y: 690, w: 355, h: 280, title: "派生检索字段", tone: "teal", lines: ["summary：LLM 摘要", "tags：内容与工具标签", "errorSignatures：结构化错误签名", "vecSummary：摘要向量", "vecAction：动作/工具向量", "schemaVersion"] }),
    box({ x: 855, y: 690, w: 330, h: 280, title: "评分字段", tone: "gold", lines: ["reflection：主题结束后补", "alpha：反思可信度", "rHuman：兼容字段/通常为空", "value：回传后的 V_t", "priority：max(V,0) × 时间衰减"] }),
    box({ x: 1230, y: 690, w: 315, h: 280, title: "首次写入值", tone: "purple", lines: ["reflection = null", "alpha = 0", "value = 0", "priority = 0.5（冷启动可检索）", "主题结束后原位更新，不重复插入"] }),
  ].join("")),
});

diagrams.push({
  file: "04-capture-two-phase",
  svg: frame(4, "Capture 双阶段：即时可见与主题级反思如何兼得", "同一批 Trace 先快速写入，稍后在完整因果链可见时补反思和 α；两次都做幂等去重。", [
    lane(260, "每回合 runLite", "teal"),
    box({ x: 55, y: 300, w: 245, h: 225, number: "1", title: "Extract", tone: "teal", lines: ["从完整 Episode 重提取", "只保留数据库中尚未出现的 ts/签名", "读取去重列时不加载向量 BLOB"] }),
    box({ x: 345, y: 300, w: 245, h: 225, number: "2", title: "Normalize", tone: "blue", lines: ["截断超长字段", "标准化工具调用", "生成 tags / error signature", "保持 turnId"] }),
    box({ x: 635, y: 300, w: 245, h: 225, number: "3", title: "Summarize", tone: "purple", lines: ["主 LLM 生成摘要", "失败时允许空摘要", "此阶段不反思", "α 固定为 0"] }),
    box({ x: 925, y: 300, w: 245, h: 225, number: "4", title: "Embed", tone: "gold", lines: ["vecSummary", "vecAction", "嵌入失败则写 null", "并进入 embedding retry queue"] }),
    box({ x: 1215, y: 300, w: 330, h: 225, number: "5", title: "Persist + lite.done", tone: "coral", lines: ["插入新的 TraceRow", "更新 Episode.traceIds", "发 capture.lite.done 供日志展示", "不会发 capture.done", "因此不会提前启动 Reward"] }),
    arrow(300, 412, 345, 412, "新步骤", "teal"), arrow(590, 412, 635, 412, "规范化", "blue"), arrow(880, 412, 925, 412, "摘要文本", "purple"), arrow(1170, 412, 1215, 412, "向量", "gold"),
    lane(610, "主题结束 runReflect", "gold"),
    box({ x: 55, y: 650, w: 270, h: 250, number: "A", title: "重建完整步骤链", tone: "gold", lines: ["episode.finalized 触发", "重新 Extract + Normalize", "按 ts/签名匹配既有 Trace", "恢复时也可补 orphan rows"] }),
    box({ x: 380, y: 650, w: 310, h: 250, number: "B", title: "反思模式选择", tone: "purple", lines: ["短 Episode：一次 batch JSON", "长 Episode：分块或逐步", "可注入 task summary", "可预览后续 1..N 步", "避免只看局部误判因果"] }),
    box({ x: 745, y: 650, w: 270, h: 250, number: "C", title: "α Judge", tone: "blue", lines: ["输入 state/thinking/action", "+ tool outcome", "+ downstream preview", "+ reflection", "输出 alpha, usable, reason"] }),
    box({ x: 1070, y: 650, w: 245, h: 250, number: "D", title: "Patch", tone: "teal", lines: ["updateReflection(id)", "只补 reflection + α", "不重复插入 Trace", "malformed/LLM 失败 → α=0"] }),
    box({ x: 1370, y: 650, w: 175, h: 250, number: "E", title: "done", tone: "red", bodySize: 17, lines: ["发 capture.done", "开启 30 秒反馈窗", "进入奖励链"] }),
    arrow(325, 775, 380, 775, "全链", "gold"), arrow(690, 775, 745, 775, "reflection", "purple"), arrow(1015, 775, 1070, 775, "α", "blue"), arrow(1315, 775, 1370, 775, "完成", "teal"),
    note(335, 955, 930, ["轻量内存模式是另一条路径：每个用户—助手回合合并成一条 Trace，只保留摘要向量；Reward / L2 / L3 / Skill / Feedback subscriber 全部不挂载。"], "gray"),
  ].join("")),
});

diagrams.push({
  file: "05-reflection-reward-scoring",
  svg: frame(5, "Trace 如何打分：α、R_human、V 与 priority 的完整链", "α 判断“这条反思是否能解释决策”；R_human 判断“整项任务做得怎样”；V 把任务结果分配回每个步骤。", [
    box({ x: 55, y: 245, w: 340, h: 265, number: "1", title: "反思质量 α_t", tone: "purple", lines: ["Judge 输入：任务上下文、state、thinking、action、tool outcome、后续步骤、reflection", "输出 alpha∈[0,1] + usable", "usable=false → α=0", "反思为空/解析失败 → α=0"] }),
    box({ x: 455, y: 245, w: 355, h: 265, number: "2", title: "任务奖励 R_human", tone: "coral", lines: ["反馈窗口内有显式反馈：立即评分", "否则 30 秒后用已存隐式信号", "LLM 失败：回退极性启发式", "无反馈的启发式结果为 0"] }),
    box({ x: 870, y: 245, w: 675, h: 265, number: "3", title: "三轴合成公式", tone: "gold", mono: true, bodySize: 19, lines: ["goal, process, satisfaction ∈ [-1, 1]", "R_human = clamp(", "  0.45 × goalAchievement", "+ 0.30 × processQuality", "+ 0.25 × userSatisfaction, -1, 1)", "显式启发式：只从 feedback polarity 得 satisfaction"] }),
    arrow(395, 378, 455, 378, "任务级反馈", "purple"), arrow(810, 378, 870, 378, "三轴", "coral"),
    lane(580, "从最后一步向前回传", "blue"),
    box({ x: 55, y: 625, w: 510, h: 270, title: "价值回传", tone: "blue", mono: true, bodySize: 20, lines: ["边界：V_T = R_human", "递推：V_t = α_t × R_human", "           + (1 − α_t) × γ × V_(t+1)", "当前默认 γ = 0.9", "α=0：完全依赖后续结果折扣传播", "α=1：该步直接承接整项任务奖励"] }),
    box({ x: 625, y: 625, w: 410, h: 270, title: "检索优先级", tone: "teal", mono: true, bodySize: 20, lines: ["decay = 0.5 ^ (Δdays / halfLifeDays)", "priority_t = max(V_t, 0) × decay", "默认 halfLifeDays = 30", "负 V 仍永久保存", "但 priority=0；普通检索下沉", "Decision Repair 可显式召回负样本"] }),
    box({ x: 1095, y: 625, w: 450, h: 270, title: "四步示例", tone: "green", mono: true, bodySize: 18, lines: ["设 R=0.8，γ=0.9，α=[0,0.6,0.2,0]", "V4 = 0.800", "V3 = 0.2×0.8 + 0.8×0.9×0.8 = 0.736", "V2 = 0.6×0.8 + 0.4×0.9×0.736 = 0.745", "V1 = 0×0.8 + 1×0.9×0.745 = 0.670", "当天 priority≈V；30 天后约减半"] }),
    note(300, 960, 1000, ["Reward 前有确定性“无意义任务”门：轮次、内容长度、无用户消息、纯测试/寒暄、工具结果占比过高、重复内容。命中后不发 reward.updated，避免污染 L2/L3/Skill。"], "red"),
  ].join("")),
});

diagrams.push({
  file: "06-retrieval-entry-routing",
  svg: frame(6, "检索入口：不同触发时机为什么查不同层", "五个内部入口共用同一条召回—排序—过滤管线，但 Tier 开关、负样本策略和预算不同。", [
    box({ x: 55, y: 245, w: 290, h: 250, title: "turn_start", tone: "coral", lines: ["新用户回合开始", "Tier 1 + Tier 2 + Tier 3", "完整预算", "当前 session 的旧 Trace 通常排除", "意图调度可覆盖各 Tier"] }),
    box({ x: 365, y: 245, w: 290, h: 250, title: "tool_driven", tone: "blue", lines: ["Agent 显式搜索", "默认 Tier 2 + Tier 3", "Tier 1 可由 plan 开启", "预算偏小", "query 来自参数与 tool name"] }),
    box({ x: 675, y: 245, w: 290, h: 250, title: "skill_invoke", tone: "purple", lines: ["即将执行某个技能", "Tier 1 主导 + 少量 Tier 2", "不查 Tier 3", "用于校验技能是否适用", "可补充相似历史步骤"] }),
    box({ x: 985, y: 245, w: 290, h: 250, title: "sub_agent", tone: "teal", lines: ["给子 Agent 准备上下文", "Tier 2 + Tier 3", "不注入 Tier 1", "query = profile + mission", "避免把父 Agent 技能强塞给子任务"] }),
    box({ x: 1295, y: 245, w: 250, h: 250, title: "decision_repair", tone: "red", bodySize: 17, lines: ["重复工具失败后", "Tier 1 + Tier 2", "includeLowValue=true", "允许找 priority=0 的反例", "无失败或无结果则不注入"] }),
    lane(565, "Query 编译", "gold"),
    box({ x: 55, y: 615, w: 350, h: 270, number: "1", title: "主检索文本", tone: "gold", lines: ["turn_start：只嵌入本轮用户原文", "tool：query + 其余 args", "skill：skillId + query", "sub-agent：profile + mission", "repair：失败工具 + 错误序列", "最长 1500 字，保留首尾"] }),
    box({ x: 455, y: 615, w: 350, h: 270, number: "2", title: "派生结构", tone: "teal", lines: ["tags：关键词映射", "structuralFragments：错误签名", "ftsMatch：SQLite FTS5 表达式", "patternTerms：短中文/混合关键词", "原始文本本身不会被改写成历史答案"] }),
    box({ x: 855, y: 615, w: 330, h: 270, number: "3", title: "降级策略", tone: "blue", lines: ["优先生成 query embedding", "嵌入失败不终止", "只要 FTS 或 pattern 可用就继续", "所有通道都不可用才返回空", "降级状态写入检索统计"] }),
    box({ x: 1235, y: 615, w: 310, h: 270, number: "4", title: "轻量模式差异", tone: "gray", lines: ["所有入口退化为 Trace-only", "turn_start / tool / skill / sub-agent 只查 Tier 2 Trace", "Decision Repair 直接禁用", "仍保留摘要、向量、FTS、LLM 过滤"] }),
    arrow(405, 750, 455, 750, "编译", "gold"), arrow(805, 750, 855, 750, "嵌入", "teal"), arrow(1185, 750, 1235, 750, "模式开关", "blue"),
    note(350, 945, 900, ["注意：这些是 core 内部纯函数入口。宿主公开工具仍可能只暴露其中一部分参数组合；图 6 描述的是实际算法能力，不等于每个 JSON-RPC 方法都完整开放。"], "gold"),
  ].join("")),
});

diagrams.push({
  file: "07-retrieval-candidates-channels",
  svg: frame(7, "并行召回：候选层级与六种检索通道", "一次 query 同时访问多个对象表与通道；同一对象被多个通道命中会合并为一个候选并保留每个 channel rank。", [
    box({ x: 55, y: 245, w: 300, h: 250, title: "Tier 1 · Skill", tone: "purple", lines: ["对象：candidate / active Skill", "过滤：η 下限、状态、owner scope", "正文：summary / trigger / invocation guide", "完整指南默认不直接塞入", "提示 Agent 按需调用兼容工具取全文"] }),
    box({ x: 385, y: 245, w: 405, h: 250, title: "Tier 2 · 经验层", tone: "blue", lines: ["2a Trace：单个决策点，带 V / priority", "2b Episode：同任务 Trace 聚合摘要", "2c Experience：反馈型 Policy，带 salience/confidence/gain", "普通 Trace 默认不取低价值", "repair 可包含负 V / priority=0"] }),
    box({ x: 820, y: 245, w: 300, h: 250, title: "Tier 3 · World Model", tone: "teal", lines: ["对象：active WorldModel", "过滤：confidence 下限、owner scope", "正文：环境事实、推断、约束", "带 source policyIds", "回答“环境通常怎样运作”"] }),
    box({ x: 1150, y: 245, w: 395, h: 250, title: "候选统一结构", tone: "gray", lines: ["refId / refKind / tier / ts", "cosine / vec", "channels[] = {channel, rank, score}", "对象特有质量字段", "debug：为什么命中、哪个字段命中", "后续排序不再回查原始表"] }),
    lane(565, "六种 Channel", "coral"),
    box({ x: 55, y: 615, w: 225, h: 250, title: "vec_summary", tone: "teal", lines: ["query 向量 ↔ Trace 摘要向量", "代表语义主题相似", "分数：clamp(cosine,0,1)"] }),
    box({ x: 305, y: 615, w: 225, h: 250, title: "vec_action", tone: "blue", lines: ["query 向量 ↔ 动作/工具向量", "适合找相似操作", "Trace 可同时命中两个向量列"] }),
    box({ x: 555, y: 615, w: 225, h: 250, title: "vec", tone: "purple", lines: ["Skill / Policy / WorldModel 的主向量", "跨对象语义召回", "向量缺失进入补嵌入队列"] }),
    box({ x: 805, y: 615, w: 225, h: 250, title: "fts", tone: "gold", lines: ["SQLite FTS5 关键词检索", "基础分：0.65/(rank+1)", "向量服务失败时仍可用"] }),
    box({ x: 1055, y: 615, w: 225, h: 250, title: "pattern", tone: "coral", lines: ["短中文、代码词、混合词覆盖", "按覆盖率计分", "分数上限 0.60"] }),
    box({ x: 1305, y: 615, w: 240, h: 250, title: "structural", tone: "red", lines: ["错误签名精确/结构匹配", "如 errorCode + tool", "强信号基准约 0.9", "主要服务故障修复"] }),
    arrow(185, 865, 710, 930, "同一 refId 合并 channel ranks", "teal", 60),
    arrow(1425, 865, 890, 930, "不重复制造候选", "red", 60),
  ].join("")),
});

diagrams.push({
  file: "08-retrieval-ranking-injection",
  svg: frame(8, "检索排序：从候选融合到最终安全注入", "机械排序解决“相关 + 高价值 + 不重复”；LLM 过滤解决“当前问题真的用得上吗”；两者职责分离。", [
    box({ x: 55, y: 245, w: 300, h: 280, number: "1", title: "基础相关度", tone: "blue", mono: true, bodySize: 15, lineHeight: 22, lines: ["base = max(channel.score)", "RRF = Σ 1/(k + rank_i + 1)", "relevance = base + 0.4×RRF + boost", "Trace/Episode ≤ 0.3×priority", "Skill = 0.15×η − candidatePenalty", "普通 L2 = 0.15×gain + 0.05×support/(support+3)", "反馈经验 = 0.2×max(salience,confidence,gain)", "candidate 质量加成再 ×0.75", "WorldModel = 0.1×confidence"] }),
    box({ x: 390, y: 245, w: 270, h: 280, number: "2", title: "相对阈值", tone: "gold", lines: ["top = 全池最高 relevance", "cutoff = top × relativeFloor", "低于 cutoff 的单通道候选丢弃", "命中 ≥2 通道可豁免", "豁免仍要参加去重"] }),
    box({ x: 695, y: 245, w: 300, h: 280, number: "3", title: "Smart-seed + MMR", tone: "purple", mono: true, bodySize: 17, lines: ["每 Tier 最多先播 1 个种子", "前提：tierBest ≥ poolTop×0.7", "MMR(c)=λ×relevance", "       −(1−λ)×maxCos(c,selected)", "然后贪心补满 limit", "candidate Skill 还有独立数量上限"] }),
    box({ x: 1030, y: 245, w: 250, h: 280, number: "4", title: "LLM 精排", tone: "coral", lines: ["把机械候选和当前 query 交给过滤模型", "输出保留 id + sufficient", "超时、禁用、解析失败：fail-open", "即回到机械排序结果"] }),
    box({ x: 1315, y: 245, w: 230, h: 280, number: "5", title: "最终去重", tone: "teal", bodySize: 17, lines: ["Trace 与 Episode 若来自同一 episode，只保留更合适者", "收集关联 Policy 的 decision guidance", "形成 Packet"] }),
    arrow(355, 385, 390, 385, "融合", "blue"), arrow(660, 385, 695, 385, "survivors", "gold"), arrow(995, 385, 1030, 385, "top-K", "purple"), arrow(1280, 385, 1315, 385, "kept", "coral"),
    lane(590, "InjectionPacket", "teal"),
    box({ x: 55, y: 635, w: 350, h: 290, title: "结构化结果", tone: "gray", lines: ["hits / snippets / rendered", "retrievalId / reason / timing", "每条保留 refKind、tier、score", "candidate audit：候选→机械保留→LLM 保留→最终返回", "viewer 可复盘每个阶段"] }),
    box({ x: 455, y: 635, w: 350, h: 290, title: "分组渲染", tone: "blue", lines: ["Skills：简短摘要 + trigger", "Memories：summary/reflection/value", "Experiences：procedure/verification/boundary", "Environment：WorldModel body", "Decision guidance：preference/anti-pattern"] }),
    box({ x: 855, y: 635, w: 330, h: 290, title: "安全边界", tone: "red", lines: ["外层 <relevant-memories>", "显式写明 UNTRUSTED DATA", "历史文本不能覆盖当前指令", "不把工具输出当系统提示", "正文长度有预算与截断"] }),
    box({ x: 1235, y: 635, w: 310, h: 290, title: "交付确认", tone: "green", lines: ["core 返回 packet ≠ 一定已进模型", "适配器负责转换宿主 prompt 形态", "调用日志分别记录候选、返回和接收", "因此页面不会把“召回”夸大成“模型使用”"] }),
    arrow(405, 780, 455, 780, "render", "gray"), arrow(805, 780, 855, 780, "wrap", "blue"), arrow(1185, 780, 1235, 780, "adapter", "red"),
  ].join("")),
});

diagrams.push({
  file: "09-l2-policy-induction",
  svg: frame(9, "L2 Policy：多条 Trace 怎样归纳成可复用经验", "L2 不是摘要升级；它先关联已有策略，未匹配的证据进候选池，达到条件后才调用归纳模型。", [
    box({ x: 55, y: 245, w: 265, h: 255, number: "1", title: "入口过滤", tone: "blue", lines: ["reward.updated 触发", "只取 V ≥ minTraceValue", "且至少有一个向量", "当前配置 minTraceValue 继承算法设置", "负值 Trace 不作正向归纳证据"] }),
    box({ x: 360, y: 245, w: 270, h: 255, number: "2", title: "关联已有 Policy", tone: "teal", lines: ["搜索 active + candidate", "比较向量相似与模式签名", "达到 minSimilarity → 建 trace↔policy link", "support 按不同 episode 计数"] }),
    box({ x: 670, y: 245, w: 270, h: 255, number: "3", title: "未匹配进候选池", tone: "gold", lines: ["按 PatternSignature 分桶", "候选有 TTL", "同一 episode 多条 Trace 不冒充多份独立证据", "达到 minDistinctEpisodes 才 ready"] }),
    box({ x: 980, y: 245, w: 270, h: 255, number: "4", title: "归纳结构化策略", tone: "purple", lines: ["每个 Episode 只选一条最佳证据", "LLM 输出 title / trigger / procedure / verification / boundary", "先做向量/内容重复检测", "新行初始 candidate"] }),
    box({ x: 1290, y: 245, w: 255, h: 255, number: "5", title: "链接与持久化", tone: "coral", bodySize: 17, lines: ["写 policies", "候选池行标记 policyId", "写 trace_policy_links", "向量失败进入 retry queue", "发 l2.policy.induced / updated"] }),
    arrow(320, 375, 360, 375, "eligible", "blue"), arrow(630, 375, 670, 375, "unmatched", "teal"), arrow(940, 375, 980, 375, "ready", "gold"), arrow(1250, 375, 1290, 375, "draft", "purple"),
    lane(570, "Gain 与生命周期", "green"),
    box({ x: 55, y: 620, w: 500, h: 300, title: "基础 Gain（保留原算法）", tone: "green", mono: true, bodySize: 17, lines: ["with = 与 Policy 关联的 episode value", "without = 近期其他 episode value", "effectiveWith = 样本≥3 ? softmax 加权 : 普通均值", "baseline = clamp(poolMean, 0.2, 0.5)", "B = (withoutMean×n + baseline×5)/(n+5)", "rawBase = effectiveWith − B", "baseGain = EMA(rawBase, oldBase, α=0.4)"] }),
    box({ x: 615, y: 620, w: 390, h: 300, title: "实际送达修正", tone: "gold", mono: true, bodySize: 17, lines: ["actual = 最终返回且 adapter 确认接收的 Episode", "actualUsageCount = 不同 Episode 数", "0 次：尚未调用", "1 次：样本不足，不计算", "n≥2：actualGain = delivered − other", "w = min(0.9, (n−1)/(n+0.5))", "2 次时 w=40%"] }),
    box({ x: 1065, y: 620, w: 480, h: 300, title: "最终 Gain 与生命周期", tone: "purple", bodySize: 16, lineHeight: 23, lines: ["n<2：finalGain = baseGain", "n≥2：finalGain = (1−w)×baseGain + w×actualGain", "2 次实际 Gain 占 40%，随后逐步升至最多 90%", "candidate → active：support 与 finalGain 达标", "active → archived：finalGain 过低或 support=0", "检索、L3、Skill 统一读取 finalGain", "Viewer 同时展示 base / actual / final"] }),
  ].join("")),
});

diagrams.push({
  file: "10-l3-world-model",
  svg: frame(10, "L3 World Model：从策略簇提炼环境认知", "L3 回答“这个环境通常如何运作、可以怎样推断、有哪些约束”，并保存 Policy 与 Episode 证据来源。", [
    box({ x: 55, y: 245, w: 275, h: 260, number: "1", title: "筛选 Policy", tone: "green", lines: ["status=active", "gain ≥ minPolicyGain", "support ≥ minPolicySupport", "可按 domainTags 限定", "先对旧 WorldModel 做生命周期对账"] }),
    box({ x: 370, y: 245, w: 285, h: 260, number: "2", title: "分域与聚类", tone: "blue", lines: ["按 domain key 分桶", "计算策略向量质心", "优先保留 cosine≥阈值的 strict cohort", "若不足但整桶达到最小数量，则 loose admission", "计算 cohesion 与 avgGain"] }),
    box({ x: 695, y: 245, w: 285, h: 260, number: "3", title: "幂等与冷却", tone: "gold", lines: ["cluster fingerprint 已处理 → 跳过重复", "同域近期抽象过 → cooldown", "无 centroid → 跳过", "按 avgGain×cohesion 排序", "每个簇加载 Policy 对应 Trace 证据"] }),
    box({ x: 1020, y: 245, w: 250, h: 260, number: "4", title: "LLM 抽象", tone: "purple", lines: ["输入结构化 Policy + L1 证据", "输出 title / body", "environment 条目", "inference 规则", "constraints 约束", "domain tags"] }),
    box({ x: 1310, y: 245, w: 235, h: 260, number: "5", title: "合并或新建", tone: "coral", bodySize: 17, lines: ["显式 supersedes 优先", "其次 Policy overlap≥0.6", "再比较向量 cosine", "命中则 update，否则 create", "保存 fingerprint"] }),
    arrow(330, 375, 370, 375, "eligible", "green"), arrow(655, 375, 695, 375, "cluster", "blue"), arrow(980, 375, 1020, 375, "evidence", "gold"), arrow(1270, 375, 1310, 375, "draft", "purple"),
    lane(575, "WorldModel 内容与生命周期", "teal"),
    box({ x: 55, y: 625, w: 360, h: 290, title: "结构化正文", tone: "teal", lines: ["Environment：可观察事实/拓扑", "Inference：从事实到结论的规则", "Constraints：边界、限制、失败条件", "body：便于注入的总述", "title / domainTags：检索入口"] }),
    box({ x: 455, y: 625, w: 350, h: 290, title: "证据与版本", tone: "blue", lines: ["policyIds：由哪些 L2 策略支撑", "sourceEpisodeIds：追溯到任务", "clusterFingerprint：同一证据簇幂等", "更新时合并旧/新唯一条目", "向量为空则排队补嵌入"] }),
    box({ x: 845, y: 625, w: 330, h: 290, title: "置信度", tone: "gold", lines: ["由簇质量、策略 gain、cohesion 等塑形", "loose cluster 会降低可信程度", "后续更新可按 confidenceDelta 漂移", "低于 minConfidenceForRetrieval 不进入 Tier 3"] }),
    box({ x: 1215, y: 625, w: 330, h: 290, title: "陈旧处理", tone: "red", lines: ["来源 Policy 归档/内容变化时可标 stale", "重建命中相同 fingerprint 可重新激活", "检索只选 active 且达到置信度下限", "历史行仍保留以便审计和证据追踪"] }),
    note(410, 960, 780, ["当前实际路由：L3 使用独立 l3Llm；当前配置为 deepseek-v4-flash。"], "purple"),
  ].join("")),
});

diagrams.push({
  file: "11-skill-lifecycle-model-routing",
  svg: frame(11, "Skill 结晶、试用与模型路由：当前真实行为", "Skill 是由 active Policy 与证据打包出的可调用能力；验证通过也只进入 candidate，必须靠真实结果建立 η。", [
    box({ x: 55, y: 245, w: 255, h: 265, number: "1", title: "Eligibility", tone: "green", bodySize: 16, lineHeight: 24, lines: ["来源：指定 Policy 或全部 active Policy", "检查 support / gain", "检查冷却与现有版本", "决定 skip / crystallize / rebuild"] }),
    box({ x: 345, y: 245, w: 270, h: 265, number: "2", title: "Evidence", tone: "blue", bodySize: 16, lineHeight: 24, lines: ["拉取关联的高价值 Trace", "保存 Trace / Episode 证据 ID", "同 Episode 内补取 V<0 反例", "Policy guidance → repair hints"] }),
    box({ x: 650, y: 245, w: 270, h: 265, number: "3", title: "Crystallize", tone: "purple", bodySize: 16, lineHeight: 24, lines: ["LLM 生成 name / summary / parameters", "生成 invocationGuide", "提取 evidence tools", "规范化并过滤危险/空内容", "失败可按约束重试一次"] }),
    box({ x: 955, y: 245, w: 265, h: 265, number: "4", title: "Verify + Package", tone: "gold", bodySize: 16, lineHeight: 24, lines: ["校验证据覆盖与一致性", "生成 content fingerprint", "写技能向量", "重建版指向 supersedesSkillId", "验证通过也不会直接 active"] }),
    box({ x: 1255, y: 245, w: 290, h: 265, number: "5", title: "Candidate 试用", tone: "coral", bodySize: 16, lineHeight: 24, lines: ["调用成功创建 pending trial", "Reward：R≥0.5 pass；R≤−0.5 fail", "其余为 unknown", "pass 达次数且 η 达标 → active", "candidate 首次 fail → archived"] }),
    arrow(310, 378, 345, 378, "eligible", "green"), arrow(615, 378, 650, 378, "证据", "blue"), arrow(920, 378, 955, 378, "draft", "purple"), arrow(1220, 378, 1255, 378, "candidate", "gold"),
    lane(575, "η 与当前模型接线", "red"),
    box({ x: 55, y: 625, w: 470, h: 300, title: "Skill η 生命周期", tone: "teal", mono: true, bodySize: 17, lines: ["trial η：把初始 η 当 1 个伪观测，再合并 pass ratio", "user.positive / negative：η ± etaDelta", "reward drift：η' = 0.7×旧η + 0.3×clamp(policyGain)", "active 且 η < archiveEta → archived", "archived 收到足够正反馈可回 candidate", "重建版本先 candidate，成功后原子替换旧 active"] }),
    box({ x: 575, y: 625, w: 420, h: 300, title: "配置看起来想要的路由", tone: "purple", lines: ["主 llm：MiniMax-M3", "skillEvolver：deepseek-v4-flash", "l3Llm：deepseek-v4-flash", "schema 注释称 skillEvolver 用于", "反思 / L2 / Skill 结晶", "这是“配置意图”，不是当前实际调用"] }),
    box({ x: 1045, y: 625, w: 500, h: 300, title: "当前源码实际路由（重要）", tone: "red", bodySize: 16, lineHeight: 23, lines: ["Capture 摘要 + 主题反思：主 bgLlm（MiniMax-M3）", "R_human：主 bgLlm（MiniMax-M3）", "L2 induction：主 bgLlm（MiniMax-M3）", "Skill crystallize：主 bgLlm（MiniMax-M3）", "Feedback repair：主 bgLlm（MiniMax-M3）", "仅 L3 abstraction 用 l3Llm（deepseek-v4-flash）", "skillEvolver 仅作为 evaluator 元数据，未参与推理"] }),
    note(330, 965, 940, ["结论：Skill 功能本身在运行；失效的是“专用 skillEvolver 模型选择”。当前不阻断流程，但会让模型分工、成本与能力预期失真。"], "red"),
  ].join("")),
});

diagrams.push({
  file: "12-feedback-repair-observability",
  svg: frame(12, "反馈、重复失败修复与可观测性", "负反馈不会只改一个总分：它既能改变 Trace/Policy/Skill，也能在连续工具失败时生成并召回“不要再这样做”的修复经验。", [
    box({ x: 55, y: 245, w: 285, h: 265, number: "1", title: "反馈来源", tone: "coral", lines: ["显式：点赞/点踩/纠正文本", "隐式：会话中可识别信号", "晚到反馈：无 pending 窗口也立即重算", "按 episodeId 关联", "同一任务反馈合并后评分"] }),
    box({ x: 380, y: 245, w: 285, h: 265, number: "2", title: "基础影响", tone: "blue", lines: ["重算 R_human", "重新 backprop 每条 Trace 的 V/priority", "触发 L2 support/gain 更新", "触发 Skill trial / η 更新", "结果通过事件总线级联"] }),
    box({ x: 705, y: 245, w: 300, h: 265, number: "3", title: "重复失败检测", tone: "red", lines: ["按 failing tool 观察滑动窗口", "达到 failureThreshold（默认 3）", "收集失败 Trace / error signatures", "受 cooldown 控制", "生成 preference 与 anti-pattern"] }),
    box({ x: 1045, y: 245, w: 285, h: 265, number: "4", title: "修复 Experience", tone: "gold", lines: ["写成 feedback 类型 Policy", "带 salience / confidence", "保存 feedbackIds / traceIds / episodeIds", "可挂到已有 Policy", "低显著性 candidate，高显著性 active"] }),
    box({ x: 1370, y: 245, w: 175, h: 265, number: "5", title: "Repair 召回", tone: "purple", bodySize: 16, lines: ["失败循环中调用 decision_repair", "Tier1+Tier2", "允许低/负 V", "注入 avoid/repair 提示"] }),
    arrow(340, 378, 380, 378, "score", "coral"), arrow(665, 378, 705, 378, "error", "blue"), arrow(1005, 378, 1045, 378, "synthesize", "red"), arrow(1330, 378, 1370, 378, "retrieve", "gold"),
    lane(575, "每一步怎样被看见", "teal"),
    box({ x: 55, y: 625, w: 330, h: 285, title: "结构化日志", tone: "gray", lines: ["api_logs：宿主工具/流程操作", "operational log：阶段、错误、耗时", "llm.jsonl：op / model / latency / token", "perf.jsonl：性能", "events.jsonl：事件流", "audit log：安全与管理操作"] }),
    box({ x: 425, y: 625, w: 340, h: 285, title: "检索审计", tone: "teal", lines: ["query tags / scenario / embedding 降级", "各 Tier 候选数量", "channel hits", "阈值丢弃与多通道豁免", "MMR 结果", "LLM filter kept/dropped", "最终 packet 与适配器确认"] }),
    box({ x: 805, y: 625, w: 340, h: 285, title: "持久化证据链", tone: "blue", lines: ["Episode → Trace IDs", "Trace ↔ Policy links", "Policy → source Episode IDs", "WorldModel → Policy + Episode", "Skill → Policy + Trace + Episode", "Feedback Experience → Feedback + Trace", "所有层都可回溯到原始行为"] }),
    box({ x: 1185, y: 625, w: 360, h: 285, title: "故障与恢复", tone: "red", lines: ["Embedding 失败：null vector + retry queue", "LLM malformed：有限重试，随后按阶段 fail-open/skip", "进程关闭：flush pending reward，不等满 30 秒", "启动恢复：扫描 dirty/未完成 Episode", "幂等签名避免重复 Trace / Policy / WorldModel", "轻量模式明确短路进化 subscriber"] }),
    note(350, 960, 900, ["阅读日志时要区分四件事：产生候选、机械保留、LLM 保留、适配器实际接收。只有最后一步才接近“进入 Agent 本回合上下文”。"], "gold"),
  ].join("")),
});

for (const diagram of diagrams) {
  writeFileSync(join(OUT_DIR, `${diagram.file}.svg`), diagram.svg, "utf8");
}

const MATH_FONT = "STIX Two Math, Cambria Math, Noto Sans Math, serif";

function formulaFrame(title, subtitle, accent, body) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="430" viewBox="0 0 1200 430">
    <defs><linearGradient id="formula-bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#fffdf9"/><stop offset="1" stop-color="#f4fbf8"/></linearGradient><filter id="formula-shadow" x="-20%" y="-20%" width="140%" height="140%"><feDropShadow dx="0" dy="7" stdDeviation="9" flood-color="#6d4a40" flood-opacity="0.10"/></filter></defs>
    <rect width="1200" height="430" rx="28" fill="url(#formula-bg)"/>
    <rect x="34" y="34" width="8" height="76" rx="4" fill="${accent}"/>
    <text x="66" y="65" font-family="${FONT}" font-size="16" font-weight="800" letter-spacing="2" fill="${accent}">PIGMEMORY · 核心公式图解</text>
    <text x="66" y="104" font-family="${FONT}" font-size="30" font-weight="900" fill="#433735">${esc(title)}</text>
    <text x="1160" y="67" text-anchor="end" font-family="${FONT}" font-size="15" fill="#887872">${esc(subtitle)}</text>
    ${body}
  </svg>`;
}

const formulaCards = [
  {
    file: "formula-reward-value",
    svg: formulaFrame("任务奖励与 Trace 价值回传", "先评价整项任务，再把结果向前分配", "#d86554", `
      <g filter="url(#formula-shadow)"><rect x="42" y="142" width="530" height="238" rx="22" fill="#fff4df" stroke="#d8b45f" stroke-width="2"/><rect x="608" y="142" width="550" height="238" rx="22" fill="#edf5ff" stroke="#73a7d9" stroke-width="2"/></g>
      <text x="72" y="183" font-family="${FONT}" font-size="20" font-weight="800" fill="#80611b">① 三轴合成任务奖励</text>
      <text x="307" y="220" text-anchor="middle" font-family="${MATH_FONT}" font-size="30" fill="#3f3835">R<tspan baseline-shift="sub" font-size="18">human</tspan> =</text>
      <text x="307" y="273" text-anchor="middle" font-family="${MATH_FONT}" font-size="25" fill="#3f3835">clamp(0.45G + 0.30P + 0.25S, −1, 1)</text>
      <g font-family="${FONT}" font-size="15" fill="#6f625c"><text x="105" y="310">G · 目标完成度</text><text x="250" y="310">P · 过程质量</text><text x="390" y="310">S · 用户满意度</text><text x="307" y="352" text-anchor="middle" font-weight="700" fill="#9b6e20">三个输入均限制在 [−1, 1]</text></g>
      <text x="638" y="183" font-family="${FONT}" font-size="20" font-weight="800" fill="#285f91">② 从最后一步向前回传</text>
      <text x="883" y="238" text-anchor="middle" font-family="${MATH_FONT}" font-size="33" fill="#343d45">V<tspan baseline-shift="sub" font-size="20">T</tspan> = R<tspan baseline-shift="sub" font-size="20">human</tspan></text>
      <text x="883" y="298" text-anchor="middle" font-family="${MATH_FONT}" font-size="28" fill="#343d45">V<tspan baseline-shift="sub" font-size="18">t</tspan> = α<tspan baseline-shift="sub" font-size="18">t</tspan>R<tspan baseline-shift="sub" font-size="18">human</tspan> + (1−α<tspan baseline-shift="sub" font-size="18">t</tspan>)γV<tspan baseline-shift="sub" font-size="18">t+1</tspan></text>
      <text x="883" y="350" text-anchor="middle" font-family="${FONT}" font-size="15" fill="#5f6b74">α 越大越相信本步反思；α=0 时只接收后续结果的折扣传播</text>`),
  },
  {
    file: "formula-priority",
    svg: formulaFrame("记忆检索优先级与时间衰减", "负价值保留在库中，但普通检索会下沉", "#339475", `
      <g filter="url(#formula-shadow)"><rect x="42" y="142" width="1116" height="238" rx="22" fill="#eaf8f3" stroke="#66b79b" stroke-width="2"/></g>
      <text x="298" y="232" text-anchor="middle" font-family="${MATH_FONT}" font-size="34" fill="#234f43">d(Δt) = 0.5<tspan baseline-shift="super" font-size="20">Δdays / H</tspan></text>
      <path d="M520 246 L650 246" stroke="#66b79b" stroke-width="4"/>
      <text x="862" y="232" text-anchor="middle" font-family="${MATH_FONT}" font-size="34" fill="#234f43">priority<tspan baseline-shift="sub" font-size="20">t</tspan> = max(V<tspan baseline-shift="sub" font-size="20">t</tspan>, 0) × d(Δt)</text>
      <g font-family="${FONT}" font-size="16" fill="#4f6860"><rect x="100" y="292" width="250" height="48" rx="24" fill="#fff"/><text x="225" y="322" text-anchor="middle">H：半衰期，默认 30 天</text><rect x="475" y="292" width="250" height="48" rx="24" fill="#fff"/><text x="600" y="322" text-anchor="middle">V &gt; 0：按时间逐渐衰减</text><rect x="850" y="292" width="250" height="48" rx="24" fill="#fff"/><text x="975" y="322" text-anchor="middle">V ≤ 0：priority = 0</text></g>`),
  },
  {
    file: "formula-policy-gain",
    svg: formulaFrame("Policy Gain：基础估算 + 实际送达修正", "不取消原算法；真实送达越多，实际结果影响越大", "#619b49", `
      <g filter="url(#formula-shadow)"><rect x="42" y="142" width="535" height="238" rx="22" fill="#eef8e9" stroke="#83b86b" stroke-width="2"/><rect x="607" y="142" width="551" height="238" rx="22" fill="#fff8df" stroke="#d8b45f" stroke-width="2"/></g>
      <text x="72" y="183" font-family="${FONT}" font-size="19" font-weight="800" fill="#40732e">① 基础 Gain 保留原算法</text>
      <text x="310" y="231" text-anchor="middle" font-family="${MATH_FONT}" font-size="27" fill="#35452f">G<tspan baseline-shift="sub" font-size="17">base</tspan> = EMA(V<tspan baseline-shift="sub" font-size="17">linked</tspan><tspan baseline-shift="super" font-size="16">*</tspan> − B)</text>
      <text x="310" y="278" text-anchor="middle" font-family="${MATH_FONT}" font-size="22" fill="#35452f">B = shrink(V̄<tspan baseline-shift="sub" font-size="15">other</tspan>, baseline, N<tspan baseline-shift="sub" font-size="15">0</tspan>=5)</text>
      <text x="310" y="330" text-anchor="middle" font-family="${FONT}" font-size="15" fill="#5d6d57">关联任务维持快速估算 · 基础值继续做 α=0.4 的 EMA</text>
      <text x="637" y="183" font-family="${FONT}" font-size="19" font-weight="800" fill="#80611b">② 实际送达从第 2 次开始修正</text>
      <text x="882" y="218" text-anchor="middle" font-family="${MATH_FONT}" font-size="20" fill="#5d4820">G<tspan baseline-shift="sub" font-size="14">actual</tspan> = effective(V<tspan baseline-shift="sub" font-size="14">delivered</tspan>) − B<tspan baseline-shift="sub" font-size="14">actual</tspan></text>
      <text x="882" y="251" text-anchor="middle" font-family="${MATH_FONT}" font-size="20" fill="#5d4820">n&lt;2: G<tspan baseline-shift="sub" font-size="14">final</tspan> = G<tspan baseline-shift="sub" font-size="14">base</tspan></text>
      <text x="882" y="283" text-anchor="middle" font-family="${MATH_FONT}" font-size="20" fill="#5d4820">w = min(0.9, (n−1)/(n+0.5))</text>
      <text x="882" y="318" text-anchor="middle" font-family="${MATH_FONT}" font-size="20" fill="#5d4820">G<tspan baseline-shift="sub" font-size="14">final</tspan> = (1−w)G<tspan baseline-shift="sub" font-size="14">base</tspan> + wG<tspan baseline-shift="sub" font-size="14">actual</tspan></text>
      <text x="882" y="352" text-anchor="middle" font-family="${FONT}" font-size="15" fill="#735e2f">n=2 → 40% · n=3 → 57% · 最高 90%</text>`),
  },
  {
    file: "formula-retrieval-ranking",
    svg: formulaFrame("多通道融合与 MMR 去重", "先算相关性，再惩罚与已选结果的重复", "#8064bb", `
      <g filter="url(#formula-shadow)"><rect x="42" y="142" width="1116" height="238" rx="22" fill="#f5efff" stroke="#9f83d5" stroke-width="2"/></g>
      <text x="80" y="188" font-family="${FONT}" font-size="17" font-weight="800" fill="#624196">① 多通道相关性</text>
      <text x="600" y="238" text-anchor="middle" font-family="${MATH_FONT}" font-size="27" fill="#41364f">relevance = base + 0.4 Σ<tspan baseline-shift="sub" font-size="17">i</tspan> [1 / (k + rank<tspan baseline-shift="sub" font-size="17">i</tspan> + 1)] + qualityBoost</text>
      <line x1="105" y1="274" x2="1095" y2="274" stroke="#c8b8e5" stroke-width="2"/>
      <text x="80" y="313" font-family="${FONT}" font-size="17" font-weight="800" fill="#624196">② 多样性选择</text>
      <text x="600" y="353" text-anchor="middle" font-family="${MATH_FONT}" font-size="26" fill="#41364f">MMR(c) = λ · relevance(c) − (1−λ) · max cosine(c, selected)</text>`),
  },
];

for (const formula of formulaCards) {
  writeFileSync(join(OUT_DIR, `${formula.file}.svg`), formula.svg, "utf8");
}

console.log(`generated ${diagrams.length} PigMemory diagrams and ${formulaCards.length} formula cards in ${OUT_DIR}`);
