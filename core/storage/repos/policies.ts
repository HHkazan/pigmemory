import type { EmbeddingVector, PolicyId, PolicyRow, ShareScope } from "../../types.js";
import type { PolicyListFilter, StorageDb } from "../types.js";
import { buildInsert, buildUpdate, buildUpsert } from "../tx.js";
import { scanAndTopK, type VectorHit } from "../vector.js";
import { contentFingerprint } from "../../util/content-fingerprint.js";
import {
  buildPageClauses,
  fromBlob,
  fromJsonText,
  joinWhere,
  normalizeShareForStorage,
  ownerFieldsFromRaw,
  ownerParamsFromRow,
  timeRangeWhere,
  toBlob,
  toJsonText,
} from "./_helpers.js";

const COLUMNS = [
  "id",
  "owner_agent_kind",
  "owner_profile_id",
  "owner_workspace_id",
  "title",
  "trigger",
  "procedure",
  "verification",
  "boundary",
  "support",
  "gain",
  "base_gain",
  "actual_gain",
  "actual_usage_count",
  "status",
  "experience_type",
  "evidence_polarity",
  "salience",
  "confidence",
  "confidence_scored",
  "source_episodes_json",
  "source_feedback_ids_json",
  "source_trace_ids_json",
  "induced_by",
  "decision_guidance_json",
  "verifier_meta_json",
  "skill_eligible",
  "vec",
  "created_at",
  "updated_at",
  "content_version",
  "content_updated_at",
  "stats_updated_at",
  "content_fingerprint",
  "share_scope",
  "share_target",
  "shared_at",
  "edited_at",
];

export interface PolicySearchMeta {
  title: string;
  status: "candidate" | "active" | "archived";
  support: number;
  gain: number;
  experience_type?: NonNullable<PolicyRow["experienceType"]>;
  evidence_polarity?: NonNullable<PolicyRow["evidencePolarity"]>;
  salience?: number;
  confidence?: number;
  confidence_scored?: number;
  owner_agent_kind?: string;
  owner_profile_id?: string;
  owner_workspace_id?: string | null;
}

export function makePoliciesRepo(db: StorageDb) {
  const insert = db.prepare(buildInsert({ table: "policies", columns: COLUMNS }));
  const upsertStmt = db.prepare(buildUpsert({ table: "policies", columns: COLUMNS }));
  const updateStats = db.prepare(
    buildUpdate({
      table: "policies",
      columns: [
        "id",
        "support",
        "gain",
        "base_gain",
        "actual_gain",
        "actual_usage_count",
        "status",
        "source_episodes_json",
        "updated_at",
        "stats_updated_at",
      ],
    }),
  );
  const selectById = db.prepare<{ id: string }, RawPolicyRow>(
    `SELECT ${COLUMNS.join(", ")} FROM policies WHERE id=@id`,
  );
  const selectExposureEpisodeValues = db.prepare<
    { policy_id: string },
    { episode_id: string; value: number }
  >(
    `SELECT x.episode_id AS episode_id, AVG(t.value) AS value
       FROM policy_exposures x
       JOIN traces t ON t.episode_id = x.episode_id
      WHERE x.policy_id=@policy_id
      GROUP BY x.episode_id
      ORDER BY MAX(t.ts) DESC, x.episode_id DESC`,
  );
  const selectExposedPolicyIdsForEpisode = db.prepare<
    { episode_id: string },
    { policy_id: string }
  >(
    `SELECT DISTINCT policy_id
       FROM policy_exposures
      WHERE episode_id=@episode_id
      ORDER BY policy_id`,
  );

  return {
    insert(row: PolicyRow): void {
      insert.run(rowToParams(preparePolicyForWrite(row, null)));
    },

    upsert(row: PolicyRow): void {
      const existingRaw = selectById.get({ id: row.id });
      const existing = existingRaw ? mapRow(existingRaw) : null;
      upsertStmt.run(rowToParams(preparePolicyForWrite(row, existing)));
    },

    updateStats(
      id: PolicyId,
      p: {
        support: number;
        gain: number;
        baseGain?: number;
        actualGain?: number | null;
        actualUsageCount?: number;
        status: PolicyRow["status"];
        sourceEpisodeIds: PolicyRow["sourceEpisodeIds"];
        updatedAt: number;
      },
    ): void {
      const current = selectById.get({ id });
      updateStats.run({
        id,
        support: p.support,
        gain: p.gain,
        base_gain: p.baseGain ?? current?.base_gain ?? p.gain,
        actual_gain: p.actualGain === undefined
          ? current?.actual_gain ?? null
          : p.actualGain,
        actual_usage_count:
          p.actualUsageCount ?? current?.actual_usage_count ?? 0,
        status: p.status,
        source_episodes_json: toJsonText(p.sourceEpisodeIds),
        updated_at: p.updatedAt,
        stats_updated_at: p.updatedAt,
      });
    },

    getExposureEpisodeValues(
      policyId: PolicyId,
    ): Array<{ episodeId: string; value: number }> {
      return selectExposureEpisodeValues
        .all({ policy_id: policyId })
        .map((row) => ({ episodeId: row.episode_id, value: row.value }));
    },

    getExposedPolicyIdsForEpisode(episodeId: string): PolicyId[] {
      return selectExposedPolicyIdsForEpisode
        .all({ episode_id: episodeId })
        .map((row) => row.policy_id as PolicyId);
    },

    getById(id: PolicyId): PolicyRow | null {
      const r = selectById.get({ id });
      if (!r) return null;
      return mapRow(r);
    },

    list(filter: PolicyListFilter = {}): PolicyRow[] {
      const tr = timeRangeWhere(filter, "updated_at");
      const fragments: string[] = [];
      const params: Record<string, unknown> = { ...tr.params };
      if (filter.status) {
        fragments.push(`status = @status`);
        params.status = filter.status;
      }
      if (filter.minSupport !== undefined) {
        fragments.push(`support >= @min_support`);
        params.min_support = filter.minSupport;
      }
      if (tr.sql) fragments.push(tr.sql);
      const where = joinWhere(fragments);
      const page = buildPageClauses(filter, "updated_at");
      const sql = `SELECT ${COLUMNS.join(", ")} FROM policies ${where} ${page}`;
      return db.prepare<typeof params, RawPolicyRow>(sql).all(params).map(mapRow);
    },

    count(filter: Omit<PolicyListFilter, "limit" | "offset"> = {}): number {
      const tr = timeRangeWhere(filter, "updated_at");
      const fragments: string[] = [];
      const params: Record<string, unknown> = { ...tr.params };
      if (filter.status) {
        fragments.push(`status = @status`);
        params.status = filter.status;
      }
      if (filter.minSupport !== undefined) {
        fragments.push(`support >= @min_support`);
        params.min_support = filter.minSupport;
      }
      if (tr.sql) fragments.push(tr.sql);
      const where = joinWhere(fragments);
      const sql = `SELECT COUNT(*) AS n FROM policies ${where}`;
      return db.prepare<typeof params, { n: number }>(sql).get(params)?.n ?? 0;
    },

    searchByVector(
      query: EmbeddingVector,
      k: number,
      opts: { statusIn?: PolicyRow["status"][]; hardCap?: number } = {},
    ): Array<VectorHit<string, PolicySearchMeta>> {
      const statusIn = opts.statusIn;
      const whereParts: string[] = ["vec IS NOT NULL"];
      const params: Record<string, unknown> = {};
      if (statusIn && statusIn.length > 0) {
        const placeholders = statusIn.map((_, i) => `@status_${i}`).join(",");
        whereParts.push(`status IN (${placeholders})`);
        statusIn.forEach((s, i) => {
          params[`status_${i}`] = s;
        });
      }
      return scanAndTopK<PolicySearchMeta>(
        db,
        "policies",
        [
          "title",
          "status",
          "support",
          "gain",
          "experience_type",
          "evidence_polarity",
          "salience",
          "confidence",
          "owner_agent_kind",
          "owner_profile_id",
          "owner_workspace_id",
        ],
        query,
        k,
        {
          vecColumn: "vec",
          where: whereParts.join(" AND "),
          params,
          hardCap: opts.hardCap,
        },
      );
    },

    /**
     * Keyword channel — FTS5 trigram MATCH against `policies_fts`.
     * Indexes the same user-facing fields the prompt renderer injects:
     * title, trigger, procedure, verification, boundary and guidance.
     */
    searchByText(
      ftsMatch: string,
      k: number,
      opts: { statusIn?: PolicyRow["status"][] } = {},
    ): Array<VectorHit<string, PolicySearchMeta>> {
      if (!ftsMatch || k <= 0) return [];
      const params: Record<string, unknown> = {
        match: ftsMatch,
        k: Math.max(1, Math.min(200, Math.floor(k))),
      };
      const whereParts: string[] = [];
      if (opts.statusIn && opts.statusIn.length > 0) {
        const placeholders = opts.statusIn.map((_, i) => `@status_${i}`).join(",");
        whereParts.push(`p.status IN (${placeholders})`);
        opts.statusIn.forEach((st, i) => {
          params[`status_${i}`] = st;
        });
      }
      const extra = whereParts.length > 0 ? ` AND ${whereParts.join(" AND ")}` : "";
      const sql = `
        SELECT p.id AS id,
               p.title AS title,
               p.status AS status,
               p.support AS support,
               p.gain AS gain,
               p.experience_type AS experience_type,
               p.evidence_polarity AS evidence_polarity,
               p.salience AS salience,
               p.confidence AS confidence,
               p.owner_agent_kind AS owner_agent_kind,
               p.owner_profile_id AS owner_profile_id,
               p.owner_workspace_id AS owner_workspace_id
          FROM policies_fts f
          JOIN policies     p ON p.id = f.policy_id
         WHERE policies_fts MATCH @match${extra}
         ORDER BY rank
         LIMIT @k`;
      const rows = db
        .prepare<typeof params, RawPolicySearchRow>(sql)
        .all(params);
      return rows.map((r, idx) => ({
        id: r.id,
        score: 1 / (idx + 1),
        meta: policySearchMeta(r),
      }));
    },

    /**
     * Pattern channel — substring fallback for short queries (2-char CJK,
     * short ids, etc.) that cannot arm the trigram FTS channel.
     */
    searchByPattern(
      terms: readonly string[],
      k: number,
      opts: { statusIn?: PolicyRow["status"][] } = {},
    ): Array<VectorHit<string, PolicySearchMeta>> {
      if (!terms || terms.length === 0 || k <= 0) return [];
      const dedup = Array.from(new Set(terms.map((t) => String(t).trim()).filter(Boolean)));
      if (dedup.length === 0) return [];
      const params: Record<string, unknown> = {
        k: Math.max(1, Math.min(200, Math.floor(k))),
      };
      const ors: string[] = [];
      dedup.slice(0, 16).forEach((t, i) => {
        const key = `pat_${i}`;
        const escaped = t.replace(/[\\%_]/g, (m) => `\\${m}`);
        params[key] = `%${escaped}%`;
        ors.push(
          `(title LIKE @${key} ESCAPE '\\' OR trigger LIKE @${key} ESCAPE '\\' OR procedure LIKE @${key} ESCAPE '\\' OR verification LIKE @${key} ESCAPE '\\' OR boundary LIKE @${key} ESCAPE '\\' OR decision_guidance_json LIKE @${key} ESCAPE '\\')`,
        );
      });
      const whereParts: string[] = [`(${ors.join(" OR ")})`];
      if (opts.statusIn && opts.statusIn.length > 0) {
        const placeholders = opts.statusIn.map((_, i) => `@status_${i}`).join(",");
        whereParts.push(`status IN (${placeholders})`);
        opts.statusIn.forEach((st, i) => {
          params[`status_${i}`] = st;
        });
      }
      const sql = `
        SELECT id,
               title,
               status,
               support,
               gain,
               experience_type,
               evidence_polarity,
               salience,
               confidence,
               owner_agent_kind,
               owner_profile_id,
               owner_workspace_id
          FROM policies
         WHERE ${whereParts.join(" AND ")}
         ORDER BY updated_at DESC
         LIMIT @k`;
      const rows = db
        .prepare<typeof params, RawPolicySearchRow>(sql)
        .all(params);
      return rows.map((r, idx) => ({
        id: r.id,
        score: 1 / (idx + 1),
        meta: policySearchMeta(r),
      }));
    },

    deleteById(id: PolicyId): void {
      db.prepare<{ id: string }>(`DELETE FROM policies WHERE id=@id`).run({ id });
    },

    /**
     * Apply a share-state transition. `scope = null` clears the share
     * fields and resets `shared_at`. Mirrors `traces.updateShare`.
     */
    updateShare(
      id: PolicyId,
      share: {
        scope: ShareScope | null;
        target?: string | null;
        sharedAt?: number | null;
      },
    ): void {
      db.prepare<{
        id: string;
        share_scope: string | null;
        share_target: string | null;
        shared_at: number | null;
      }>(
        `UPDATE policies SET share_scope=@share_scope, share_target=@share_target, shared_at=@shared_at WHERE id=@id`,
      ).run({
        id,
        share_scope: normalizeShareForStorage(share.scope),
        share_target: share.target ?? null,
        shared_at: share.sharedAt ?? null,
      });
    },

    /**
     * User-driven content patch from the viewer's edit modal. Limited
     * to the title / trigger / procedure / verification / boundary
     * fields; status, support, gain, vec are owned by the induction
     * pipeline. Stamps `edited_at = Date.now()` on any change.
     */
    updateContent(
      id: PolicyId,
      patch: {
        title?: string;
        trigger?: string;
        procedure?: string;
        verification?: string;
        boundary?: string;
      },
    ): void {
      const existingRaw = selectById.get({ id });
      if (!existingRaw || Object.keys(patch).length === 0) return;
      const existing = mapRow(existingRaw);
      const at = Date.now();
      upsertStmt.run(rowToParams(preparePolicyForWrite({
        ...existing,
        ...patch,
        updatedAt: at,
        editedAt: at,
      }, existing)));
    },

    updateVector(id: PolicyId, vec: EmbeddingVector): boolean {
      const res = db.prepare<{ id: string; vec: Buffer; updated_at: number }>(
        `UPDATE policies SET vec=@vec, updated_at=@updated_at WHERE id=@id`,
      ).run({ id, vec: toBlob(vec)!, updated_at: Date.now() });
      return res.changes > 0;
    },
  };
}

interface RawPolicyRow {
  id: string;
  owner_agent_kind: string;
  owner_profile_id: string;
  owner_workspace_id: string | null;
  title: string;
  trigger: string;
  procedure: string;
  verification: string;
  boundary: string;
  support: number;
  gain: number;
  base_gain: number;
  actual_gain: number | null;
  actual_usage_count: number;
  status: "candidate" | "active" | "archived";
  experience_type: NonNullable<PolicyRow["experienceType"]> | null;
  evidence_polarity: NonNullable<PolicyRow["evidencePolarity"]> | null;
  salience: number | null;
  confidence: number | null;
  confidence_scored: number | null;
  source_episodes_json: string;
  source_feedback_ids_json: string | null;
  source_trace_ids_json: string | null;
  induced_by: string;
  decision_guidance_json: string;
  verifier_meta_json: string | null;
  skill_eligible: number | null;
  vec: Buffer | null;
  created_at: number;
  updated_at: number;
  content_version: number;
  content_updated_at: number;
  stats_updated_at: number;
  content_fingerprint: string;
  share_scope: string | null;
  share_target: string | null;
  shared_at: number | null;
  edited_at: number | null;
}

type RawPolicySearchRow = Pick<
  RawPolicyRow,
  | "id"
  | "title"
  | "status"
  | "support"
  | "gain"
  | "experience_type"
  | "evidence_polarity"
  | "salience"
  | "confidence"
  | "confidence_scored"
  | "owner_agent_kind"
  | "owner_profile_id"
  | "owner_workspace_id"
>;

const EMPTY_GUIDANCE: PolicyRow["decisionGuidance"] = Object.freeze({
  preference: [] as string[],
  antiPattern: [] as string[],
});

function rowToParams(row: PolicyRow): Record<string, unknown> {
  return {
    id: row.id,
    ...ownerParamsFromRow(row),
    title: row.title,
    trigger: row.trigger,
    procedure: row.procedure,
    verification: row.verification,
    boundary: row.boundary,
    support: row.support,
    gain: row.gain,
    base_gain: row.baseGain ?? row.gain,
    actual_gain: row.actualGain ?? null,
    actual_usage_count: Math.max(0, row.actualUsageCount ?? 0),
    status: row.status,
    experience_type: row.experienceType ?? "success_pattern",
    evidence_polarity: row.evidencePolarity ?? "positive",
    salience: row.salience ?? 0,
    confidence: row.confidence ?? 0.5,
    confidence_scored:
      (row.confidenceScored ?? typeof row.confidence === "number") ? 1 : 0,
    source_episodes_json: toJsonText(row.sourceEpisodeIds),
    source_feedback_ids_json: toJsonText(row.sourceFeedbackIds ?? []),
    source_trace_ids_json: toJsonText(row.sourceTraceIds ?? []),
    induced_by: row.inducedBy,
    decision_guidance_json: toJsonText({
      preference: row.decisionGuidance.preference,
      antiPattern: row.decisionGuidance.antiPattern,
    }),
    verifier_meta_json: toJsonText(row.verifierMeta ?? null),
    skill_eligible: row.skillEligible === false ? 0 : 1,
    vec: toBlob(row.vec),
    created_at: row.createdAt,
    updated_at: row.updatedAt,
    content_version: row.contentVersion ?? 1,
    content_updated_at: row.contentUpdatedAt ?? row.updatedAt,
    stats_updated_at: row.statsUpdatedAt ?? row.updatedAt,
    content_fingerprint: row.contentFingerprint || fingerprintPolicyContent(row),
    share_scope: normalizeShareForStorage(row.share?.scope),
    share_target: row.share?.target ?? null,
    shared_at: row.share?.sharedAt ?? null,
    edited_at: row.editedAt ?? null,
  };
}

function mapRow(r: RawPolicyRow): PolicyRow {
  return {
    id: r.id,
    ...ownerFieldsFromRaw(r),
    title: r.title,
    trigger: r.trigger,
    procedure: r.procedure,
    verification: r.verification,
    boundary: r.boundary,
    support: r.support,
    baseGain: finiteOr(r.base_gain, r.gain),
    actualGain: r.actual_gain == null ? null : finiteOr(r.actual_gain, 0),
    actualUsageCount: Math.max(0, r.actual_usage_count ?? 0),
    gain: r.gain,
    status: r.status,
    experienceType: normalizeExperienceType(r.experience_type),
    evidencePolarity: normalizeEvidencePolarity(r.evidence_polarity),
    salience: finiteOr(r.salience, 0),
    confidence: r.confidence_scored === 1 ? finiteOr(r.confidence, 0.5) : undefined,
    confidenceScored: r.confidence_scored === 1,
    sourceEpisodeIds: fromJsonText(r.source_episodes_json, []),
    sourceFeedbackIds: fromJsonText(r.source_feedback_ids_json ?? "[]", []),
    sourceTraceIds: fromJsonText(r.source_trace_ids_json ?? "[]", []),
    inducedBy: r.induced_by,
    decisionGuidance: parseGuidance(r.decision_guidance_json),
    verifierMeta: fromJsonText<Record<string, unknown> | null>(
      r.verifier_meta_json ?? "null",
      null,
    ),
    skillEligible: r.skill_eligible == null ? true : r.skill_eligible !== 0,
    vec: fromBlob(r.vec),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    contentVersion: Math.max(1, r.content_version ?? 1),
    contentUpdatedAt: r.content_updated_at || r.updated_at,
    statsUpdatedAt: r.stats_updated_at || r.updated_at,
    contentFingerprint: r.content_fingerprint || contentFingerprint({
      title: r.title,
      trigger: r.trigger,
      procedure: r.procedure,
      verification: r.verification,
      boundary: r.boundary,
      decisionGuidance: parseGuidance(r.decision_guidance_json),
    }),
    share:
      r.share_scope != null
        ? {
            scope: normalizeShareForStorage(r.share_scope) as ShareScope,
            target: r.share_target,
            sharedAt: r.shared_at,
          }
        : null,
    editedAt: r.edited_at,
  };
}

function preparePolicyForWrite(row: PolicyRow, existing: PolicyRow | null): PolicyRow {
  const preparedRow: PolicyRow = {
    ...row,
    baseGain: row.baseGain ?? existing?.baseGain ?? row.gain,
    actualGain: row.actualGain === undefined
      ? existing?.actualGain ?? null
      : row.actualGain,
    actualUsageCount: row.actualUsageCount ?? existing?.actualUsageCount ?? 0,
  };
  const nextFingerprint = fingerprintPolicyContent(preparedRow);
  if (!existing) {
    return {
      ...preparedRow,
      contentVersion: Math.max(1, preparedRow.contentVersion ?? 1),
      contentUpdatedAt: preparedRow.contentUpdatedAt ?? preparedRow.updatedAt,
      statsUpdatedAt: preparedRow.statsUpdatedAt ?? preparedRow.updatedAt,
      contentFingerprint: nextFingerprint,
    };
  }
  const previousFingerprint = existing.contentFingerprint || fingerprintPolicyContent(existing);
  const contentChanged = previousFingerprint !== nextFingerprint;
  const statsChanged =
    preparedRow.support !== existing.support ||
    preparedRow.gain !== existing.gain ||
    preparedRow.baseGain !== existing.baseGain ||
    preparedRow.actualGain !== existing.actualGain ||
    preparedRow.actualUsageCount !== existing.actualUsageCount ||
    preparedRow.status !== existing.status ||
    preparedRow.confidence !== existing.confidence ||
    preparedRow.confidenceScored !== existing.confidenceScored ||
    preparedRow.sourceEpisodeIds.join("\u0000") !== existing.sourceEpisodeIds.join("\u0000");
  return {
    ...preparedRow,
    contentVersion: contentChanged
      ? Math.max(1, existing.contentVersion) + 1
      : existing.contentVersion,
    contentUpdatedAt: contentChanged ? preparedRow.updatedAt : existing.contentUpdatedAt,
    statsUpdatedAt: statsChanged ? preparedRow.updatedAt : existing.statsUpdatedAt,
    contentFingerprint: nextFingerprint,
  };
}

export function fingerprintPolicyContent(row: Pick<
  PolicyRow,
  "title" | "trigger" | "procedure" | "verification" | "boundary" | "decisionGuidance"
>): string {
  return contentFingerprint({
    title: row.title,
    trigger: row.trigger,
    procedure: row.procedure,
    verification: row.verification,
    boundary: row.boundary,
    decisionGuidance: row.decisionGuidance,
  });
}

function policySearchMeta(r: RawPolicySearchRow): PolicySearchMeta {
  return {
    title: r.title,
    status: r.status,
    support: r.support,
    gain: r.gain,
    experience_type: normalizeExperienceType(r.experience_type),
    evidence_polarity: normalizeEvidencePolarity(r.evidence_polarity),
    salience: finiteOr(r.salience, 0),
    confidence: r.confidence_scored === 1 ? finiteOr(r.confidence, 0.5) : undefined,
    confidence_scored: r.confidence_scored ?? 0,
    owner_agent_kind: r.owner_agent_kind,
    owner_profile_id: r.owner_profile_id,
    owner_workspace_id: r.owner_workspace_id,
  };
}

/**
 * Deserialise the `decision_guidance_json` column into the typed
 * `{ preference, antiPattern }` shape. Defensively guards against
 * malformed JSON (returns the empty pair) since the column carries
 * LLM-derived content that may someday surprise us. Both arrays are
 * coerced to `string[]` to keep the read side honest even if a
 * future writer puts non-strings in there.
 */
function parseGuidance(raw: string): PolicyRow["decisionGuidance"] {
  if (!raw) return { ...EMPTY_GUIDANCE };
  try {
    const parsed = JSON.parse(raw) as Partial<PolicyRow["decisionGuidance"]>;
    return {
      preference: Array.isArray(parsed.preference)
        ? parsed.preference.map((s) => String(s))
        : [],
      antiPattern: Array.isArray(parsed.antiPattern)
        ? parsed.antiPattern.map((s) => String(s))
        : [],
    };
  } catch {
    return { ...EMPTY_GUIDANCE };
  }
}

function normalizeExperienceType(
  raw: NonNullable<PolicyRow["experienceType"]> | null | undefined,
): NonNullable<PolicyRow["experienceType"]> {
  switch (raw) {
    case "success_pattern":
    case "repair_validated":
    case "failure_avoidance":
    case "repair_instruction":
    case "preference":
    case "verifier_feedback":
    case "procedural":
      return raw;
    default:
      return "success_pattern";
  }
}

function normalizeEvidencePolarity(
  raw: NonNullable<PolicyRow["evidencePolarity"]> | null | undefined,
): NonNullable<PolicyRow["evidencePolarity"]> {
  switch (raw) {
    case "positive":
    case "negative":
    case "neutral":
    case "mixed":
      return raw;
    default:
      return "positive";
  }
}

function finiteOr(value: number | null | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}
