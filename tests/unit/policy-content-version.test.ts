import { describe, expect, it } from "vitest";

import { makeRepos, openDb, runMigrations } from "../../core/storage/index.js";
import type { PolicyRow } from "../../core/types.js";

function policyRow(): PolicyRow {
  return {
    id: "policy-version-test",
    title: "Safe deployment",
    trigger: "Before deploying",
    procedure: "Run the focused tests.",
    verification: "Confirm the checks pass.",
    boundary: "Only for this repository.",
    support: 1,
    gain: 0.2,
    status: "active",
    confidence: 0.8,
    sourceEpisodeIds: ["episode-1"],
    inducedBy: "test",
    decisionGuidance: { preference: ["test first"], antiPattern: [] },
    vec: null,
    createdAt: 100,
    updatedAt: 100,
    contentVersion: 1,
    contentUpdatedAt: 100,
    statsUpdatedAt: 100,
    contentFingerprint: "",
  } as PolicyRow;
}

describe("policy content versioning", () => {
  it("separates statistics updates from material content changes", () => {
    const db = openDb({ filepath: ":memory:", agent: "test", wal: false });
    runMigrations(db);
    const repos = makeRepos(db);
    repos.policies.insert(policyRow());
    const initial = repos.policies.getById("policy-version-test")!;

    repos.policies.updateStats(initial.id, {
      support: 2,
      gain: 0.3,
      status: "active",
      sourceEpisodeIds: ["episode-1", "episode-2"],
      updatedAt: 200,
    });
    const afterStats = repos.policies.getById(initial.id)!;
    expect(afterStats.contentVersion).toBe(1);
    expect(afterStats.contentUpdatedAt).toBe(100);
    expect(afterStats.statsUpdatedAt).toBe(200);
    expect(afterStats.contentFingerprint).toBe(initial.contentFingerprint);

    repos.policies.upsert({
      ...afterStats,
      procedure: "  Run   the focused tests.  ",
      updatedAt: 300,
    });
    const afterEquivalentContent = repos.policies.getById(initial.id)!;
    expect(afterEquivalentContent.contentVersion).toBe(1);
    expect(afterEquivalentContent.contentUpdatedAt).toBe(100);

    repos.policies.upsert({
      ...afterEquivalentContent,
      procedure: "Run the focused tests, then inspect the deployment preview.",
      updatedAt: 400,
    });
    const afterContent = repos.policies.getById(initial.id)!;
    expect(afterContent.contentVersion).toBe(2);
    expect(afterContent.contentUpdatedAt).toBe(400);
    expect(afterContent.statsUpdatedAt).toBe(200);
    expect(afterContent.contentFingerprint).not.toBe(initial.contentFingerprint);
    db.close();
  });
});
