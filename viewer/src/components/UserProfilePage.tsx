import { useEffect, useMemo, useState } from "preact/hooks";

import { api, json, qs, time } from "../api.js";

interface Fact {
  id: string;
  subjectId: string;
  dimension: string;
  claim: string;
  evidenceKind: "explicit" | "inferred" | "user_edited";
  confidence: number;
  firstSeenAt: number;
  lastConfirmedAt: number;
  updatedAt: number;
}

interface DailyEvent {
  kind: string;
  summary: string;
  state: string;
  salience: number;
  confidence: number;
}

interface DailyMemory {
  id: string;
  subjectId: string;
  memoryDate: string;
  summary: string;
  highlights: string[];
  events: DailyEvent[];
  openLoops: string[];
  moodSignals: string[];
  updatedAt: number;
}

interface Subject {
  subjectId: string;
  lastActivityAt: number;
  factCount: number;
  dailyMemoryCount: number;
}

interface Interaction {
  id: string;
  sourceDate: string;
  reason: string;
  message: string;
  score: number;
  dueDate: string;
  dueTime: string;
  status: string;
  sentAt?: number | null;
  error?: string | null;
}

interface Snapshot {
  enabled: boolean;
  subjectId: string;
  timezone: string;
  facts: Fact[];
  yesterday: DailyMemory | null;
  latestJob: {
    memoryDate: string;
    status: string;
    attempts: number;
    startedAt?: number | null;
    completedAt?: number | null;
    error?: string | null;
    model?: string | null;
  } | null;
}

const dimensionNames: Record<string, string> = {
  personality: "性格倾向",
  communication_style: "沟通偏好",
  work_style: "工作方式",
  interest: "兴趣",
  long_term_goal: "长期目标",
  habit: "生活习惯",
  boundary: "边界与禁忌",
  other: "其他",
};

const evidenceNames: Record<string, string> = {
  explicit: "用户明确表达",
  inferred: "模型推断",
  user_edited: "用户已编辑",
};

export function UserProfilePage() {
  const [subjects, setSubjects] = useState<Subject[]>([]);
  const [subjectId, setSubjectId] = useState("default");
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [daily, setDaily] = useState<DailyMemory | null>(null);
  const [interactions, setInteractions] = useState<Interaction[]>([]);
  const [selectedDate, setSelectedDate] = useState(yesterdayDate());
  const [schedule, setSchedule] = useState<Record<string, any> | null>(null);
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState("");

  const loadSubjects = async () => {
    const response = await api<{ subjects: Subject[] }>("/api/v1/user-profile/subjects");
    const next = response.subjects ?? [];
    setSubjects(next);
    if (subjectId === "default" && next.length > 0) setSubjectId(next[0]!.subjectId);
  };

  const load = async () => {
    try {
      setLoading(true);
      const [profile, memories, interactionResponse, config] = await Promise.all([
        api<Snapshot>(`/api/v1/user-profile${qs({ subjectId })}`),
        api<{ dailyMemories: DailyMemory[] }>(`/api/v1/user-profile/daily${qs({ subjectId, fromDate: selectedDate, toDate: selectedDate, limit: 1 })}`),
        api<{ interactions: Interaction[] }>(`/api/v1/user-profile/interactions${qs({ subjectId, limit: 20 })}`),
        api<Record<string, any>>("/api/v1/config"),
      ]);
      setSnapshot(profile);
      setDaily(memories.dailyMemories?.[0] ?? null);
      setInteractions(interactionResponse.interactions ?? []);
      setSchedule(config.userProfile ?? null);
      setError("");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { void loadSubjects().catch((err) => setError(String(err))); }, []);
  useEffect(() => { void load(); }, [subjectId, selectedDate]);

  const grouped = useMemo(() => {
    const out = new Map<string, Fact[]>();
    for (const fact of snapshot?.facts ?? []) {
      const list = out.get(fact.dimension) ?? [];
      list.push(fact);
      out.set(fact.dimension, list);
    }
    return [...out.entries()];
  }, [snapshot]);

  const runNow = async () => {
    try {
      setRunning(true);
      const result = await api<{ processed: number; failed: number }>(
        "/api/v1/user-profile/run",
        json("POST", { subjectId, memoryDate: selectedDate }),
      );
      if (result.failed > 0) throw new Error("整理任务失败，请查看最近任务状态或日志。");
      await Promise.all([load(), loadSubjects()]);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRunning(false);
    }
  };

  const editFact = async (fact: Fact) => {
    const next = window.prompt("修改画像内容", fact.claim)?.trim();
    if (!next || next === fact.claim) return;
    try {
      await api(`/api/v1/user-profile/facts/${encodeURIComponent(fact.id)}`, json("PATCH", { claim: next }));
      await load();
    } catch (err) { setError(err instanceof Error ? err.message : String(err)); }
  };

  const deleteFact = async (fact: Fact) => {
    if (!window.confirm(`删除这条画像？\n\n${fact.claim}`)) return;
    try {
      await api(`/api/v1/user-profile/facts/${encodeURIComponent(fact.id)}`, json("DELETE"));
      await Promise.all([load(), loadSubjects()]);
    } catch (err) { setError(err instanceof Error ? err.message : String(err)); }
  };

  if (loading && !snapshot) return <div class="empty large">正在读取独立用户画像记忆…</div>;

  return <div class="page-stack user-profile-page">
    {error && <div class="notice error">{error}</div>}
    <section class="profile-hero">
      <div>
        <span class="eyebrow">Sidecar user memory</span>
        <h2>用户画像与每日记忆</h2>
        <p>这套记忆独立于 L1/L2/L3。白天只收集，深夜集中整理；画像不会进入策略或世界模型进化。</p>
        <div class="profile-controls">
          <label>当前用户<select value={subjectId} onChange={(event) => setSubjectId((event.target as HTMLSelectElement).value)}>
            {subjects.length === 0 && <option value="default">default</option>}
            {subjects.map((subject) => <option value={subject.subjectId}>{subject.subjectId}</option>)}
          </select></label>
          <span class={snapshot?.enabled ? "status-pill ok" : "status-pill off"}>{snapshot?.enabled ? "功能已开启" : "功能未开启"}</span>
          <a href="#/settings">修改开关与时间</a>
        </div>
      </div>
      <div class="profile-schedule-card">
        <strong>{schedule?.schedule?.time ?? "23:10"}</strong>
        <span>每日整理 · {snapshot?.timezone ?? "Asia/Shanghai"}</span>
        <small>主动互动：{schedule?.proactiveInteraction?.enabled ? `开启，${schedule?.proactiveInteraction?.sendTime}` : "关闭"}</small>
      </div>
    </section>

    {!snapshot?.enabled && <div class="notice">请在设置中打开 <code>userProfile.enabled</code>。关闭状态不会收集新对话，也不会删除已有数据。</div>}

    <section class="profile-section">
      <header class="section-head"><div><span class="eyebrow">Current profile</span><h2>当前用户画像</h2></div><span>{snapshot?.facts.length ?? 0} 条</span></header>
      {grouped.length === 0
        ? <div class="empty">暂无画像。功能开启后，夜间任务会从用户明确表达和重复行为中谨慎整理。</div>
        : <div class="profile-dimension-grid">{grouped.map(([dimension, facts]) => <article class="profile-dimension-card">
          <h3>{dimensionNames[dimension] ?? dimension}</h3>
          <div>{facts.map((fact) => <div class="profile-fact">
            <p>{fact.claim}</p>
            <footer>
              <span class={`evidence ${fact.evidenceKind}`}>{evidenceNames[fact.evidenceKind] ?? fact.evidenceKind}</span>
              <span>置信度 {Math.round(fact.confidence * 100)}%</span>
              <span>确认于 {time(fact.lastConfirmedAt)}</span>
              <button onClick={() => void editFact(fact)}>编辑</button>
              <button class="danger" onClick={() => void deleteFact(fact)}>删除</button>
            </footer>
          </div>)}</div>
        </article>)}</div>}
    </section>

    <section class="profile-section daily-memory-section">
      <header class="section-head">
        <div><span class="eyebrow">Daily memory</span><h2>{selectedDate === yesterdayDate() ? "昨日记忆" : "历史每日记忆"}</h2></div>
        <div class="date-controls">
          <button onClick={() => setSelectedDate(addDays(selectedDate, -1))}>‹</button>
          <input type="date" value={selectedDate} max={todayDate()} onInput={(event) => setSelectedDate((event.target as HTMLInputElement).value)} />
          <button disabled={selectedDate >= todayDate()} onClick={() => setSelectedDate(addDays(selectedDate, 1))}>›</button>
          <button disabled={running || !snapshot?.enabled} onClick={() => void runNow()}>{running ? "正在整理…" : "立即整理"}</button>
        </div>
      </header>
      {daily ? <div class="daily-memory-card">
        <div class="daily-summary"><time>{daily.memoryDate}</time><p>{daily.summary}</p><small>更新于 {time(daily.updatedAt)}</small></div>
        <MemoryList title="当天重点" values={daily.highlights} />
        <MemoryList title="尚未闭环" values={daily.openLoops} />
        <MemoryList title="情绪与状态信号" values={daily.moodSignals} />
        <div class="daily-events"><h3>经历与计划</h3>{daily.events.length === 0 ? <p class="muted">没有可确认事件。</p> : daily.events.map((event) => <article>
          <div><span>{event.kind}</span><span>{event.state}</span></div>
          <p>{event.summary}</p>
          <small>重要度 {Math.round(event.salience * 100)}% · 置信度 {Math.round(event.confidence * 100)}%</small>
        </article>)}</div>
      </div> : <div class="empty">{selectedDate} 暂无每日记忆。可选择“立即整理”处理尚未整理的对话。</div>}
    </section>

    <section class="profile-section">
      <header class="section-head"><div><span class="eyebrow">Proactive outbox</span><h2>主动互动记录</h2></div><span>{interactions.length} 条</span></header>
      {interactions.length === 0 ? <div class="empty">暂无主动互动候选。</div> : <div class="interaction-list">{interactions.map((item) => <article>
        <header><span class={`interaction-status ${item.status}`}>{item.status}</span><time>{item.dueDate} {item.dueTime}</time><strong>{Math.round(item.score * 100)} 分</strong></header>
        <p>{item.message}</p>
        <small>原因：{item.reason}{item.error ? ` · 错误：${item.error}` : ""}</small>
      </article>)}</div>}
    </section>

    {snapshot?.latestJob && <section class="profile-job">
      <strong>最近整理任务：{snapshot.latestJob.memoryDate} · {snapshot.latestJob.status}</strong>
      <span>尝试 {snapshot.latestJob.attempts} 次 · 模型 {snapshot.latestJob.model ?? "—"}</span>
      {snapshot.latestJob.error && <small>{snapshot.latestJob.error}</small>}
    </section>}
  </div>;
}

function MemoryList({ title, values }: { title: string; values: string[] }) {
  return <div class="daily-memory-list"><h3>{title}</h3>{values.length === 0 ? <p class="muted">无</p> : <ul>{values.map((value) => <li>{value}</li>)}</ul>}</div>;
}

function todayDate(): string {
  return localDate(new Date());
}

function yesterdayDate(): string {
  return addDays(todayDate(), -1);
}

function addDays(value: string, amount: number): string {
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year!, month! - 1, day! + amount));
  return date.toISOString().slice(0, 10);
}

function localDate(value: Date): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(value);
  const get = (kind: string) => parts.find((part) => part.type === kind)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}
