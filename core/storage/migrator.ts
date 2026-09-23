/**
 * Idempotent schema migrator.
 *
 * On open:
 *   1. Ensure the `schema_migrations` table exists.
 *   2. Enumerate `migrations/*.sql` (in lexicographic order).
 *   3. For each not-yet-applied file, run it inside a transaction.
 *   4. Insert a row into `schema_migrations` (version, name, applied_at).
 *   5. Mark the StorageDb as "ready".
 *
 * Migrations are **additive only**. Renames / drops need a major version bump.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { now } from "../time.js";
import { rootLogger } from "../logger/index.js";
import { contentFingerprint } from "../util/content-fingerprint.js";
import { markReady } from "./connection.js";
import type { StorageDb } from "./types.js";

const log = rootLogger.child({ channel: "storage.migration" });

const MIGRATION_FILE_PATTERN = /^(\d{3})-([a-z0-9][a-z0-9-]*)\.sql$/i;

export interface MigrationFile {
  version: number;
  name: string;
  fullPath: string;
}

export interface MigrationsResult {
  applied: Array<{ version: number; name: string; durationMs: number }>;
  skipped: number;
  total: number;
}

/**
 * Resolve the `migrations/` directory next to this file. Works both when the
 * package is run via `tsx` (source) and when it's bundled/compiled, because
 * we ship the `.sql` files as runtime assets (see `package.json#files`).
 */
export function defaultMigrationsDir(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const compiled = path.join(here, "migrations");
  const source = path.resolve(here, "..", "..", "..", "core", "storage", "migrations");

  // Installed development checkouts can contain a freshly compiled runtime
  // beside newer source migrations when the package-only asset copier is not
  // available. Prefer whichever complete directory has the newest migration;
  // released packages normally have identical directories and keep using the
  // compiled one.
  if (fs.existsSync(source)
      && (!fs.existsSync(compiled) || highestMigrationVersion(source) > highestMigrationVersion(compiled))) {
    return source;
  }
  return compiled;
}

function highestMigrationVersion(dir: string): number {
  try {
    return fs.readdirSync(dir).reduce((highest, filename) => {
      const match = MIGRATION_FILE_PATTERN.exec(filename);
      return match ? Math.max(highest, Number(match[1])) : highest;
    }, 0);
  } catch {
    return 0;
  }
}

export function discoverMigrations(dir: string): MigrationFile[] {
  if (!fs.existsSync(dir)) {
    throw new Error(`[storage.migration] migrations dir does not exist: ${dir}`);
  }
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const files: MigrationFile[] = [];
  for (const e of entries) {
    if (!e.isFile()) continue;
    const m = MIGRATION_FILE_PATTERN.exec(e.name);
    if (!m) continue;
    const version = Number(m[1]);
    const name = m[2];
    files.push({ version, name, fullPath: path.join(dir, e.name) });
  }
  files.sort((a, b) => a.version - b.version);
  assertMonotonic(files);
  return files;
}

function assertMonotonic(files: MigrationFile[]): void {
  const seen = new Set<number>();
  for (const f of files) {
    if (seen.has(f.version)) {
      throw new Error(
        `[storage.migration] duplicate migration version ${f.version} (${f.fullPath})`,
      );
    }
    seen.add(f.version);
  }
}

/**
 * Run every not-yet-applied migration found under `dir`. Returns a summary.
 * Idempotent.
 */
export function runMigrations(db: StorageDb, dir: string = defaultMigrationsDir()): MigrationsResult {
  ensureSchemaMigrationsTable(db);
  const allFiles = discoverMigrations(dir);
  const appliedVersions = getAppliedVersions(db);

  const applied: MigrationsResult["applied"] = [];
  let skipped = 0;

  // better-sqlite3 ≥ v11 enables SQLITE_DBCONFIG_DEFENSIVE by default, which
  // blocks writes to `sqlite_master` even when `PRAGMA writable_schema=ON`.
  // A handful of migrations need that (e.g. 012 swaps CHECK constraints
  // in-place). Migration files are shipped with the plugin and never user
  // input, so turning unsafe mode on for the migration phase is safe.
  // `.unsafeMode()` may not be toggled inside a transaction, so we flip it
  // at the outer boundary.
  const needsUnsafe = allFiles.some(
    (f) => !appliedVersions.has(f.version) && migrationNeedsUnsafeMode(f.fullPath),
  );
  if (needsUnsafe) db.raw.unsafeMode(true);

  try {
    for (const file of allFiles) {
      if (appliedVersions.has(file.version)) {
        skipped++;
        continue;
      }
      const t0 = now();
      db.tx(() => {
        applyMigration(db, file);
        db.prepare(
          `INSERT INTO schema_migrations (version, name, applied_at) VALUES (@version, @name, @applied_at)`,
        ).run({ version: file.version, name: file.name, applied_at: now() });
      });
      const durationMs = now() - t0;
      applied.push({ version: file.version, name: file.name, durationMs });
      log.info("migration.applied", {
        version: file.version,
        name: file.name,
        durationMs,
        file: path.basename(file.fullPath),
      });
    }
  } finally {
    if (needsUnsafe) db.raw.unsafeMode(false);
  }

  ensureHubSharingSearchColumns(db);
  markReady(db);

  log.info("migrations.summary", {
    total: allFiles.length,
    applied: applied.length,
    skipped,
  });

  return { applied, skipped, total: allFiles.length };
}

/**
 * Detect migrations that need `SQLITE_DBCONFIG_DEFENSIVE` relaxed. We
 * look for the `writable_schema` pragma (the only legitimate reason to
 * poke `sqlite_master` from SQL).
 */
function migrationNeedsUnsafeMode(fullPath: string): boolean {
  const sql = fs.readFileSync(fullPath, "utf8");
  return /PRAGMA\s+writable_schema/i.test(sql);
}

function applyMigration(db: StorageDb, file: MigrationFile): void {
  if (file.version === 3 && file.name === "embedding-retry-lease") {
    ensureEmbeddingRetryLeaseColumns(db);
    return;
  }
  if (file.version === 4 && file.name === "skill-usage") {
    ensureSkillUsageColumns(db);
    return;
  }
  if (file.version === 5 && file.name === "skill-trials") {
    if (tableExists(db, "skills") && tableExists(db, "episodes") && tableExists(db, "traces")) {
      db.exec(fs.readFileSync(file.fullPath, "utf8"));
    }
    return;
  }
  if (file.version === 6 && file.name === "world-model-version") {
    if (tableExists(db, "world_model")) {
      ensureColumn(db, "world_model", "version", "INTEGER NOT NULL DEFAULT 1");
    }
    return;
  }
  if (file.version === 7 && file.name === "namespace-visibility") {
    ensureNamespaceVisibilityColumns(db);
    return;
  }
  if (file.version === 8 && file.name === "feedback-experience-metadata") {
    ensureFeedbackExperienceMetadataColumns(db);
    return;
  }
  if (file.version === 9 && file.name === "policies-fts") {
    if (tableExists(db, "policies")) {
      db.exec(fs.readFileSync(file.fullPath, "utf8"));
    }
    return;
  }
  if (file.version === 10 && file.name === "trace-policy-links") {
    if (tableExists(db, "traces") && tableExists(db, "policies")) {
      db.exec(fs.readFileSync(file.fullPath, "utf8"));
    }
    return;
  }
  if (file.version === 12 && file.name === "trace-turn-pagination-index") {
    if (tableExists(db, "traces")) {
      db.exec(fs.readFileSync(file.fullPath, "utf8"));
    }
    return;
  }
  if (file.version === 14 && file.name === "evolution-versioning") {
    ensureEvolutionVersioningColumns(db);
    return;
  }
  if (file.version === 15 && file.name === "monitoring-observability") {
    const requiredTables = [
      "api_logs",
      "episodes",
      "policies",
      "skills",
      "traces",
      "world_model",
    ];
    if (requiredTables.every((table) => tableExists(db, table))) {
      db.exec(fs.readFileSync(file.fullPath, "utf8"));
    }
    return;
  }
  if (file.version === 16 && file.name === "policy-confidence-provenance") {
    ensurePolicyConfidenceProvenanceColumns(db);
    return;
  }
  if (file.version === 17 && file.name === "policy-observed-gain") {
    ensurePolicyObservedGainColumns(db);
    return;
  }
  db.exec(fs.readFileSync(file.fullPath, "utf8"));
}

function ensurePolicyObservedGainColumns(db: StorageDb): void {
  if (!tableExists(db, "policies")) return;
  // A few package-era schemas omitted Gain entirely; defaulting it to zero is
  // the only honest recovery because no historical score can be reconstructed.
  ensureColumn(db, "policies", "gain", "REAL NOT NULL DEFAULT 0");
  ensureColumn(db, "policies", "base_gain", "REAL NOT NULL DEFAULT 0");
  ensureColumn(db, "policies", "actual_gain", "REAL");
  ensureColumn(
    db,
    "policies",
    "actual_usage_count",
    "INTEGER NOT NULL DEFAULT 0 CHECK (actual_usage_count >= 0)",
  );
  db.exec(`UPDATE policies
              SET base_gain=gain,
                  actual_gain=NULL,
                  actual_usage_count=0`);

  if (!tableExists(db, "episodes")) return;
  db.exec(`CREATE TABLE IF NOT EXISTS policy_exposures (
             policy_id        TEXT    NOT NULL REFERENCES policies(id) ON DELETE CASCADE,
             episode_id       TEXT    NOT NULL REFERENCES episodes(id) ON DELETE CASCADE,
             delivered_at     INTEGER NOT NULL,
             retrieval_run_id TEXT,
             PRIMARY KEY (policy_id, episode_id)
           ) STRICT;
           CREATE INDEX IF NOT EXISTS idx_policy_exposures_episode
             ON policy_exposures(episode_id, policy_id);
           CREATE INDEX IF NOT EXISTS idx_policy_exposures_policy_time
             ON policy_exposures(policy_id, delivered_at DESC);`);

  if (!tableExists(db, "retrieval_candidates") || !tableExists(db, "retrieval_runs")) return;
  db.exec(`INSERT OR IGNORE INTO policy_exposures
             (policy_id, episode_id, delivered_at, retrieval_run_id)
           SELECT c.ref_id,
                  r.episode_id,
                  COALESCE(r.acknowledged_at, r.completed_at, r.started_at),
                  r.id
             FROM retrieval_candidates c
             JOIN retrieval_runs r ON r.id=c.run_id
             JOIN policies p ON p.id=c.ref_id
            WHERE c.ref_kind='experience'
              AND c.adapter_received=1
              AND c.final_returned=1
              AND r.episode_id IS NOT NULL`);
}

function ensurePolicyConfidenceProvenanceColumns(db: StorageDb): void {
  if (!tableExists(db, "policies")) return;
  ensureColumn(
    db,
    "policies",
    "confidence_scored",
    "INTEGER NOT NULL DEFAULT 0 CHECK (confidence_scored IN (0,1))",
  );
  // Historical feedback experiences always carried a deliberate confidence.
  // For success-pattern L2 rows, only non-default values prove that the
  // induction model supplied a score; an exact legacy 0.5 is ambiguous and is
  // therefore presented conservatively as unscored.
  const hasExperienceType = columnExists(db, "policies", "experience_type");
  const hasConfidence = columnExists(db, "policies", "confidence");
  if (hasExperienceType && hasConfidence) {
    db.exec(`UPDATE policies
                SET confidence_scored = CASE
                  WHEN experience_type != 'success_pattern' THEN 1
                  WHEN confidence != 0.5 THEN 1
                  ELSE 0
                END`);
  } else if (hasConfidence) {
    db.exec(`UPDATE policies
                SET confidence_scored = CASE WHEN confidence != 0.5 THEN 1 ELSE 0 END`);
  }
}

function ensureEvolutionVersioningColumns(db: StorageDb): void {
  if (tableExists(db, "policies")) {
    ensureColumn(db, "policies", "content_version", "INTEGER NOT NULL DEFAULT 1");
    ensureColumn(db, "policies", "content_updated_at", "INTEGER NOT NULL DEFAULT 0");
    ensureColumn(db, "policies", "stats_updated_at", "INTEGER NOT NULL DEFAULT 0");
    ensureColumn(db, "policies", "content_fingerprint", "TEXT NOT NULL DEFAULT ''");
    db.exec(`UPDATE policies
                SET content_updated_at = CASE WHEN content_updated_at = 0 THEN updated_at ELSE content_updated_at END,
                    stats_updated_at = CASE WHEN stats_updated_at = 0 THEN updated_at ELSE stats_updated_at END`);
    backfillPolicyFingerprints(db);
  }
  if (tableExists(db, "skills")) {
    db.exec(`DROP INDEX IF EXISTS uq_skills_owner_name`);
    ensureColumn(db, "skills", "supersedes_skill_id", "TEXT REFERENCES skills(id) ON DELETE SET NULL");
    ensureColumn(
      db,
      "skills",
      "source_policy_versions_json",
      "TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(source_policy_versions_json))",
    );
    ensureColumn(db, "skills", "content_fingerprint", "TEXT NOT NULL DEFAULT ''");
    ensureColumn(db, "skills", "trial_version", "INTEGER NOT NULL DEFAULT 1");
    db.exec(`UPDATE skills SET trial_version = CASE
               WHEN trial_version = 1 AND version > 1 THEN version
               ELSE trial_version
             END`);
    backfillSkillVersionMetadata(db);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_skills_supersedes ON skills(supersedes_skill_id, status)`);
    db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS uq_skills_owner_active_name
               ON skills(owner_agent_kind, owner_profile_id, name)
               WHERE status = 'active'`);
  }
  if (tableExists(db, "skill_trials")) {
    ensureColumn(db, "skill_trials", "skill_version", "INTEGER NOT NULL DEFAULT 1");
  }
  if (tableExists(db, "world_model")) {
    ensureColumn(db, "world_model", "cluster_fingerprint", "TEXT NOT NULL DEFAULT ''");
    ensureColumn(db, "world_model", "stale_reason", "TEXT");
    backfillWorldModelFingerprints(db);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_world_retrieval
               ON world_model(status, confidence DESC, updated_at DESC)`);
    db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS uq_world_cluster_fingerprint
               ON world_model(cluster_fingerprint)
               WHERE cluster_fingerprint != ''`);
  }
}

function backfillPolicyFingerprints(db: StorageDb): void {
  const rows = db.prepare<unknown, {
    id: string;
    title: string;
    trigger: string;
    procedure: string;
    verification: string;
    boundary: string;
    decision_guidance_json: string;
  }>(`SELECT id, title, trigger, procedure, verification, boundary,
             decision_guidance_json
        FROM policies
       WHERE content_fingerprint = ''`).all();
  const update = db.prepare<{ id: string; fingerprint: string }>(
    `UPDATE policies SET content_fingerprint=@fingerprint WHERE id=@id`,
  );
  for (const row of rows) {
    update.run({
      id: row.id,
      fingerprint: contentFingerprint({
        title: row.title,
        trigger: row.trigger,
        procedure: row.procedure,
        verification: row.verification,
        boundary: row.boundary,
        decisionGuidance: parseJson(row.decision_guidance_json, {
          preference: [],
          antiPattern: [],
        }),
      }),
    });
  }
}

function backfillSkillVersionMetadata(db: StorageDb): void {
  const policyVersions = new Map(
    db.prepare<unknown, { id: string; content_version: number }>(
      `SELECT id, content_version FROM policies`,
    ).all().map((row) => [row.id, Math.max(1, row.content_version || 1)]),
  );
  const rows = db.prepare<unknown, {
    id: string;
    name: string;
    invocation_guide: string;
    procedure_json: string;
    source_policies_json: string;
    source_policy_versions_json: string;
    content_fingerprint: string;
  }>(`SELECT id, name, invocation_guide, procedure_json, source_policies_json,
             source_policy_versions_json, content_fingerprint
        FROM skills
       WHERE source_policy_versions_json = '{}' OR content_fingerprint = ''`).all();
  const update = db.prepare<{
    id: string;
    source_policy_versions_json: string;
    content_fingerprint: string;
  }>(`UPDATE skills
         SET source_policy_versions_json=@source_policy_versions_json,
             content_fingerprint=@content_fingerprint
       WHERE id=@id`);
  for (const row of rows) {
    const sourceIds = parseJson<string[]>(row.source_policies_json, []);
    const existingVersions = parseJson<Record<string, number>>(
      row.source_policy_versions_json,
      {},
    );
    const sourcePolicyContentVersions = { ...existingVersions };
    for (const id of sourceIds) {
      sourcePolicyContentVersions[id] ??= policyVersions.get(id) ?? 1;
    }
    update.run({
      id: row.id,
      source_policy_versions_json: JSON.stringify(sourcePolicyContentVersions),
      content_fingerprint: row.content_fingerprint || contentFingerprint({
        legacySkillId: row.id,
        name: row.name,
        invocationGuide: row.invocation_guide,
        procedure: parseJson(row.procedure_json, null),
        sourcePolicyContentVersions,
      }),
    });
  }
}

function backfillWorldModelFingerprints(db: StorageDb): void {
  const rows = db.prepare<unknown, {
    id: string;
    title: string;
    body: string;
    policy_ids_json: string;
    domain_tags_json: string;
    induced_by: string;
  }>(`SELECT id, title, body, policy_ids_json, domain_tags_json, induced_by
        FROM world_model
       WHERE cluster_fingerprint = ''`).all();
  const update = db.prepare<{ id: string; fingerprint: string }>(
    `UPDATE world_model SET cluster_fingerprint=@fingerprint WHERE id=@id`,
  );
  for (const row of rows) {
    update.run({
      id: row.id,
      fingerprint: contentFingerprint({
        legacyWorldModelId: row.id,
        title: row.title,
        body: row.body,
        policyIds: parseJson(row.policy_ids_json, []),
        domainTags: parseJson(row.domain_tags_json, []),
        inducedBy: row.induced_by,
      }),
    });
  }
}

function parseJson<T>(raw: string, fallback: T): T {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function ensureEmbeddingRetryLeaseColumns(db: StorageDb): void {
  const columns = new Set(
    db.prepare<unknown, { name: string }>(`PRAGMA table_info(embedding_retry_queue)`)
      .all()
      .map((row) => row.name),
  );
  if (!columns.has("claimed_by")) {
    db.exec(`ALTER TABLE embedding_retry_queue ADD COLUMN claimed_by TEXT`);
  }
  if (!columns.has("lease_until")) {
    db.exec(`ALTER TABLE embedding_retry_queue ADD COLUMN lease_until INTEGER`);
  }
}

function ensureSkillUsageColumns(db: StorageDb): void {
  const table = db
    .prepare<unknown, { name: string }>(
      `SELECT name FROM sqlite_master WHERE type='table' AND name='skills'`,
    )
    .get();
  if (!table) return;
  const columns = new Set(
    db.prepare<unknown, { name: string }>(`PRAGMA table_info(skills)`)
      .all()
      .map((row) => row.name),
  );
  if (!columns.has("usage_count")) {
    db.exec(`ALTER TABLE skills ADD COLUMN usage_count INTEGER NOT NULL DEFAULT 0`);
  }
  if (!columns.has("last_used_at")) {
    db.exec(`ALTER TABLE skills ADD COLUMN last_used_at INTEGER`);
  }
}

function ensureNamespaceVisibilityColumns(db: StorageDb): void {
  const ownerTables = [
    "sessions",
    "episodes",
    "traces",
    "policies",
    "world_model",
    "skills",
    "feedback",
    "decision_repairs",
    "l2_candidate_pool",
    "skill_trials",
    "api_logs",
    "audit_events",
  ];
  for (const table of ownerTables) {
    if (!tableExists(db, table)) continue;
    ensureColumn(db, table, "owner_agent_kind", "TEXT NOT NULL DEFAULT 'unknown'");
    ensureColumn(db, table, "owner_profile_id", "TEXT NOT NULL DEFAULT 'default'");
    ensureColumn(db, table, "owner_workspace_id", "TEXT");
  }
  // Per-row backfill of `share_scope` was originally done here with a blanket
  // `UPDATE ${table} SET share_scope='private' WHERE share_scope IS NULL`.
  // That rewrites every row of `traces` — which on busy installs is the
  // largest, fattest table (each row carries embedding BLOBs, tool-call JSON,
  // agent text, etc.). On databases past ~500 MB, the synchronous bootstrap
  // transaction would hold the connection in CPU-bound JSON-revalidation for
  // many minutes and never reach `migrations.summary`, manifesting as the
  // "bridge hangs at 100 % CPU after `sqlite.open`" regression filed as
  // https://github.com/MemTensor/MemOS/issues/1787.
  //
  // The application layer already treats NULL `share_scope` as the
  // 'private' default — see `normalizeShareScope` and the
  // `COALESCE(share_scope, 'private')` in `visibilityWhere`. Adding the
  // column with `DEFAULT 'private'` covers every NEW row, so dropping the
  // bulk UPDATE has no observable effect on behaviour. We keep the
  // `ensureColumn` calls (they're O(1) since SQLite 3.35) so the schema
  // shape is unchanged.
  for (const table of ["episodes", "traces", "policies", "world_model", "skills"]) {
    if (!tableExists(db, table)) continue;
    ensureColumn(db, table, "share_scope", "TEXT DEFAULT 'private'");
  }

  execIfTable(db, "skills", `DROP INDEX IF EXISTS uq_skills_name`);
  execIfTable(db, "sessions", `CREATE INDEX IF NOT EXISTS idx_sessions_owner ON sessions(owner_agent_kind, owner_profile_id, last_seen_at DESC)`);
  execIfTable(db, "episodes", `CREATE INDEX IF NOT EXISTS idx_episodes_owner ON episodes(owner_agent_kind, owner_profile_id, started_at DESC)`);
  execIfTable(db, "episodes", `CREATE INDEX IF NOT EXISTS idx_episodes_share ON episodes(share_scope, started_at DESC)`);
  execIfTable(db, "traces", `CREATE INDEX IF NOT EXISTS idx_traces_owner ON traces(owner_agent_kind, owner_profile_id, ts DESC)`);
  execIfTable(db, "traces", `CREATE INDEX IF NOT EXISTS idx_traces_share ON traces(share_scope, ts DESC)`);
  execIfTable(db, "policies", `CREATE INDEX IF NOT EXISTS idx_policies_owner ON policies(owner_agent_kind, owner_profile_id, updated_at DESC)`);
  execIfTable(db, "policies", `CREATE INDEX IF NOT EXISTS idx_policies_share ON policies(share_scope, updated_at DESC)`);
  execIfTable(db, "world_model", `CREATE INDEX IF NOT EXISTS idx_world_owner ON world_model(owner_agent_kind, owner_profile_id, updated_at DESC)`);
  execIfTable(db, "world_model", `CREATE INDEX IF NOT EXISTS idx_world_share ON world_model(share_scope, updated_at DESC)`);
  execIfTable(db, "skills", `CREATE UNIQUE INDEX IF NOT EXISTS uq_skills_owner_name ON skills(owner_agent_kind, owner_profile_id, name)`);
  execIfTable(db, "skills", `CREATE INDEX IF NOT EXISTS idx_skills_owner ON skills(owner_agent_kind, owner_profile_id, updated_at DESC)`);
  execIfTable(db, "skills", `CREATE INDEX IF NOT EXISTS idx_skills_share ON skills(share_scope, updated_at DESC)`);
  execIfTable(db, "feedback", `CREATE INDEX IF NOT EXISTS idx_feedback_owner ON feedback(owner_agent_kind, owner_profile_id, ts DESC)`);
  execIfTable(db, "decision_repairs", `CREATE INDEX IF NOT EXISTS idx_repairs_owner ON decision_repairs(owner_agent_kind, owner_profile_id, ts DESC)`);
  execIfTable(db, "l2_candidate_pool", `CREATE INDEX IF NOT EXISTS idx_l2_candidate_owner ON l2_candidate_pool(owner_agent_kind, owner_profile_id, expires_at)`);
  execIfTable(db, "skill_trials", `CREATE INDEX IF NOT EXISTS idx_skill_trials_owner ON skill_trials(owner_agent_kind, owner_profile_id, created_at DESC)`);
  execIfTable(db, "api_logs", `CREATE INDEX IF NOT EXISTS idx_api_logs_owner ON api_logs(owner_agent_kind, owner_profile_id, called_at DESC)`);
  execIfTable(db, "audit_events", `CREATE INDEX IF NOT EXISTS idx_audit_owner ON audit_events(owner_agent_kind, owner_profile_id, ts DESC)`);
}

function ensureFeedbackExperienceMetadataColumns(db: StorageDb): void {
  if (!tableExists(db, "policies")) return;
  ensureColumn(
    db,
    "policies",
    "experience_type",
    `TEXT NOT NULL DEFAULT 'success_pattern'
      CHECK (experience_type IN ('success_pattern','repair_validated','failure_avoidance','repair_instruction','preference','verifier_feedback','procedural'))`,
  );
  ensureColumn(
    db,
    "policies",
    "evidence_polarity",
    `TEXT NOT NULL DEFAULT 'positive'
      CHECK (evidence_polarity IN ('positive','negative','neutral','mixed'))`,
  );
  ensureColumn(db, "policies", "salience", "REAL NOT NULL DEFAULT 0");
  ensureColumn(db, "policies", "confidence", "REAL NOT NULL DEFAULT 0.5");
  ensureColumn(
    db,
    "policies",
    "source_feedback_ids_json",
    "TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(source_feedback_ids_json))",
  );
  ensureColumn(
    db,
    "policies",
    "source_trace_ids_json",
    "TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(source_trace_ids_json))",
  );
  ensureColumn(
    db,
    "policies",
    "verifier_meta_json",
    "TEXT NOT NULL DEFAULT 'null' CHECK (json_valid(verifier_meta_json))",
  );
  ensureColumn(
    db,
    "policies",
    "skill_eligible",
    "INTEGER NOT NULL DEFAULT 1 CHECK (skill_eligible IN (0,1))",
  );
  db.exec(`CREATE INDEX IF NOT EXISTS idx_policies_experience ON policies(experience_type, evidence_polarity, updated_at DESC)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_policies_skill_eligible ON policies(skill_eligible, status, updated_at DESC)`);
}

function ensureHubSharingSearchColumns(db: StorageDb): void {
  if (!tableExists(db, "hub_shared_memories")) return;
  ensureColumn(db, "hub_shared_memories", "embedding", "BLOB");
  ensureColumn(db, "hub_shared_memories", "embedding_norm2", "REAL");
  ensureColumn(
    db,
    "hub_shared_memories",
    "visible",
    "INTEGER NOT NULL DEFAULT 1 CHECK (visible IN (0,1))",
  );
  ensureColumn(db, "hub_shared_memories", "deleted_at", "INTEGER");
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_hub_shared_memories_deleted
       ON hub_shared_memories(visible, deleted_at)
       WHERE visible = 0 AND deleted_at IS NOT NULL`,
  );
}

function execIfTable(db: StorageDb, table: string, sql: string): void {
  if (tableExists(db, table)) db.exec(sql);
}

function tableExists(db: StorageDb, table: string): boolean {
  return Boolean(
    db.prepare<{ name: string }, { name: string }>(
      `SELECT name FROM sqlite_master WHERE type='table' AND name=@name`,
    ).get({ name: table }),
  );
}

function ensureColumn(db: StorageDb, table: string, column: string, definition: string): void {
  if (!columnExists(db, table, column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

function columnExists(db: StorageDb, table: string, column: string): boolean {
  return db.prepare<unknown, { name: string }>(`PRAGMA table_info(${table})`)
    .all()
    .some((row) => row.name === column);
}

function ensureSchemaMigrationsTable(db: StorageDb): void {
  db.exec(
    `CREATE TABLE IF NOT EXISTS schema_migrations (
       version     INTEGER PRIMARY KEY,
       name        TEXT    NOT NULL,
       applied_at  INTEGER NOT NULL
     ) STRICT;`,
  );
}

function getAppliedVersions(db: StorageDb): Set<number> {
  const rows = db
    .prepare<unknown, { version: number }>(`SELECT version FROM schema_migrations`)
    .all();
  return new Set(rows.map((r) => r.version));
}

/**
 * Convenience helper for tests / CLIs: open, migrate, return.
 */
export function runMigrationsForPath(
  openFn: () => StorageDb,
  dir?: string,
): { db: StorageDb; result: MigrationsResult } {
  const db = openFn();
  try {
    const result = runMigrations(db, dir);
    return { db, result };
  } catch (err) {
    db.close();
    throw err;
  }
}
