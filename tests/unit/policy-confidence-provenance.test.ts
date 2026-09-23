import { describe, expect, it } from "vitest";

import { makeRepos, openDb, runMigrations } from "../../core/storage/index.js";
import type { PolicyRow } from "../../core/types.js";

function policy(id: string, patch: Partial<PolicyRow> = {}): PolicyRow {
  return {
    id,
    title: id,
    trigger: "when tested",
    procedure: "perform the test",
    verification: "inspect the row",
    boundary: "unit test",
    support: 1,
    gain: 0.1,
    status: "active",
    experienceType: "success_pattern",
    evidencePolarity: "positive",
    salience: 0,
    sourceEpisodeIds: [],
    inducedBy: "test",
    decisionGuidance: { preference: [], antiPattern: [] },
    vec: null,
    createdAt: 1,
    updatedAt: 1,
    contentVersion: 1,
    contentUpdatedAt: 1,
    statsUpdatedAt: 1,
    contentFingerprint: `fp-${id}`,
    ...patch,
  } as PolicyRow;
}

describe("policy confidence provenance", () => {
  it("preserves unscored L2 confidence separately from a deliberate 0.5", () => {
    const db = openDb({ filepath: ":memory:", agent: "test", wal: false });
    runMigrations(db);
    const repos = makeRepos(db);
    repos.policies.insert(policy("unscored", {
      confidence: undefined,
      confidenceScored: false,
    }));
    repos.policies.insert(policy("feedback", {
      experienceType: "repair_instruction",
      confidence: 0.5,
      confidenceScored: true,
    }));

    expect(repos.policies.getById("unscored" as PolicyRow["id"])).toMatchObject({
      confidence: undefined,
      confidenceScored: false,
    });
    expect(repos.policies.getById("feedback" as PolicyRow["id"])).toMatchObject({
      confidence: 0.5,
      confidenceScored: true,
    });
    db.close();
  });
});
