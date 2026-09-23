import { describe, expect, it } from "vitest";

import { makeRepos, openDb, runMigrations } from "../../core/storage/index.js";
import type { WorldModelRow } from "../../core/types.js";

function world(
  id: string,
  patch: Partial<WorldModelRow> = {},
): WorldModelRow {
  return {
    id,
    title: `alpha world ${id}`,
    body: "alpha environment rule",
    structure: { environment: [], inference: [], constraints: [] },
    domainTags: ["alpha"],
    confidence: 0.8,
    policyIds: [],
    sourceEpisodeIds: [],
    inducedBy: "test",
    vec: new Float32Array([1, 0]),
    createdAt: 1,
    updatedAt: 1,
    version: 1,
    status: "active",
    clusterFingerprint: `fingerprint-${id}`,
    staleReason: null,
    ...patch,
  } as WorldModelRow;
}

describe("world-model retrieval filters", () => {
  it("excludes archived, stale, and low-confidence rows from every channel", () => {
    const db = openDb({ filepath: ":memory:", agent: "test", wal: false });
    runMigrations(db);
    const repo = makeRepos(db).worldModel;
    repo.insert(world("good"));
    repo.insert(world("archived", { status: "archived", archivedAt: 2 }));
    repo.insert(world("stale", { staleReason: "insufficient_valid_sources:0/1" }));
    repo.insert(world("low", { confidence: 0.1 }));

    const opts = { status: "active" as const, minConfidence: 0.2 };
    expect(repo.searchByVector(new Float32Array([1, 0]), 10, opts).map((hit) => hit.id))
      .toEqual(["good"]);
    expect(repo.searchByText("alpha", 10, opts).map((hit) => hit.id))
      .toEqual(["good"]);
    expect(repo.searchByPattern(["alpha"], 10, opts).map((hit) => hit.id))
      .toEqual(["good"]);
    db.close();
  });
});
