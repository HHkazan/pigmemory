import type { EpisodeId, PolicyId, TraceId } from "../../types.js";
import type { StorageDb } from "../types.js";

export function makeTracePolicyLinksRepo(db: StorageDb) {
  const insert = db.prepare<{
    trace_id: TraceId;
    policy_id: PolicyId;
    episode_id: EpisodeId;
    created_at: number;
  }>(
    `INSERT OR IGNORE INTO trace_policy_links
       (trace_id, policy_id, episode_id, created_at)
     VALUES (@trace_id, @policy_id, @episode_id, @created_at)`,
  );
  const selectTraceIds = db.prepare<{ policy_id: PolicyId }, { trace_id: TraceId }>(
    `SELECT trace_id
       FROM trace_policy_links
      WHERE policy_id=@policy_id
      ORDER BY created_at DESC, trace_id DESC`,
  );
  const selectEpisodeIds = db.prepare<{ policy_id: PolicyId }, { episode_id: EpisodeId }>(
    `SELECT DISTINCT episode_id
       FROM trace_policy_links
      WHERE policy_id=@policy_id
      ORDER BY episode_id`,
  );
  const selectPolicyIdsForTrace = db.prepare<{ trace_id: TraceId }, { policy_id: PolicyId }>(
    `SELECT DISTINCT policy_id
       FROM trace_policy_links
      WHERE trace_id=@trace_id
      ORDER BY policy_id`,
  );
  const selectPolicyIdsForEpisode = db.prepare<{ episode_id: EpisodeId }, { policy_id: PolicyId }>(
    `SELECT DISTINCT policy_id
       FROM trace_policy_links
      WHERE episode_id=@episode_id
      ORDER BY policy_id`,
  );
  const countEpisodes = db.prepare<{ policy_id: PolicyId }, { n: number }>(
    `SELECT COUNT(DISTINCT episode_id) AS n
       FROM trace_policy_links
      WHERE policy_id=@policy_id`,
  );
  const selectEpisodeValues = db.prepare<
    { policy_id: PolicyId },
    { episode_id: EpisodeId; value: number }
  >(
    `SELECT l.episode_id AS episode_id, AVG(t.value) AS value
       FROM trace_policy_links l
       JOIN traces t ON t.id = l.trace_id
      WHERE l.policy_id=@policy_id
      GROUP BY l.episode_id
      ORDER BY MAX(t.ts) DESC, l.episode_id DESC`,
  );

  return {
    link(args: {
      traceId: TraceId;
      policyId: PolicyId;
      episodeId: EpisodeId;
      now?: number;
    }): boolean {
      const result = insert.run({
        trace_id: args.traceId,
        policy_id: args.policyId,
        episode_id: args.episodeId,
        created_at: args.now ?? Date.now(),
      });
      return result.changes > 0;
    },

    getWithTraceIds(policyId: PolicyId): TraceId[] {
      return selectTraceIds.all({ policy_id: policyId }).map((r) => r.trace_id);
    },

    getLinkedEpisodeIds(policyId: PolicyId): EpisodeId[] {
      return selectEpisodeIds.all({ policy_id: policyId }).map((r) => r.episode_id);
    },

    getPolicyIdsForTrace(traceId: TraceId): PolicyId[] {
      return selectPolicyIdsForTrace.all({ trace_id: traceId }).map((r) => r.policy_id);
    },

    getPolicyIdsForEpisode(episodeId: EpisodeId): PolicyId[] {
      return selectPolicyIdsForEpisode.all({ episode_id: episodeId }).map((r) => r.policy_id);
    },

    countDistinctEpisodes(policyId: PolicyId): number {
      return countEpisodes.get({ policy_id: policyId })?.n ?? 0;
    },

    getEpisodeValues(policyId: PolicyId): Array<{ episodeId: EpisodeId; value: number }> {
      return selectEpisodeValues
        .all({ policy_id: policyId })
        .map((row) => ({ episodeId: row.episode_id, value: row.value }));
    },
  };
}
