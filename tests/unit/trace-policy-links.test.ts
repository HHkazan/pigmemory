import { describe, expect, it } from "vitest";

import { openDb } from "../../core/storage/connection.js";
import { makeTracePolicyLinksRepo } from "../../core/storage/repos/trace-policy-links.js";

describe("trace-policy links", () => {
  it("reports whether a link is new", () => {
    const db = openDb({ filepath: ":memory:", agent: "test", wal: false });
    db.exec(`
      CREATE TABLE trace_policy_links (
        trace_id TEXT NOT NULL,
        policy_id TEXT NOT NULL,
        episode_id TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (trace_id, policy_id)
      );
      CREATE TABLE traces (
        id TEXT PRIMARY KEY,
        episode_id TEXT NOT NULL,
        value REAL NOT NULL,
        ts INTEGER NOT NULL
      );
      INSERT INTO traces VALUES
        ('trace-1', 'episode-1', 0.8, 1),
        ('trace-2', 'episode-1', 0.4, 2),
        ('trace-3', 'episode-2', 0.3, 3);
    `);
    const repo = makeTracePolicyLinksRepo(db);
    const args = {
      traceId: "trace-1",
      policyId: "policy-1",
      episodeId: "episode-1",
      now: 1,
    } as Parameters<typeof repo.link>[0];

    expect(repo.link(args)).toBe(true);
    expect(repo.link(args)).toBe(false);
    expect(repo.getWithTraceIds(args.policyId)).toEqual([args.traceId]);
    expect(repo.getPolicyIdsForTrace(args.traceId)).toEqual([args.policyId]);
    expect(repo.getPolicyIdsForEpisode(args.episodeId)).toEqual([args.policyId]);
    expect(repo.link({
      ...args,
      traceId: "trace-2",
      now: 2,
    })).toBe(true);
    const values = repo.getEpisodeValues(args.policyId);
    expect(values).toHaveLength(1);
    expect(values[0]?.episodeId).toBe("episode-1");
    expect(values[0]?.value).toBeCloseTo(0.6);
    db.close();
  });
});
