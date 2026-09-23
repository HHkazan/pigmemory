CREATE TABLE IF NOT EXISTS encrypted_payloads (
  id                 TEXT PRIMARY KEY,
  payload_ciphertext TEXT NOT NULL,
  received_at        INTEGER NOT NULL,
  lease_token        TEXT,
  lease_expires_at   INTEGER
) STRICT;

CREATE INDEX IF NOT EXISTS idx_encrypted_payloads_pull
  ON encrypted_payloads(lease_expires_at, received_at);
CREATE INDEX IF NOT EXISTS idx_encrypted_payloads_retention
  ON encrypted_payloads(received_at);

CREATE TABLE IF NOT EXISTS relay_control (
  singleton          INTEGER PRIMARY KEY CHECK (singleton=1),
  lease_expires_at   INTEGER NOT NULL DEFAULT 0,
  updated_at         INTEGER NOT NULL
) STRICT;

INSERT OR IGNORE INTO relay_control (singleton, lease_expires_at, updated_at)
VALUES (1, 0, 0);
