import { useEffect, useState } from "preact/hooks";

import { api, dayInShanghai, duration, time } from "../api.js";
import { componentNames, term } from "../terms.js";

export function OverviewPage() {
  const [data, setData] = useState<any>(null);
  const [overview, setOverview] = useState<any>(null);
  const [error, setError] = useState("");

  const load = async () => {
    try {
      const [monitor, counts] = await Promise.all([
        api("/api/v1/monitor/summary"),
        api("/api/v1/overview"),
      ]);
      setData(monitor);
      setOverview(counts);
      setError("");
    } catch (err) { setError(err instanceof Error ? err.message : String(err)); }
  };
  useEffect(() => {
    void load();
    const timer = setInterval(load, 10_000);
    return () => clearInterval(timer);
  }, []);

  if (!data) return <Loading error={error} />;
  const status = data.status ?? "degraded";
  const components = Object.entries(data.components ?? {});
  const counts = [
    ["记忆（Trace）", overview?.traces ?? 0],
    ["任务片段（Episode）", overview?.episodes ?? 0],
    ["策略（Policy）", overview?.policies?.total ?? 0],
    ["技能（Skill）", overview?.skills?.total ?? 0],
    ["世界模型（World Model）", overview?.worldModels ?? 0],
  ];

  return <div class="page-stack">
    {error && <div class="notice error">刷新失败：{error}</div>}
    <section class={`health-hero status-${status}`}>
      <div>
        <span class="eyebrow">总体健康状态</span>
        <h2><span class="pulse" />{term(status)}</h2>
        <p>{healthCopy(status)}</p>
      </div>
      <div class="hero-meta">
        <span>近 24 小时</span>
        <strong>{Number(data.warningCount ?? 0) + Number(data.errorCount ?? 0)}</strong>
        <small>个警告或错误操作</small>
      </div>
    </section>

    <section>
      <div class="section-heading"><div><span class="eyebrow">Runtime</span><h2>运行组件</h2></div><span>每 10 秒刷新</span></div>
      <div class="component-grid">
        {components.map(([key, value]: [string, any]) => <article class="component-card">
          <div class="component-title"><span class={`status-dot ${value.status}`} /><strong>{componentNames[key] ?? key}</strong></div>
          <div class="component-status">{statusTerm(value.status)}</div>
          {(value.provider || value.model) && <p class="mono muted">{[value.provider, value.model].filter(Boolean).join(" / ")}</p>}
          <dl>
            <div><dt>最后成功</dt><dd>{time(value.lastSuccessAt)}</dd></div>
            <div><dt>运行时长</dt><dd>{duration(value.uptimeMs)}</dd></div>
          </dl>
          {value.lastError && <a class="component-error" href={`#/logs?session=__all__&level=${value.status === "warning" ? "warn" : "error"}`}>{value.lastError}</a>}
        </article>)}
      </div>
    </section>

    <section>
      <div class="section-heading"><div><span class="eyebrow">Storage</span><h2>当前数据</h2></div></div>
      <div class="count-grid">
        {counts.map(([label, value]) => <article><strong>{value}</strong><span>{label}</span></article>)}
      </div>
    </section>

    <section class="issues-section">
      <div class="section-heading">
        <div><span class="eyebrow">Last 24 hours</span><h2>当前问题与近 24 小时警告/错误</h2></div>
        <div class="issue-actions">
          <a href={recentRangeHref("warn")}>{term("warning")} {data.warningCount ?? 0} 个操作{Number(data.warningDetailCount ?? 0) !== Number(data.warningCount ?? 0) ? ` / ${data.warningDetailCount} 条明细` : ""}</a>
          <a href={recentRangeHref("error")}>{term("error")} {data.errorCount ?? 0}</a>
        </div>
      </div>
      {(data.recentIssues ?? []).length === 0
        ? <div class="empty">近 24 小时没有结构化警告或错误。</div>
        : <div class="issue-list">{data.recentIssues.map((issue: any) => <a
          href={issueHref(issue)}
        >
          <span class={`badge ${issue.level}`}>{statusTerm(issue.level)}</span>
          <strong>{issue.toolName}</strong>
          <span>{issueSummary(issue)}</span>
          <time>{time(issue.calledAt)}</time>
        </a>)}</div>}
    </section>
  </div>;
}

function healthCopy(status: string): string {
  if (status === "healthy") return "核心、数据库、桥接与必要组件运行正常。";
  if (status === "fault") return "存在当前故障；请从下方组件或日志进入排查。";
  return "系统仍可用，但有模型回退、桥接重连、向量降级或组件警告。";
}

function statusTerm(status: unknown): string {
  const value = String(status ?? "unknown");
  return ({
    ok: "正常",
    idle: "待首次验证",
    warning: "警告",
    error: "错误",
    fatal: "严重错误",
    warn: "警告",
    unknown: "未知",
  } as any)[value] ?? value;
}

function Loading({ error }: { error: string }) {
  return <div class="empty large">{error ? `无法加载监控摘要：${error}` : "正在读取监控摘要…"}</div>;
}

function issueHref(issue: any): string {
  const params = new URLSearchParams({
    date: dayInShanghai(issue.calledAt),
    session: issue.sessionId || "__all__",
    level: String(issue.level ?? ""),
    logId: String(issue.id ?? ""),
  });
  if (issue.category) params.set("category", issue.category);
  if (issue.episodeId) params.set("episodeId", issue.episodeId);
  return `#/logs?${params.toString()}`;
}

function recentRangeHref(level: string): string {
  const to = Date.now();
  const params = new URLSearchParams({
    session: "__all__",
    level,
    from: String(to - 24 * 60 * 60 * 1_000),
    to: String(to),
  });
  return `#/logs?${params.toString()}`;
}

function issueSummary(issue: any): string {
  if (issue.reason) return issue.reason;
  if (issue.toolName === "task_failed" && Number.isFinite(Number(issue.output?.rHuman))) {
    return `任务奖励为负（R_human=${Number(issue.output.rHuman).toFixed(3)}），评分来源 ${issue.output?.source || "未知"}`;
  }
  const warnings = Array.isArray(issue.output?.warnings) ? issue.output.warnings : [];
  if (warnings.length > 0) {
    const text = warnings.map((warning: any) => warning?.message || warning?.reason || warning?.error || warning?.stage).filter(Boolean).join("；");
    return `${warnings.length} 条警告：${text || "点击查看完整结构化警告"}`;
  }
  return issue.output?.message || issue.output?.error || "查看操作详情";
}
