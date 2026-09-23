-- Durable local observability for the monitoring viewer.
--
-- api_logs remains backward compatible: existing readers can continue to use
-- the original seven columns while monitor readers use the structured fields.

ALTER TABLE api_logs ADD COLUMN session_id TEXT;
ALTER TABLE api_logs ADD COLUMN episode_id TEXT;
ALTER TABLE api_logs ADD COLUMN turn_id TEXT;
ALTER TABLE api_logs ADD COLUMN level TEXT NOT NULL DEFAULT 'info';
ALTER TABLE api_logs ADD COLUMN category TEXT NOT NULL DEFAULT 'operation';
ALTER TABLE api_logs ADD COLUMN phase TEXT;
ALTER TABLE api_logs ADD COLUMN reason TEXT;

-- Only backfill identifiers that are explicitly present in the historical
-- JSON. json_type(...)=text avoids coercing malformed values into ids.
UPDATE api_logs
   SET session_id = CASE
         WHEN json_valid(input_json) AND json_type(input_json, '$.sessionId') = 'text'
           THEN json_extract(input_json, '$.sessionId')
         WHEN json_valid(input_json) AND json_type(input_json, '$.session_id') = 'text'
           THEN json_extract(input_json, '$.session_id')
         WHEN json_valid(output_json) AND json_type(output_json, '$.sessionId') = 'text'
           THEN json_extract(output_json, '$.sessionId')
         WHEN json_valid(output_json) AND json_type(output_json, '$.session_id') = 'text'
           THEN json_extract(output_json, '$.session_id')
         WHEN json_valid(output_json) AND json_type(output_json, '$.query.sessionId') = 'text'
           THEN json_extract(output_json, '$.query.sessionId')
         ELSE NULL
       END,
       episode_id = CASE
         WHEN json_valid(input_json) AND json_type(input_json, '$.episodeId') = 'text'
           THEN json_extract(input_json, '$.episodeId')
         WHEN json_valid(input_json) AND json_type(input_json, '$.episode_id') = 'text'
           THEN json_extract(input_json, '$.episode_id')
         WHEN json_valid(output_json) AND json_type(output_json, '$.episodeId') = 'text'
           THEN json_extract(output_json, '$.episodeId')
         WHEN json_valid(output_json) AND json_type(output_json, '$.episode_id') = 'text'
           THEN json_extract(output_json, '$.episode_id')
         WHEN json_valid(output_json) AND json_type(output_json, '$.query.episodeId') = 'text'
           THEN json_extract(output_json, '$.query.episodeId')
         ELSE NULL
       END,
       turn_id = CASE
         WHEN json_valid(input_json) AND json_type(input_json, '$.turnId') IN ('text','integer')
           THEN CAST(json_extract(input_json, '$.turnId') AS TEXT)
         WHEN json_valid(input_json) AND json_type(input_json, '$.turn_id') IN ('text','integer')
           THEN CAST(json_extract(input_json, '$.turn_id') AS TEXT)
         WHEN json_valid(output_json) AND json_type(output_json, '$.turnId') IN ('text','integer')
           THEN CAST(json_extract(output_json, '$.turnId') AS TEXT)
         WHEN json_valid(output_json) AND json_type(output_json, '$.turn_id') IN ('text','integer')
           THEN CAST(json_extract(output_json, '$.turn_id') AS TEXT)
         ELSE NULL
       END,
       level = CASE
         WHEN success = 0 OR tool_name IN ('system_error','task_failed') THEN 'error'
         ELSE 'info'
       END,
       category = CASE
         WHEN tool_name IN ('memos_search','memory_search') THEN 'retrieval'
         WHEN tool_name = 'memory_add' THEN 'capture'
         WHEN tool_name LIKE 'policy_%' THEN 'l2'
         WHEN tool_name LIKE 'world_model_%' THEN 'l3'
         WHEN tool_name LIKE 'skill_%' THEN 'skill'
         WHEN tool_name LIKE 'task_%' THEN 'episode'
         WHEN tool_name LIKE 'system_%' THEN 'system'
         ELSE 'operation'
       END,
       phase = CASE
         WHEN json_valid(input_json) AND json_type(input_json, '$.phase') = 'text'
           THEN json_extract(input_json, '$.phase')
         WHEN json_valid(output_json) AND json_type(output_json, '$.phase') = 'text'
           THEN json_extract(output_json, '$.phase')
         ELSE NULL
       END,
       reason = CASE
         WHEN json_valid(output_json) AND json_type(output_json, '$.reason') = 'text'
           THEN json_extract(output_json, '$.reason')
         WHEN json_valid(output_json) AND json_type(output_json, '$.error') = 'text'
           THEN json_extract(output_json, '$.error')
         ELSE NULL
       END;

CREATE INDEX IF NOT EXISTS idx_api_logs_monitor_time
  ON api_logs(called_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_api_logs_monitor_session
  ON api_logs(session_id, called_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_api_logs_monitor_episode
  ON api_logs(episode_id, called_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_api_logs_monitor_level_category
  ON api_logs(level, category, called_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS lifecycle_events (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  entity_kind    TEXT    NOT NULL,
  entity_id      TEXT    NOT NULL,
  old_state      TEXT,
  new_state      TEXT    NOT NULL,
  event_at       INTEGER NOT NULL,
  reason         TEXT    NOT NULL,
  source         TEXT    NOT NULL DEFAULT 'core',
  session_id     TEXT,
  episode_id     TEXT,
  turn_id        TEXT,
  old_version    INTEGER,
  new_version    INTEGER,
  detail_json    TEXT    NOT NULL DEFAULT '{}' CHECK (json_valid(detail_json)),
  CHECK (
    source = 'migration'
    OR entity_kind NOT IN ('policy', 'skill')
    OR new_state != 'active'
    OR old_state IS NOT NULL
  )
) STRICT;

CREATE INDEX IF NOT EXISTS idx_lifecycle_entity
  ON lifecycle_events(entity_kind, entity_id, event_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_lifecycle_session
  ON lifecycle_events(session_id, event_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_lifecycle_episode
  ON lifecycle_events(episode_id, event_at DESC, id DESC);

-- Existing objects receive one honest baseline. Their present state is
-- preserved; no historical transition or reason is invented.
INSERT INTO lifecycle_events
  (entity_kind, entity_id, old_state, new_state, event_at, reason, source,
   session_id, episode_id, turn_id, old_version, new_version, detail_json)
SELECT 'trace', id, NULL,
       CASE
         WHEN reflection IS NOT NULL AND vec_summary IS NOT NULL THEN 'reflected_vectorized'
         WHEN reflection IS NOT NULL THEN 'reflected'
         WHEN vec_summary IS NOT NULL THEN 'vectorized'
         ELSE 'captured'
       END,
       CAST(strftime('%s','now') AS INTEGER) * 1000,
       'migration_first_observation', 'migration', session_id, episode_id,
       CAST(turn_id AS TEXT), NULL, schema_version, '{}'
  FROM traces;

INSERT INTO lifecycle_events
  (entity_kind, entity_id, old_state, new_state, event_at, reason, source,
   old_version, new_version, detail_json)
SELECT 'policy', id, NULL, status, CAST(strftime('%s','now') AS INTEGER) * 1000,
       'migration_first_observation', 'migration', NULL, content_version, '{}'
  FROM policies;

INSERT INTO lifecycle_events
  (entity_kind, entity_id, old_state, new_state, event_at, reason, source,
   old_version, new_version, detail_json)
SELECT 'skill', id, NULL, status, CAST(strftime('%s','now') AS INTEGER) * 1000,
       'migration_first_observation', 'migration', NULL, version, '{}'
  FROM skills;

INSERT INTO lifecycle_events
  (entity_kind, entity_id, old_state, new_state, event_at, reason, source,
   old_version, new_version, detail_json)
SELECT 'world_model', id, NULL, status, CAST(strftime('%s','now') AS INTEGER) * 1000,
       'migration_first_observation', 'migration', NULL, version, '{}'
  FROM world_model;

INSERT INTO lifecycle_events
  (entity_kind, entity_id, old_state, new_state, event_at, reason, source,
   session_id, episode_id, detail_json)
SELECT 'episode', id, NULL,
       CASE
         WHEN status = 'open' AND json_valid(meta_json)
              AND json_type(meta_json, '$.topicState') = 'text'
           THEN json_extract(meta_json, '$.topicState')
         ELSE status
       END,
       CAST(strftime('%s','now') AS INTEGER) * 1000,
       'migration_first_observation', 'migration',
       session_id, id, '{}'
  FROM episodes;

CREATE TABLE IF NOT EXISTS retrieval_runs (
  id                    TEXT PRIMARY KEY,
  source                TEXT    NOT NULL,
  agent                 TEXT    NOT NULL,
  session_id            TEXT,
  episode_id            TEXT,
  turn_id                TEXT,
  query_text             TEXT    NOT NULL DEFAULT '',
  started_at             INTEGER NOT NULL,
  completed_at           INTEGER,
  duration_ms            INTEGER NOT NULL DEFAULT 0,
  status                 TEXT    NOT NULL DEFAULT 'running',
  raw_candidate_count    INTEGER NOT NULL DEFAULT 0,
  sent_to_model_count    INTEGER NOT NULL DEFAULT 0,
  model_kept_count       INTEGER NOT NULL DEFAULT 0,
  final_returned_count   INTEGER NOT NULL DEFAULT 0,
  adapter_received_count INTEGER NOT NULL DEFAULT 0,
  acknowledged_at       INTEGER,
  acknowledged_by       TEXT,
  delivered_ids_json    TEXT    NOT NULL DEFAULT '[]' CHECK (json_valid(delivered_ids_json)),
  error                  TEXT,
  detail_json            TEXT    NOT NULL DEFAULT '{}' CHECK (json_valid(detail_json))
) STRICT;

CREATE INDEX IF NOT EXISTS idx_retrieval_runs_time
  ON retrieval_runs(started_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_retrieval_runs_session
  ON retrieval_runs(session_id, started_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_retrieval_runs_episode
  ON retrieval_runs(episode_id, started_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_retrieval_runs_source
  ON retrieval_runs(source, started_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS retrieval_candidates (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id            TEXT    NOT NULL REFERENCES retrieval_runs(id) ON DELETE CASCADE,
  source            TEXT    NOT NULL DEFAULT 'local',
  tier              INTEGER NOT NULL,
  ref_kind          TEXT    NOT NULL,
  ref_id            TEXT    NOT NULL,
  score             REAL    NOT NULL DEFAULT 0,
  relevance         REAL,
  initial_rank      INTEGER,
  model_rank        INTEGER,
  final_rank        INTEGER,
  sent_to_model     INTEGER NOT NULL DEFAULT 0,
  model_kept        INTEGER NOT NULL DEFAULT 0,
  final_returned    INTEGER NOT NULL DEFAULT 0,
  adapter_received  INTEGER NOT NULL DEFAULT 0,
  decision          TEXT    NOT NULL DEFAULT 'candidate',
  reason            TEXT,
  summary           TEXT    NOT NULL DEFAULT '',
  detail_json       TEXT    NOT NULL DEFAULT '{}' CHECK (json_valid(detail_json))
) STRICT;

CREATE INDEX IF NOT EXISTS idx_retrieval_candidates_run
  ON retrieval_candidates(run_id, initial_rank, id);
CREATE INDEX IF NOT EXISTS idx_retrieval_candidates_entity
  ON retrieval_candidates(ref_kind, ref_id, id DESC);
