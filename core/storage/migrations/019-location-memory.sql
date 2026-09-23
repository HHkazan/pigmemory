-- Opt-in OwnTracks location sidecar.
--
-- These tables are deliberately disconnected from traces, episodes,
-- policies, skills, and world_model. Coordinates exist only in the short-term
-- relay/sample/state tables; semantic places and completed visits contain no
-- plaintext coordinate.

CREATE TABLE IF NOT EXISTS location_relay_items (
  id                 TEXT    PRIMARY KEY,
  payload_ciphertext TEXT    NOT NULL,
  received_at        INTEGER NOT NULL,
  status             TEXT    NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','processed','failed')),
  attempts           INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  last_error         TEXT,
  processed_at       INTEGER,
  updated_at         INTEGER NOT NULL
) STRICT;

CREATE INDEX IF NOT EXISTS idx_location_relay_items_status
  ON location_relay_items(status, updated_at);

CREATE TABLE IF NOT EXISTS semantic_places (
  id                 TEXT PRIMARY KEY,
  name               TEXT,
  city               TEXT,
  created_at         INTEGER NOT NULL,
  updated_at         INTEGER NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS semantic_place_cells (
  cell_hmac          TEXT PRIMARY KEY,
  place_id           TEXT NOT NULL REFERENCES semantic_places(id) ON DELETE CASCADE,
  created_at         INTEGER NOT NULL
) STRICT;

CREATE INDEX IF NOT EXISTS idx_semantic_place_cells_place
  ON semantic_place_cells(place_id);

CREATE TABLE IF NOT EXISTS location_visits (
  id                 TEXT PRIMARY KEY,
  device_id          TEXT NOT NULL,
  place_id           TEXT NOT NULL REFERENCES semantic_places(id) ON DELETE RESTRICT,
  arrived_at         INTEGER NOT NULL,
  departed_at        INTEGER,
  created_at         INTEGER NOT NULL,
  updated_at         INTEGER NOT NULL,
  UNIQUE(device_id, arrived_at)
) STRICT;

CREATE INDEX IF NOT EXISTS idx_location_visits_time
  ON location_visits(arrived_at, departed_at);
CREATE INDEX IF NOT EXISTS idx_location_visits_place
  ON location_visits(place_id, arrived_at DESC);

CREATE TABLE IF NOT EXISTS location_samples (
  id                 TEXT PRIMARY KEY,
  relay_item_id      TEXT NOT NULL UNIQUE
    REFERENCES location_relay_items(id) ON DELETE CASCADE,
  device_id          TEXT NOT NULL,
  sampled_at         INTEGER NOT NULL,
  received_at        INTEGER NOT NULL,
  latitude           REAL NOT NULL CHECK (latitude >= -90 AND latitude <= 90),
  longitude          REAL NOT NULL CHECK (longitude >= -180 AND longitude <= 180),
  accuracy_meters    REAL NOT NULL CHECK (accuracy_meters >= 0),
  quality            TEXT NOT NULL CHECK (quality IN ('accepted','inaccurate','out_of_order')),
  processed_at       INTEGER NOT NULL
) STRICT;

CREATE INDEX IF NOT EXISTS idx_location_samples_retention
  ON location_samples(processed_at);
CREATE INDEX IF NOT EXISTS idx_location_samples_device_time
  ON location_samples(device_id, sampled_at DESC);

CREATE TABLE IF NOT EXISTS location_device_state (
  device_id                  TEXT PRIMARY KEY,
  current_visit_id           TEXT REFERENCES location_visits(id) ON DELETE SET NULL,
  anchor_latitude            REAL,
  anchor_longitude           REAL,
  anchor_sample_count        INTEGER NOT NULL DEFAULT 0,
  candidate_started_at       INTEGER,
  departure_anchor_latitude  REAL,
  departure_anchor_longitude REAL,
  departure_started_at       INTEGER,
  departure_sample_count     INTEGER NOT NULL DEFAULT 0,
  last_sample_at             INTEGER,
  updated_at                 INTEGER NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS location_notifications (
  id                  TEXT PRIMARY KEY,
  place_id            TEXT NOT NULL REFERENCES semantic_places(id) ON DELETE CASCADE,
  visit_id            TEXT NOT NULL REFERENCES location_visits(id) ON DELETE CASCADE,
  kind                TEXT NOT NULL CHECK (kind IN ('arrival','departure','name_prompt','named')),
  message             TEXT NOT NULL,
  due_at              INTEGER NOT NULL,
  status              TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','claimed','sent','failed','skipped')),
  claim_token         TEXT,
  claimed_at          INTEGER,
  lease_expires_at    INTEGER,
  sent_at             INTEGER,
  channel             TEXT,
  target_id           TEXT,
  external_message_id TEXT,
  error               TEXT,
  created_at          INTEGER NOT NULL,
  updated_at          INTEGER NOT NULL,
  UNIQUE(visit_id, kind)
) STRICT;

CREATE INDEX IF NOT EXISTS idx_location_notifications_due
  ON location_notifications(status, due_at);

CREATE TABLE IF NOT EXISTS location_daily_memories (
  local_date          TEXT PRIMARY KEY,
  summary             TEXT NOT NULL,
  generated_at        INTEGER NOT NULL,
  updated_at          INTEGER NOT NULL
) STRICT;
