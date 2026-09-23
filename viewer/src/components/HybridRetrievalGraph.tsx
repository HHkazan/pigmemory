import type { ComponentChildren } from "preact";
import { useMemo } from "preact/hooks";

import {
  buildRetrievalGraph,
  graphNodeKindLabel,
  graphRelationshipLabel,
  nodeLane,
  parseNodeKey,
  retrievalChannelLabel,
  retrievalGraphEdgeId,
  type RetrievalCandidateView,
  type RetrievalGraphModel,
  type RetrievalGraphNode,
  type RetrievalGraphPath,
} from "../retrieval-graph.js";

interface Props {
  run: any;
  candidates: RetrievalCandidateView[];
  selectedPathId?: string;
  onSelectPath: (id: string) => void;
}

const LANES = [
  { title: "原始证据", subtitle: "Trace / Episode / Repair" },
  { title: "归纳经验", subtitle: "Policy · L2" },
  { title: "世界模型", subtitle: "World Model · L3" },
  { title: "可执行技能", subtitle: "Skill · L1" },
];

export function HybridRetrievalVisualization({
  run,
  candidates,
  selectedPathId,
  onSelectPath,
}: Props) {
  const graph = useMemo(() => buildRetrievalGraph(candidates), [candidates]);
  const preferred = graph.paths.find((path) => path.id === selectedPathId)
    ?? graph.paths.find((path) => path.candidate.finalReturned)
    ?? graph.paths[0];
  const detail = asRecord(run.detail);
  const graphStats = asRecord(detail.lineageGraph);
  const channelHits = asNumberRecord(detail.channelHits);
  const graphMetricsRecorded = Object.keys(graphStats).length > 0;
  const graphEnabled = graphStats.enabled !== false && (graphMetricsRecorded || graph.paths.length > 0);
  const graphCandidateCount = numberOr(graphStats.candidateCount, graph.paths.length);
  const graphSeedCount = numberOr(graphStats.seedCount, uniqueSeeds(graph.paths));
  const graphLatency = numberOrNull(graphStats.latencyMs);
  const graphFallback = graphStats.fallback === true;
  const vectorHits = (channelHits.vec ?? 0) +
    (channelHits.vec_summary ?? 0) +
    (channelHits.vec_action ?? 0);

  return <>
    <section class="hybrid-overview">
      <div class="section-heading">
        <div><span class="eyebrow">Hybrid retrieval</span><h2>这次检索是怎样合并的</h2></div>
        <span class={`hybrid-status ${graphFallback ? "fallback" : graphEnabled ? "on" : "legacy"}`}>
          {graphFallback ? "Graph 已安全降级" : graphEnabled ? "Hybrid 已运行" : "旧记录 / 未记录 Graph"}
        </span>
      </div>
      <div class="hybrid-pipeline">
        <PipelineStage className="baseline" index="A" title="文本候选池" subtitle="现有 Baseline">
          <MetricPill label="向量" value={vectorHits} />
          <MetricPill label="全文" value={channelHits.fts ?? 0} />
          <MetricPill label="模式" value={channelHits.pattern ?? 0} />
          <MetricPill label="结构" value={channelHits.structural ?? 0} />
        </PipelineStage>
        <PipelineStage className={graphFallback ? "graph fallback" : "graph"} index="B" title="关系图扩展" subtitle="5 个种子 · 最多两跳">
          <MetricPill label="种子" value={graphSeedCount} />
          <MetricPill label="图候选" value={graphCandidateCount} />
          <MetricPill label="耗时" value={graphLatency == null ? "—" : `${graphLatency}ms`} />
        </PipelineStage>
        <PipelineStage className="fusion" index="1" title="统一融合排序" subtitle="RRF + MMR">
          <MetricPill label="候选" value={run.rawCandidateCount ?? detail.raw ?? candidates.length} />
          <MetricPill label="入围" value={detail.ranked ?? run.sentToModelCount ?? 0} />
          <MetricPill label="阈值淘汰" value={detail.droppedByThreshold ?? 0} />
        </PipelineStage>
        <PipelineStage className="filter" index="2" title="LLM 相关性过滤" subtitle={filterOutcomeLabel(asRecord(detail.llmFilter).outcome)}>
          <MetricPill label="送模型" value={run.sentToModelCount ?? 0} />
          <MetricPill label="保留" value={run.modelKeptCount ?? 0} />
          <MetricPill label="丢弃" value={Math.max(0, Number(run.sentToModelCount ?? 0) - Number(run.modelKeptCount ?? 0))} />
        </PipelineStage>
        <PipelineStage className="result" index="3" title="最终上下文" subtitle="去重并交给适配器">
          <MetricPill label="最终返回" value={run.finalReturnedCount ?? 0} />
          <MetricPill label="适配器接收" value={run.adapterReceivedCount ?? 0} />
        </PipelineStage>
      </div>
      <p class="hybrid-explanation">A、B 两路只负责提供候选；它们在第 1 步进入同一个排名池。Graph 不直接写答案，最终仍要经过统一排序、去重和相关性过滤。</p>
    </section>

    <section id="hybrid-evidence" class="hybrid-evidence-section">
      <div class="section-heading">
        <div><span class="eyebrow">Evidence lineage</span><h2>Graph 证据路径</h2></div>
        <span>{graph.paths.length} 个图候选 · {graph.nodes.length} 个证据节点</span>
      </div>
      {graph.paths.length === 0
        ? <div class="graph-empty">
            <strong>本次运行没有可展示的 Graph 路径</strong>
            <p>{graphMetricsRecorded && graphStats.enabled === false
              ? "这次检索明确关闭了关系图通道。"
              : "这通常表示它是 Hybrid 上线前的旧记录，或本次 Graph 没有找到合格候选。新检索命中后会在这里显示种子、关系边和原始证据。"}</p>
          </div>
        : <>
            <div class="graph-candidate-tabs" aria-label="选择图候选">
              {graph.paths.map((path) => <button
                type="button"
                class={`${path.id === preferred?.id ? "active" : ""} ${path.candidate.finalReturned ? "returned" : ""}`}
                onClick={() => onSelectPath(path.id)}
                title={String(path.candidate.summary ?? "")}
              >
                <span>{path.candidate.finalRank ? `返回 #${path.candidate.finalRank}` : "候选"}</span>
                <strong>{graphNodeKindLabel(parseNodeKey(path.targetKey).kind)}</strong>
                <small>{shortId(parseNodeKey(path.targetKey).refId)}</small>
              </button>)}
            </div>
            <GraphCanvas graph={graph} activePath={preferred} onSelectPath={onSelectPath} />
            {preferred && <PathInspector path={preferred} />}
          </>}
    </section>
  </>;
}

function PipelineStage({
  className,
  index,
  title,
  subtitle,
  children,
}: {
  className: string;
  index: string;
  title: string;
  subtitle: string;
  children: ComponentChildren;
}) {
  return <article class={`hybrid-stage ${className}`}>
    <header><span>{index}</span><div><strong>{title}</strong><small>{subtitle}</small></div></header>
    <div class="hybrid-stage-metrics">{children}</div>
  </article>;
}

function MetricPill({ label, value }: { label: string; value: unknown }) {
  return <div><strong>{value == null || value === "" ? "—" : String(value)}</strong><span>{label}</span></div>;
}

function GraphCanvas({
  graph,
  activePath,
  onSelectPath,
}: {
  graph: RetrievalGraphModel;
  activePath?: RetrievalGraphPath;
  onSelectPath: (id: string) => void;
}) {
  const layout = graphLayout(graph.nodes);
  const activeNodes = new Set(activePath?.lineage.path ?? []);
  const activeEdges = new Set<string>();
  if (activePath) {
    for (let index = 0; index < activePath.lineage.path.length - 1; index += 1) {
      activeEdges.add(retrievalGraphEdgeId(
        activePath.lineage.path[index]!,
        activePath.lineage.path[index + 1]!,
        activePath.lineage.edgePath[index] ?? "RELATED",
      ));
    }
  }

  const selectNode = (node: RetrievalGraphNode) => {
    const path = node.candidatePathIds
      .map((id) => graph.paths.find((item) => item.id === id))
      .filter((item): item is RetrievalGraphPath => Boolean(item))
      .sort((a, b) => Number(b.candidate.finalReturned) - Number(a.candidate.finalReturned))[0];
    if (path) onSelectPath(path.id);
  };

  return <div class="hybrid-graph-scroll">
    <svg
      class="hybrid-graph-canvas"
      viewBox={`0 0 ${layout.width} ${layout.height}`}
      width={layout.width}
      height={layout.height}
      role="img"
      aria-label="本次 Hybrid 检索使用的 PigMemory 证据关系图"
    >
      {LANES.map((lane, index) => <g class="graph-lane">
        <rect x={layout.laneX(index)} y="8" width={layout.laneWidth - 18} height={layout.height - 16} rx="16" />
        <text x={layout.laneX(index) + 16} y="32" class="lane-title">{lane.title}</text>
        <text x={layout.laneX(index) + 16} y="49" class="lane-subtitle">{lane.subtitle}</text>
      </g>)}
      <g class="graph-edges">
        {graph.edges.map((edge) => {
          const from = layout.positions.get(edge.from);
          const to = layout.positions.get(edge.to);
          if (!from || !to) return null;
          const active = activeEdges.has(edge.id);
          const midpoint = edgeMidpoint(from, to);
          return <g class={active ? "active" : "dim"}>
            <path d={edgeCurve(from, to)} />
            {active && <>
              <rect x={midpoint.x - 43} y={midpoint.y - 10} width="86" height="20" rx="10" />
              <text x={midpoint.x} y={midpoint.y + 3}>{graphRelationshipLabel(edge.relationship)}</text>
            </>}
          </g>;
        })}
      </g>
      <g class="graph-nodes">
        {graph.nodes.map((node) => {
          const position = layout.positions.get(node.key)!;
          const active = activeNodes.has(node.key);
          return <g
            class={`hybrid-graph-node lane-${nodeLane(node.kind)} ${active ? "active" : ""} ${node.isSeed ? "seed" : ""} ${node.isReturned ? "returned" : ""}`}
            transform={`translate(${position.x}, ${position.y})`}
            role="button"
            tabIndex={0}
            onClick={() => selectNode(node)}
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === " ") selectNode(node);
            }}
          >
            <title>{`${graphNodeKindLabel(node.kind)} · ${node.summary || node.refId}`}</title>
            <rect width={layout.nodeWidth} height={layout.nodeHeight} rx="12" />
            <circle cx="16" cy="18" r="5" />
            <text x="28" y="22" class="node-kind">{graphNodeKindLabel(node.kind)}</text>
            <text x="14" y="43" class="node-summary">{shortText(node.summary || node.refId, 28)}</text>
            {node.isSeed && <text x={layout.nodeWidth - 12} y="20" textAnchor="end" class="node-state">种子</text>}
            {node.isReturned && <text x={layout.nodeWidth - 12} y="44" textAnchor="end" class="node-returned">✓ 返回</text>}
          </g>;
        })}
      </g>
    </svg>
  </div>;
}

function PathInspector({ path }: { path: RetrievalGraphPath }) {
  const channels = path.lineage.seedChannels.map(retrievalChannelLabel);
  return <div class="graph-path-inspector">
    <header>
      <div><span class="eyebrow">Selected evidence path</span><strong>{path.candidate.finalReturned ? `最终返回 #${path.candidate.finalRank ?? "—"}` : "进入统一候选池但未最终返回"}</strong></div>
      <div class="path-score"><span>Graph 分数</span><strong>{path.lineage.score.toFixed(4)}</strong></div>
    </header>
    <div class="graph-evidence-trail">
      {path.lineage.path.map((key, index) => {
        const node = parseNodeKey(key);
        const content = <><strong>{graphNodeKindLabel(node.kind)}</strong><code>{node.refId}</code>{index === 0 && <em>种子 · {channels.join(" + ") || "图内词法"}</em>}</>;
        return <>
          {index > 0 && <div class="trail-edge"><span>{graphRelationshipLabel(path.lineage.edgePath[index - 1] ?? "RELATED")}</span><b>→</b></div>}
          {nodeHref(node.kind, node.refId)
            ? <a class={index === path.lineage.path.length - 1 ? "target" : ""} href={nodeHref(node.kind, node.refId)!}>{content}</a>
            : <div class={index === path.lineage.path.length - 1 ? "trail-node target" : "trail-node"}>{content}</div>}
        </>;
      })}
    </div>
    <footer><span>证据锚点：<code>{path.lineage.evidenceRef || "—"}</code></span><span>{path.lineage.hops} 跳 · 来源 {path.lineage.provenance}</span></footer>
  </div>;
}

function graphLayout(nodes: RetrievalGraphNode[]) {
  const laneWidth = 285;
  const nodeWidth = 230;
  const nodeHeight = 58;
  const laneGroups = LANES.map((_, lane) => nodes.filter((node) => nodeLane(node.kind) === lane));
  const maxNodes = Math.max(1, ...laneGroups.map((items) => items.length));
  const width = laneWidth * LANES.length + 20;
  const height = Math.max(330, 78 + maxNodes * 78);
  const laneX = (lane: number) => 10 + lane * laneWidth;
  const positions = new Map<string, { x: number; y: number; lane: number }>();
  laneGroups.forEach((items, lane) => {
    items.forEach((node, index) => {
      positions.set(node.key, { x: laneX(lane) + 18, y: 68 + index * 78, lane });
    });
  });
  return { width, height, laneWidth, nodeWidth, nodeHeight, laneX, positions };
}

function edgeCurve(
  from: { x: number; y: number; lane: number },
  to: { x: number; y: number; lane: number },
): string {
  const nodeWidth = 230;
  const nodeHeight = 58;
  const fromX = from.x + nodeWidth / 2;
  const fromY = from.y + nodeHeight / 2;
  const toX = to.x + nodeWidth / 2;
  const toY = to.y + nodeHeight / 2;
  if (from.lane === to.lane) {
    const bend = fromX + (fromY < toY ? 120 : -120);
    return `M ${fromX} ${fromY} C ${bend} ${fromY}, ${bend} ${toY}, ${toX} ${toY}`;
  }
  if (Math.abs(from.lane - to.lane) > 1) {
    const controlY = Math.max(58, Math.min(fromY, toY) - 48);
    return `M ${fromX} ${fromY} C ${fromX} ${controlY}, ${toX} ${controlY}, ${toX} ${toY}`;
  }
  const midX = (fromX + toX) / 2;
  return `M ${fromX} ${fromY} C ${midX} ${fromY}, ${midX} ${toY}, ${toX} ${toY}`;
}

function edgeMidpoint(
  from: { x: number; y: number; lane: number },
  to: { x: number; y: number; lane: number },
): { x: number; y: number } {
  const x = (from.x + to.x) / 2 + 115;
  const y = (from.y + to.y) / 2 + 29;
  if (Math.abs(from.lane - to.lane) > 1) return { x, y: Math.max(58, Math.min(from.y, to.y) + 5) };
  return from.lane === to.lane ? { x: x + 70, y } : { x, y };
}

function nodeHref(kind: string, id: string): string | null {
  const route = kind === "trace"
    ? "traces"
    : kind === "episode"
      ? "episodes"
      : kind === "policy"
        ? "policies"
        : kind === "world-model"
          ? "world"
          : kind === "skill"
            ? "skills"
            : null;
  return route ? `#/${route}?id=${encodeURIComponent(id)}` : null;
}

function uniqueSeeds(paths: RetrievalGraphPath[]): number {
  return new Set(paths.map((path) => path.lineage.seed)).size;
}

function filterOutcomeLabel(value: unknown): string {
  const labels: Record<string, string> = {
    llm_kept_all: "模型全部保留",
    llm_filtered: "模型已筛选",
    llm_filtered_refilled: "筛选后补足",
    llm_failed_safe_cutoff: "模型失败 · 安全降级",
    disabled: "已关闭",
    no_llm: "无可用模型",
    below_threshold: "候选不足，未调用",
    skipped_by_scheduler: "调度器跳过",
    deferred_to_final: "延后到最终合并",
  };
  return labels[String(value ?? "")] ?? "按相关性保留";
}

function shortText(value: string, length: number): string {
  const compact = value.replace(/\s+/g, " ").trim();
  return compact.length > length ? `${compact.slice(0, length - 1)}…` : compact;
}

function shortId(value: string): string {
  return value.length > 18 ? `${value.slice(0, 8)}…${value.slice(-6)}` : value;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function asNumberRecord(value: unknown): Record<string, number> {
  return Object.fromEntries(
    Object.entries(asRecord(value))
      .map(([key, item]) => [key, Number(item)] as const)
      .filter((entry) => Number.isFinite(entry[1])),
  );
}

function numberOr(value: unknown, fallback: number): number {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function numberOrNull(value: unknown): number | null {
  const number = Number(value);
  return value == null || !Number.isFinite(number) ? null : number;
}
