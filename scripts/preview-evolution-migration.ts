#!/usr/bin/env node

/**
 * Read-only preview for the policy/skill/world-model evolution migration.
 *
 * Safety invariants:
 *   - opens SQLite with readonly + fileMustExist;
 *   - enables PRAGMA query_only before reading;
 *   - never runs application migrations or repository writes;
 *   - prints JSON to stdout only.
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import BetterSqlite3 from "better-sqlite3";
import YAML from "yaml";

import { contentFingerprint } from "../core/util/content-fingerprint.js";

interface PreviewThresholds {
  policy: {
    minSupport: number;
    minGain: number;
    archiveGain: number;
  };
  skill: {
    minEtaForRetrieval: number;
  };
  worldModel: {
    minPolicies: number;
    minPolicySupport: number;
    minPolicyGain: number;
    minConfidenceForRetrieval: number;
  };
}

interface CliOptions {
  dbFile: string;
  configFile: string;
  pretty: boolean;
}

interface RawPolicy {
  id: string;
  title: string;
  trigger: string;
  procedure: string;
  verification: string;
  boundary: string;
  support: number;
  gain: number;
  status: "candidate" | "active" | "archived";
  source_episodes_json: string;
  decision_guidance_json: string;
  content_version: number;
  content_fingerprint: string;
}

interface PolicyPreview {
  id: string;
  title: string;
  currentSupport: number;
  distinctEpisodeSupport: number;
  supportDelta: number;
  currentStatus: RawPolicy["status"];
  predictedStatus: RawPolicy["status"];
  statusChange: string | null;
  gain: number;
  sourceEpisodeIds: string[];
  linkedEpisodeIds: string[];
  contentVersion: number;
  contentFingerprint: string;
}

interface RawSkill {
  id: string;
  owner_agent_kind: string;
  owner_profile_id: string;
  name: string;
  status: "candidate" | "active" | "archived";
  eta: number;
  source_policies_json: string;
  procedure_json: string;
  invocation_guide: string;
  updated_at: number;
  version: number;
  supersedes_skill_id: string | null;
  source_policy_versions_json: string;
  content_fingerprint: string;
  trial_version: number;
}

interface TrialSummary {
  pending: number;
  pass: number;
  fail: number;
  unknown: number;
  currentVersionPass: number;
  currentVersionFail: number;
  currentVersionPending: number;
  priorVersionPass: number;
}

interface SkillPreview {
  id: string;
  name: string;
  status: RawSkill["status"];
  eta: number;
  version: number;
  trialVersion: number;
  supersedesSkillId: string | null;
  sourcePolicyIds: string[];
  sourcePolicyContentVersions: Record<string, number>;
  contentFingerprint: string;
  trials: TrialSummary;
  recommendation: "keep" | "archive" | "activate_after_approval" | "retrial" | "pending_trial";
  invalidCandidateReasons: string[];
}

interface RawWorldModel {
  id: string;
  title: string;
  status: "active" | "archived";
  confidence: number;
  policy_ids_json: string;
  cluster_fingerprint: string;
  stale_reason: string | null;
}

const DEFAULT_THRESHOLDS: PreviewThresholds = {
  policy: { minSupport: 1, minGain: 0.02, archiveGain: -0.05 },
  skill: { minEtaForRetrieval: 0.1 },
  worldModel: {
    minPolicies: 1,
    minPolicySupport: 1,
    minPolicyGain: 0.02,
    minConfidenceForRetrieval: 0.2,
  },
};

function main(): void {
  const options = parseArgs(process.argv.slice(2));
  if (!existsSync(options.dbFile)) {
    throw new Error(`database not found: ${options.dbFile}`);
  }
  const thresholds = loadThresholds(options.configFile);
  const db = new BetterSqlite3(options.dbFile, {
    readonly: true,
    fileMustExist: true,
  });
  try {
    db.pragma("query_only = ON");
    const report = buildPreview(db, options, thresholds);
    process.stdout.write(`${JSON.stringify(report, null, options.pretty ? 2 : 0)}\n`);
  } finally {
    db.close();
  }
}

function buildPreview(
  db: BetterSqlite3.Database,
  options: CliOptions,
  thresholds: PreviewThresholds,
): Record<string, unknown> {
  const policyRows = readPolicies(db);
  const linkedEpisodes = readLinkedEpisodes(db);
  const policies = policyRows.map((row) => previewPolicy(row, linkedEpisodes.get(row.id), thresholds));
  const policyById = new Map(policyRows.map((row) => [row.id, row]));
  const trialsBySkill = readTrials(db);
  const rawSkills = readSkills(db);
  const duplicateCandidates = findDuplicateCandidates(rawSkills);
  const skills = rawSkills.map((row) =>
    previewSkill(
      row,
      trialsBySkill.get(row.id) ?? [],
      policyById,
      duplicateCandidates.get(row.id) ?? [],
      thresholds,
    ));
  const worldModels = readWorldModels(db).map((row) =>
    previewWorldModel(row, policyById, thresholds),
  );
  const schemaVersion = tableExists(db, "schema_migrations")
    ? db.prepare("SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations")
        .get() as { version: number }
    : { version: 0 };

  return {
    mode: "read-only-preview",
    generatedAt: new Date().toISOString(),
    database: resolve(options.dbFile),
    config: existsSync(options.configFile) ? resolve(options.configFile) : null,
    schemaVersion: schemaVersion.version,
    assumptions: {
      gainStrategy: "retain current policy gain; recalculate support from distinct linked episodes",
      legacyTrialVersion: "missing skill_trials.skill_version is treated as version 1",
      activationPolicy: "historical candidate skills are never auto-activated by this preview",
    },
    thresholds,
    summary: {
      policies: {
        total: policies.length,
        supportChanges: policies.filter((row) => row.supportDelta !== 0).length,
        predictedStatusChanges: policies.filter((row) => row.statusChange).length,
        predictedActivations: policies.filter((row) => row.statusChange?.endsWith("->active")).length,
        predictedArchives: policies.filter((row) => row.predictedStatus === "archived" && row.currentStatus !== "archived").length,
      },
      skills: {
        total: skills.length,
        activePreserved: skills.filter((row) => row.status === "active" && row.recommendation === "keep").length,
        candidatesToArchive: skills.filter((row) => row.status === "candidate" && row.recommendation === "archive").length,
        candidatesToRetrial: skills.filter((row) => row.status === "candidate" && row.recommendation === "retrial").length,
        candidatesPending: skills.filter((row) => row.recommendation === "pending_trial").length,
        passedCurrentVersion: skills.filter((row) => row.recommendation === "activate_after_approval").length,
        invalidCandidates: skills.filter((row) => row.invalidCandidateReasons.length > 0).length,
        duplicateRebuilds: countDuplicateRebuilds(rawSkills),
      },
      worldModels: {
        total: worldModels.length,
        predictedArchives: worldModels.filter((row) => row.predictedStatus === "archived" && row.currentStatus !== "archived").length,
        staleOrHidden: worldModels.filter((row) => row.predictedStaleReason || row.hiddenForLowConfidence).length,
        archivedOnlySources: worldModels.filter((row) => row.archivedOnlySources).length,
        lowConfidence: worldModels.filter((row) => row.hiddenForLowConfidence).length,
      },
    },
    policies,
    skills,
    worldModels,
  };
}

function readPolicies(db: BetterSqlite3.Database): RawPolicy[] {
  if (!tableExists(db, "policies")) return [];
  const columns = tableColumns(db, "policies");
  const contentVersion = columnExpr(columns, "content_version", "1");
  const fingerprint = columnExpr(columns, "content_fingerprint", "''");
  return db.prepare(`
    SELECT id, title, trigger, procedure, verification, boundary,
           support, gain, status, source_episodes_json, decision_guidance_json,
           ${contentVersion} AS content_version,
           ${fingerprint} AS content_fingerprint
      FROM policies
     ORDER BY id
  `).all() as RawPolicy[];
}

function readLinkedEpisodes(db: BetterSqlite3.Database): Map<string, string[]> {
  const out = new Map<string, string[]>();
  if (!tableExists(db, "trace_policy_links")) return out;
  const rows = db.prepare(`
    SELECT policy_id, episode_id
      FROM trace_policy_links
     GROUP BY policy_id, episode_id
     ORDER BY policy_id, episode_id
  `).all() as Array<{ policy_id: string; episode_id: string }>;
  for (const row of rows) {
    const ids = out.get(row.policy_id) ?? [];
    ids.push(row.episode_id);
    out.set(row.policy_id, ids);
  }
  return out;
}

function previewPolicy(
  row: RawPolicy,
  linked: string[] | undefined,
  thresholds: PreviewThresholds,
): PolicyPreview {
  const storedEpisodes = uniqueStrings(parseJson<string[]>(row.source_episodes_json, []));
  const linkedEpisodes = linked ? uniqueStrings(linked) : [];
  const support = linkedEpisodes.length;
  const predictedStatus = nextPolicyStatus(row.status, support, row.gain, thresholds.policy);
  const fingerprint = row.content_fingerprint || contentFingerprint({
    title: row.title,
    trigger: row.trigger,
    procedure: row.procedure,
    verification: row.verification,
    boundary: row.boundary,
    decisionGuidance: parseJson(row.decision_guidance_json, {
      preference: [],
      antiPattern: [],
    }),
  });
  return {
    id: row.id,
    title: row.title,
    currentSupport: row.support,
    distinctEpisodeSupport: support,
    supportDelta: support - row.support,
    currentStatus: row.status,
    predictedStatus,
    statusChange: predictedStatus === row.status ? null : `${row.status}->${predictedStatus}`,
    gain: row.gain,
    sourceEpisodeIds: storedEpisodes,
    linkedEpisodeIds: linkedEpisodes,
    contentVersion: Math.max(1, row.content_version || 1),
    contentFingerprint: fingerprint,
  };
}

function readSkills(db: BetterSqlite3.Database): RawSkill[] {
  if (!tableExists(db, "skills")) return [];
  const columns = tableColumns(db, "skills");
  return db.prepare(`
    SELECT id,
           ${columnExpr(columns, "owner_agent_kind", "'unknown'")} AS owner_agent_kind,
           ${columnExpr(columns, "owner_profile_id", "'default'")} AS owner_profile_id,
           name, status, eta, source_policies_json, procedure_json, invocation_guide,
           updated_at,
           ${columnExpr(columns, "version", "1")} AS version,
           ${columnExpr(columns, "supersedes_skill_id", "NULL")} AS supersedes_skill_id,
           ${columnExpr(columns, "source_policy_versions_json", "'{}'")} AS source_policy_versions_json,
           ${columnExpr(columns, "content_fingerprint", "''")} AS content_fingerprint,
           ${columnExpr(columns, "trial_version", columnExpr(columns, "version", "1"))} AS trial_version
      FROM skills
     ORDER BY owner_agent_kind, owner_profile_id, name, version, updated_at
  `).all() as RawSkill[];
}

function readTrials(db: BetterSqlite3.Database): Map<string, Array<{ status: string; skillVersion: number }>> {
  const out = new Map<string, Array<{ status: string; skillVersion: number }>>();
  if (!tableExists(db, "skill_trials")) return out;
  const columns = tableColumns(db, "skill_trials");
  const rows = db.prepare(`
    SELECT skill_id, status,
           ${columnExpr(columns, "skill_version", "1")} AS skill_version
      FROM skill_trials
     ORDER BY created_at
  `).all() as Array<{ skill_id: string; status: string; skill_version: number }>;
  for (const row of rows) {
    const list = out.get(row.skill_id) ?? [];
    list.push({ status: row.status, skillVersion: row.skill_version || 1 });
    out.set(row.skill_id, list);
  }
  return out;
}

function previewSkill(
  row: RawSkill,
  trials: Array<{ status: string; skillVersion: number }>,
  policies: Map<string, RawPolicy>,
  duplicateReasons: string[],
  thresholds: PreviewThresholds,
): SkillPreview {
  const sourcePolicyIds = uniqueStrings(parseJson<string[]>(row.source_policies_json, []));
  const sourcePolicyContentVersions = parseJson<Record<string, number>>(
    row.source_policy_versions_json,
    {},
  );
  const trialVersion = Math.max(1, row.trial_version || row.version || 1);
  const trialSummary = summarizeTrials(trials, trialVersion);
  const invalidCandidateReasons = [...duplicateReasons];
  const knownSources = sourcePolicyIds.map((id) => policies.get(id)).filter(Boolean) as RawPolicy[];
  if (sourcePolicyIds.length > 0 && knownSources.length === 0) {
    invalidCandidateReasons.push("all_source_policies_missing");
  } else if (
    knownSources.length > 0 &&
    knownSources.every((policy) => policy.status === "archived")
  ) {
    invalidCandidateReasons.push("all_source_policies_archived");
  }
  const fingerprint = row.content_fingerprint || contentFingerprint({
    name: row.name,
    invocationGuide: row.invocation_guide,
    procedure: parseJson(row.procedure_json, null),
    sourcePolicyContentVersions,
  });

  let recommendation: SkillPreview["recommendation"] = "keep";
  if (row.status === "candidate") {
    if (
      invalidCandidateReasons.length > 0 ||
      trialSummary.currentVersionFail > 0
    ) {
      recommendation = "archive";
    } else if (trialSummary.currentVersionPass > 0) {
      recommendation = row.eta >= thresholds.skill.minEtaForRetrieval
        ? "activate_after_approval"
        : "retrial";
    } else if (trialSummary.currentVersionPending > 0) {
      recommendation = "pending_trial";
    } else {
      recommendation = "retrial";
    }
  }
  return {
    id: row.id,
    name: row.name,
    status: row.status,
    eta: row.eta,
    version: Math.max(1, row.version || 1),
    trialVersion,
    supersedesSkillId: row.supersedes_skill_id,
    sourcePolicyIds,
    sourcePolicyContentVersions,
    contentFingerprint: fingerprint,
    trials: trialSummary,
    recommendation,
    invalidCandidateReasons: uniqueStrings(invalidCandidateReasons),
  };
}

function summarizeTrials(
  trials: Array<{ status: string; skillVersion: number }>,
  currentVersion: number,
): TrialSummary {
  const summary: TrialSummary = {
    pending: 0,
    pass: 0,
    fail: 0,
    unknown: 0,
    currentVersionPass: 0,
    currentVersionFail: 0,
    currentVersionPending: 0,
    priorVersionPass: 0,
  };
  for (const trial of trials) {
    if (trial.status === "pending") summary.pending += 1;
    else if (trial.status === "pass") summary.pass += 1;
    else if (trial.status === "fail") summary.fail += 1;
    else summary.unknown += 1;
    if (trial.skillVersion === currentVersion) {
      if (trial.status === "pass") summary.currentVersionPass += 1;
      if (trial.status === "fail") summary.currentVersionFail += 1;
      if (trial.status === "pending") summary.currentVersionPending += 1;
    } else if (trial.status === "pass") {
      summary.priorVersionPass += 1;
    }
  }
  return summary;
}

function findDuplicateCandidates(skills: RawSkill[]): Map<string, string[]> {
  const out = new Map<string, string[]>();
  const groups = new Map<string, RawSkill[]>();
  for (const skill of skills) {
    if (skill.status !== "candidate") continue;
    const fallbackFingerprint = contentFingerprint({
      name: skill.name,
      invocationGuide: skill.invocation_guide,
      procedure: parseJson(skill.procedure_json, null),
      sourcePolicyContentVersions: parseJson(skill.source_policy_versions_json, {}),
    });
    const key = [
      skill.owner_agent_kind,
      skill.owner_profile_id,
      skill.name,
      skill.content_fingerprint || fallbackFingerprint,
    ].join("\u0000");
    const group = groups.get(key) ?? [];
    group.push(skill);
    groups.set(key, group);
  }
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    group.sort((left, right) => right.version - left.version || right.updated_at - left.updated_at);
    const keep = group[0]!;
    for (const duplicate of group.slice(1)) {
      out.set(duplicate.id, [`duplicate_candidate_of:${keep.id}`]);
    }
  }
  return out;
}

function countDuplicateRebuilds(skills: RawSkill[]): number {
  const groups = new Map<string, number>();
  for (const skill of skills) {
    const key = [skill.owner_agent_kind, skill.owner_profile_id, skill.name].join("\u0000");
    groups.set(key, (groups.get(key) ?? 0) + 1);
  }
  let count = 0;
  for (const size of groups.values()) count += Math.max(0, size - 1);
  return count;
}

function readWorldModels(db: BetterSqlite3.Database): RawWorldModel[] {
  if (!tableExists(db, "world_model")) return [];
  const columns = tableColumns(db, "world_model");
  return db.prepare(`
    SELECT id, title,
           ${columnExpr(columns, "status", "'active'")} AS status,
           ${columnExpr(columns, "confidence", "0.5")} AS confidence,
           policy_ids_json,
           ${columnExpr(columns, "cluster_fingerprint", "''")} AS cluster_fingerprint,
           ${columnExpr(columns, "stale_reason", "NULL")} AS stale_reason
      FROM world_model
     ORDER BY id
  `).all() as RawWorldModel[];
}

function previewWorldModel(
  row: RawWorldModel,
  policies: Map<string, RawPolicy>,
  thresholds: PreviewThresholds,
): Record<string, unknown> {
  const sourcePolicyIds = uniqueStrings(parseJson<string[]>(row.policy_ids_json, []));
  const knownSources = sourcePolicyIds.map((id) => policies.get(id)).filter(Boolean) as RawPolicy[];
  const validSourceIds = knownSources.filter((policy) =>
    policy.status === "active" &&
    policy.support >= thresholds.worldModel.minPolicySupport &&
    policy.gain >= thresholds.worldModel.minPolicyGain
  ).map((policy) => policy.id);
  const invalidSourceIds = sourcePolicyIds.filter((id) => !validSourceIds.includes(id));
  const archivedOnlySources = knownSources.length > 0 &&
    knownSources.every((policy) => policy.status === "archived");
  const predictedStatus = archivedOnlySources ? "archived" : row.status;
  const predictedStaleReason = archivedOnlySources
    ? "all_sources_archived"
    : validSourceIds.length < thresholds.worldModel.minPolicies
      ? `insufficient_valid_sources:${validSourceIds.length}/${thresholds.worldModel.minPolicies}`
      : null;
  return {
    id: row.id,
    title: row.title,
    currentStatus: row.status,
    predictedStatus,
    currentStaleReason: row.stale_reason,
    predictedStaleReason,
    confidence: row.confidence,
    hiddenForLowConfidence:
      row.confidence < thresholds.worldModel.minConfidenceForRetrieval,
    sourcePolicyIds,
    validSourceIds,
    invalidSourceIds,
    archivedOnlySources,
    clusterFingerprint: row.cluster_fingerprint,
  };
}

function nextPolicyStatus(
  status: RawPolicy["status"],
  support: number,
  gain: number,
  thresholds: PreviewThresholds["policy"],
): RawPolicy["status"] {
  if (status === "archived") return "archived";
  if (status === "candidate") {
    return support >= thresholds.minSupport && gain >= thresholds.minGain
      ? "active"
      : "candidate";
  }
  return gain < thresholds.archiveGain || support <= 0 ? "archived" : "active";
}

function loadThresholds(configFile: string): PreviewThresholds {
  if (!existsSync(configFile)) return structuredClone(DEFAULT_THRESHOLDS);
  try {
    const parsed = YAML.parse(readFileSync(configFile, "utf8")) as {
      algorithm?: {
        l2Induction?: Record<string, unknown>;
        l3Abstraction?: Record<string, unknown>;
        skill?: Record<string, unknown>;
      };
    };
    const l2 = parsed.algorithm?.l2Induction ?? {};
    const l3 = parsed.algorithm?.l3Abstraction ?? {};
    const skill = parsed.algorithm?.skill ?? {};
    return {
      policy: {
        minSupport: finiteNumber(skill.minSupport, DEFAULT_THRESHOLDS.policy.minSupport),
        minGain: finiteNumber(skill.minGain, DEFAULT_THRESHOLDS.policy.minGain),
        archiveGain: finiteNumber(l2.archiveGain, DEFAULT_THRESHOLDS.policy.archiveGain),
      },
      skill: {
        minEtaForRetrieval: finiteNumber(
          skill.minEtaForRetrieval,
          DEFAULT_THRESHOLDS.skill.minEtaForRetrieval,
        ),
      },
      worldModel: {
        minPolicies: finiteNumber(l3.minPolicies, DEFAULT_THRESHOLDS.worldModel.minPolicies),
        minPolicySupport: finiteNumber(
          l3.minPolicySupport,
          DEFAULT_THRESHOLDS.worldModel.minPolicySupport,
        ),
        minPolicyGain: finiteNumber(
          l3.minPolicyGain,
          DEFAULT_THRESHOLDS.worldModel.minPolicyGain,
        ),
        minConfidenceForRetrieval: finiteNumber(
          l3.minConfidenceForRetrieval,
          DEFAULT_THRESHOLDS.worldModel.minConfidenceForRetrieval,
        ),
      },
    };
  } catch {
    return structuredClone(DEFAULT_THRESHOLDS);
  }
}

function parseArgs(args: string[]): CliOptions {
  let dbFile = resolve(process.cwd(), "data", "memos.db");
  let configFile = resolve(process.cwd(), "config.yaml");
  let pretty = true;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--db") {
      dbFile = resolve(requireArg(args, ++index, "--db"));
    } else if (arg === "--config") {
      configFile = resolve(requireArg(args, ++index, "--config"));
    } else if (arg === "--compact") {
      pretty = false;
    } else if (arg === "--help" || arg === "-h") {
      process.stdout.write(
        "Usage: npm run preview:evolution -- [--db path] [--config path] [--compact]\n",
      );
      process.exit(0);
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return { dbFile, configFile, pretty };
}

function requireArg(args: string[], index: number, flag: string): string {
  const value = args[index];
  if (!value) throw new Error(`${flag} requires a path`);
  return value;
}

function tableExists(db: BetterSqlite3.Database, table: string): boolean {
  return Boolean(
    db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?")
      .get(table),
  );
}

function tableColumns(db: BetterSqlite3.Database, table: string): Set<string> {
  const rows = db.pragma(`table_info(${table})`) as Array<{ name: string }>;
  return new Set(rows.map((row) => row.name));
}

function columnExpr(columns: Set<string>, name: string, fallback: string): string {
  return columns.has(name) ? name : fallback;
}

function parseJson<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function uniqueStrings(values: readonly string[]): string[] {
  return Array.from(new Set(values.map(String).filter(Boolean)));
}

function finiteNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

main();
