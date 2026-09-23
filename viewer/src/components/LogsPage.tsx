import { useEffect, useMemo, useState } from "preact/hooks";

import { api, clip, dayInShanghai, qs, time } from "../api.js";
import { associationLabel, buildConversationFlow, type ConversationFlowTurn, type FlowLog } from "../conversation-flow.js";
import { term } from "../terms.js";

function hashParams(): URLSearchParams {
  return new URLSearchParams(location.hash.split("?")[1] ?? "");
}

export function LogsPage() {
  const initial = hashParams();
  const initialFocusId = initial.get("logId") ?? "";
  const initialSession = initial.get("session") ?? (
    initialFocusId || initial.get("level") || initial.get("category") || initial.get("episodeId")
      ? "__all__"
      : null
  );
  const [date, setDate] = useState(initial.get("date") ?? dayInShanghai());
  const [rangeFrom, setRangeFrom] = useState(initial.get("from") ?? "");
  const [rangeTo, setRangeTo] = useState(initial.get("to") ?? "");
  const [level, setLevel] = useState(initial.get("level") ?? "");
  const [category, setCategory] = useState(initial.get("category") ?? "");
  const [episodeId, setEpisodeId] = useState(initial.get("episodeId") ?? "");
  const [selected, setSelected] = useState<string | null>(initialSession);
  const [focusId, setFocusId] = useState(initialFocusId);
  const [sessions, setSessions] = useState<any[]>([]);
  const [logs, setLogs] = useState<any[]>([]);
  const [traces, setTraces] = useState<any[]>([]);
  const [flowView, setFlowView] = useState(initialSession !== "__all__" && initialSession !== "__system__");
  const [conversationLoading, setConversationLoading] = useState(false);
  const [error, setError] = useState("");

  const sessionQuery = useMemo(() => qs({ date, limit: 200 }), [date]);
  const logQuery = useMemo(() => qs({
    date: rangeFrom ? undefined : date,
    from: rangeFrom || undefined,
    to: rangeTo || undefined,
    sessionId: selected === "__all__" ? undefined : selected ?? undefined,
    level,
    category,
    episodeId,
    limit: 500,
  }), [date, rangeFrom, rangeTo, selected, level, category, episodeId]);
  const conversationQuery = useMemo(() => qs({
    date: rangeFrom ? undefined : date,
    from: rangeFrom || undefined,
    to: rangeTo || undefined,
    sessionId: isConcreteSession(selected) ? selected : undefined,
  }), [date, rangeFrom, rangeTo, selected]);
  const flow = useMemo(() => buildConversationFlow(traces, logs), [traces, logs]);

  const loadSessions = async () => {
    try {
      const result = await api<any>(`/api/v1/monitor/sessions${sessionQuery}`);
      setSessions(result.sessions ?? []);
      setError("");
    } catch (err) { setError(err instanceof Error ? err.message : String(err)); }
  };
  const loadLogs = async () => {
    if (!selected) return;
    try {
      const result = await api<any>(`/api/v1/monitor/logs${logQuery}`);
      setLogs(result.logs ?? []);
      if (focusId) requestAnimationFrame(() => document.getElementById(`log-${focusId}`)?.scrollIntoView({ behavior: "smooth", block: "center" }));
      setError("");
    } catch (err) { setError(err instanceof Error ? err.message : String(err)); }
  };
  const loadConversation = async () => {
    if (!isConcreteSession(selected)) {
      setTraces([]);
      return;
    }
    try {
      setConversationLoading(true);
      const result = await api<any>(`/api/v1/monitor/conversation${conversationQuery}`);
      setTraces(result.traces ?? []);
      setError("");
    } catch (err) { setError(err instanceof Error ? err.message : String(err)); }
    finally { setConversationLoading(false); }
  };
  useEffect(() => { void loadSessions(); }, [sessionQuery]);
  useEffect(() => {
    void loadLogs();
    const timer = setInterval(loadLogs, 5_000);
    return () => clearInterval(timer);
  }, [logQuery, selected]);
  useEffect(() => { void loadConversation(); }, [conversationQuery, selected]);

  const choose = (id: string) => {
    setSelected(id);
    setFocusId("");
    setFlowView(isConcreteSession(id));
    setLogs([]);
  };

  return <div class="page-stack">
    {error && <div class="notice error">{error}</div>}
    <section class="filter-bar">
      <label>北京时间日期<input type="date" value={date} onInput={(event) => { setDate((event.target as HTMLInputElement).value); setRangeFrom(""); setRangeTo(""); }} /></label>
      {rangeFrom && <span class="range-note">当前：精确最近 24 小时</span>}
      <label>严重级别<select value={level} onChange={(event) => setLevel((event.target as HTMLSelectElement).value)}>
        <option value="">全部级别</option><option value="warn">警告（Warning）</option><option value="error">错误（Error）</option><option value="fatal">严重错误（Fatal）</option><option value="info">信息（Info）</option>
      </select></label>
      <label>操作类别<select value={category} onChange={(event) => setCategory((event.target as HTMLSelectElement).value)}>
        <option value="">全部类别</option><option value="retrieval">检索（Retrieval）</option><option value="capture">一级记忆（L1）</option><option value="l2">二级经验（L2）</option><option value="l3">三级世界模型（L3）</option><option value="skill">技能（Skill）</option><option value="episode">任务片段（Episode）</option><option value="system">系统（System）</option><option value="operation">旧版其他操作（Legacy）</option>
      </select></label>
      {selected && <label>任务片段编号<input value={episodeId} placeholder="全部任务片段" onInput={(event) => setEpisodeId((event.target as HTMLInputElement).value)} /></label>}
      <button onClick={() => { void loadSessions(); void loadLogs(); }}>立即刷新</button>
    </section>

    {!selected ? <SessionList sessions={sessions} date={date} onChoose={choose} /> : <section>
      <div class="section-heading sticky-heading">
        <div><button class="back" onClick={() => setSelected(null)}>← 会话列表</button><h2>{selected === "__system__" ? "系统操作" : selected === "__all__" ? "全部操作" : `会话（Session） ${selected}`}</h2></div>
        <span>每 5 秒实时刷新 · {logs.length} 条</span>
      </div>
      {isConcreteSession(selected) && <div class="log-view-switch">
        <div><strong>展示方式</strong><span>流程视图会把 PigMemory 操作关联到对应用户回合；原始操作保留数据库顺序。</span></div>
        <div><button class={flowView ? "active" : ""} onClick={() => setFlowView(true)}>对话流程</button><button class={!flowView ? "active" : ""} onClick={() => setFlowView(false)}>原始操作</button></div>
      </div>}
      {flowView && isConcreteSession(selected)
        ? <ConversationFlowView turns={flow.turns} asynchronousLogs={flow.asynchronousLogs} loading={conversationLoading} focusId={focusId} />
        : <RawTimeline logs={logs} focusId={focusId} />}
    </section>}
  </div>;
}

function ConversationFlowView({ turns, asynchronousLogs, loading, focusId }: { turns: ConversationFlowTurn[]; asynchronousLogs: any[]; loading: boolean; focusId: string }) {
  if (loading && turns.length === 0) return <div class="empty">正在把对话与 PigMemory 操作关联起来…</div>;
  if (turns.length === 0) return <div class="empty">当前日期没有可用于还原对话流程的记忆。可切换到“原始操作”查看独立日志。</div>;
  return <div class="conversation-flow">
    <div class="flow-legend">
      <span class="user">用户发言</span><i>→</i><span class="memos">PigMemory 操作</span><i>→</i><span class="hermes">Hermes 操作与回复</span><i>→</i><span class="memos after">PigMemory 响应后处理</span>
    </div>
    <p class="flow-honesty">有回合编号的操作会精确归组；旧日志缺少回合编号时，只按任务片段和时间就近关联，并在操作卡上明确标注关联方式。</p>
    <div class="flow-turns">{turns.map((turn, index) => <FlowTurnCard turn={turn} index={index + 1} focusId={focusId} />)}</div>
    {asynchronousLogs.length > 0 && <section class="async-operations">
      <div class="section-heading"><div><span class="eyebrow">Background / unbound</span><h3>未绑定回合的异步 PigMemory 操作</h3></div><span>{asynchronousLogs.length} 条</span></div>
      <p>这些记录没有足够的会话、任务片段或时间证据，因此不强行放到某条用户发言后面。</p>
      <div class="memos-operation-list">{asynchronousLogs.map((row) => <MemosLogCard row={row} focusId={focusId} />)}</div>
    </section>}
  </div>;
}

function FlowTurnCard({ turn, index, focusId }: { turn: ConversationFlowTurn; index: number; focusId: string }) {
  const userTexts = uniqueText(turn.traces.map((trace) => trace.userText));
  const assistantTexts = uniqueText(turn.traces.flatMap((trace) => [
    ...(Array.isArray(trace.toolCalls) ? trace.toolCalls.map((tool: any) => tool.assistantTextBefore) : []),
    trace.agentText,
  ]));
  const tools = dedupeTools(turn.traces.flatMap((trace) => Array.isArray(trace.toolCalls) ? trace.toolCalls : []));
  return <article class="flow-turn">
    <header><div><span>第 {index} 轮</span><time>{time(turn.at)}</time></div><a href={`#/episodes?id=${encodeURIComponent(turn.episodeId)}`}>任务片段 <code>{turn.episodeId}</code></a></header>
    <FlowStage role="user" label="用户发言" description="本轮输入">
      {userTexts.length > 0 ? userTexts.map((text) => <p class="speech-text">{text}</p>) : <p class="stage-empty">这条旧记忆没有保存用户文本。</p>}
    </FlowStage>
    <FlowStage role="memos" label="PigMemory 响应前操作" description="关系判断、回合开始检索与上下文准备">
      <MemosLogList logs={turn.memosBefore} focusId={focusId} empty="当前筛选条件下没有响应前 PigMemory 操作。" />
    </FlowStage>
    <FlowStage role="hermes" label="Hermes 操作与回复" description="工具调用和用户可见回复">
      {tools.length > 0 && <div class="hermes-tools">{tools.map((tool) => <article>
        <div><span class={`tool-status ${tool.errorCode ? "error" : "ok"}`}>{tool.errorCode ? "失败" : "完成"}</span><strong>{tool.name}</strong></div>
        {tool.input !== undefined && <p>输入：{safePreview(tool.input, 220)}</p>}
        {tool.errorCode && <small>错误码：{tool.errorCode}</small>}
        <details><summary>工具结构化详情</summary><pre>{JSON.stringify({ input: tool.input, output: tool.output }, null, 2)}</pre></details>
      </article>)}</div>}
      {assistantTexts.length > 0 && <div class="hermes-replies">{assistantTexts.map((text) => <p>{text}</p>)}</div>}
      {tools.length === 0 && assistantTexts.length === 0 && <p class="stage-empty">这条旧记忆没有保存 Hermes 操作或回复。</p>}
    </FlowStage>
    <FlowStage role="memos" label="PigMemory 响应后处理" description="捕获、摘要、向量化、评分、策略、技能与世界模型演进" after>
      <MemosLogList logs={turn.memosAfter} focusId={focusId} empty="当前筛选条件下没有响应后 PigMemory 操作。" />
    </FlowStage>
  </article>;
}

function FlowStage({ role, label, description, after = false, children }: { role: "user" | "memos" | "hermes"; label: string; description: string; after?: boolean; children: any }) {
  return <section class={`flow-stage role-${role}${after ? " after" : ""}`}>
    <div class="role-marker">{role === "user" ? "用" : role === "memos" ? "M" : "H"}</div>
    <div class="flow-stage-body"><div class="flow-stage-title"><strong>{label}</strong><span>{description}</span></div>{children}</div>
  </section>;
}

function MemosLogList({ logs, focusId, empty }: { logs: FlowLog[]; focusId: string; empty: string }) {
  return logs.length === 0 ? <p class="stage-empty">{empty}</p> : <div class="memos-operation-list">{logs.map((row) => <MemosLogCard row={row} focusId={focusId} />)}</div>;
}

function MemosLogCard({ row, focusId }: { row: any; focusId: string }) {
  return <article id={`log-${row.id}`} class={`memos-operation level-${row.level}${String(row.id) === focusId ? " focused" : ""}`}>
    <div class="memos-operation-head">
      <div><span class={`badge ${row.level}`}>{levelName(row.level)}</span><span class="badge neutral">{categoryName(row.category)}</span><strong>{toolName(row.toolName)}</strong></div>
      <time>{time(row.calledAt)} · {row.durationMs} 毫秒</time>
    </div>
    <p>{row.reason || summary(row)}</p>
    <WarningDetails warnings={row.output?.warnings} />
    <div class="id-line">
      {row.flowAssociation && <span class="association-note">{associationLabel(row.flowAssociation)}</span>}
      {row.phase && <span>阶段：{phaseName(row.phase)}</span>}
      {row.turnId && <span>回合：<code>{row.turnId}</code></span>}
    </div>
    <details><summary>结构化详情</summary><pre>{JSON.stringify({ input: row.input, output: row.output }, null, 2)}</pre></details>
  </article>;
}

function RawTimeline({ logs, focusId }: { logs: any[]; focusId: string }) {
  if (logs.length === 0) return <div class="empty">当前筛选条件下没有操作日志。</div>;
  return <div class="timeline">{logs.slice().reverse().map((row) => <article id={`log-${row.id}`} class={`timeline-row level-${row.level}${String(row.id) === focusId ? " focused" : ""}`}>
    <div class="timeline-rail"><span /><time>{time(row.calledAt)}</time></div>
    <div class="timeline-card">
      <div class="card-head">
        <div><span class={`badge ${row.level}`}>{levelName(row.level)}</span><span class="badge neutral">{categoryName(row.category)}</span></div>
        <strong>{toolName(row.toolName)}</strong>
        <span>{row.durationMs} 毫秒</span>
      </div>
      <p>{row.reason || summary(row)}</p>
      <WarningDetails warnings={row.output?.warnings} />
      <div class="id-line">
        {row.episodeId && <span>任务片段：<a href={`#/episodes?id=${encodeURIComponent(row.episodeId)}`}><code>{row.episodeId}</code></a></span>}
        {row.sessionId && <span>会话：<code>{row.sessionId}</code></span>}
        {row.turnId && <span>回合：<code>{row.turnId}</code></span>}
        {row.phase && <span>阶段：{phaseName(row.phase)}</span>}
      </div>
      <details><summary>结构化详情</summary><pre>{JSON.stringify({ input: row.input, output: row.output }, null, 2)}</pre></details>
    </div>
  </article>)}</div>;
}

function SessionList({ sessions, date, onChoose }: { sessions: any[]; date: string; onChoose: (id: string) => void }) {
  return <section>
    <div class="section-heading"><div><span class="eyebrow">{date} · Asia/Shanghai</span><h2>会话列表</h2></div><span>{sessions.length} 个独立会话</span></div>
    <div class="session-list">
      <button class="session-row system all" onClick={() => onChoose("__all__")}>
        <div><strong>全部操作</strong><span>跨会话查看当天所有结构化操作，适合警告与错误排查</span></div><span>查看时间线 →</span>
      </button>
      <button class="session-row system" onClick={() => onChoose("__system__")}>
        <div><strong>系统操作</strong><span>没有明确会话编号的后台与基础设施记录</span></div><span>查看时间线 →</span>
      </button>
      {sessions.map((session) => <button class="session-row" onClick={() => onChoose(session.sessionId)}>
        <div class="session-main"><strong>{session.sessionId}</strong><span>开始 {time(session.startedAt)} · 结束 {session.endedAt ? time(session.endedAt) : "进行中"} · 最后活动 {time(session.lastActivityAt)}</span></div>
        <div class="session-stats">
          <Metric label="任务片段" value={session.episodeCount} />
          <Metric label="操作" value={session.operationCount} />
          <Metric label="检索" value={session.retrievalCount} />
          <Metric label="警告" value={session.warningCount} tone="warn" />
          <Metric label="错误" value={session.errorCount} tone="error" />
        </div>
      </button>)}
    </div>
  </section>;
}

function Metric({ label, value, tone = "" }: { label: string; value: unknown; tone?: string }) {
  return <span class={tone}><strong>{Number(value) || 0}</strong><small>{label}</small></span>;
}

function levelName(value: string): string {
  return ({ warn: term("warning"), error: term("error"), fatal: "严重错误（Fatal）", info: "信息（Info）", debug: "调试（Debug）" } as any)[value] ?? value;
}
function categoryName(value: string): string {
  return ({ retrieval: "检索（Retrieval）", capture: "一级记忆（L1）", l2: "二级经验（L2）", l3: "三级世界模型（L3）", skill: "技能（Skill）", episode: "任务片段（Episode）", system: "系统（System）", operation: "旧版其他操作（Legacy）" } as any)[value] ?? value;
}
function toolName(value: string): string {
  return ({ memos_search: "记忆检索", session_relation_classify: "任务关系判断", memory_add: "记忆处理", policy_generate: "策略生成", policy_evolve: "策略演进", world_model_generate: "世界模型生成", world_model_evolve: "世界模型演进", skill_generate: "技能生成", skill_evolve: "技能演进", task_done: "任务完成", task_failed: "任务失败", task_skipped: "任务跳过", system_error: "系统错误", system_model_status: "模型状态" } as any)[value] ?? value;
}
function phaseName(value: unknown): string {
  return ({ started: "开始", completed: "完成", done: "完成", lite: "逐回合捕获", reflect: "任务结束反思", skipped: "跳过", failed: "失败", induced: "已归纳", created: "已创建" } as Record<string, string>)[String(value ?? "")] ?? String(value ?? "—");
}
function summary(row: any): string {
  const output = row.output ?? {};
  const warnings = Array.isArray(output.warnings) ? output.warnings : [];
  const warningText = warnings.map((warning: any) => warning?.message || warning?.reason || warning?.error || warning?.stage).filter(Boolean).join("；");
  if (row.toolName === "task_failed" && Number.isFinite(Number(output.rHuman))) {
    return `任务奖励为负（R_human=${Number(output.rHuman).toFixed(3)}），评分来源 ${output.source || "未知"}`;
  }
  return clip(warningText || output.message || output.reason || output.stats || output.stage || output.kind || JSON.stringify(output), 360) || "操作已记录";
}

function WarningDetails({ warnings }: { warnings: unknown }) {
  if (!Array.isArray(warnings) || warnings.length === 0) return null;
  return <div class="warning-detail-list"><strong>完整警告（{warnings.length} 条）</strong>{warnings.map((warning: any, index: number) => <div><span>{warning?.stage || warning?.kind || `#${index + 1}`}</span><p>{warning?.message || warning?.reason || warning?.error || JSON.stringify(warning)}</p></div>)}</div>;
}

function isConcreteSession(value: string | null): value is string {
  return Boolean(value && value !== "__all__" && value !== "__system__");
}

function uniqueText(values: unknown[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    if (typeof value !== "string") continue;
    const text = value.trim();
    if (!text || seen.has(text)) continue;
    seen.add(text);
    out.push(text);
  }
  return out;
}

function dedupeTools(tools: any[]): any[] {
  const out = new Map<string, any>();
  for (const tool of tools) {
    const key = String(tool?.toolCallId || `${tool?.name}:${tool?.startedAt ?? ""}:${safePreview(tool?.input, 120)}`);
    if (!out.has(key)) out.set(key, tool);
  }
  return [...out.values()];
}

function safePreview(value: unknown, max: number): string {
  if (typeof value === "string") return clip(value, max);
  try { return clip(JSON.stringify(value), max); }
  catch { return clip(String(value), max); }
}
