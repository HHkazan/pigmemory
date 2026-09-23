#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import Database from "better-sqlite3";
import YAML from "yaml";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const action = args[0] || "inspect";
const backup = option("--backup");
const confirmation = option("--confirm");
const configFile = path.resolve(option("--config") || path.join(root, "config.yaml"));
const dbFile = path.resolve(option("--db") || path.join(root, "data", "memos.db"));

console.log("PigMemory location rollback guard");
console.log(`Action: ${action}`);
console.log(`Current database: ${dbFile}`);
if (backup) console.log(`Selected backup: ${path.resolve(backup)}`);

switch (action) {
  case "inspect":
    inspectBackup(requiredBackup());
    break;
  case "soft-disable":
    requireConfirmation("SOFT-DISABLE");
    await softDisable();
    break;
  case "purge-location":
    requireConfirmation("DELETE-LOCATION-DATA");
    purgeLocation();
    break;
  case "prepare-database":
    requireConfirmation("PREPARE-DATABASE-RESTORE");
    await prepareDatabase(requiredBackup());
    break;
  case "prepare-code":
    requireConfirmation("PREPARE-CODE-RESTORE");
    prepareCode(requiredBackup());
    break;
  default:
    usage(`unknown action: ${action}`);
}

function inspectBackup(dirValue) {
  const dir = path.resolve(dirValue);
  const manifestFile = path.join(dir, "manifest.json");
  const manifest = JSON.parse(fs.readFileSync(manifestFile, "utf8"));
  const checksums = manifest.files ?? {};
  for (const [name, expected] of Object.entries(checksums)) {
    const fullPath = path.join(dir, name);
    const actual = sha256(fullPath);
    if (actual !== expected) throw new Error(`checksum mismatch: ${name}`);
  }
  const snapshot = path.join(dir, "memos.db");
  const db = new Database(snapshot, { readonly: true, fileMustExist: true });
  const check = db.pragma("quick_check", { simple: true });
  db.close();
  if (check !== "ok") throw new Error(`backup quick_check failed: ${check}`);
  console.log(`Backup verified: ${dir}`);
  console.log(`Snapshot quick_check: ${check}`);
  console.log("No files were changed.");
}

async function softDisable() {
  const document = YAML.parseDocument(fs.readFileSync(configFile, "utf8"));
  const relayUrl = String(document.getIn(["userProfile", "location", "relayUrl"]) ?? "")
    .replace(/\/+$/, "");
  document.setIn(["userProfile", "location", "enabled"], false);
  fs.writeFileSync(configFile, document.toString(), { mode: 0o600 });
  fs.chmodSync(configFile, 0o600);
  console.log("Location config disabled. Historical semantic places and visits were preserved.");
  const token = process.env.PIGMEMORY_LOCATION_CONTROL_TOKEN?.trim();
  if (relayUrl && token) {
    try {
      const response = await fetch(`${relayUrl}/control/revoke`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: "{}",
        signal: AbortSignal.timeout(15_000),
      });
      console.log(response.ok
        ? "Worker collection lease revoked and remote ciphertext queue cleared."
        : `Worker revoke returned HTTP ${response.status}; its lease still expires within ten minutes.`);
    } catch {
      console.log("Worker revoke was unreachable; its collection lease still expires within ten minutes.");
    }
  } else {
    console.log("No relay URL/control token available; the Worker lease expires within ten minutes.");
  }
  console.log("To stop iPhone location use and battery consumption, also turn off OwnTracks monitoring.");
}

function purgeLocation() {
  const document = YAML.parse(fs.readFileSync(configFile, "utf8")) ?? {};
  if (document?.userProfile?.location?.enabled === true) {
    throw new Error("refusing purge while userProfile.location.enabled is true; soft-disable first");
  }
  const db = new Database(dbFile, { fileMustExist: true });
  const tables = new Set(db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND (name LIKE 'location_%' OR name LIKE 'semantic_place%')",
  ).all().map((row) => row.name));
  const required = [
    "location_notifications",
    "location_daily_memories",
    "location_device_state",
    "location_samples",
    "location_relay_items",
    "location_visits",
    "semantic_place_cells",
    "semantic_places",
  ];
  if (!required.every((table) => tables.has(table))) {
    db.close();
    throw new Error("location migration is incomplete; no data was deleted");
  }
  db.transaction(() => {
    for (const table of required) db.prepare(`DELETE FROM ${table}`).run();
  })();
  const check = db.pragma("quick_check", { simple: true });
  db.close();
  if (check !== "ok") throw new Error(`database quick_check failed after purge: ${check}`);
  console.log("Deleted data only from location sidecar tables. Ordinary PigMemory data was untouched.");
}

function prepareDatabase(dirValue) {
  const dir = path.resolve(dirValue);
  inspectBackup(dir);
  const source = path.join(dir, "memos.db");
  const candidate = path.resolve(
    option("--candidate") || path.join(root, "data", "memos.restore-candidate.db"),
  );
  if (fs.existsSync(candidate)) {
    throw new Error(`candidate already exists; inspect or move it first: ${candidate}`);
  }
  fs.copyFileSync(source, candidate, fs.constants.COPYFILE_EXCL);
  fs.chmodSync(candidate, 0o600);
  const candidateDb = new Database(candidate, { readonly: true, fileMustExist: true });
  const check = candidateDb.pragma("quick_check", { simple: true });
  candidateDb.close();
  if (check !== "ok") throw new Error(`candidate quick_check failed: ${check}`);
  console.log(`Prepared, but did not activate, database candidate: ${candidate}`);
  console.log("WARNING: replacing memos.db would discard every ordinary memory created after the backup.");
}

function prepareCode(dirValue) {
  const dir = path.resolve(dirValue);
  inspectBackup(dir);
  const archive = path.join(dir, "source-before.tar.gz");
  const distArchive = path.join(dir, "dist-before.tar.gz");
  const destination = path.resolve(
    option("--destination") || path.join(
      "/tmp",
      `pigmemory-location-code-restore-${new Date().toISOString().replace(/[:.]/g, "-")}`,
    ),
  );
  fs.mkdirSync(destination, { mode: 0o700 });
  const result = spawnSync("tar", ["-xzf", archive, "-C", destination], {
    encoding: "utf8",
  });
  if (result.status !== 0) throw new Error(result.stderr || "failed to extract source archive");
  const distResult = spawnSync("tar", ["-xzf", distArchive, "-C", destination], {
    encoding: "utf8",
  });
  if (distResult.status !== 0) {
    throw new Error(distResult.stderr || "failed to extract dist archive");
  }
  console.log(`Prepared code/config comparison candidate: ${destination}`);
  console.log("No current source or database file was overwritten.");
}

function requiredBackup() {
  if (!backup) usage("--backup is required for this action");
  return backup;
}

function option(name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function requireConfirmation(expected) {
  if (confirmation !== expected) {
    console.error(`Impact confirmation required: --confirm ${expected}`);
    process.exit(2);
  }
}

function sha256(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function usage(error) {
  if (error) console.error(error);
  console.error(`Usage:
  node scripts/location-rollback.mjs inspect --backup <directory>
  node scripts/location-rollback.mjs soft-disable --confirm SOFT-DISABLE
  node scripts/location-rollback.mjs purge-location --confirm DELETE-LOCATION-DATA [--db <path>] [--config <path>]
  node scripts/location-rollback.mjs prepare-code --backup <directory> --confirm PREPARE-CODE-RESTORE [--destination <path>]
  node scripts/location-rollback.mjs prepare-database --backup <directory> --confirm PREPARE-DATABASE-RESTORE [--candidate <path>]`);
  process.exit(2);
}
