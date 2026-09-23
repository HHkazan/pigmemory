import { useEffect, useState } from "preact/hooks";

import { api, time } from "../api.js";
import { term } from "../terms.js";

const entityKinds = [
  { key: "trace", label: "记忆 Trace", href: "#/traces", tone: "blue" },
  { key: "episode", label: "任务 Episode", href: "#/episodes", tone: "gold" },
  { key: "policy", label: "策略 Policy", href: "#/policies", tone: "coral" },
  { key: "world_model", label: "世界模型 L3", href: "#/world", tone: "teal" },
  { key: "skill", label: "技能 Skill", href: "#/skills", tone: "purple" },
] as const;

export function TodayChangesPage() {
  const [data, setData] = useState<any>(null);
  const [error, setError] = useState("");
  const load = async () => {
    try {
      setData(await api("/api/v1/monitor/today-changes"));
      setError("");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };
  useEffect(() => {
    void load();
    const timer = setInterval(load, 10_000);
    return () => clearInterval(timer);
  }, []);

  if (!data) return <div class="empty large">{error ? `无法加载今日变化：${error}` : "正在统计今天的记忆变化…"}</div>;
  const totals = data.totals ?? {};
  const hourly = data.hourly ?? [];
  const maxHourly = Math.max(1, ...hourly.map((row: any) => Number(row.created) + Number(row.activated)));
  return <div class="page-stack today-page">
    {error && <div class="notice error">刷新失败：{error}</div>}
    <section class="today-hero">
      <div class="today-copy">
        <span class="eyebrow">Since midnight · Asia/Shanghai</span>
        <h2>今天，呼呼猪整理了 <strong>{Number(totals.created) || 0}</strong> 份新记忆</h2>
        <p>统计范围从今天凌晨 00:00 到现在。新增量直接读取各实体创建时间；Active、归档和版本进化来自持久化生命周期事件。</p>
        <div class="today-range"><span>起点：{time(data.fromMs)}</span><span>更新至：{time(data.toMs)}</span><button onClick={load}>立即刷新</button></div>
      </div>
      <div class="today-pig-scene" aria-label="呼呼猪正在整理今天的记忆卡片">
        <span class="memory-float card-a" /><span class="memory-float card-b" /><span class="memory-float card-c" />
        <img src="/assets/huhu-pig-today-memory.png" alt="呼呼猪整理记忆卡片" />
      </div>
    </section>

    <section>
      <div class="section-heading"><div><span class="eyebrow">Today at a glance</span><h2>今日变化总计</h2></div><span>每 10 秒刷新</span></div>
      <div class="today-summary-grid">
        <TodayStat label="新增对象" value={totals.created} hint="按数据库创建时间" tone="created" />
        <TodayStat label="转为 Active" value={totals.activated} hint="不包含本来就是 Active" tone="active" />
        <TodayStat label="版本进化" value={totals.evolved} hint="内容版本发生变化" tone="evolved" />
        <TodayStat label="进入归档" value={totals.archived} hint="Active/Candidate → Archived" tone="archived" />
        <TodayStat label="发生变化的对象" value={totals.changed} hint={`${Number(totals.eventCount) || 0} 条生命周期事件`} tone="changed" />
      </div>
    </section>

    <section>
      <div class="section-heading"><div><span class="eyebrow">By memory layer</span><h2>各层分别发生了什么</h2></div></div>
      <div class="today-kind-grid">
        {entityKinds.map((kind) => {
          const row = data.byKind?.[kind.key] ?? {};
          return <a class={`today-kind-card ${kind.tone}`} href={kind.href}>
            <header><span>{kind.label}</span><strong>+{Number(row.created) || 0}</strong></header>
            <dl>
              <div><dt>新增</dt><dd>{Number(row.created) || 0}</dd></div>
              <div><dt>转 Active</dt><dd>{Number(row.activated) || 0}</dd></div>
              <div><dt>版本进化</dt><dd>{Number(row.evolved) || 0}</dd></div>
              <div><dt>归档</dt><dd>{Number(row.archived) || 0}</dd></div>
            </dl>
          </a>;
        })}
      </div>
    </section>

    <section>
      <div class="section-heading"><div><span class="eyebrow">Hourly rhythm</span><h2>从凌晨到现在的变化节奏</h2></div><div class="today-chart-legend"><span class="created">新增</span><span class="activated">转 Active</span></div></div>
      <div class="today-hour-chart">
        {hourly.map((row: any) => <div class="today-hour" title={`${padHour(row.hour)}:00 · 新增 ${row.created} · 转 Active ${row.activated}`}>
          <div class="today-hour-bars">
            <i class="created" style={`height:${barHeight(row.created, maxHourly)}%`} />
            <i class="activated" style={`height:${barHeight(row.activated, maxHourly)}%`} />
          </div>
          <strong>{Number(row.created) + Number(row.activated) || "·"}</strong>
          <span>{row.hour % 2 === 0 || row.hour === hourly.length - 1 ? `${padHour(row.hour)}时` : ""}</span>
        </div>)}
      </div>
    </section>

    <section>
      <div class="section-heading"><div><span class="eyebrow">Latest lifecycle events</span><h2>最近变化</h2></div><span>{(data.recent ?? []).length} 条</span></div>
      {(data.recent ?? []).length === 0 ? <div class="empty">今天还没有生命周期变化。呼呼猪正在等待新的记忆。</div> : <div class="today-event-list">
        {data.recent.map((event: any) => <a href={entityHref(event.entityKind, event.entityId)}>
          <span class={`today-event-kind ${event.entityKind}`}>{entityLabel(event.entityKind)}</span>
          <div><strong>{eventSummary(event)}</strong><small>{event.reason} · 来源 {event.source}</small></div>
          <time>{time(event.eventAt)}</time>
        </a>)}
      </div>}
    </section>
  </div>;
}

function TodayStat({ label, value, hint, tone }: { label: string; value: unknown; hint: string; tone: string }) {
  return <article class={`today-stat ${tone}`}><strong>{Number(value) || 0}</strong><span>{label}</span><small>{hint}</small></article>;
}

function barHeight(value: unknown, max: number): number {
  const n = Number(value) || 0;
  return n <= 0 ? 2 : Math.max(8, Math.round(n / max * 100));
}

function padHour(value: unknown): string {
  return String(Number(value) || 0).padStart(2, "0");
}

function entityLabel(kind: string): string {
  return entityKinds.find((item) => item.key === kind)?.label ?? kind;
}

function entityHref(kind: string, id: string): string {
  const route = ({ trace: "traces", episode: "episodes", policy: "policies", world_model: "world", skill: "skills" } as Record<string, string>)[kind] ?? "overview";
  return `#/${route}?id=${encodeURIComponent(id)}`;
}

function eventSummary(event: any): string {
  if (event.oldState == null) return `新增对象，初始状态为 ${term(event.newState)}`;
  if (event.newState === "active" && event.oldState !== "active") return `${term(event.oldState)} → 生效（Active）`;
  if (event.oldVersion != null && event.newVersion != null && event.oldVersion !== event.newVersion) {
    return `版本 ${event.oldVersion} → ${event.newVersion}，状态 ${term(event.newState)}`;
  }
  return `${term(event.oldState)} → ${term(event.newState)}`;
}
