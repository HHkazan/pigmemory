/**
 * `runL3` — cross-task world-model abstraction.
 *
 * The orchestrator follows the V7 §2.4.1 recipe:
 *
 *   1. **Gather eligible L2 policies** (status = active, gain ≥ minGain,
 *      support ≥ minSupport) and split them into compatible clusters
 *      via `clusterPolicies` (domain key + centroid proximity).
 *   2. **Cooldown check**: skip clusters whose primary tag was abstracted
 *      recently — controlled by `algorithm.l3Abstraction.cooldownDays`.
 *   3. **Abstract** each surviving cluster with the `l3.abstraction`
 *      prompt (see `abstract.ts`).
 *   4. **Merge or create**: compare the draft against existing WMs that
 *      share a domain tag (see `merge.ts`). Above the similarity cutoff
 *      we update the existing row; otherwise we insert a new WM.
 *   5. **Persist evidence** — every WM row carries its source policies
 *      and source episodes so Tier-3 retrieval can trace WMs back to the
 *      L1/L2 rows that minted them.
 *
 * Pure pipeline: takes `deps` (repos, llm, log, bus) and returns a
 * `L3ProcessResult`. No globals.
 */

import type { Logger } from "../../logger/types.js";
import type { LlmClient } from "../../llm/index.js";
import { L3_ABSTRACTION_PROMPT } from "../../llm/prompts/l3-abstraction.js";
import type { Repos } from "../../storage/repos/index.js";
import { ids } from "../../id.js";
import type {
  EpisodeId,
  EpochMs,
  PolicyId,
  PolicyRow,
  TraceRow,
  WorldModelId,
} from "../../types.js";
import { abstractDraft, buildWorldModelRow } from "./abstract.js";
import { clusterPolicies } from "./cluster.js";
import {
  chooseMergeTarget,
  gatherMergeCandidates,
  mergeForUpdate,
} from "./merge.js";
import type {
  AbstractionResult,
  L3Config,
  L3Event,
  L3EventBus,
  L3ProcessInput,
  L3ProcessResult,
  PolicyCluster,
} from "./types.js";
import { contentFingerprint } from "../../util/content-fingerprint.js";

// ─── Deps ──────────────────────────────────────────────────────────────────

export interface RunL3Deps {
  repos: Pick<Repos, "embeddingRetryQueue" | "policies" | "traces" | "worldModel" | "kv">;
  llm: LlmClient | null;
  log: Logger;
  bus?: L3EventBus;
  config: L3Config;
}

const KV_COOLDOWN_PREFIX = "l3.lastRun.";
const KV_FINGERPRINT_PREFIX = "l3.fingerprint.";

// ─── Public entry ──────────────────────────────────────────────────────────

export async function runL3(
  input: L3ProcessInput,
  deps: RunL3Deps,
): Promise<L3ProcessResult> {
  const { repos, config, log, bus } = deps;
  const startedAt: EpochMs = Date.now();
  const now = input.now ?? startedAt;
  const warnings: L3ProcessResult["warnings"] = [];
  const timings = { cluster: 0, abstract: 0, persist: 0, total: 0 };
  const abstractions: AbstractionResult[] = [];
  let inputPolicyCount = 0;

  log.info("run.start", {
    trigger: input.trigger,
    domainTagsFilter: input.domainTagsFilter ?? null,
    sessionId: input.sessionId ?? null,
    episodeId: input.episodeId ?? null,
  });

  reconcileWorldModelLifecycle(repos, config, now, log);

  // ─── Step 1: Gather eligible policies + cluster ─────────────────────────
  let clusters: PolicyCluster[] = [];
  {
    const t0 = Date.now();
    const candidates = repos.policies
      .list({ status: "active" })
      .filter(
        (p) =>
          p.gain >= config.minPolicyGain &&
          p.support >= config.minPolicySupport,
      );
    inputPolicyCount = candidates.length;

    const clusterLog = log.child({ channel: "core.memory.l3.cluster" });
    clusters = clusterPolicies(
      { policies: candidates },
      {
        config: {
          clusterMinSimilarity: config.clusterMinSimilarity,
          minPolicies: config.minPolicies,
        },
      },
    );

    if (input.domainTagsFilter && input.domainTagsFilter.length > 0) {
      const filterSet = new Set(input.domainTagsFilter.map((t) => t.toLowerCase()));
      clusters = clusters.filter((c) => c.domainTags.some((t) => filterSet.has(t)));
    }

    clusterLog.info("clusters.built", {
      eligiblePolicies: candidates.length,
      clusters: clusters.length,
      domainTagsFilter: input.domainTagsFilter ?? null,
    });

    timings.cluster = Date.now() - t0;
  }

  emit(bus, {
    kind: "l3.abstraction.started",
    trigger: input.trigger,
    clusterCount: clusters.length,
    inputCount: inputPolicyCount,
    sessionId: input.sessionId,
    episodeId: input.episodeId,
    startedAt,
  });

  // ─── Step 2, 3, 4: per-cluster abstract + merge/persist ─────────────────
  const abstractLog = log.child({ channel: "core.memory.l3.abstract" });
  const mergeLog = log.child({ channel: "core.memory.l3.merge" });
  const confidenceLog = log.child({ channel: "core.memory.l3.confidence" });

  for (const cluster of clusters) {
    if (cluster.policies.length < config.minPolicies) {
      abstractions.push(skipped(cluster, "too_few_policies"));
      continue;
    }

    if (!cluster.centroidVec) {
      abstractions.push(skipped(cluster, "no_centroid"));
      continue;
    }

    const fingerprint = fingerprintCluster(cluster);
    const processedWorldId = repos.kv.get<string>(
      `${KV_FINGERPRINT_PREFIX}${fingerprint}`,
      "",
    );
    const processed = repos.worldModel.getByClusterFingerprint(fingerprint) ??
      (processedWorldId
        ? repos.worldModel.getById(processedWorldId as WorldModelId)
        : null);
    if (processed) {
      if (processed.status !== "active") {
        repos.worldModel.setStatus(processed.id, "active", now);
      }
      if (processed.staleReason) {
        repos.worldModel.markStale(processed.id, null, now);
      }
      abstractions.push(skipped(cluster, "duplicate_of", {
        episodeIds: processed.sourceEpisodeIds,
        policyIds: cluster.policies.map((policy) => policy.id),
      }));
      abstractions[abstractions.length - 1]!.duplicateOfWorldId = processed.id;
      continue;
    }

    if (isInCooldown(cluster, repos.kv, config.cooldownDays, now)) {
      abstractLog.info("cooldown.skipped", {
        clusterKey: cluster.key,
        domainTags: cluster.domainTags,
      });
      abstractions.push(skipped(cluster, "cooldown"));
      continue;
    }

    const evidenceByPolicy = loadEvidence(cluster, repos, config.traceEvidencePerPolicy);
    const episodeIds = collectEpisodeIds(cluster.policies, evidenceByPolicy);

    // Surface a per-cluster trigger episode so the LLM call's
    // `system_model_status` row can be grouped with the rest of that
    // episode's pipeline activity in the Logs viewer. Prefer the
    // explicit trigger (passed by the L2 → L3 subscriber); otherwise
    // fall back to the first contributing episode in the cluster so
    // manual / rebuild runs still get a coherent grouping.
    const triggerEpisodeId = input.episodeId ?? episodeIds[0];

    const t0 = Date.now();
    const draftRes = await abstractDraft(
      { cluster, evidenceByPolicy, episodeId: triggerEpisodeId },
      { llm: deps.llm, log: abstractLog, config },
    );
    timings.abstract += Date.now() - t0;

    if (!draftRes.ok) {
      abstractions.push(skipped(cluster, draftRes.reason, { episodeIds, policyIds: cluster.policies.map((p) => p.id) }));
      emit(bus, {
        kind: "l3.failed",
        stage: "abstract",
        error: { code: draftRes.reason, message: draftRes.detail ?? "" },
        clusterKey: cluster.key,
      });
      continue;
    }

    const t1 = Date.now();
    const candidatesWm = gatherMergeCandidates(cluster, { lookup: repos.worldModel, config });
    const decision = chooseMergeTarget(cluster, candidatesWm, draftRes.draft, {
      lookup: repos.worldModel,
      config,
    });

    let persistedWorldId: WorldModelId | null = null;
    if (decision.kind === "update") {
      const patch = mergeForUpdate({
        existing: decision.target,
        draft: draftRes.draft,
        cluster,
        episodeIds,
      });
      try {
        repos.worldModel.updateBody(decision.target.id, {
          title: patch.title,
          body: patch.body,
          structure: patch.structure,
          domainTags: patch.domainTags,
          policyIds: patch.policyIds,
          sourceEpisodeIds: patch.sourceEpisodeIds,
          vec: patch.vec,
          updatedAt: now,
          clusterFingerprint: fingerprint,
        });
        if (!patch.vec) {
          repos.embeddingRetryQueue.enqueue({
            id: `er_${ids.span()}`,
            targetKind: "world_model",
            targetId: decision.target.id,
            vectorField: "vec",
            sourceText: worldModelVectorText(patch.title, patch.body),
            now,
          });
          warnings.push({
            stage: "embed",
            message: "embedding retry queued for world model vector",
            detail: { worldModelId: decision.target.id },
          });
        }
        const bumped = clamp01(decision.target.confidence + config.confidenceDelta);
        if (bumped !== decision.target.confidence) {
          repos.worldModel.updateConfidence(decision.target.id, bumped, now);
          confidenceLog.info("confidence.bumped", {
            worldModelId: decision.target.id,
            previous: decision.target.confidence,
            next: bumped,
          });
          emit(bus, {
            kind: "l3.confidence.adjusted",
            worldModelId: decision.target.id,
            previous: decision.target.confidence,
            next: bumped,
            reason: "merge",
          });
        }
        mergeLog.info("merged", {
          worldModelId: decision.target.id,
          clusterKey: cluster.key,
          cosine: decision.cosineScore,
        });
        abstractions.push({
          clusterKey: cluster.key,
          worldModelId: decision.target.id,
          policyCount: cluster.policies.length,
          episodeIds,
          policyIds: cluster.policies.map((p) => p.id),
          skippedReason: null,
          createdNew: false,
          mergedIntoWorldId: decision.target.id,
        });
        emit(bus, {
          kind: "l3.world-model.updated",
          worldModelId: decision.target.id,
          title: patch.title,
          domainTags: patch.domainTags,
          policyIds: patch.policyIds as PolicyId[],
          confidence: bumped,
        });
        persistedWorldId = decision.target.id;
      } catch (err) {
        warnings.push(stageWarn("merge", err, { clusterKey: cluster.key }));
      }
    } else {
      const wm = buildWorldModelRow({
        draft: draftRes.draft,
        cluster,
        episodeIds,
        inducedBy: `${L3_ABSTRACTION_PROMPT.id}.v${L3_ABSTRACTION_PROMPT.version}`,
        now,
        clusterFingerprint: fingerprint,
      });
      const owner = ownerFromPolicies(cluster.policies);
      wm.ownerAgentKind = owner.ownerAgentKind;
      wm.ownerProfileId = owner.ownerProfileId;
      wm.ownerWorkspaceId = owner.ownerWorkspaceId;
      try {
        repos.worldModel.insert(wm);
        if (!wm.vec) {
          repos.embeddingRetryQueue.enqueue({
            id: `er_${ids.span()}`,
            targetKind: "world_model",
            targetId: wm.id,
            vectorField: "vec",
            sourceText: worldModelVectorText(wm.title, wm.body),
            now,
          });
          warnings.push({
            stage: "embed",
            message: "embedding retry queued for world model vector",
            detail: { worldModelId: wm.id },
          });
        }
        abstractions.push({
          clusterKey: cluster.key,
          worldModelId: wm.id,
          policyCount: cluster.policies.length,
          episodeIds,
          policyIds: cluster.policies.map((p) => p.id),
          skippedReason: null,
          createdNew: true,
        });
        emit(bus, {
          kind: "l3.world-model.created",
          worldModelId: wm.id,
          title: wm.title,
          domainTags: wm.domainTags,
          policyIds: wm.policyIds,
          confidence: wm.confidence,
        });
        persistedWorldId = wm.id;
      } catch (err) {
        warnings.push(stageWarn("insert", err, { clusterKey: cluster.key }));
      }
    }

    if (persistedWorldId) {
      markCooldown(cluster, repos.kv, now);
      repos.kv.set<string>(`${KV_FINGERPRINT_PREFIX}${fingerprint}`, persistedWorldId);
    }
    timings.persist += Date.now() - t1;
  }

  const completedAt = Date.now();
  timings.total = completedAt - startedAt;

  log.info("run.done", {
    trigger: input.trigger,
    clusters: clusters.length,
    created: abstractions.filter((a) => a.createdNew === true).length,
    merged: abstractions.filter((a) => a.mergedIntoWorldId).length,
    skipped: abstractions.filter((a) => a.skippedReason !== null).length,
    timings,
  });

  const outputWorldModelIds = [...new Set(
    abstractions
      .map((item) => item.worldModelId)
      .filter((id): id is WorldModelId => id !== null),
  )];
  const skippedReasons = abstractions
    .map((item) => item.skippedReason)
    .filter((reason): reason is NonNullable<typeof reason> => reason !== null);
  if (outputWorldModelIds.length === 0) {
    emit(bus, {
      kind: "l3.abstraction.skipped",
      trigger: input.trigger,
      inputCount: inputPolicyCount,
      reason: skippedReasons.length > 0
        ? [...new Set(skippedReasons)].join(",")
        : "no_eligible_clusters",
      sessionId: input.sessionId,
      episodeId: input.episodeId,
      startedAt,
      completedAt,
    });
  } else {
    emit(bus, {
      kind: "l3.abstraction.completed",
      trigger: input.trigger,
      inputCount: inputPolicyCount,
      outputWorldModelIds,
      skippedReasons,
      sessionId: input.sessionId,
      episodeId: input.episodeId,
      startedAt,
      completedAt,
    });
  }

  return {
    trigger: input.trigger,
    abstractions,
    warnings,
    timings,
    startedAt,
    completedAt,
  };
}

function fingerprintCluster(cluster: PolicyCluster): string {
  return contentFingerprint({
    domainKey: cluster.key,
    policies: cluster.policies
      .map((policy) => ({ id: policy.id, contentVersion: policy.contentVersion }))
      .sort((left, right) => left.id.localeCompare(right.id)),
    prompt: `${L3_ABSTRACTION_PROMPT.id}.v${L3_ABSTRACTION_PROMPT.version}`,
  });
}

export function reconcileWorldModelLifecycle(
  repos: Pick<Repos, "policies" | "worldModel">,
  config: L3Config,
  now: number,
  log: Logger,
): void {
  for (const world of repos.worldModel.list({ limit: 5_000 })) {
    const sources = world.policyIds
      .map((id) => repos.policies.getById(id))
      .filter((policy): policy is PolicyRow => Boolean(policy));
    const valid = sources.filter((policy) =>
      policy.status === "active" &&
      policy.support >= config.minPolicySupport &&
      policy.gain >= config.minPolicyGain);
    const allArchived = sources.length > 0 && sources.every((policy) => policy.status === "archived");
    if (allArchived) {
      const statusChanged = world.status !== "archived";
      const reasonChanged = world.staleReason !== "all_sources_archived";
      if (statusChanged) repos.worldModel.setStatus(world.id, "archived", now);
      if (reasonChanged) repos.worldModel.markStale(world.id, "all_sources_archived", now);
      if (statusChanged || reasonChanged) {
        log.info("lifecycle.archived", {
          worldModelId: world.id,
          reason: "all_sources_archived",
        });
      }
      continue;
    }
    if (valid.length < config.minPolicies) {
      const reason = `insufficient_valid_sources:${valid.length}/${config.minPolicies}`;
      if (world.staleReason !== reason) repos.worldModel.markStale(world.id, reason, now);
    }
  }
}

function ownerFromPolicies(policies: readonly { ownerAgentKind?: string; ownerProfileId?: string; ownerWorkspaceId?: string | null }[]): {
  ownerAgentKind: string;
  ownerProfileId: string;
  ownerWorkspaceId: string | null;
} {
  const first = policies[0];
  return {
    ownerAgentKind: first?.ownerAgentKind ?? "unknown",
    ownerProfileId: first?.ownerProfileId ?? "default",
    ownerWorkspaceId: first?.ownerWorkspaceId ?? null,
  };
}

// ─── Helpers ───────────────────────────────────────────────────────────────

function emit(bus: L3EventBus | undefined, evt: L3Event): void {
  if (!bus) return;
  bus.emit(evt);
}

function stageWarn(
  stage: string,
  err: unknown,
  detail?: Record<string, unknown>,
): { stage: string; message: string; detail?: Record<string, unknown> } {
  const message = err instanceof Error ? err.message : String(err);
  return { stage, message, detail };
}

function worldModelVectorText(title: string, body: string): string {
  return [title.trim(), body.trim()].filter(Boolean).join("\n\n") || "(empty)";
}

function skipped(
  cluster: PolicyCluster,
  reason: Exclude<AbstractionResult["skippedReason"], null>,
  extra?: { episodeIds?: EpisodeId[]; policyIds?: PolicyId[] },
): AbstractionResult {
  return {
    clusterKey: cluster.key,
    worldModelId: null,
    policyCount: cluster.policies.length,
    episodeIds: extra?.episodeIds ?? [],
    policyIds: extra?.policyIds ?? cluster.policies.map((p) => p.id),
    skippedReason: reason,
  };
}

function loadEvidence(
  cluster: PolicyCluster,
  repos: Pick<Repos, "traces">,
  cap: number,
): Map<PolicyId, readonly TraceRow[]> {
  const out = new Map<PolicyId, readonly TraceRow[]>();
  if (cap <= 0) {
    for (const p of cluster.policies) out.set(p.id, []);
    return out;
  }
  for (const p of cluster.policies) {
    const epIds = p.sourceEpisodeIds.slice(0, Math.min(3, cap + 1));
    const traces: TraceRow[] = [];
    for (const ep of epIds) {
      const forEpisode = repos.traces.list({ episodeId: ep, limit: 8 });
      const best = forEpisode
        .filter((t) => (t.vecSummary ?? t.vecAction) !== null)
        .sort((a, b) => b.value - a.value)
        .slice(0, cap);
      for (const t of best) {
        if (!traces.some((prev) => prev.id === t.id)) traces.push(t);
        if (traces.length >= cap) break;
      }
      if (traces.length >= cap) break;
    }
    out.set(p.id, traces);
  }
  return out;
}

function collectEpisodeIds(
  policies: readonly PolicyRow[],
  evidenceByPolicy: Map<PolicyId, readonly TraceRow[]>,
): EpisodeId[] {
  const set = new Set<string>();
  for (const p of policies) for (const ep of p.sourceEpisodeIds) set.add(ep);
  for (const arr of evidenceByPolicy.values()) for (const t of arr) set.add(t.episodeId);
  return Array.from(set) as EpisodeId[];
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

// ─── Cooldown bookkeeping ───────────────────────────────────────────────────

function cooldownKey(cluster: PolicyCluster): string {
  const primary = cluster.domainTags[0] ?? cluster.key;
  return `${KV_COOLDOWN_PREFIX}${primary}`;
}

function isInCooldown(
  cluster: PolicyCluster,
  kv: Repos["kv"],
  cooldownDays: number,
  now: number,
): boolean {
  if (cooldownDays <= 0) return false;
  const last = kv.get<number>(cooldownKey(cluster), 0);
  if (!last || last <= 0) return false;
  const cooldownMs = cooldownDays * 24 * 60 * 60 * 1000;
  return now - last < cooldownMs;
}

function markCooldown(
  cluster: PolicyCluster,
  kv: Repos["kv"],
  now: number,
): void {
  kv.set<number>(cooldownKey(cluster), now);
}

// ─── Public confidence adjustment (used by feedback/subscriber) ─────────────

export function adjustConfidence(
  worldModelId: WorldModelId,
  polarity: "positive" | "negative",
  deps: Pick<RunL3Deps, "repos" | "config" | "log" | "bus">,
  now: number = Date.now(),
): { previous: number; next: number } | null {
  const row = deps.repos.worldModel.getById(worldModelId);
  if (!row) return null;
  const delta = polarity === "positive" ? deps.config.confidenceDelta : -deps.config.confidenceDelta;
  const next = clamp01(row.confidence + delta);
  if (next === row.confidence) return { previous: row.confidence, next };

  deps.repos.worldModel.updateConfidence(worldModelId, next, now);
  const log = deps.log.child({ channel: "core.memory.l3.feedback" });
  log.info("confidence.adjusted", {
    worldModelId,
    previous: row.confidence,
    next,
    polarity,
  });
  if (deps.bus) {
    deps.bus.emit({
      kind: "l3.confidence.adjusted",
      worldModelId,
      previous: row.confidence,
      next,
      reason: `feedback.${polarity}`,
    });
  }
  return { previous: row.confidence, next };
}
