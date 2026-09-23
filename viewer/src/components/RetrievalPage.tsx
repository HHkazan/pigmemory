import { useEffect, useMemo, useState } from "preact/hooks";

import { api, dayInShanghai, qs, time } from "../api.js";
import {
  candidateChannels,
  candidatePathId,
  lineagePath,
  retrievalChannelLabel,
} from "../retrieval-graph.js";
import { term } from "../terms.js";
import { HybridRetrievalVisualization } from "./HybridRetrievalGraph.js";

export function RetrievalPage() {
  const initialId = new URLSearchParams(location.hash.split("?")[1] ?? "").get("id");
  const [date, setDate] = useState(dayInShanghai());
  const [source, setSource] = useState("");
  const [session, setSession] = useState("");
  const [runs, setRuns] = useState<any[]>([]);
  const [selected, setSelected] = useState<any>(null);
  const [error, setError] = useState("");
  const query = useMemo(() => qs({ date, source, sessionId: session, limit: 200 }), [date, source, session]);

  const load = async () => {
    try {
      const result = await api<any>(`/api/v1/monitor/retrieval-runs${query}`);
      setRuns(result.runs ?? []);
      setError("");
    } catch (err) { setError(err instanceof Error ? err.message : String(err)); }
  };
  useEffect(() => { void load(); }, [query]);
  useEffect(() => { if (initialId) void open(initialId); }, []);

  const open = async (id: string) => {
    try { setSelected(await api(`/api/v1/monitor/retrieval-runs/${encodeURIComponent(id)}`)); }
    catch (err) { setError(err instanceof Error ? err.message : String(err)); }
  };

  if (selected) return <RunDetail run={selected} onBack={() => setSelected(null)} />;
  return <div class="page-stack">
    {error && <div class="notice error">{error}</div>}
    <section class="filter-bar">
      <label>北京时间日期<input type="date" value={date} onInput={(event) => setDate((event.target as HTMLInputElement).value)} /></label>
      <label>检索来源<select value={source} onChange={(event) => setSource((event.target as HTMLSelectElement).value)}><option value="">全部来源</option><option value="turn_start">回合开始（Turn Start）</option><option value="search">检索（Search）</option></select></label>
      <label>会话编号<input value={session} placeholder="全部会话" onInput={(event) => setSession((event.target as HTMLInputElement).value)} /></label>
      <button onClick={load}>立即刷新</button>
    </section>
    <section>
      <div class="section-heading"><div><span class="eyebrow">Retrieval funnel</span><h2>独立检索运行</h2></div><span>{runs.length} 次</span></div>
      {runs.length === 0 ? <div class="empty">当前日期和筛选条件下没有检索运行。</div> : <div class="table-wrap"><table>
        <thead><tr><th>时间 / 来源</th><th>查询文本</th><th>漏斗</th><th>适配器确认</th><th>状态</th></tr></thead>
        <tbody>{runs.map((run) => <tr onClick={() => open(run.id)} class="clickable">
          <td><strong>{run.source === "turn_start" ? term("turn_start") : term("search")}</strong><small>{time(run.startedAt)}</small><code>{run.id}</code></td>
          <td><span class="query-cell">{run.queryText || "（空查询）"}</span><small>{run.sessionId ? `会话 ${run.sessionId}` : "系统检索"}</small>{graphCount(run) != null && <span class={`badge ${graphCount(run)! > 0 ? "graph" : "neutral"}`}>Graph {graphCount(run)}</span>}</td>
          <td><div class="mini-funnel"><span>{run.rawCandidateCount}</span><i>→</i><span>{run.sentToModelCount}</span><i>→</i><span>{run.modelKeptCount}</span><i>→</i><strong>{run.finalReturnedCount}</strong></div></td>
          <td>{run.acknowledgedAt ? <span class="badge ok">已接收 {run.adapterReceivedCount}</span> : <span class="badge neutral">未确认</span>}</td>
          <td><span class={`badge ${run.status === "failed" ? "error" : "ok"}`}>{run.status === "failed" ? "失败" : "完成"}</span><small>{run.durationMs} 毫秒</small></td>
        </tr>)}</tbody>
      </table></div>}
    </section>
  </div>;
}

export function RunDetail({ run, onBack }: { run: any; onBack: () => void }) {
  const candidates = run.candidates ?? [];
  const [selectedGraphPath, setSelectedGraphPath] = useState<string | undefined>();
  return <div class="page-stack">
    <section class="detail-hero">
      <button class="back" onClick={onBack}>← 检索运行列表</button>
      <span class="eyebrow">{run.source === "turn_start" ? term("turn_start") : term("search")}</span>
      <h2>{run.queryText || "（空查询）"}</h2>
      <div class="id-line"><span>运行编号：<code>{run.id}</code></span><span>会话：<code>{run.sessionId ?? "系统"}</code></span>{run.episodeId && <span>任务片段：<code>{run.episodeId}</code></span>}</div>
      <p>{time(run.startedAt)} · 耗时 {run.durationMs} 毫秒</p>
    </section>

    <section class="funnel-grid">
      <Stage label="检索候选（Candidate）" value={run.rawCandidateCount} />
      <Stage label="送入相关性模型" value={run.sentToModelCount} />
      <Stage label="模型保留" value={run.modelKeptCount} />
      <Stage label="最终返回" value={run.finalReturnedCount} />
      <Stage label="适配器已接收" value={run.adapterReceivedCount} accent />
    </section>
    <p class="honesty-note">“适配器已接收”只表示 Hermes/OpenClaw 已组装自动上下文或工具结果；页面不会把它冒充为宿主模型已实际读取。</p>

    <HybridRetrievalVisualization
      run={run}
      candidates={candidates}
      selectedPathId={selectedGraphPath}
      onSelectPath={setSelectedGraphPath}
    />

    <section>
      <div class="section-heading"><div><span class="eyebrow">Candidate decisions</span><h2>逐条候选明细</h2></div><span>{candidates.length} 条</span></div>
      {candidates.length === 0 ? <div class="empty">本次没有候选。</div> : <div class="table-wrap"><table class="candidate-table">
        <thead><tr><th>初始排名</th><th>对象</th><th>来源 / 层级</th><th>分数</th><th>阶段状态</th><th>决定原因</th></tr></thead>
        <tbody>{candidates.map((item: any) => <tr class={lineagePath(item) ? "graph-candidate-row" : ""}>
          <td><strong>#{item.initialRank ?? "—"}</strong>{item.finalRank && <small>最终 #{item.finalRank}</small>}</td>
          <td><a href={entityHref(item.refKind, item.refId)}>{term(item.refKind)}<br /><code>{item.refId}</code></a><p>{item.summary}</p></td>
          <td>
            <span class="badge neutral">{item.source === "shared" ? "共享（Shared）" : "本地（Local）"}</span><span class="badge neutral">{tierName(item.tier)}</span>
            <div class="candidate-channels">{candidateChannels(item).map((channel) => <span class={`channel-${channel}`}>{retrievalChannelLabel(channel)}</span>)}</div>
            {lineagePath(item) && <button class="graph-path-button" type="button" onClick={() => {
              setSelectedGraphPath(candidatePathId(item));
              document.getElementById("hybrid-evidence")?.scrollIntoView({ behavior: "smooth", block: "start" });
            }}>查看证据路径</button>}
          </td>
          <td><strong>{Number(item.score).toFixed(4)}</strong>{item.relevance != null && <small>相关度 {Number(item.relevance).toFixed(4)}</small>}</td>
          <td><div class="stage-flags"><Flag on label="候选" /><Flag on={item.sentToModel} label="送模型" /><Flag on={item.modelKept} label="模型留" /><Flag on={item.finalReturned} label="返回" /><Flag on={item.adapterReceived} label="接收" /></div></td>
          <td><span class={`badge ${item.decision === "returned" ? "ok" : "neutral"}`}>{item.decision === "returned" ? "保留" : "丢弃"}</span><p>{reasonName(item.reason)}</p></td>
        </tr>)}</tbody>
      </table></div>}
    </section>
  </div>;
}

function Stage({ label, value, accent = false }: { label: string; value: unknown; accent?: boolean }) {
  return <article class={accent ? "accent" : ""}><strong>{Number(value) || 0}</strong><span>{label}</span></article>;
}
function Flag({ on, label }: { on: boolean; label: string }) { return <span class={on ? "on" : ""}>{on ? "✓" : "·"} {label}</span>; }
function tierName(tier: number): string { return tier === 1 ? "一级记忆（L1）" : tier === 2 ? "二级经验（L2）" : "三级世界模型（L3）"; }
function entityHref(kind: string, id: string): string {
  const route = kind === "trace" ? "traces" : kind === "experience" ? "policies" : kind === "skill" ? "skills" : kind === "world-model" ? "world" : kind === "episode" ? "episodes" : "traces";
  return `#/${route}?id=${encodeURIComponent(id)}`;
}
function reasonName(reason: unknown): string {
  const value = String(reason ?? "");
  const names: Record<string, string> = {
    below_relative_threshold: "低于相对阈值",
    rank_diversity_or_keyword_limit: "排名、多样性或关键词确认阶段淘汰",
    relevance_model_dropped: "相关性模型判定不相关",
    final_relevance_model_dropped: "合并本地与共享候选后由相关性模型丢弃",
    relevance_model_kept: "相关性模型保留",
    final_relevance_model_kept: "合并候选后由相关性模型保留",
    covered_or_deduplicated_before_packet: "被更高层对象覆盖或去重",
    model_failed_fallback_returned: "相关性模型失败，安全降级后返回",
    safe_fallback_cutoff: "相关性模型失败，安全阈值淘汰",
  };
  return names[value] ?? (value.replaceAll("_", " ") || "未记录");
}

function graphCount(run: any): number | null {
  const value = run?.detail?.lineageGraph?.candidateCount;
  const number = Number(value);
  return value == null || !Number.isFinite(number) ? null : number;
}
