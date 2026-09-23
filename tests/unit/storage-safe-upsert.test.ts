import BetterSqlite3 from "better-sqlite3";
import { describe, expect, it } from "vitest";

import { buildUpsert } from "../../core/storage/tx.js";

describe("buildUpsert", () => {
  it("updates in place without deleting children or duplicating search rows", () => {
    const db = new BetterSqlite3(":memory:");
    db.pragma("foreign_keys = ON");
    db.exec(`
      CREATE TABLE parents (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL
      );
      CREATE TABLE children (
        id TEXT PRIMARY KEY,
        parent_id TEXT NOT NULL REFERENCES parents(id) ON DELETE CASCADE
      );
      CREATE TABLE search_rows (
        parent_id TEXT NOT NULL,
        name TEXT NOT NULL
      );
      CREATE TRIGGER search_rows_ai AFTER INSERT ON parents BEGIN
        INSERT INTO search_rows(parent_id, name) VALUES (new.id, new.name);
      END;
      CREATE TRIGGER search_rows_au AFTER UPDATE ON parents BEGIN
        DELETE FROM search_rows WHERE parent_id = old.id;
        INSERT INTO search_rows(parent_id, name) VALUES (new.id, new.name);
      END;
    `);

    const upsert = db.prepare(buildUpsert({ table: "parents", columns: ["id", "name"] }));
    upsert.run({ id: "parent-1", name: "before" });
    db.prepare("INSERT INTO children(id, parent_id) VALUES (?, ?)").run("child-1", "parent-1");

    upsert.run({ id: "parent-1", name: "after" });

    expect(db.prepare("SELECT COUNT(*) AS count FROM children").get()).toEqual({ count: 1 });
    expect(db.prepare("SELECT parent_id, name FROM search_rows").all()).toEqual([
      { parent_id: "parent-1", name: "after" },
    ]);
    db.close();
  });
});
