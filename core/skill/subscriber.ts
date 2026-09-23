/**
 * Wires the skill module to the upstream event buses.
 *
 * Upstream triggers (all debounced via `queueMicrotask` so they never block
 * the emitter):
 *
 *   - `l2.policy.induced`        → `runSkill({ trigger, policyId })`
 *   - `l2.policy.status_changed` → `runSkill({ trigger, policyId })` when
 *                                  the new status is `active`
 *   - `reward.updated`           → `runSkill({ trigger: "reward.updated" })`
 *                                  — evaluates every policy referenced by
 *                                  the updated episode. Also drives the η
 *                                  drift adjustment on existing skills.
 *
 * The handle returns `runOnce` for manual runs (used by the CLI / viewer
 * rebuild button) and `applyFeedback` for explicit skill feedback.
 */

import type { L2Event, L2EventBus } from "../memory/l2/types.js";
import type { Logger } from "../logger/types.js";
import type { RewardEvent, RewardEventBus } from "../reward/types.js";
import { rootLogger } from "../logger/index.js";
import {
  applySkillFeedback,
  runSkill,
  type RunSkillDeps,
} from "./skill.js";
import {
  candidateArchiveReason,
  policyMeetsSkillGate,
  shouldPromoteCandidate,
} from "./lifecycle.js";
import type {
  RunSkillInput,
  RunSkillResult,
  SkillEventBus,
  SkillArchiveReason,
  SkillFeedbackKind,
  SkillTrigger,
} from "./types.js";
import type { SkillId, SkillRow } from "../types.js";
import { now as nowMs } from "../time.js";

export interface SkillSubscriberDeps
  extends Omit<RunSkillDeps, "log" | "bus"> {
  log?: Logger;
  bus: SkillEventBus;
  l2Bus: L2EventBus;
  rewardBus: RewardEventBus;
}

export interface SkillSubscriberHandle {
  dispose(): void;
  runOnce(input: Omit<RunSkillInput, "trigger"> & { trigger?: SkillTrigger }): Promise<RunSkillResult>;
  applyFeedback(skillId: SkillId, kind: SkillFeedbackKind, magnitude?: number): void;
  lifecycleTick(): Promise<void>;
  /**
   * Await any in-flight scheduled run. Primarily useful in tests where we
   * want to assert on the effects of an event-driven run after the bus has
   * fanned out the event.
   */
  flush(): Promise<void>;
}

export function attachSkillSubscriber(
  deps: SkillSubscriberDeps,
): SkillSubscriberHandle {
  const log = deps.log ?? rootLogger.child({ channel: "core.skill" });
  const runDeps: RunSkillDeps = {
    repos: deps.repos,
    embedder: deps.embedder,
    llm: deps.llm,
    log,
    bus: deps.bus,
    config: deps.config,
  };

  let inflight: Promise<void> | null = null;
  let runningAll = false;
  const queued = new Map<
    string,
    { trigger: SkillTrigger; hint?: { policyId?: string; skillId?: SkillId } }
  >();

  async function drain(): Promise<void> {
    while (queued.size > 0) {
      const entry = queued.entries().next().value as [string, {
        trigger: SkillTrigger;
        hint?: { policyId?: string; skillId?: SkillId };
      }] | undefined;
      if (!entry) break;
      const [key, next] = entry;
      queued.delete(key);
      runningAll = key === "all";
      try {
        await runSkill(
          { trigger: next.trigger, policyId: next.hint?.policyId, skillId: next.hint?.skillId },
          runDeps,
        );
      } catch (err) {
        log.error("skill.run.failed", {
          trigger: next.trigger,
          err: err instanceof Error ? err.message : String(err),
        });
      }
      runningAll = false;
    }
  }

  function triggerRun(
    trigger: SkillTrigger,
    hint?: { policyId?: string; skillId?: SkillId },
  ): void {
    const isAll = !hint?.policyId && !hint?.skillId;
    if (isAll) {
      queued.clear();
      queued.set("all", { trigger, hint });
    } else {
      if (queued.has("all") && !runningAll) return;
      const key = hint?.policyId
        ? `policy:${hint.policyId}`
        : `skill:${hint?.skillId ?? "_"}`;
      queued.set(key, { trigger, hint });
    }
    if (inflight) {
      log.debug("skill.run.queued", { trigger });
      return;
    }
    const promise = drain().finally(() => {
      if (inflight === promise) inflight = null;
    });
    inflight = promise;
  }

  const offStatus = deps.l2Bus.on("l2.policy.updated", (evt: L2Event) => {
    if (evt.kind !== "l2.policy.updated") return;
    if (
      (evt.previousStatus === "candidate" && evt.nextStatus === "active") ||
      (evt.previousStatus === "active" && evt.nextStatus === "active" && evt.changeKind === "content")
    ) {
      log.debug("trigger.l2.policy.updated", {
        policyId: evt.policyId,
        previousStatus: evt.previousStatus,
        nextStatus: evt.nextStatus,
        changeKind: evt.changeKind,
      });
      triggerRun("l2.policy.status_changed", { policyId: evt.policyId });
      return;
    }
    if (
      evt.previousStatus === "active" &&
      evt.nextStatus === "active" &&
      evt.changeKind === "stats"
    ) {
      for (const skill of deps.repos.skills.list({ limit: 5_000 })) {
        if (skill.status === "archived" || !skill.sourcePolicyIds.includes(evt.policyId)) continue;
        applySkillFeedback(skill.id, "reward.updated", runDeps, evt.gain);
      }
      return;
    }
    if (evt.previousStatus === "active" && evt.nextStatus === "archived") {
      invalidateSkillsForPolicy(evt.policyId);
    }
  });

  const offReward = deps.rewardBus.on("reward.updated", (evt: RewardEvent) => {
    if (evt.kind !== "reward.updated") return;
    log.debug("trigger.reward.updated", {
      episodeId: evt.result.episodeId,
    });
    resolveTrialsForReward(evt);
    triggerRun("reward.updated");
  });

  function dispose(): void {
    offStatus();
    offReward();
    log.info("skill.subscriber.disposed");
  }

  async function runOnce(
    input: Omit<RunSkillInput, "trigger"> & { trigger?: SkillTrigger },
  ): Promise<RunSkillResult> {
    const trigger: SkillTrigger = input.trigger ?? "manual";
    return runSkill(
      {
        trigger,
        policyId: input.policyId,
        skillId: input.skillId,
      },
      runDeps,
    );
  }

  function applyFeedback(
    skillId: SkillId,
    kind: SkillFeedbackKind,
    magnitude?: number,
  ): void {
    applySkillFeedback(skillId, kind, runDeps, magnitude);
  }

  function resolveTrialsForReward(evt: Extract<RewardEvent, { kind: "reward.updated" }>): void {
    const rTask = evt.result.rHuman;
    const outcome =
      rTask >= 0.5 ? "pass" :
      rTask <= -0.5 ? "fail" :
      "unknown";
    const trials = deps.repos.skillTrials.listPendingForEpisode(evt.result.episodeId);
    if (trials.length === 0) return;
    for (const trial of trials) {
      const evidence = {
        source: "reward.updated",
        episodeId: evt.result.episodeId,
        rTask,
        threshold: { pass: 0.5, fail: -0.5 },
        reason:
          outcome === "pass"
            ? "rTask >= 0.5"
            : outcome === "fail"
              ? "rTask <= -0.5"
              : "-0.5 < rTask < 0.5",
      };
      const skill = deps.repos.skills.getById(trial.skillId);
      const versionMatches = Boolean(
        skill && trial.skillVersion === skill.trialVersion && trial.skillVersion === skill.version,
      );
      const resolvedOutcome = versionMatches ? outcome : "unknown";
      const changed = deps.repos.skillTrials.resolve(
        trial.id,
        resolvedOutcome,
        evt.result.completedAt,
        evidence,
      );
      if (!changed) continue;
      if (resolvedOutcome === "pass" || resolvedOutcome === "fail") {
        applySkillFeedback(
          trial.skillId,
          resolvedOutcome === "pass" ? "trial.pass" : "trial.fail",
          runDeps,
        );
      }
      log.info("skill.trial.resolved", {
        trialId: trial.id,
        skillId: trial.skillId,
        episodeId: evt.result.episodeId,
        outcome: resolvedOutcome,
        rTask,
        skillVersion: trial.skillVersion,
        versionMatches,
      });
    }
  }

  function invalidateSkillsForPolicy(policyId: string): void {
    const at = nowMs();
    for (const skill of deps.repos.skills.list({ limit: 5_000 })) {
      if (skill.status === "archived" || !skill.sourcePolicyIds.includes(policyId)) continue;
      const hasEligibleSource = skill.sourcePolicyIds.some((sourceId) => {
        const source = deps.repos.policies.getById(sourceId);
        return source ? policyMeetsSkillGate(source, deps.config) : false;
      });
      if (hasEligibleSource) continue;
      archiveSkill(skill, "below-generation-gate", at);
    }
  }

  function archiveSkill(
    skill: SkillRow,
    reason: Extract<
      SkillArchiveReason,
      "below-generation-gate" | "candidate-expired"
    >,
    at: number,
  ): void {
    deps.repos.skills.setStatus(skill.id, "archived", at);
    log.info("skill.auto_archived", {
      skillId: skill.id,
      name: skill.name,
      previous: skill.status,
      reason,
    });
    deps.bus.emit({
      kind: "skill.status.changed",
      at,
      skillId: skill.id,
      previous: skill.status,
      next: "archived",
      transition: "archived",
      reason,
    });
    deps.bus.emit({
      kind: "skill.archived",
      at,
      skillId: skill.id,
      reason,
    });
  }

  async function flush(): Promise<void> {
    // Loop in case additional events arrive while we're draining.
    while (inflight) {
      await inflight;
    }
  }

  /** Periodic lifecycle pass: archive invalid/expired candidates, then promote. */
  async function lifecycleTick(): Promise<void> {
    const candidates = deps.repos.skills.list({ status: "candidate", limit: 5_000 });
    const at = nowMs();
    for (const s of candidates) {
      const sourcePolicies = s.sourcePolicyIds.flatMap((sourceId) => {
        const source = deps.repos.policies.getById(sourceId);
        return source ? [source] : [];
      });
      const archiveReason = candidateArchiveReason(s, sourcePolicies, deps.config, at);
      if (archiveReason) {
        archiveSkill(s, archiveReason, at);
        continue;
      }
      if (!shouldPromoteCandidate(s, deps.config)) continue;
      if (s.supersedesSkillId) {
        deps.repos.skills.activateSuperseding(s.id, s.supersedesSkillId, at);
      } else {
        deps.repos.skills.setStatus(s.id, "active", at);
      }
      log.info("skill.auto_promoted", { skillId: s.id, name: s.name, eta: s.eta });
      deps.bus.emit({
        kind: "skill.status.changed",
        at,
        skillId: s.id,
        previous: "candidate",
        next: "active",
        transition: "promoted",
      });
    }
  }

  return { dispose, runOnce, applyFeedback, flush, lifecycleTick };
}
