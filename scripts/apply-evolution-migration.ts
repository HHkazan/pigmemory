#!/usr/bin/env node

/**
 * Apply the policy/skill/world-model evolution data repair.
 *
 * This command is intentionally guarded: callers must pass `--apply` and a
 * directory containing a pre-migration `memos.db` + `memos.db-wal` backup.
 * Schema migration 014 is applied first, then all state changes happen in one
 * SQLite transaction. Historical rows and trial evidence are never deleted.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import YAML from "yaml";

import { makeRepos, openDb, runMigrations } from "../core/storage/index.js";
import type { PolicyRow, SkillRow, WorldModelRow } from "../core/types.js";

interface CliOptions {
  apply: boolean;
  backupDir: string;
  configFile: string;
  dbFile: string;
  reportFile: string;
}

interface Thresholds {
  policy: { archiveGain: number };
  world: {
    minPolicies: number;
    minPolicyGain: number;
    minPolicySupport: number;
    minConfidenceForRetrieval: number;
  };
}

interface PolicyChange {
  id: string;
  beforeSupport: number;
  afterSupport: number;
  beforeStatus: PolicyRow["status"];
  afterStatus: PolicyRow["status"];
  beforeSourceEpisodeIds: string[];
  afterSourceEpisodeIds: string[];
}

interface SkillChange {
  id: string;
  beforeStatus: SkillRow["status"];
  afterStatus: SkillRow["status"];
  beforeTrialsAttempted: number;
  afterTrialsAttempted: number;
  beforeTrialsPassed: number;
  afterTrialsPassed: number;
  reason: string;
}

interface WorldChange {
  id: string;
  beforeStatus: WorldModelRow["status"];
  afterStatus: WorldModelRow["status"];
  beforeStaleReason: string | null;
  afterStaleReason: string | null;
  validSourceIds: string[];
}

const DEFAULT_THRESHOLDS: Thresholds = {
  policy: { archiveGain: -0.05 },
  world: {
    minPolicies: 1,
    minPolicyGain: 0.02,
    minPolicySupport: 1,
    minConfidenceForRetrieval: 0.2,
  },
};

function main(): void {
  const options = parseArgs(process.argv.slice(2));
  assertSafeToApply(options);
  const thresholds = loadThresholds(options.configFile);
  const startedAt = Date.now();
  const db = openDb({
    filepath: options.dbFile,
    agent: "evolution-migration",
    wal: true,
    synchronous: "FULL",
  });

  try {
    const migrations = runMigrations(db);
    const repos = makeRepos(db);
    const beforePolicies = repos.policies.list({ limit: 100_000 });
    const beforeSkills = repos.skills.list({ limit: 100_000 });
    const beforeWorldModels = repos.worldModel.list({ limit: 100_000 });
    const activeSkillIds = beforeSkills
      .filter((skill) => skill.status === "active")
      .map((skill) => skill.id);
    if (activeSkillIds.length !== 1) {
      throw new Error(
        `expected exactly one active skill to preserve; found ${activeSkillIds.length}`,
      );
    }

    const policyChanges: PolicyChange[] = [];
    const skillChanges: SkillChange[] = [];
    const worldChanges: WorldChange[] = [];
    let invalidatedOldPendingTrials = 0;

    db.tx(() => {
      for (const policy of beforePolicies) {
        const sourceEpisodeIds = repos.tracePolicyLinks.getLinkedEpisodeIds(policy.id);
        const support = sourceEpisodeIds.length;
        const status = repairedPolicyStatus(policy, support, thresholds.policy.archiveGain);
        const sourceChanged = !sameStrings(policy.sourceEpisodeIds, sourceEpisodeIds);
        if (
          support === policy.support &&
          status === policy.status &&
          !sourceChanged
        ) {
          continue;
        }
        repos.policies.updateStats(policy.id, {
          support,
          gain: policy.gain,
          status,
          sourceEpisodeIds,
          updatedAt: startedAt,
        });
        policyChanges.push({
          id: policy.id,
          beforeSupport: policy.support,
          afterSupport: support,
          beforeStatus: policy.status,
          afterStatus: status,
          beforeSourceEpisodeIds: [...policy.sourceEpisodeIds],
          afterSourceEpisodeIds: [...sourceEpisodeIds],
        });
      }

      invalidatedOldPendingTrials = db.raw.prepare(`
        UPDATE skill_trials
           SET status='unknown',
               resolved_at=@resolved_at,
               evidence_json=json_set(
                 COALESCE(evidence_json, '{}'),
                 '$.migrationReason',
                 'skill_version_rebuilt'
               )
         WHERE status='pending'
           AND skill_version<>(
             SELECT s.trial_version FROM skills s WHERE s.id=skill_trials.skill_id
           )
      `).run({ resolved_at: startedAt }).changes;

      const duplicateCandidateIds = duplicateCandidateIdsToArchive(beforeSkills);
      const resetCandidateTrials = db.prepare<{
        id: string;
        updated_at: number;
      }>(`
        UPDATE skills
           SET trials_attempted=0,
               trials_passed=0,
               updated_at=@updated_at
         WHERE id=@id AND status='candidate'
      `);
      for (const skill of beforeSkills) {
        if (skill.status === "active") continue;
        if (skill.status === "archived") continue;
        const sourcePolicies = skill.sourcePolicyIds
          .map((id) => repos.policies.getById(id))
          .filter((policy): policy is PolicyRow => Boolean(policy));
        const currentVersionFail = currentVersionTrialCount(
          db.raw,
          skill.id,
          skill.trialVersion,
          "fail",
        );
        const reasons: string[] = [];
        if (duplicateCandidateIds.has(skill.id)) reasons.push("duplicate_candidate");
        if (skill.sourcePolicyIds.length > 0 && sourcePolicies.length === 0) {
          reasons.push("all_source_policies_missing");
        } else if (
          sourcePolicies.length > 0 &&
          sourcePolicies.every((policy) => policy.status === "archived")
        ) {
          reasons.push("all_source_policies_archived");
        }
        if (currentVersionFail > 0) reasons.push("current_version_trial_failed");

        if (reasons.length > 0) {
          repos.skills.setStatus(skill.id, "archived", startedAt);
          skillChanges.push({
            id: skill.id,
            beforeStatus: skill.status,
            afterStatus: "archived",
            beforeTrialsAttempted: skill.trialsAttempted,
            afterTrialsAttempted: skill.trialsAttempted,
            beforeTrialsPassed: skill.trialsPassed,
            afterTrialsPassed: skill.trialsPassed,
            reason: reasons.join(","),
          });
          continue;
        }

        // Historical candidate counters are not promotion authority. Keep
        // trial rows as audit evidence but require a fresh version-matched
        // trial before this candidate can become active.
        if (skill.trialsAttempted !== 0 || skill.trialsPassed !== 0) {
          resetCandidateTrials.run({ id: skill.id, updated_at: startedAt });
          skillChanges.push({
            id: skill.id,
            beforeStatus: skill.status,
            afterStatus: skill.status,
            beforeTrialsAttempted: skill.trialsAttempted,
            afterTrialsAttempted: 0,
            beforeTrialsPassed: skill.trialsPassed,
            afterTrialsPassed: 0,
            reason: "historical_candidate_requires_retrial",
          });
        }
      }

      for (const world of beforeWorldModels) {
        const sources = world.policyIds
          .map((id) => repos.policies.getById(id))
          .filter((policy): policy is PolicyRow => Boolean(policy));
        const validSourceIds = sources
          .filter((policy) =>
            policy.status === "active" &&
            policy.support >= thresholds.world.minPolicySupport &&
            policy.gain >= thresholds.world.minPolicyGain)
          .map((policy) => policy.id);
        const allArchived = sources.length > 0 &&
          sources.every((policy) => policy.status === "archived");
        const nextStatus = allArchived ? "archived" : world.status;
        const nextStaleReason = allArchived
          ? "all_sources_archived"
          : validSourceIds.length < thresholds.world.minPolicies
            ? `insufficient_valid_sources:${validSourceIds.length}/${thresholds.world.minPolicies}`
            : null;
        if (
          nextStatus === world.status &&
          nextStaleReason === (world.staleReason ?? null)
        ) {
          continue;
        }
        if (nextStatus !== world.status) {
          repos.worldModel.setStatus(world.id, nextStatus, startedAt);
        }
        if (nextStaleReason !== (world.staleReason ?? null)) {
          repos.worldModel.markStale(world.id, nextStaleReason, startedAt);
        }
        worldChanges.push({
          id: world.id,
          beforeStatus: world.status,
          afterStatus: nextStatus,
          beforeStaleReason: world.staleReason ?? null,
          afterStaleReason: nextStaleReason,
          validSourceIds,
        });
      }

      for (const id of activeSkillIds) {
        if (repos.skills.getById(id)?.status !== "active") {
          throw new Error(`active skill preservation invariant failed: ${id}`);
        }
      }
    });

    const integrity = db.raw.pragma("integrity_check") as Array<{ integrity_check: string }>;
    const schemaVersion = db.raw.prepare(
      "SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations",
    ).get() as { version: number };
    const afterSkills = repos.skills.list({ limit: 100_000 });
    const report = {
      mode: "applied",
      startedAt: new Date(startedAt).toISOString(),
      completedAt: new Date().toISOString(),
      database: options.dbFile,
      backupDir: options.backupDir,
      config: options.configFile,
      schema: {
        version: schemaVersion.version,
        migrationsApplied: migrations.applied,
      },
      thresholds,
      invariants: {
        integrityCheck: integrity.map((row) => row.integrity_check),
        activeSkillIdsPreserved: activeSkillIds,
        activeSkillCountAfter: afterSkills.filter((skill) => skill.status === "active").length,
        historicalCandidatesActivated: 0,
        physicalRowsDeleted: 0,
      },
      summary: {
        policiesChanged: policyChanges.length,
        policiesArchived: policyChanges.filter((row) =>
          row.beforeStatus !== "archived" && row.afterStatus === "archived").length,
        policyCandidatesActivated: 0,
        skillsChanged: skillChanges.length,
        candidateSkillsArchived: skillChanges.filter((row) =>
          row.beforeStatus === "candidate" && row.afterStatus === "archived").length,
        candidateSkillsResetForRetrial: skillChanges.filter((row) =>
          row.reason === "historical_candidate_requires_retrial").length,
        oldPendingTrialsInvalidated: invalidatedOldPendingTrials,
        worldModelsChanged: worldChanges.length,
        worldModelsArchived: worldChanges.filter((row) =>
          row.beforeStatus !== "archived" && row.afterStatus === "archived").length,
        worldModelsStaleOrHidden: repos.worldModel.list({ limit: 100_000 })
          .filter((world) =>
            Boolean(world.staleReason) ||
            world.confidence < thresholds.world.minConfidenceForRetrieval).length,
      },
      policyChanges,
      skillChanges,
      worldChanges,
    };
    mkdirSync(dirname(options.reportFile), { recursive: true });
    writeFileSync(options.reportFile, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    process.stdout.write(`${JSON.stringify({
      report: options.reportFile,
      schemaVersion: schemaVersion.version,
      summary: report.summary,
      invariants: report.invariants,
    }, null, 2)}\n`);
  } finally {
    db.close();
  }
}

function repairedPolicyStatus(
  policy: PolicyRow,
  support: number,
  archiveGain: number,
): PolicyRow["status"] {
  if (policy.status === "archived") return "archived";
  // Historical candidates must earn activation through new runtime evidence;
  // migration itself never promotes them in bulk.
  if (policy.status === "candidate") return "candidate";
  return policy.gain < archiveGain || support <= 0 ? "archived" : "active";
}

function duplicateCandidateIdsToArchive(skills: readonly SkillRow[]): Set<string> {
  const out = new Set<string>();
  const groups = new Map<string, SkillRow[]>();
  for (const skill of skills) {
    if (skill.status !== "candidate" || !skill.contentFingerprint) continue;
    const key = [
      skill.ownerAgentKind,
      skill.ownerProfileId,
      skill.contentFingerprint,
    ].join("\u0000");
    const group = groups.get(key) ?? [];
    group.push(skill);
    groups.set(key, group);
  }
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    group.sort((left, right) =>
      right.version - left.version || right.updatedAt - left.updatedAt);
    for (const duplicate of group.slice(1)) out.add(duplicate.id);
  }
  return out;
}

function currentVersionTrialCount(
  db: import("better-sqlite3").Database,
  skillId: string,
  skillVersion: number,
  status: "pass" | "fail",
): number {
  return (db.prepare(`
    SELECT COUNT(*) AS n
      FROM skill_trials
     WHERE skill_id=@skill_id
       AND skill_version=@skill_version
       AND status=@status
  `).get({
    skill_id: skillId,
    skill_version: skillVersion,
    status,
  }) as { n: number }).n;
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  return left.every((value, index) => value === right[index]);
}

function assertSafeToApply(options: CliOptions): void {
  if (!options.apply) {
    throw new Error("refusing to mutate data without --apply");
  }
  if (!existsSync(options.dbFile)) {
    throw new Error(`database not found: ${options.dbFile}`);
  }
  for (const name of ["memos.db", "memos.db-wal"]) {
    const file = resolve(options.backupDir, name);
    if (!existsSync(file)) throw new Error(`required backup not found: ${file}`);
  }
}

function loadThresholds(configFile: string): Thresholds {
  if (!existsSync(configFile)) return structuredClone(DEFAULT_THRESHOLDS);
  const parsed = YAML.parse(readFileSync(configFile, "utf8")) as {
    algorithm?: {
      l2Induction?: Record<string, unknown>;
      l3Abstraction?: Record<string, unknown>;
    };
  };
  const l2 = parsed.algorithm?.l2Induction ?? {};
  const l3 = parsed.algorithm?.l3Abstraction ?? {};
  return {
    policy: {
      archiveGain: finiteNumber(l2.archiveGain, DEFAULT_THRESHOLDS.policy.archiveGain),
    },
    world: {
      minPolicies: finiteNumber(l3.minPolicies, DEFAULT_THRESHOLDS.world.minPolicies),
      minPolicyGain: finiteNumber(
        l3.minPolicyGain,
        DEFAULT_THRESHOLDS.world.minPolicyGain,
      ),
      minPolicySupport: finiteNumber(
        l3.minPolicySupport,
        DEFAULT_THRESHOLDS.world.minPolicySupport,
      ),
      minConfidenceForRetrieval: finiteNumber(
        l3.minConfidenceForRetrieval,
        DEFAULT_THRESHOLDS.world.minConfidenceForRetrieval,
      ),
    },
  };
}

function finiteNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function parseArgs(args: readonly string[]): CliOptions {
  let apply = false;
  let backupDir = "";
  let configFile = resolve(process.cwd(), "config.yaml");
  let dbFile = resolve(process.cwd(), "data", "memos.db");
  let reportFile = "";
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--apply") apply = true;
    else if (arg === "--backup-dir") backupDir = resolve(requireArg(args, ++index, arg));
    else if (arg === "--config") configFile = resolve(requireArg(args, ++index, arg));
    else if (arg === "--db") dbFile = resolve(requireArg(args, ++index, arg));
    else if (arg === "--report") reportFile = resolve(requireArg(args, ++index, arg));
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (!backupDir) throw new Error("--backup-dir is required");
  if (!reportFile) reportFile = resolve(backupDir, "migration-report.json");
  return { apply, backupDir, configFile, dbFile, reportFile };
}

function requireArg(args: readonly string[], index: number, flag: string): string {
  const value = args[index];
  if (!value) throw new Error(`${flag} requires a value`);
  return value;
}

main();
