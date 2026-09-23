export interface RetrievalCandidateView {
  id?: string | number;
  refKind?: string;
  refId?: string;
  summary?: string;
  finalReturned?: boolean;
  finalRank?: number | null;
  score?: number;
  detail?: unknown;
}

export interface LineagePathDetail {
  provenance: string;
  evidenceRef: string;
  seed: string;
  seedChannels: string[];
  hops: number;
  path: string[];
  edgePath: string[];
  score: number;
}

export interface RetrievalGraphPath {
  id: string;
  candidate: RetrievalCandidateView;
  lineage: LineagePathDetail;
  targetKey: string;
}

export interface RetrievalGraphNode {
  key: string;
  kind: string;
  refId: string;
  summary: string;
  isSeed: boolean;
  isReturned: boolean;
  candidatePathIds: string[];
}

export interface RetrievalGraphEdge {
  id: string;
  from: string;
  to: string;
  relationship: string;
  candidatePathIds: string[];
}

export interface RetrievalGraphModel {
  nodes: RetrievalGraphNode[];
  edges: RetrievalGraphEdge[];
  paths: RetrievalGraphPath[];
}

interface MutableNode extends RetrievalGraphNode {
  pathIds: Set<string>;
}

interface MutableEdge extends RetrievalGraphEdge {
  pathIds: Set<string>;
}

export function candidateChannels(candidate: RetrievalCandidateView): string[] {
  const detail = record(candidate.detail);
  return stringArray(detail.channels);
}

export function candidatePathId(candidate: RetrievalCandidateView): string {
  if (candidate.id != null) return String(candidate.id);
  return `${String(candidate.refKind ?? "candidate")}:${String(candidate.refId ?? "unknown")}`;
}

export function lineagePath(candidate: RetrievalCandidateView): LineagePathDetail | null {
  const graph = record(record(candidate.detail).lineageGraph);
  const path = stringArray(graph.path);
  if (path.length === 0) return null;
  const edgePath = stringArray(graph.edgePath).slice(0, Math.max(0, path.length - 1));
  const seedChannels = stringArray(graph.seedChannels);
  return {
    provenance: text(graph.provenance) || "pigmemory_storage",
    evidenceRef: text(graph.evidenceRef),
    seed: text(graph.seed) || path[0]!,
    seedChannels,
    hops: finiteNumber(graph.hops, edgePath.length),
    path,
    edgePath,
    score: finiteNumber(graph.score, 0),
  };
}

export function buildRetrievalGraph(
  candidates: readonly RetrievalCandidateView[],
): RetrievalGraphModel {
  const paths: RetrievalGraphPath[] = [];
  const nodes = new Map<string, MutableNode>();
  const edges = new Map<string, MutableEdge>();

  for (const candidate of candidates) {
    const lineage = lineagePath(candidate);
    if (!lineage) continue;
    const id = candidatePathId(candidate);
    const targetKey = lineage.path[lineage.path.length - 1]!;
    paths.push({ id, candidate, lineage, targetKey });

    for (const key of lineage.path) {
      const parsed = parseNodeKey(key);
      const existing = nodes.get(key);
      const targetSummary = key === targetKey ? String(candidate.summary ?? "").trim() : "";
      if (existing) {
        existing.isSeed ||= key === lineage.seed;
        existing.isReturned ||= key === targetKey && candidate.finalReturned === true;
        if (!existing.summary && targetSummary) existing.summary = targetSummary;
        existing.pathIds.add(id);
      } else {
        nodes.set(key, {
          key,
          kind: parsed.kind,
          refId: parsed.refId,
          summary: targetSummary,
          isSeed: key === lineage.seed,
          isReturned: key === targetKey && candidate.finalReturned === true,
          candidatePathIds: [],
          pathIds: new Set([id]),
        });
      }
    }

    for (let index = 0; index < lineage.path.length - 1; index += 1) {
      const from = lineage.path[index]!;
      const to = lineage.path[index + 1]!;
      const relationship = lineage.edgePath[index] ?? "RELATED";
      const edgeId = retrievalGraphEdgeId(from, to, relationship);
      const existing = edges.get(edgeId);
      if (existing) {
        existing.pathIds.add(id);
      } else {
        edges.set(edgeId, {
          id: edgeId,
          from,
          to,
          relationship,
          candidatePathIds: [],
          pathIds: new Set([id]),
        });
      }
    }
  }

  return {
    paths,
    nodes: [...nodes.values()]
      .map(({ pathIds, ...node }) => ({ ...node, candidatePathIds: [...pathIds] }))
      .sort((a, b) => nodeLane(a.kind) - nodeLane(b.kind) || a.key.localeCompare(b.key)),
    edges: [...edges.values()]
      .map(({ pathIds, ...edge }) => ({ ...edge, candidatePathIds: [...pathIds] }))
      .sort((a, b) => a.id.localeCompare(b.id)),
  };
}

export function retrievalGraphEdgeId(
  from: string,
  to: string,
  relationship: string,
): string {
  const pair = [from, to].sort();
  return `${pair[0]}|${relationship}|${pair[1]}`;
}

export function parseNodeKey(key: string): { kind: string; refId: string } {
  const separator = key.indexOf(":");
  if (separator < 0) return { kind: "unknown", refId: key };
  return { kind: key.slice(0, separator), refId: key.slice(separator + 1) };
}

export function nodeLane(kind: string): number {
  if (kind === "policy") return 1;
  if (kind === "world-model") return 2;
  if (kind === "skill") return 3;
  return 0;
}

export function retrievalChannelLabel(channel: string): string {
  const labels: Record<string, string> = {
    vec: "向量",
    vec_summary: "摘要向量",
    vec_action: "行动向量",
    fts: "全文检索",
    pattern: "模式匹配",
    structural: "结构召回",
    graph: "关系图",
    lexical: "图内词法",
  };
  return labels[channel] ?? channel.replaceAll("_", " ");
}

export function graphNodeKindLabel(kind: string): string {
  const labels: Record<string, string> = {
    trace: "记忆 Trace",
    episode: "任务 Episode",
    "decision-repair": "决策修复",
    policy: "策略 Policy",
    "world-model": "世界模型 L3",
    skill: "技能 Skill",
  };
  return labels[kind] ?? kind.replaceAll("-", " ");
}

export function graphRelationshipLabel(relationship: string): string {
  const labels: Record<string, string> = {
    HAS_TRACE: "包含记忆",
    POSITIVE_EVIDENCE: "正向证据",
    NEGATIVE_EVIDENCE: "反向证据",
    SUPPORTS: "支撑策略",
    EPISODE_SUPPORTS: "任务支撑",
    ABSTRACTED_INTO: "抽象形成",
    CRYSTALLIZED_AS: "结晶为技能",
    GROUNDED_IN: "依据模型",
    SUPERSEDES: "取代旧技能",
    RELATED: "有关联",
  };
  return labels[relationship] ?? relationship.replaceAll("_", " ").toLowerCase();
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string" && item.length > 0);
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function finiteNumber(value: unknown, fallback: number): number {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}
