import { useEffect, useMemo, useState } from "preact/hooks";

import { api, clip, json, qs, time } from "../api.js";
import { policyScoreForSort, scoreSummary, type ScoreSummary } from "../scoring.js";
import { term } from "../terms.js";

type PageKind = "traces" | "policies" | "skills" | "world" | "episodes";
type PolicySortKey = "updated" | "score" | "retrieval" | "candidates" | "support" | "title";

const configs: Record<PageKind, any> = {
  traces: { entityKind: "trace", endpoint: "/api/v1/traces", key: "traces", title: "记忆（Trace）", eyebrow: "一级记忆（L1）" },
  policies: { entityKind: "policy", endpoint: "/api/v1/policies", key: "policies", title: "策略（Policy）", eyebrow: "二级经验（L2）" },
  skills: { entityKind: "skill", endpoint: "/api/v1/skills", key: "skills", title: "技能（Skill）", eyebrow: "技能库" },
  world: { entityKind: "world_model", endpoint: "/api/v1/world-models", key: "worldModels", title: "世界模型（World Model）", eyebrow: "三级世界模型（L3）" },
  episodes: { entityKind: "episode", endpoint: "/api/v1/episodes", key: "episodes", title: "任务片段（Episode）", eyebrow: "任务生命周期" },
};

export function EntityPage({ kind }: { kind: PageKind }) {
  const config = configs[kind];
  const hashId = new URLSearchParams(location.hash.split("?")[1] ?? "").get("id");
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState("");
  const [sortKey, setSortKey] = useState<PolicySortKey>("updated");
  const [sortDirection, setSortDirection] = useState<"desc" | "asc">("desc");
  const [rows, setRows] = useState<any[]>([]);
  const [selected, setSelected] = useState<any>(null);
  const [loadingId, setLoadingId] = useState(hashId ?? "");
  const [error, setError] = useState("");
  const url = useMemo(() => `${config.endpoint}${qs({ q: query, status, limit: 200 })}`, [config.endpoint, query, status]);

  const load = async () => {
    try {
      const result = await api<any>(url);
      const statsById = result.retrievalStatsById ?? {};
      const items = (result[config.key] ?? []).map((item: any) => ({
        ...item,
        ...(kind === "policies"
          ? { retrievalStats: statsById[item.id] ?? emptyRetrievalStats() }
          : {}),
      }));
      setRows(items);
      if (loadingId) {
        const match = items.find((item: any) => item.id === loadingId);
        if (match) { setSelected(match); setLoadingId(""); }
        else await openById(loadingId);
      }
      setError("");
    } catch (err) { setError(err instanceof Error ? err.message : String(err)); }
  };
  const openById = async (id: string) => {
    try {
      const endpoint = kind === "episodes"
        ? `/api/v1/episodes/${encodeURIComponent(id)}/timeline`
        : `${config.endpoint}/${encodeURIComponent(id)}`;
      const value = await api<any>(endpoint);
      const listItem = rows.find((item: any) => item.id === id) ?? {};
      setSelected(kind === "episodes" ? { ...listItem, id, traces: value.traces ?? [] } : value);
      setLoadingId("");
    } catch (err) { setError(err instanceof Error ? err.message : String(err)); setLoadingId(""); }
  };
  useEffect(() => { setRows([]); setSelected(null); void load(); }, [url, kind]);
  const visibleRows = useMemo(
    () => kind === "policies" ? sortPolicies(rows, sortKey, sortDirection) : rows,
    [kind, rows, sortKey, sortDirection],
  );

  if (selected) return <EntityDetail
    kind={kind}
    item={selected}
    onBack={() => setSelected(null)}
    onChanged={async () => { setSelected(null); await load(); }}
  />;

  return <div class="page-stack">
    {error && <div class="notice error">{error}</div>}
    <section class="filter-bar">
      <label>搜索<input value={query} placeholder={`搜索${config.title}`} onInput={(event) => setQuery((event.target as HTMLInputElement).value)} /></label>
      {kind !== "traces" && kind !== "episodes" && <label>状态<select value={status} onChange={(event) => setStatus((event.target as HTMLSelectElement).value)}><option value="">全部状态</option><option value="candidate">候选（Candidate）</option><option value="active">生效（Active）</option><option value="archived">已归档（Archived）</option></select></label>}
      {kind === "policies" && <><label>排序依据<select value={sortKey} onChange={(event) => setSortKey((event.target as HTMLSelectElement).value as PolicySortKey)}><option value="updated">更新时间</option><option value="score">质量评分（ΔV / 反馈信号）</option><option value="retrieval">检索使用次数（最终返回）</option><option value="candidates">进入候选次数</option><option value="support">支持任务数</option><option value="title">标题</option></select></label><label>顺序<select value={sortDirection} onChange={(event) => setSortDirection((event.target as HTMLSelectElement).value as "desc" | "asc")}><option value="desc">从高到低 / 从新到旧</option><option value="asc">从低到高 / 从旧到新</option></select></label></>}
      <button onClick={load}>立即刷新</button>
    </section>
    <section>
      <div class="section-heading"><div><span class="eyebrow">{config.eyebrow}</span><h2>{config.title}</h2></div><span>{rows.length} 条</span></div>
      {visibleRows.length === 0 ? <div class="empty">当前没有匹配对象。</div> : <div class="entity-grid">{visibleRows.map((item) => <EntityCard key={item.id} kind={kind} item={item} onOpen={() => setSelected(item)} />)}</div>}
    </section>
  </div>;
}

function EntityDetail({ kind, item, onBack, onChanged }: { kind: PageKind; item: any; onBack: () => void; onChanged: () => Promise<void> }) {
  const config = configs[kind];
  const [history, setHistory] = useState<any>(null);
  const [timeline, setTimeline] = useState<any[]>(item.traces ?? []);
  const [error, setError] = useState("");

  const load = async () => {
    try {
      const result = await api(`/api/v1/monitor/entities/${config.entityKind}/${encodeURIComponent(item.id)}/history`);
      setHistory(result);
      if (kind === "episodes") {
        const episode = await api<any>(`/api/v1/episodes/${encodeURIComponent(item.id)}/timeline`);
        setTimeline(episode.traces ?? []);
      }
      setError("");
    } catch (err) { setError(err instanceof Error ? err.message : String(err)); }
  };
  useEffect(() => { void load(); }, [item.id, kind]);

  const action = async (fn: () => Promise<unknown>) => {
    try { await fn(); await onChanged(); }
    catch (err) { setError(err instanceof Error ? err.message : String(err)); }
  };

  const latest = history?.lifecycle?.[0];
  const stats = history?.retrievalStats ?? {};
  const scores = scoreSummary(kind, item);
  return <div class="page-stack">
    {error && <div class="notice error">{error}</div>}
    <section class={`detail-hero score-band-${scores.band}`}>
      <button class="back" onClick={onBack}>← {config.title}列表</button>
      <span class="eyebrow">{config.eyebrow}</span>
      <h2>{titleOf(kind, item)}</h2>
      <p>{previewOf(kind, item, 600)}</p>
      <ScoreStrip scores={scores} detailed />
      <div class="id-line"><span>编号：<code>{item.id}</code></span><span>当前状态：<strong>{stateOf(kind, item)}</strong></span><span>更新时间：{time(updatedOf(kind, item))}</span><span>版本：{versionOf(kind, item)}</span><span>状态来源：{latest?.source ?? "现有对象"}</span></div>
      <div class="action-row"><Actions kind={kind} item={item} run={(fn) => action(fn)} /></div>
    </section>

    <EntityLineage kind={kind} item={item} lineage={history?.lineage} />

    <section>
      <div class="section-heading"><div><span class="eyebrow">Retrieval usage</span><h2>检索使用统计</h2></div></div>
      <div class="stat-grid seven">
        <Stat label="回合开始检索" value={stats.turnStartRuns} />
        <Stat label="工具检索" value={stats.searchRuns} />
        <Stat label="候选次数" value={stats.candidateCount} />
        <Stat label="送入模型" value={stats.sentToModelCount} />
        <Stat label="模型保留" value={stats.modelKeptCount} />
        <Stat label="最终返回" value={stats.finalReturnedCount} />
        <Stat label="适配器接收" value={stats.adapterReceivedCount} accent />
      </div>
      {(history?.retrievalRuns ?? []).length > 0 && <div class="run-chips">{history.retrievalRuns.map((run: any) => <a href={`#/retrieval?id=${encodeURIComponent(run.id)}`}>{run.source === "turn_start" ? term("turn_start") : term("search")} · {time(run.startedAt)}</a>)}</div>}
    </section>

    <section>
      <div class="section-heading"><div><span class="eyebrow">Lifecycle</span><h2>完整状态变化轨迹</h2></div></div>
      {!history ? <div class="empty">正在读取生命周期…</div> : history.lifecycle.length === 0 ? <div class="empty">尚无生命周期记录。</div> : <div class="lifecycle-list">{history.lifecycle.map((event: any) => <article>
        <time>{time(event.eventAt)}</time><div><strong>{event.oldState ? term(event.oldState) : "首次观察"} → {term(event.newState)}</strong><p>原因：{event.reason}</p><small>来源：{event.source}{event.oldVersion || event.newVersion ? ` · 版本 ${event.oldVersion ?? "—"} → ${event.newVersion ?? "—"}` : ""}</small></div>
      </article>)}</div>}
    </section>

    {kind === "episodes" && <section><div class="section-heading"><div><span class="eyebrow">Conversation</span><h2>任务片段时间线</h2></div><span>{timeline.length} 条记忆</span></div>{timeline.length === 0 ? <div class="empty">没有捕获到会话内容。</div> : <div class="conversation">{timeline.map((trace) => <article><span>用户</span><p>{trace.userText}</p><span>助手</span><p>{trace.agentText}</p><time>{time(trace.ts)}</time></article>)}</div>}</section>}

    <details class="raw-detail"><summary>对象原始字段</summary><pre>{JSON.stringify(item, null, 2)}</pre></details>
  </div>;
}

function EntityCard({ kind, item, onOpen }: { kind: PageKind; item: any; onOpen: () => void }) {
  const scores = scoreSummary(kind, item);
  return <button class={`entity-card score-band-${scores.band}`} onClick={onOpen}>
    <div class="entity-card-head"><span class={`badge ${item.status === "archived" ? "neutral" : item.status === "active" ? "ok" : "warning"}`}>{stateOf(kind, item)}</span><code>{item.id}</code></div>
    <h3>{titleOf(kind, item)}</h3>
    <p>{previewOf(kind, item)}</p>
    <ScoreStrip scores={scores} />
    <footer><span>{time(updatedOf(kind, item))}</span>{kind === "policies" && <span>实际效果样本 {Number(item.actualUsageCount) || 0} 次</span>}<span>查看详情 →</span></footer>
  </button>;
}

function EntityLineage({ kind, item, lineage }: { kind: PageKind; item: any; lineage: any }) {
  const traces = lineage?.sourceTraces ?? [];
  const episodes = lineage?.sourceEpisodes ?? [];
  const policies = lineage?.policies ?? [];
  const worldModels = lineage?.worldModels ?? [];
  const skills = lineage?.skills ?? [];
  const currentClass = (targetKind: PageKind, id: string) =>
    kind === targetKind && item.id === id ? "current-relation" : "";
  return <section class="entity-lineage">
    <div class="section-heading"><div><span class="eyebrow">Persisted relationships</span><h2>L1 → L2 → L3 全链路关系</h2></div><span>按持久化 ID 关联，不使用相似度猜测</span></div>
    <div class="policy-source-definition">
      <div><b>Policy 的直接来源：Trace</b><span>Policy 读取并归纳 L1 Trace 中的对话、行动、反思与评分。</span></div>
      <div><b>Policy 的支持单位：Episode</b><span>Episode 是 Trace 所属的独立任务容器；support 按不同 Episode 去重计数，不是第二种内容证据。</span></div>
    </div>
    {!lineage ? <div class="empty">正在解析上下游关联…</div> : <>
      <div class="lineage-flow">
        <article class="lineage-stage l1">
          <header><span>L1</span><div><strong>直接证据 Trace</strong><small>{traces.length} 条内容证据</small></div></header>
          <div class="lineage-items">{traces.length === 0 ? <p class="lineage-empty">没有保存可审计的 Trace 链接</p> : traces.map((trace: any) => <a class={currentClass("traces", trace.id)} href={`#/traces?id=${encodeURIComponent(trace.id)}`}><strong>{trace.summary || clip(trace.userText, 72) || trace.id}</strong><small>V {scoreNumber(trace.value)} · α {scorePercent(trace.alpha)} · {time(trace.ts)}</small><code>{trace.id}</code>{kind === "traces" && item.id === trace.id && <em>当前对象</em>}</a>)}</div>
        </article>
        <div class="lineage-arrow"><span>从多个任务的 Trace 归纳</span><b>→</b></div>
        <article class="lineage-stage l2">
          <header><span>L2</span><div><strong>经验 Policy</strong><small>{policies.length} 条归纳结果</small></div></header>
          <div class="lineage-items">{policies.length === 0 ? <p class="lineage-empty">尚无由这些证据归纳出的 Policy</p> : policies.map((policy: any) => <a class={currentClass("policies", policy.id)} href={`#/policies?id=${encodeURIComponent(policy.id)}`}><strong>{policy.title || policy.id}</strong><small>{term(policy.status)} · 支持 {Number(policy.support) || 0} 个 Episode · ΔV {scoreNumber(policy.gain)}</small><code>{policy.id}</code>{kind === "policies" && item.id === policy.id && <em>当前对象</em>}</a>)}</div>
        </article>
        <div class="lineage-arrow"><span>由 Policy 聚类抽象</span><b>→</b></div>
        <article class="lineage-stage l3">
          <header><span>L3</span><div><strong>World Model</strong><small>{worldModels.length} 个抽象结果</small></div></header>
          <div class="lineage-items">{worldModels.length === 0 ? <p class="lineage-empty">尚未形成关联的 World Model</p> : worldModels.map((model: any) => <a class={currentClass("world", model.id)} href={`#/world?id=${encodeURIComponent(model.id)}`}><strong>{model.title || model.id}</strong><small>置信度 {scorePercent(model.confidence)} · v{model.version ?? 1} · {term(model.status)}</small><code>{model.id}</code>{kind === "world" && item.id === model.id && <em>当前对象</em>}</a>)}</div>
        </article>
      </div>
      <div class="lineage-support">
        <div><h3>证据归属任务（Episode）<small>用于证明跨任务支持，Policy support 按这里去重</small></h3><div class="relation-chips">{episodes.length === 0 ? <span class="muted">没有保存证据所属 Episode</span> : episodes.map((episode: any) => <a class={currentClass("episodes", episode.id)} href={`#/episodes?id=${encodeURIComponent(episode.id)}`}><strong>{episode.preview || episode.id}</strong><small>{term(episode.status)} · {Number(episode.traceCount) || 0} 条 Trace · R {scoreNumber(episode.rTask)}</small>{kind === "episodes" && item.id === episode.id && <em>当前对象</em>}</a>)}</div></div>
        <div><h3>能力出口（Skill）<small>由 Policy / World Model 结晶出的可调用能力</small></h3><div class="relation-chips">{skills.length === 0 ? <span class="muted">尚未结晶为 Skill</span> : skills.map((skill: any) => <a class={currentClass("skills", skill.id)} href={`#/skills?id=${encodeURIComponent(skill.id)}`}><strong>{skill.name || skill.id}</strong><small>{term(skill.status)} · η {scorePercent(skill.eta)} · 支持 {Number(skill.support) || 0}</small>{kind === "skills" && item.id === skill.id && <em>当前对象</em>}</a>)}</div></div>
      </div>
    </>}
  </section>;
}

function ScoreStrip({ scores, detailed = false }: { scores: ScoreSummary; detailed?: boolean }) {
  return <div class={detailed ? "score-strip detailed" : "score-strip"}>
    <div class="score-primary"><small>{scores.primaryLabel}</small><strong>{scores.primaryValue}</strong><span>{scores.bandLabel}</span></div>
    <div class="score-metrics">{scores.metrics.map((metric) => <div><small>{metric.label}</small><strong>{metric.value}</strong>{metric.hint && <em>{metric.hint}</em>}</div>)}</div>
  </div>;
}

function Actions({ kind, item, run }: { kind: PageKind; item: any; run: (fn: () => Promise<unknown>) => void }) {
  const edit = () => run(async () => {
    if (kind === "traces") {
      const summary = prompt("编辑记忆摘要", item.summary ?? "");
      if (summary === null) return;
      return api(`/api/v1/traces/${encodeURIComponent(item.id)}`, json("PATCH", { summary }));
    }
    if (kind === "policies") {
      const title = prompt("编辑策略标题", item.title ?? "");
      if (title === null) return;
      const procedure = prompt("编辑策略过程", item.procedure ?? "");
      if (procedure === null) return;
      return api(`/api/v1/policies/${encodeURIComponent(item.id)}`, json("PATCH", { title, procedure }));
    }
    if (kind === "skills") {
      const name = prompt("编辑技能名称", item.name ?? "");
      if (name === null) return;
      const invocationGuide = prompt("编辑调用指南", item.invocationGuide ?? "");
      if (invocationGuide === null) return;
      return api(`/api/v1/skills/${encodeURIComponent(item.id)}`, json("PATCH", { name, invocationGuide }));
    }
    if (kind === "world") {
      const title = prompt("编辑世界模型标题", item.title ?? "");
      if (title === null) return;
      const body = prompt("编辑世界模型正文", item.body ?? "");
      if (body === null) return;
      return api(`/api/v1/world-models/${encodeURIComponent(item.id)}`, json("PATCH", { title, body }));
    }
  });
  const share = () => run(() => {
    const scope = item.share?.scope === "public" || item.share?.scope === "hub" ? null : "public";
    const base = kind === "traces" ? "traces" : kind === "policies" ? "policies" : kind === "skills" ? "skills" : "world-models";
    return api(`/api/v1/${base}/${encodeURIComponent(item.id)}/share`, json("POST", { scope }));
  });
  const archive = () => run(() => {
    if (kind === "policies") return api(`/api/v1/policies/${encodeURIComponent(item.id)}`, json("PATCH", { status: item.status === "archived" ? "active" : "archived" }));
    if (kind === "skills") return api(`/api/v1/skills/${item.status === "archived" ? "reactivate" : "archive"}`, json("POST", { id: item.id, reason: "manual" }));
    return api(`/api/v1/world-models/${encodeURIComponent(item.id)}/${item.status === "archived" ? "unarchive" : "archive"}`, json("POST", {}));
  });
  const remove = () => {
    if (!confirm(`确定永久删除 ${item.id}？此操作不可恢复。`)) return;
    run(() => {
      const base = kind === "traces" ? "traces" : kind === "policies" ? "policies" : kind === "skills" ? "skills" : "world-models";
      return api(`/api/v1/${base}/${encodeURIComponent(item.id)}`, json("DELETE"));
    });
  };
  if (kind === "episodes") return <span class="muted">任务片段由运行时生命周期管理</span>;
  return <><button onClick={edit}>编辑</button><button onClick={share}>{item.share?.scope === "public" || item.share?.scope === "hub" ? "取消共享" : "共享"}</button>{kind !== "traces" && <button onClick={archive}>{item.status === "archived" ? "恢复生效" : "归档"}</button>}<button class="danger" onClick={remove}>删除</button></>;
}

function Stat({ label, value, accent = false }: { label: string; value: unknown; accent?: boolean }) { return <article class={accent ? "accent" : ""}><strong>{Number(value) || 0}</strong><span>{label}</span></article>; }
function sortPolicies(rows: any[], key: PolicySortKey, direction: "desc" | "asc"): any[] {
  const sign = direction === "desc" ? -1 : 1;
  return [...rows].sort((left, right) => {
    if (key === "title") return sign * String(left.title ?? "").localeCompare(String(right.title ?? ""), "zh-CN");
    const a = policySortValue(left, key);
    const b = policySortValue(right, key);
    if (a !== b) return sign * (a - b);
    return Number(right.updatedAt ?? 0) - Number(left.updatedAt ?? 0);
  });
}
function policySortValue(item: any, key: Exclude<PolicySortKey, "title">): number {
  if (key === "score") return policyScoreForSort(item) ?? Number.NEGATIVE_INFINITY;
  if (key === "retrieval") return Number(item.retrievalStats?.finalReturnedCount) || 0;
  if (key === "candidates") return Number(item.retrievalStats?.candidateCount) || 0;
  if (key === "support") return Number(item.support) || 0;
  return Number(item.updatedAt) || 0;
}
function emptyRetrievalStats() { return { turnStartRuns: 0, searchRuns: 0, candidateCount: 0, sentToModelCount: 0, modelKeptCount: 0, finalReturnedCount: 0, adapterReceivedCount: 0 }; }
function scoreNumber(value: unknown): string { const n = Number(value); return value == null || !Number.isFinite(n) ? "—" : `${n > 0 ? "+" : ""}${n.toFixed(3)}`; }
function scorePercent(value: unknown): string { const n = Number(value); return value == null || !Number.isFinite(n) ? "—" : `${Math.round(n * 100)}%`; }
function titleOf(kind: PageKind, item: any): string { return kind === "traces" ? item.summary || clip(item.userText, 80) || "未命名记忆" : kind === "policies" || kind === "world" ? item.title || "未命名" : kind === "skills" ? item.name || "未命名技能" : item.preview || `任务片段 ${item.id}`; }
function previewOf(kind: PageKind, item: any, max = 180): string { return clip(kind === "traces" ? item.agentText || item.userText : kind === "policies" ? item.procedure || item.trigger : kind === "skills" ? item.invocationGuide : kind === "world" ? item.body : item.preview, max) || "暂无摘要"; }
function updatedOf(kind: PageKind, item: any): unknown { return kind === "traces" ? item.ts : kind === "episodes" ? item.endedAt || item.startedAt : item.updatedAt || item.createdAt; }
function versionOf(kind: PageKind, item: any): unknown { return kind === "traces" ? item.schemaVersion ?? 1 : kind === "policies" ? item.contentVersion ?? 1 : kind === "episodes" ? "—" : item.version ?? 1; }
function stateOf(kind: PageKind, item: any): string { if (kind === "traces") return item.reflection ? "已反思（Reflected）" : "已捕获（Captured）"; if (kind === "episodes") return item.topicState ? term(item.topicState) : item.status === "closed" ? "已结束（Ended）" : "进行中（Open）"; return term(item.status); }
