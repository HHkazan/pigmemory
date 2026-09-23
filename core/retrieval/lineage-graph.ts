/**
 * Deterministic PigMemory evolution-graph retrieval.
 *
 * This module does not extract entities or invent relationships. It follows
 * only relationships already persisted by PigMemory (Trace → Policy → World
 * Model / Skill, plus Episode and Decision Repair evidence), then contributes
 * those rows as one extra `graph` channel to the normal ranker. The traversal
 * is deliberately bounded and query-local: five seeds, two hops, twenty
 * candidates. Nothing is persisted and every result names its storage path in
 * `candidate.debug.lineageGraph`.
 */

import type { EpisodeId, SessionId } from "../../agent-contract/dto.js";
import type {
  EmbeddingVector,
  PolicyId,
  SkillId,
  TraceId,
  WorldModelId,
} from "../types.js";
import type {
  DecisionRepairCandidate,
  EpisodeCandidate,
  ExperienceCandidate,
  RetrievalConfig,
  RetrievalRepos,
  SkillCandidate,
  TierCandidate,
  TraceCandidate,
  WorldModelCandidate,
} from "./types.js";

const MAX_SEEDS = 5;
const MAX_HOPS = 2;
const MAX_CANDIDATES = 20;
const MAX_NEIGHBORS = 40;
const PATH_DECAY = 0.94;

const EDGE_WEIGHTS = {
  HAS_TRACE: 0.76,
  POSITIVE_EVIDENCE: 0.96,
  NEGATIVE_EVIDENCE: 0.93,
  SUPPORTS: 1,
  EPISODE_SUPPORTS: 0.87,
  ABSTRACTED_INTO: 0.96,
  CRYSTALLIZED_AS: 1,
  GROUNDED_IN: 0.96,
  SUPERSEDES: 0.94,
} as const;

type EdgeKind = keyof typeof EDGE_WEIGHTS;
type NodeKind =
  | "trace"
  | "episode"
  | "policy"
  | "skill"
  | "world-model"
  | "decision-repair";

type LineageRepo = NonNullable<RetrievalRepos["lineage"]>;
type GraphSkillRow = ReturnType<LineageRepo["listSkills"]>[number];
type GraphWorldRow = ReturnType<LineageRepo["listWorldModels"]>[number];
type GraphRepairRow = ReturnType<LineageRepo["listDecisionRepairs"]>[number];
type GraphEpisodeRow = NonNullable<ReturnType<LineageRepo["getEpisodeById"]>>;
type PoliciesRepo = NonNullable<RetrievalRepos["policies"]>;
type GraphPolicyRow = ReturnType<PoliciesRepo["list"]>[number];
type GraphTraceRow = ReturnType<RetrievalRepos["traces"]["getManyByIds"]>[number];

export interface LineageCandidateGroups {
  tier1: readonly SkillCandidate[];
  tier2Traces: readonly TraceCandidate[];
  tier2Episodes: readonly EpisodeCandidate[];
  tier2Experiences: readonly ExperienceCandidate[];
  tier3: readonly WorldModelCandidate[];
}

export interface LineageGraphResult {
  candidates: TierCandidate[];
  seedCount: number;
  latencyMs: number;
}

interface Seed {
  key: string;
  score: number;
  channels: string[];
}

interface PathState {
  key: string;
  hops: number;
  score: number;
  path: string[];
  edges: EdgeKind[];
  seed: Seed;
}

interface BestPath {
  score: number;
  path: string[];
  edges: EdgeKind[];
  seed: Seed;
}

interface Neighbor {
  key: string;
  edge: EdgeKind;
}

interface LexicalDocument {
  key: string;
  text: string;
}

export function runLineageGraph(input: {
  queryText: string;
  repos: RetrievalRepos;
  config: RetrievalConfig;
  baseline: LineageCandidateGroups;
  now: number;
  includeLowValue?: boolean;
  includeCandidatePolicies?: boolean;
  excludeSessionId?: SessionId;
}): LineageGraphResult {
  const startedAt = Date.now();
  const lineage = input.repos.lineage;
  const policiesRepo = input.repos.policies;
  if (!lineage || !policiesRepo || !input.queryText.trim()) {
    return { candidates: [], seedCount: 0, latencyMs: Date.now() - startedAt };
  }

  const baselineCandidates = flattenBaseline(input.baseline);
  const baselineByNode = new Map<string, TierCandidate>();
  for (const candidate of baselineCandidates) {
    const key = nodeKeyForCandidate(candidate);
    if (key) baselineByNode.set(key, candidate);
  }

  const policies = policiesRepo.list();
  const skills = lineage.listSkills();
  const worlds = lineage.listWorldModels();
  const repairs = lineage.listDecisionRepairs();
  const policyById = new Map(policies.map((row) => [row.id, row]));
  const skillById = new Map(skills.map((row) => [row.id, row]));
  const worldById = new Map(worlds.map((row) => [row.id, row]));
  const repairById = new Map(repairs.map((row) => [row.id, row]));

  const skillsByPolicy = multiIndex(skills, (row) => row.sourcePolicyIds);
  const skillsByWorld = multiIndex(skills, (row) => row.sourceWorldModelIds);
  const supersedingSkills = multiIndex(
    skills.filter((row) => row.supersedesSkillId),
    (row) => row.supersedesSkillId ? [row.supersedesSkillId] : [],
  );
  const worldsByPolicy = multiIndex(worlds, (row) => row.policyIds);
  const worldsByEpisode = multiIndex(worlds, (row) => row.sourceEpisodeIds);
  const policiesByEpisode = multiIndex(policies, (row) => row.sourceEpisodeIds);
  const repairsByTrace = new Map<string, GraphRepairRow[]>();
  for (const repair of repairs) {
    for (const traceId of [...repair.highValueTraceIds, ...repair.lowValueTraceIds]) {
      appendIndex(repairsByTrace, traceId, repair);
    }
  }

  const traceCache = new Map<string, GraphTraceRow | null>();
  const episodeCache = new Map<string, GraphEpisodeRow | null>();
  const getTrace = (id: TraceId): GraphTraceRow | null => {
    if (traceCache.has(id)) return traceCache.get(id) ?? null;
    const row = input.repos.traces.getManyByIds([id])[0] ?? null;
    traceCache.set(id, row);
    return row;
  };
  const getEpisode = (id: EpisodeId): GraphEpisodeRow | null => {
    if (episodeCache.has(id)) return episodeCache.get(id) ?? null;
    const row = lineage.getEpisodeById(id);
    episodeCache.set(id, row);
    return row;
  };

  const hydrate = (key: string): TierCandidate | null => {
    const baseline = baselineByNode.get(key);
    if (baseline) return baseline;
    const { kind, id } = parseNodeKey(key);
    switch (kind) {
      case "trace": {
        const row = getTrace(id as TraceId);
        return row ? traceCandidate(row) : null;
      }
      case "episode": {
        const row = getEpisode(id as EpisodeId);
        return row ? episodeCandidate(row, getTrace) : null;
      }
      case "policy": {
        const row = policyById.get(id);
        return row ? policyCandidate(row, input.now) : null;
      }
      case "skill": {
        const row = skillById.get(id as SkillId);
        return row ? skillCandidate(row, policyById) : null;
      }
      case "world-model": {
        const row = worldById.get(id as WorldModelId);
        return row ? worldCandidate(row) : null;
      }
      case "decision-repair": {
        const row = repairById.get(id);
        return row ? repairCandidate(row) : null;
      }
    }
  };

  const neighbors = (key: string): Neighbor[] => {
    const { kind, id } = parseNodeKey(key);
    const out = new Map<string, Neighbor>();
    const add = (neighborKey: string, edge: EdgeKind) => {
      if (!neighborKey || neighborKey === key) return;
      const current = out.get(neighborKey);
      if (!current || EDGE_WEIGHTS[edge] > EDGE_WEIGHTS[current.edge]) {
        out.set(neighborKey, { key: neighborKey, edge });
      }
    };

    if (kind === "trace") {
      const traceId = id as TraceId;
      const row = getTrace(traceId);
      if (row) add(nodeKey("episode", row.episodeId), "HAS_TRACE");
      for (const policyId of lineage.getPolicyIdsForTrace(traceId)) {
        add(nodeKey("policy", policyId), "SUPPORTS");
      }
      if (row) {
        for (const policyId of lineage.getPolicyIdsForEpisode(row.episodeId)) {
          add(nodeKey("policy", policyId), "SUPPORTS");
        }
        for (const policy of policiesByEpisode.get(row.episodeId) ?? []) {
          add(nodeKey("policy", policy.id), "EPISODE_SUPPORTS");
        }
      }
      for (const repair of repairsByTrace.get(traceId) ?? []) {
        const positive = repair.highValueTraceIds.includes(traceId);
        add(
          nodeKey("decision-repair", repair.id),
          positive ? "POSITIVE_EVIDENCE" : "NEGATIVE_EVIDENCE",
        );
      }
    } else if (kind === "episode") {
      const episodeId = id as EpisodeId;
      const row = getEpisode(episodeId);
      for (const traceId of row?.traceIds ?? []) {
        add(nodeKey("trace", traceId), "HAS_TRACE");
      }
      for (const policyId of lineage.getPolicyIdsForEpisode(episodeId)) {
        add(nodeKey("policy", policyId), "EPISODE_SUPPORTS");
      }
      for (const policy of policiesByEpisode.get(episodeId) ?? []) {
        add(nodeKey("policy", policy.id), "EPISODE_SUPPORTS");
      }
      for (const world of worldsByEpisode.get(episodeId) ?? []) {
        add(nodeKey("world-model", world.id), "ABSTRACTED_INTO");
      }
    } else if (kind === "policy") {
      const policyId = id as PolicyId;
      const row = policyById.get(policyId);
      const traceIds = dedupe([
        ...(row?.sourceTraceIds ?? []),
        ...lineage.getTraceIdsForPolicy(policyId),
      ]);
      for (const traceId of traceIds) add(nodeKey("trace", traceId), "SUPPORTS");
      for (const episodeId of row?.sourceEpisodeIds ?? []) {
        add(nodeKey("episode", episodeId), "EPISODE_SUPPORTS");
      }
      for (const skill of skillsByPolicy.get(policyId) ?? []) {
        add(nodeKey("skill", skill.id), "CRYSTALLIZED_AS");
      }
      for (const world of worldsByPolicy.get(policyId) ?? []) {
        add(nodeKey("world-model", world.id), "ABSTRACTED_INTO");
      }
    } else if (kind === "skill") {
      const row = skillById.get(id as SkillId);
      for (const policyId of row?.sourcePolicyIds ?? []) {
        add(nodeKey("policy", policyId), "CRYSTALLIZED_AS");
      }
      for (const worldId of row?.sourceWorldModelIds ?? []) {
        add(nodeKey("world-model", worldId), "GROUNDED_IN");
      }
      for (const traceId of row?.evidenceAnchors ?? []) {
        add(nodeKey("trace", traceId), "SUPPORTS");
      }
      if (row?.supersedesSkillId) {
        add(nodeKey("skill", row.supersedesSkillId), "SUPERSEDES");
      }
      for (const successor of supersedingSkills.get(id) ?? []) {
        add(nodeKey("skill", successor.id), "SUPERSEDES");
      }
    } else if (kind === "world-model") {
      const row = worldById.get(id as WorldModelId);
      for (const policyId of row?.policyIds ?? []) {
        add(nodeKey("policy", policyId), "ABSTRACTED_INTO");
      }
      for (const skill of skillsByWorld.get(id) ?? []) {
        add(nodeKey("skill", skill.id), "GROUNDED_IN");
      }
      for (const episodeId of row?.sourceEpisodeIds ?? []) {
        add(nodeKey("episode", episodeId), "EPISODE_SUPPORTS");
      }
    } else if (kind === "decision-repair") {
      const row = repairById.get(id);
      for (const traceId of row?.highValueTraceIds ?? []) {
        add(nodeKey("trace", traceId), "POSITIVE_EVIDENCE");
      }
      for (const traceId of row?.lowValueTraceIds ?? []) {
        add(nodeKey("trace", traceId), "NEGATIVE_EVIDENCE");
      }
    }

    return [...out.values()]
      .sort((a, b) => EDGE_WEIGHTS[b.edge] - EDGE_WEIGHTS[a.edge] || a.key.localeCompare(b.key))
      .slice(0, MAX_NEIGHBORS);
  };

  const lexicalDocs: LexicalDocument[] = [];
  for (const candidate of baselineCandidates) {
    const key = nodeKeyForCandidate(candidate);
    if (key) lexicalDocs.push({ key, text: candidateText(candidate) });
  }
  for (const row of policies) {
    if (row.status !== "archived") {
      lexicalDocs.push({ key: nodeKey("policy", row.id), text: policyText(row) });
    }
  }
  for (const row of skills) {
    if (row.status !== "archived" && row.eta >= input.config.minSkillEta) {
      lexicalDocs.push({ key: nodeKey("skill", row.id), text: `${row.name}\n${row.invocationGuide}` });
    }
  }
  for (const row of worlds) {
    if (worldIsEligible(row, input.config)) {
      lexicalDocs.push({ key: nodeKey("world-model", row.id), text: `${row.title}\n${row.body}` });
    }
  }
  for (const row of repairs) {
    lexicalDocs.push({
      key: nodeKey("decision-repair", row.id),
      text: `Preference: ${row.preference}\nAnti-pattern: ${row.antiPattern}`,
    });
  }

  const lexical = bm25Scores(input.queryText, dedupeDocuments(lexicalDocs));
  const seedPool = new Map<string, Seed>();
  for (const document of dedupeDocuments(lexicalDocs)) {
    const candidate = baselineByNode.get(document.key);
    const baseScore = candidate ? bestChannelScore(candidate) : 0;
    const lexicalScore = lexical.get(document.key) ?? 0;
    if (baseScore <= 0 && lexicalScore <= 0) continue;
    const score = (
      Math.max(baseScore, 0.92 * lexicalScore) +
      0.08 * Math.min(baseScore, lexicalScore)
    ) * typeBoost(input.queryText, parseNodeKey(document.key).kind);
    seedPool.set(document.key, {
      key: document.key,
      score,
      channels: candidate
        ? [...new Set((candidate.channels ?? []).map((channel) => channel.channel))]
        : ["lexical"],
    });
  }
  const seeds = [...seedPool.values()]
    .sort((a, b) => b.score - a.score || a.key.localeCompare(b.key))
    .slice(0, MAX_SEEDS);

  const best = new Map<string, BestPath>();
  for (const seed of seeds) {
    const queue: PathState[] = [{
      key: seed.key,
      hops: 0,
      score: seed.score,
      path: [seed.key],
      edges: [],
      seed,
    }];
    const seen = new Map<string, number>([[seed.key, seed.score]]);
    while (queue.length > 0) {
      const state = queue.shift()!;
      const boostedScore = state.hops === 0
        ? state.score
        : state.score * typeBoost(input.queryText, parseNodeKey(state.key).kind);
      const current = best.get(state.key);
      if (!current || boostedScore > current.score) {
        best.set(state.key, {
          score: boostedScore,
          path: state.path,
          edges: state.edges,
          seed,
        });
      }
      if (state.hops >= MAX_HOPS) continue;
      for (const neighbor of neighbors(state.key)) {
        const score = state.score * EDGE_WEIGHTS[neighbor.edge] * PATH_DECAY;
        if (score <= (seen.get(neighbor.key) ?? -Infinity)) continue;
        seen.set(neighbor.key, score);
        queue.push({
          key: neighbor.key,
          hops: state.hops + 1,
          score,
          path: [...state.path, neighbor.key],
          edges: [...state.edges, neighbor.edge],
          seed,
        });
      }
    }
  }

  const rankedPaths = [...best.entries()]
    .sort((a, b) => b[1].score - a[1].score || a[0].localeCompare(b[0]));
  const candidates: TierCandidate[] = [];
  for (const [key, path] of rankedPaths) {
    if (candidates.length >= MAX_CANDIDATES) break;
    const candidate = hydrate(key);
    if (!candidate || !candidateIsEligible(candidate, input.config, {
      includeLowValue: input.includeLowValue === true,
      includeCandidatePolicies: input.includeCandidatePolicies === true,
      excludeSessionId: input.excludeSessionId,
      getTrace,
    })) continue;
    const graphScore = clamp01(path.score);
    candidates.push({
      ...candidate,
      channels: [
        ...(candidate.channels ?? []).filter((channel) => channel.channel !== "graph"),
        { channel: "graph", rank: candidates.length, score: graphScore },
      ],
      debug: {
        ...(candidate.debug ?? {}),
        lineageGraph: {
          provenance: "pigmemory_storage",
          evidenceRef: evidenceRef(key),
          seed: path.seed.key,
          seedChannels: path.seed.channels,
          hops: path.edges.length,
          path: path.path,
          edgePath: path.edges,
          score: graphScore,
        },
      },
    });
  }

  return {
    candidates,
    seedCount: seeds.length,
    latencyMs: Date.now() - startedAt,
  };
}

function flattenBaseline(input: LineageCandidateGroups): TierCandidate[] {
  return [
    ...input.tier1,
    ...input.tier2Traces,
    ...input.tier2Episodes,
    ...input.tier2Experiences,
    ...input.tier3,
  ];
}

function nodeKey(kind: NodeKind, id: string): string {
  return `${kind}:${id}`;
}

function parseNodeKey(key: string): { kind: NodeKind; id: string } {
  const separator = key.indexOf(":");
  return {
    kind: key.slice(0, separator) as NodeKind,
    id: key.slice(separator + 1),
  };
}

function nodeKeyForCandidate(candidate: TierCandidate): string | null {
  if (candidate.refKind === "experience") return nodeKey("policy", candidate.refId);
  if (candidate.refKind === "decision-repair") {
    return nodeKey("decision-repair", candidate.repairId);
  }
  return nodeKey(candidate.refKind, candidate.refId);
}

function evidenceRef(key: string): string {
  const { kind, id } = parseNodeKey(key);
  const table = kind === "world-model"
    ? "world_model"
    : kind === "decision-repair"
      ? "decision_repairs"
      : `${kind.replace("-", "_")}s`;
  return `${table}:${id}`;
}

function bestChannelScore(candidate: TierCandidate): number {
  let best = clamp01(candidate.cosine);
  for (const channel of candidate.channels ?? []) {
    best = Math.max(best, clamp01(channel.score));
  }
  return best;
}

function candidateIsEligible(
  candidate: TierCandidate,
  config: RetrievalConfig,
  opts: {
    includeLowValue: boolean;
    includeCandidatePolicies: boolean;
    excludeSessionId?: SessionId;
    getTrace: (id: TraceId) => GraphTraceRow | null;
  },
): boolean {
  if (candidate.refKind === "skill") {
    return candidate.status !== "archived" && candidate.eta >= config.minSkillEta;
  }
  if (candidate.refKind === "trace") {
    return (opts.includeLowValue || candidate.value >= 0) &&
      (!opts.excludeSessionId || candidate.sessionId !== opts.excludeSessionId);
  }
  if (candidate.refKind === "episode") {
    return !opts.excludeSessionId || candidate.sessionId !== opts.excludeSessionId;
  }
  if (candidate.refKind === "experience") {
    return candidate.status === "active" ||
      (candidate.status === "candidate" && opts.includeCandidatePolicies);
  }
  if (candidate.refKind === "decision-repair") {
    const evidence = opts.getTrace(candidate.refId);
    return Boolean(
      evidence &&
      (opts.includeLowValue || evidence.value >= 0) &&
      (!opts.excludeSessionId || evidence.sessionId !== opts.excludeSessionId),
    );
  }
  if (candidate.refKind === "world-model") {
    return candidate.confidence >= (config.minWorldConfidence ?? 0.2);
  }
  return true;
}

function worldIsEligible(row: GraphWorldRow, config: RetrievalConfig): boolean {
  return row.status === "active" &&
    !row.staleReason &&
    row.confidence >= (config.minWorldConfidence ?? 0.2);
}

function policyCandidate(row: GraphPolicyRow, now: number): ExperienceCandidate {
  const updatedAt = row.updatedAt ?? now;
  return {
    tier: "tier2",
    refKind: "experience",
    refId: row.id as PolicyId,
    cosine: 0,
    ts: updatedAt,
    vec: row.vec ?? null,
    channels: [],
    title: row.title,
    trigger: row.trigger ?? "",
    procedure: row.procedure ?? "",
    verification: row.verification ?? "",
    boundary: row.boundary ?? "",
    support: row.support ?? 1,
    gain: row.gain ?? 0,
    status: row.status ?? "candidate",
    experienceType: row.experienceType ?? "success_pattern",
    evidencePolarity: row.evidencePolarity ?? "positive",
    salience: row.salience ?? 0,
    confidence: row.confidence,
    skillEligible: row.skillEligible !== false,
    sourceEpisodeIds: row.sourceEpisodeIds ?? [],
    sourceFeedbackIds: row.sourceFeedbackIds ?? [],
    sourceTraceIds: row.sourceTraceIds ?? [],
    decisionGuidance: row.decisionGuidance,
    updatedAt,
  };
}

function skillCandidate(
  row: GraphSkillRow,
  policyById: ReadonlyMap<string, GraphPolicyRow>,
): SkillCandidate {
  const triggers = row.sourcePolicyIds
    .map((id) => policyById.get(id)?.trigger?.trim())
    .filter((value): value is string => Boolean(value));
  return {
    tier: "tier1",
    refKind: "skill",
    refId: row.id,
    cosine: 0,
    ts: row.updatedAt,
    vec: row.vec ?? null,
    channels: [],
    skillName: row.name,
    eta: row.eta,
    status: row.status,
    summary: skillSummary(row.procedureJson),
    trigger: [...new Set(triggers)].join(" / ") || undefined,
    invocationGuide: row.invocationGuide,
    decisionGuidance: row.decisionGuidance,
    sourcePolicyIds: row.sourcePolicyIds,
    updatedAt: row.updatedAt,
  };
}

function worldCandidate(row: GraphWorldRow): WorldModelCandidate {
  return {
    tier: "tier3",
    refKind: "world-model",
    refId: row.id,
    cosine: 0,
    ts: row.updatedAt,
    vec: row.vec ?? null,
    channels: [],
    title: row.title,
    body: row.body,
    policyIds: row.policyIds,
    confidence: row.confidence,
  };
}

function traceCandidate(row: GraphTraceRow): TraceCandidate {
  const vec = row.vecSummary ?? row.vecAction ?? null;
  return {
    tier: "tier2",
    refKind: "trace",
    refId: row.id,
    cosine: 0,
    ts: row.ts,
    vec,
    channels: [],
    value: row.value,
    priority: row.priority,
    episodeId: row.episodeId,
    sessionId: row.sessionId,
    vecKind: row.vecSummary ? "summary" : "action",
    userText: row.userText,
    agentText: row.agentText,
    summary: row.summary ?? null,
    reflection: row.reflection,
    tags: row.tags,
  };
}

function episodeCandidate(
  row: GraphEpisodeRow,
  getTrace: (id: TraceId) => GraphTraceRow | null,
): EpisodeCandidate | null {
  const traces = row.traceIds.slice(0, 5)
    .map(getTrace)
    .filter((trace): trace is GraphTraceRow => Boolean(trace));
  const metaSummary = firstString(row.meta?.goal, row.meta?.summary, row.meta?.title);
  const traceSummary = traces
    .map((trace) => trace.summary || trace.userText)
    .filter(Boolean)
    .slice(0, 3)
    .join("\n");
  const summary = metaSummary || traceSummary;
  if (!summary) return null;
  return {
    tier: "tier2",
    refKind: "episode",
    refId: row.id,
    cosine: 0,
    ts: row.startedAt,
    vec: meanVector(traces.map((trace) => trace.vecSummary ?? trace.vecAction ?? null)),
    channels: [],
    sessionId: row.sessionId,
    summary,
    maxValue: Math.max(0, ...traces.map((trace) => trace.value)),
    meanPriority: traces.length > 0
      ? traces.reduce((sum, trace) => sum + trace.priority, 0) / traces.length
      : 0,
  };
}

function repairCandidate(row: GraphRepairRow): DecisionRepairCandidate | null {
  const evidenceTraceId = row.highValueTraceIds[0] ?? row.lowValueTraceIds[0];
  if (!evidenceTraceId || (!row.preference.trim() && !row.antiPattern.trim())) return null;
  return {
    tier: "tier2",
    refKind: "decision-repair",
    refId: evidenceTraceId,
    repairId: row.id,
    cosine: 0,
    ts: row.ts,
    vec: null,
    channels: [],
    preference: row.preference,
    antiPattern: row.antiPattern,
    validated: row.validated,
    highValueTraceIds: row.highValueTraceIds,
    lowValueTraceIds: row.lowValueTraceIds,
  };
}

function candidateText(candidate: TierCandidate): string {
  if (candidate.refKind === "skill") {
    return `${candidate.skillName}\n${candidate.invocationGuide}`;
  }
  if (candidate.refKind === "trace") {
    return [candidate.summary, candidate.userText, candidate.agentText, candidate.reflection]
      .filter(Boolean)
      .join("\n");
  }
  if (candidate.refKind === "episode") return candidate.summary;
  if (candidate.refKind === "experience") return policyText(candidate);
  if (candidate.refKind === "decision-repair") {
    return `Preference: ${candidate.preference}\nAnti-pattern: ${candidate.antiPattern}`;
  }
  return `${candidate.title}\n${candidate.body}`;
}

function policyText(row: Pick<GraphPolicyRow, "title" | "trigger" | "procedure" | "verification" | "boundary">): string {
  return [row.title, row.trigger, row.procedure, row.verification, row.boundary]
    .filter(Boolean)
    .join("\n");
}

function skillSummary(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const summary = (value as { summary?: unknown }).summary;
  return typeof summary === "string" && summary.trim() ? summary.trim() : undefined;
}

function firstString(...values: unknown[]): string {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

function meanVector(values: Array<EmbeddingVector | null>): EmbeddingVector | null {
  const vectors = values.filter((value): value is EmbeddingVector => Boolean(value));
  if (vectors.length === 0) return null;
  const length = vectors[0]!.length;
  if (length === 0 || vectors.some((value) => value.length !== length)) return null;
  const out = new Float32Array(length);
  for (const vector of vectors) {
    for (let index = 0; index < length; index += 1) out[index] += vector[index]!;
  }
  let normSq = 0;
  for (let index = 0; index < length; index += 1) {
    out[index] /= vectors.length;
    normSq += out[index]! * out[index]!;
  }
  const norm = Math.sqrt(normSq);
  if (norm === 0) return null;
  for (let index = 0; index < length; index += 1) out[index] /= norm;
  return out as EmbeddingVector;
}

function typeBoost(query: string, kind: NodeKind): number {
  const rules: Array<[RegExp, NodeKind, number]> = [
    [/\bskill\b|技能/i, "skill", 1.22],
    [/decision\s*repair|修复|偏好|anti-pattern|冲突|矛盾|failure mode/i, "decision-repair", 1.28],
    [/\bpolicy\b|策略|政策|经验/i, "policy", 1.16],
    [/\btrace\b|轨迹|记录/i, "trace", 1.14],
    [/world\s*model|世界模型|领域认知/i, "world-model", 1.16],
  ];
  let boost = 1;
  for (const [pattern, target, value] of rules) {
    if (target === kind && pattern.test(query)) boost = Math.max(boost, value);
  }
  return boost;
}

function bm25Scores(query: string, documents: readonly LexicalDocument[]): Map<string, number> {
  const queryTerms = tokenCounts(query);
  if (queryTerms.size === 0 || documents.length === 0) return new Map();
  const termCounts = new Map<string, Map<string, number>>();
  const documentFrequency = new Map<string, number>();
  let totalLength = 0;
  for (const document of documents) {
    const counts = tokenCounts(document.text);
    termCounts.set(document.key, counts);
    totalLength += sum(counts.values());
    for (const term of counts.keys()) {
      documentFrequency.set(term, (documentFrequency.get(term) ?? 0) + 1);
    }
  }
  const averageLength = Math.max(1, totalLength / documents.length);
  const raw = new Map<string, number>();
  let max = 0;
  for (const document of documents) {
    const counts = termCounts.get(document.key)!;
    const length = Math.max(1, sum(counts.values()));
    let score = 0;
    for (const [term, queryCount] of queryTerms) {
      const frequency = counts.get(term) ?? 0;
      if (frequency === 0) continue;
      const frequencyDocs = documentFrequency.get(term) ?? 0;
      const idf = Math.log(1 + (documents.length - frequencyDocs + 0.5) / (frequencyDocs + 0.5));
      const denominator = frequency + 1.2 * (0.25 + 0.75 * length / averageLength);
      score += idf * frequency * 2.2 / denominator * Math.min(queryCount, 2);
    }
    raw.set(document.key, score);
    max = Math.max(max, score);
  }
  if (max <= 0) return new Map();
  return new Map([...raw].map(([key, value]) => [key, value / max]));
}

function tokenCounts(text: string): Map<string, number> {
  const counts = new Map<string, number>();
  const add = (token: string) => {
    const normalized = token.toLocaleLowerCase().trim();
    if (normalized) counts.set(normalized, (counts.get(normalized) ?? 0) + 1);
  };
  for (const match of text.match(/[a-z0-9_./:-]+/gi) ?? []) add(match);
  for (const run of text.match(/[\u3400-\u9fff]+/g) ?? []) {
    if (run.length === 1) add(run);
    for (let index = 0; index < run.length - 1; index += 1) {
      add(run.slice(index, index + 2));
    }
  }
  return counts;
}

function dedupeDocuments(documents: readonly LexicalDocument[]): LexicalDocument[] {
  const byKey = new Map<string, LexicalDocument>();
  for (const document of documents) {
    const current = byKey.get(document.key);
    if (!current || document.text.length > current.text.length) byKey.set(document.key, document);
  }
  return [...byKey.values()];
}

function multiIndex<Row, Key extends string>(
  rows: readonly Row[],
  keys: (row: Row) => readonly Key[],
): Map<Key, Row[]> {
  const out = new Map<Key, Row[]>();
  for (const row of rows) {
    for (const key of keys(row)) appendIndex(out, key, row);
  }
  return out;
}

function appendIndex<Key, Row>(map: Map<Key, Row[]>, key: Key, row: Row): void {
  const values = map.get(key) ?? [];
  values.push(row);
  map.set(key, values);
}

function dedupe<T>(values: readonly T[]): T[] {
  return [...new Set(values)];
}

function sum(values: Iterable<number>): number {
  let total = 0;
  for (const value of values) total += value;
  return total;
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));
}
