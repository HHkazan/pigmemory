-- Sidecar user-profile memory.
--
-- These tables intentionally have no foreign keys to traces, episodes,
-- policies, skills, or world_model. Completed turns are copied into the
-- inbox and consolidated independently so L1/L2/L3 evolution can never
-- query profile memory through an accidental relationship.

CREATE TABLE IF NOT EXISTS user_context_inbox (
  id                   TEXT    PRIMARY KEY,
  owner_agent_kind     TEXT    NOT NULL DEFAULT 'unknown',
  owner_profile_id     TEXT    NOT NULL DEFAULT 'default',
  owner_workspace_id   TEXT,
  subject_id           TEXT    NOT NULL DEFAULT 'default',
  session_id           TEXT    NOT NULL,
  episode_id           TEXT,
  trace_id             TEXT,
  local_date           TEXT    NOT NULL,
  ts                    INTEGER NOT NULL,
  user_text             TEXT    NOT NULL,
  agent_text            TEXT    NOT NULL,
  context_json          TEXT    NOT NULL DEFAULT '{}' CHECK (json_valid(context_json)),
  processed_at          INTEGER,
  created_at            INTEGER NOT NULL
) STRICT;

CREATE INDEX IF NOT EXISTS idx_user_context_inbox_pending
  ON user_context_inbox(processed_at, local_date, owner_agent_kind, owner_profile_id, subject_id);
CREATE INDEX IF NOT EXISTS idx_user_context_inbox_subject
  ON user_context_inbox(owner_agent_kind, owner_profile_id, subject_id, ts DESC);

CREATE TABLE IF NOT EXISTS user_profile_facts (
  id                   TEXT    PRIMARY KEY,
  owner_agent_kind     TEXT    NOT NULL DEFAULT 'unknown',
  owner_profile_id     TEXT    NOT NULL DEFAULT 'default',
  owner_workspace_id   TEXT,
  subject_id           TEXT    NOT NULL DEFAULT 'default',
  dimension            TEXT    NOT NULL,
  claim                TEXT    NOT NULL,
  evidence_kind        TEXT    NOT NULL CHECK (evidence_kind IN ('explicit','inferred','user_edited')),
  confidence           REAL    NOT NULL DEFAULT 0.5 CHECK (confidence >= 0 AND confidence <= 1),
  source_inbox_ids_json TEXT   NOT NULL DEFAULT '[]' CHECK (json_valid(source_inbox_ids_json)),
  first_seen_at        INTEGER NOT NULL,
  last_confirmed_at    INTEGER NOT NULL,
  updated_at           INTEGER NOT NULL,
  status               TEXT    NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived')),
  edited_at            INTEGER,
  UNIQUE(owner_agent_kind, owner_profile_id, subject_id, dimension, claim)
) STRICT;

CREATE INDEX IF NOT EXISTS idx_user_profile_facts_subject
  ON user_profile_facts(owner_agent_kind, owner_profile_id, subject_id, status, updated_at DESC);

CREATE TABLE IF NOT EXISTS user_daily_memories (
  id                   TEXT    PRIMARY KEY,
  owner_agent_kind     TEXT    NOT NULL DEFAULT 'unknown',
  owner_profile_id     TEXT    NOT NULL DEFAULT 'default',
  owner_workspace_id   TEXT,
  subject_id           TEXT    NOT NULL DEFAULT 'default',
  memory_date          TEXT    NOT NULL,
  summary              TEXT    NOT NULL,
  highlights_json      TEXT    NOT NULL DEFAULT '[]' CHECK (json_valid(highlights_json)),
  events_json          TEXT    NOT NULL DEFAULT '[]' CHECK (json_valid(events_json)),
  open_loops_json      TEXT    NOT NULL DEFAULT '[]' CHECK (json_valid(open_loops_json)),
  mood_signals_json    TEXT    NOT NULL DEFAULT '[]' CHECK (json_valid(mood_signals_json)),
  source_inbox_ids_json TEXT   NOT NULL DEFAULT '[]' CHECK (json_valid(source_inbox_ids_json)),
  created_at           INTEGER NOT NULL,
  updated_at           INTEGER NOT NULL,
  UNIQUE(owner_agent_kind, owner_profile_id, subject_id, memory_date)
) STRICT;

CREATE INDEX IF NOT EXISTS idx_user_daily_memories_subject
  ON user_daily_memories(owner_agent_kind, owner_profile_id, subject_id, memory_date DESC);

CREATE TABLE IF NOT EXISTS proactive_interactions (
  id                   TEXT    PRIMARY KEY,
  owner_agent_kind     TEXT    NOT NULL DEFAULT 'unknown',
  owner_profile_id     TEXT    NOT NULL DEFAULT 'default',
  owner_workspace_id   TEXT,
  subject_id           TEXT    NOT NULL DEFAULT 'default',
  source_date          TEXT    NOT NULL,
  reason               TEXT    NOT NULL,
  message              TEXT    NOT NULL,
  score                REAL    NOT NULL DEFAULT 0 CHECK (score >= 0 AND score <= 1),
  due_date             TEXT    NOT NULL,
  due_time             TEXT    NOT NULL,
  status               TEXT    NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','claimed','sent','skipped','expired','failed','responded')),
  claim_token          TEXT,
  claimed_at           INTEGER,
  lease_expires_at     INTEGER,
  sent_at              INTEGER,
  channel              TEXT,
  target_id            TEXT,
  external_message_id  TEXT,
  error                TEXT,
  created_at           INTEGER NOT NULL,
  updated_at           INTEGER NOT NULL,
  UNIQUE(owner_agent_kind, owner_profile_id, subject_id, source_date)
) STRICT;

CREATE INDEX IF NOT EXISTS idx_proactive_interactions_due
  ON proactive_interactions(status, due_date, due_time, owner_agent_kind, owner_profile_id, subject_id);

CREATE TABLE IF NOT EXISTS user_profile_jobs (
  owner_agent_kind     TEXT    NOT NULL DEFAULT 'unknown',
  owner_profile_id     TEXT    NOT NULL DEFAULT 'default',
  owner_workspace_id   TEXT,
  subject_id           TEXT    NOT NULL DEFAULT 'default',
  memory_date          TEXT    NOT NULL,
  status               TEXT    NOT NULL CHECK (status IN ('running','completed','failed')),
  attempts             INTEGER NOT NULL DEFAULT 0,
  started_at           INTEGER,
  completed_at         INTEGER,
  lease_expires_at     INTEGER,
  error                TEXT,
  model                TEXT,
  stats_json           TEXT    NOT NULL DEFAULT '{}' CHECK (json_valid(stats_json)),
  updated_at           INTEGER NOT NULL,
  PRIMARY KEY(owner_agent_kind, owner_profile_id, subject_id, memory_date)
) STRICT;

CREATE INDEX IF NOT EXISTS idx_user_profile_jobs_recent
  ON user_profile_jobs(owner_agent_kind, owner_profile_id, subject_id, updated_at DESC);
