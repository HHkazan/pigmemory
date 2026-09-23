import { describe, expect, it } from "vitest";

import { openDb } from "../../core/storage/connection.js";
import { runMigrations } from "../../core/storage/migrator.js";

describe("evolution versioning migration", () => {
  it("backfills legacy fingerprints, source policy versions, and trial versions", () => {
    const db = openDb({ filepath: ":memory:", agent: "test", wal: false });
    db.exec(`
      CREATE TABLE schema_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at INTEGER NOT NULL
      ) STRICT;
      CREATE TABLE policies (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        trigger TEXT NOT NULL,
        procedure TEXT NOT NULL,
        verification TEXT NOT NULL,
        boundary TEXT NOT NULL,
        decision_guidance_json TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      ) STRICT;
      CREATE TABLE skills (
        id TEXT PRIMARY KEY,
        owner_agent_kind TEXT NOT NULL,
        owner_profile_id TEXT NOT NULL,
        name TEXT NOT NULL,
        status TEXT NOT NULL,
        invocation_guide TEXT NOT NULL,
        procedure_json TEXT NOT NULL,
        source_policies_json TEXT NOT NULL,
        version INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      ) STRICT;
      CREATE UNIQUE INDEX uq_skills_owner_name
        ON skills(owner_agent_kind, owner_profile_id, name);
      CREATE TABLE skill_trials (
        id TEXT PRIMARY KEY,
        skill_id TEXT NOT NULL
      ) STRICT;
      CREATE TABLE world_model (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        body TEXT NOT NULL,
        policy_ids_json TEXT NOT NULL,
        domain_tags_json TEXT NOT NULL,
        induced_by TEXT NOT NULL,
        status TEXT NOT NULL,
        confidence REAL NOT NULL,
        updated_at INTEGER NOT NULL
      ) STRICT;
      INSERT INTO policies VALUES (
        'policy-1', 'Policy', 'Trigger', 'Procedure', 'Verify', 'Boundary',
        '{"preference":[],"antiPattern":[]}', 100
      );
      INSERT INTO skills VALUES (
        'skill-1', 'hermes', 'default', 'legacy_skill', 'candidate', 'Guide',
        '{}', '["policy-1"]', 5, 100
      );
      INSERT INTO skill_trials VALUES ('trial-1', 'skill-1');
      INSERT INTO world_model VALUES (
        'world-1', 'World', 'Body', '["policy-1"]', '["test"]', 'legacy',
        'active', 0.8, 100
      );
    `);
    const migrationInsert = db.raw.prepare(
      "INSERT INTO schema_migrations(version, name, applied_at) VALUES (?, ?, 1)",
    );
    for (let version = 1; version <= 13; version += 1) {
      migrationInsert.run(version, `legacy-${version}`);
    }

    const result = runMigrations(db);
    expect(result.applied.map((migration) => migration.version)).toEqual([14, 15, 16, 17, 18, 19]);
    const migratedPolicy = db.raw.prepare(`
      SELECT content_version, content_updated_at, stats_updated_at, content_fingerprint,
             gain, base_gain, actual_gain, actual_usage_count
        FROM policies WHERE id='policy-1'
    `).get() as Record<string, unknown>;
    expect(migratedPolicy).toMatchObject({
      content_version: 1,
      content_updated_at: 100,
      stats_updated_at: 100,
      gain: 0,
      base_gain: 0,
      actual_gain: null,
      actual_usage_count: 0,
    });
    expect(String(migratedPolicy.content_fingerprint)).toHaveLength(64);

    const migratedSkill = db.raw.prepare(`
      SELECT trial_version, source_policy_versions_json, content_fingerprint
        FROM skills WHERE id='skill-1'
    `).get() as Record<string, unknown>;
    expect(migratedSkill.trial_version).toBe(5);
    expect(JSON.parse(String(migratedSkill.source_policy_versions_json))).toEqual({
      "policy-1": 1,
    });
    expect(String(migratedSkill.content_fingerprint)).toHaveLength(64);

    const migratedTrial = db.raw.prepare(
      "SELECT skill_version FROM skill_trials WHERE id='trial-1'",
    ).get() as { skill_version: number };
    expect(migratedTrial.skill_version).toBe(1);
    const migratedWorld = db.raw.prepare(
      "SELECT cluster_fingerprint FROM world_model WHERE id='world-1'",
    ).get() as { cluster_fingerprint: string };
    expect(migratedWorld.cluster_fingerprint).toHaveLength(64);
    db.close();
  });
});
