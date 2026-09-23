import { useEffect, useMemo, useState } from "preact/hooks";

import { api, json } from "../api.js";

const sectionNames: Record<string, string> = {
  __general__: "基础配置（General）",
  viewer: "查看器（Viewer）",
  bridge: "桥接器（Bridge）",
  embedding: "向量模型（Embedding）",
  llm: "摘要与评分模型（LLM）",
  l3Llm: "世界模型专用模型（L3 LLM）",
  skillEvolver: "技能进化模型（Skill Evolver）",
  storage: "存储（Storage）",
  userProfile: "用户画像（User Profile）",
  algorithm: "算法与评分（Algorithm）",
  hub: "共享中心（Hub）",
  telemetry: "遥测（Telemetry）",
  logging: "日志（Logging）",
};

const fieldNames: Record<string, string> = {
  provider: "提供商（Provider）",
  endpoint: "接口地址（Endpoint）",
  model: "模型（Model）",
  apiKey: "API 密钥（API Key）",
  temperature: "温度（Temperature）",
  timeoutMs: "超时毫秒（Timeout）",
  maxRetries: "最大重试次数（Max Retries）",
  enabled: "启用（Enabled）",
  port: "端口（Port）",
  bindHost: "监听地址（Bind Host）",
  gamma: "折扣因子 γ（Gamma）",
  tauSoftmax: "Softmax 温度 τ",
  alphaScoring: "反思 α 评分（Alpha Scoring）",
  llmScoring: "LLM 奖励评分（LLM Scoring）",
  implicitThreshold: "隐式奖励阈值（Implicit Threshold）",
  decayHalfLifeDays: "优先级半衰期天数（Decay Half-life）",
  minExchangesForCompletion: "评分所需最少对话轮数",
  minContentCharsForCompletion: "评分所需最少内容字符",
  reviewInterview: "记忆评分触发（Review Interview）",
  manualEnabled: "允许 /review 手动评分",
  threshold: "自动弹卡阈值",
  sendDelaySeconds: "回复送达后等待秒数",
  cooldownMinutes: "自动弹卡冷却分钟数",
  dailyLimit: "每天自动弹卡上限（0 为不限）",
  weights: "触发分总权重",
  tool: "工具调用分",
  difficulty: "任务难度分",
  memory: "记忆评价价值",
  callBands: "工具调用数量分段",
  mutationBonus: "写入或修改操作加分",
  verificationBonus: "测试或验证操作加分",
  ignoredPatterns: "不计分工具匹配词",
  mutationPatterns: "写入或修改匹配词",
  verificationPatterns: "测试或验证匹配词",
  externalSideEffectPatterns: "外部副作用匹配词",
  failurePatterns: "失败或重试匹配词",
  multiStepMinToolCalls: "多步骤任务最少工具数",
  multiStepPoints: "多步骤难度加分",
  artifactPoints: "代码、配置或产物加分",
  externalSideEffectPoints: "外部副作用加分",
  retryPoints: "错误或重试加分",
  verificationPoints: "验证环节加分",
  longRunningPoints: "长耗时任务加分",
  longRunningMs: "长耗时判定毫秒数",
  relevanceWeight: "本轮记忆相关度权重",
  uncertaintyWeight: "记忆评分不确定性权重",
  inboxRetentionDays: "原始对话保留天数",
  schedule: "夜间整理计划",
  time: "每日整理时间",
  timezone: "时区",
  catchUpOnStartup: "启动时补跑遗漏日期",
  proactiveInteraction: "主动互动",
  sendTime: "主动消息发送时间",
  quietHours: "勿扰时段",
  start: "开始时间",
  end: "结束时间",
  maxBatchChars: "夜间单批最大字符",
  maxContextChars: "画像注入最大字符",
};

export function SettingsPage() {
  const [config, setConfig] = useState<Record<string, any> | null>(null);
  const [saved, setSaved] = useState<Record<string, any> | null>(null);
  const [active, setActive] = useState("");
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [saving, setSaving] = useState(false);

  const load = async () => {
    try {
      const value = await api<Record<string, any>>("/api/v1/config");
      setConfig(value);
      setSaved(value);
      setActive((current) => current || sectionKeys(value)[0] || "");
      setError("");
    } catch (err) { setError(err instanceof Error ? err.message : String(err)); }
  };
  useEffect(() => { void load(); }, []);

  const changed = useMemo(() => JSON.stringify(config) !== JSON.stringify(saved), [config, saved]);
  const update = (path: string[], value: unknown) => {
    setConfig((current) => {
      if (!current) return current;
      const next = structuredClone(current);
      let cursor: Record<string, any> = next;
      for (const key of path.slice(0, -1)) cursor = cursor[key];
      cursor[path[path.length - 1]!] = value;
      return next;
    });
    setMessage("");
  };
  const save = async () => {
    if (!config) return;
    try {
      setSaving(true);
      const value = await api<Record<string, any>>("/api/v1/config", json("PATCH", config));
      setConfig(value);
      setSaved(value);
      setMessage("配置已安全写入 config.yaml。模型与大部分算法参数将在下次重启后生效。");
      setError("");
    } catch (err) { setError(err instanceof Error ? err.message : String(err)); }
    finally { setSaving(false); }
  };

  if (!config) return <div class="empty large">{error ? `无法读取配置：${error}` : "正在读取 config.yaml…"}</div>;
  const sections = sectionKeys(config);
  const sectionValue = active === "__general__"
    ? Object.fromEntries(Object.entries(config).filter(([, value]) => !isRecord(value)))
    : config[active];
  const sectionPath = active === "__general__" ? [] : [active];
  return <div class="settings-layout">
    <aside class="settings-nav">
      <div><span class="eyebrow">config.yaml</span><h2>全部超参数</h2><p>敏感字段保持掩码，不会在页面回显。</p></div>
      {sections.map((key) => <button class={active === key ? "active" : ""} onClick={() => setActive(key)}>{sectionNames[key] ?? key}</button>)}
    </aside>
    <div class="settings-main page-stack">
      {error && <div class="notice error">保存失败：{error}</div>}
      {message && <div class="notice success">{message}</div>}
      <section class="settings-intro">
        <div><span class="eyebrow">Local configuration</span><h2>{sectionNames[active] ?? active}</h2><p>这里直接编辑当前解析后的配置，包含模型、检索、评分、L1/L2/L3 和技能进化参数。</p></div>
        <img src="/assets/huhu-pig-mascot.png" alt="呼呼猪配置助手" />
      </section>
      {active === "algorithm" && config.algorithm?.reviewInterview && <ReviewSettingsSummary value={config.algorithm.reviewInterview} />}
      <section class="settings-fields">
        <ConfigGroup value={sectionValue} path={sectionPath} onChange={update} />
      </section>
      <div class="settings-savebar">
        <span>{changed ? "有尚未保存的修改" : "配置与磁盘一致"}</span>
        <button disabled={!changed || saving} onClick={save}>{saving ? "正在保存…" : "保存 config.yaml"}</button>
      </div>
    </div>
  </div>;
}

function ReviewSettingsSummary({ value }: { value: Record<string, any> }) {
  const weights = value.weights ?? {};
  return <section class="review-settings-summary">
    <div><span class="eyebrow">Memory review gate</span><h3>记忆评分卡触发规则</h3></div>
    <p><strong>硬门槛：</strong>上一轮必须实际向模型交付至少一条 PigMemory 记忆；没有记忆时不会计算触发分，也不会弹卡。</p>
    <code>S = T × {Number(weights.tool ?? 0)} + D × {Number(weights.difficulty ?? 0)} + M × {Number(weights.memory ?? 0)}（按权重总和归一化）</code>
    <p>当前自动阈值为 <strong>{Number(value.threshold ?? 0)}</strong>。记忆分只使用本轮相关度和评分不确定性，不使用历史好评高低，避免“高分记忆越来越容易被评价”的循环。</p>
    <p>这些参数保存后会被下一次 <code>review.evaluate</code> 直接读取；<code>/review</code> 可绕过自动阈值，但不能绕过“上一轮确实使用过记忆”。</p>
  </section>;
}

function ConfigGroup({ value, path, onChange }: { value: Record<string, any>; path: string[]; onChange: (path: string[], value: unknown) => void }) {
  return <div class="config-group">{Object.entries(value ?? {}).map(([key, child]) => {
    const childPath = [...path, key];
    if (isRecord(child)) return <fieldset><legend>{fieldLabel(key)}</legend><ConfigGroup value={child} path={childPath} onChange={onChange} /></fieldset>;
    return <ConfigField name={key} value={child} path={childPath} onChange={onChange} />;
  })}</div>;
}

function ConfigField({ name, value, path, onChange }: { name: string; value: any; path: string[]; onChange: (path: string[], value: unknown) => void }) {
  const secret = /(?:api.?key|token|secret|password)/i.test(name);
  const numericConstraint = numericConstraints[path.join(".")];
  const [arrayText, setArrayText] = useState(Array.isArray(value) ? JSON.stringify(value, null, 2) : "");
  const [arrayError, setArrayError] = useState("");
  useEffect(() => { if (Array.isArray(value)) setArrayText(JSON.stringify(value, null, 2)); }, [value]);
  if (typeof value === "boolean") return <label class="config-field toggle-field"><span><strong>{fieldLabel(name)}</strong><small>{path.join(".")}</small></span><input type="checkbox" checked={value} onChange={(event) => onChange(path, (event.target as HTMLInputElement).checked)} /></label>;
  if (Array.isArray(value)) return <label class="config-field"><span><strong>{fieldLabel(name)}</strong><small>{path.join(".")} · JSON 数组</small></span><textarea rows={Math.max(3, Math.min(8, value.length + 2))} value={arrayText} onInput={(event) => setArrayText((event.target as HTMLTextAreaElement).value)} onBlur={() => {
    try {
      const parsed = JSON.parse(arrayText);
      if (!Array.isArray(parsed)) throw new Error("必须是 JSON 数组");
      onChange(path, parsed);
      setArrayError("");
    } catch (err) { setArrayError(err instanceof Error ? err.message : String(err)); }
  }} />{arrayError && <em>{arrayError}</em>}</label>;
  const shown = secret && value === "__memos_secret__" ? "" : String(value ?? "");
  return <label class="config-field"><span><strong>{fieldLabel(name)}</strong><small>{path.join(".")}{secret ? " · 已配置的密钥不会回显" : ""}</small></span><input
    type={secret ? "password" : typeof value === "number" ? "number" : "text"}
    value={shown}
    placeholder={secret && value === "__memos_secret__" ? "已配置；留空保持不变" : ""}
    min={numericConstraint?.min}
    max={numericConstraint?.max}
    step={typeof value === "number" ? numericConstraint?.step ?? "any" : undefined}
    onInput={(event) => {
      const raw = (event.target as HTMLInputElement).value;
      onChange(path, typeof value === "number" ? Number(raw) : raw);
    }}
  /></label>;
}

const numericConstraints: Record<string, { min: number; max: number; step: number }> = {
  "userProfile.inboxRetentionDays": { min: 1, max: 365, step: 1 },
};

function fieldLabel(key: string): string {
  return fieldNames[key] ?? `参数：${humanize(key)}（${key}）`;
}

function humanize(value: string): string {
  return value.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/^./, (letter) => letter.toUpperCase());
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sectionKeys(config: Record<string, any>): string[] {
  const nested = Object.entries(config).filter(([, value]) => isRecord(value)).map(([key]) => key);
  const hasScalars = Object.values(config).some((value) => !isRecord(value));
  return hasScalars ? ["__general__", ...nested] : nested;
}
