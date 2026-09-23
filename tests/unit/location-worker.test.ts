import { describe, expect, it } from "vitest";

import worker from "../../location-worker/src/index.js";

describe("Cloudflare location relay", () => {
  it("drops while disabled, authenticates, leases ciphertext, ACKs, and revokes", async () => {
    const env = {
      DB: new FakeD1(),
      LOCATION_RELAY_USERNAME: "owntracks-user",
      LOCATION_RELAY_PASSWORD: "owntracks-password",
      LOCATION_RELAY_CONTROL_TOKEN: "control-token",
    };
    const encryptedBody = JSON.stringify({ _type: "encrypted", data: "opaque-base64" });
    const basic = `Basic ${btoa("owntracks-user:owntracks-password")}`;
    const bearer = "Bearer control-token";

    expect((await call("/pub", encryptedBody, basic, env)).status).toBe(200);
    expect(env.DB.payloads.size).toBe(0);
    expect((await call("/control/lease", { ttlSeconds: 600 }, "Bearer wrong", env)).status)
      .toBe(401);
    expect((await call("/control/lease", { ttlSeconds: 600 }, bearer, env)).status).toBe(200);
    expect((await call("/pub", encryptedBody, "Basic wrong", env)).status).toBe(401);
    expect((await call("/pub", { _type: "location", lat: 1, lon: 2 }, basic, env)).status)
      .toBe(400);
    expect((await call("/pub", encryptedBody, basic, env)).status).toBe(200);
    expect(env.DB.payloads.size).toBe(1);

    const pull = await call("/pull?limit=10&leaseSeconds=300", {}, bearer, env);
    const pulled = await pull.json() as {
      leaseToken: string;
      items: Array<{ id: string; payload: string }>;
    };
    expect(pulled.items).toHaveLength(1);
    expect(pulled.items[0].payload).toBe(encryptedBody);
    const emptyPull = await call("/pull?limit=10&leaseSeconds=300", {}, bearer, env);
    expect(((await emptyPull.json()) as { items: unknown[] }).items).toEqual([]);

    const wrongAck = await call("/ack", {
      leaseToken: "wrong",
      ids: [pulled.items[0].id],
    }, bearer, env);
    expect((await wrongAck.json()) as object).toMatchObject({ acknowledged: 0 });
    expect(env.DB.payloads.size).toBe(1);
    const ack = await call("/ack", {
      leaseToken: pulled.leaseToken,
      ids: [pulled.items[0].id],
    }, bearer, env);
    expect((await ack.json()) as object).toMatchObject({ acknowledged: 1 });
    expect(env.DB.payloads.size).toBe(0);

    await call("/pub", encryptedBody, basic, env);
    expect(env.DB.payloads.size).toBe(1);
    expect((await call("/control/revoke", {}, bearer, env)).status).toBe(200);
    expect(env.DB.payloads.size).toBe(0);
    await call("/pub", encryptedBody, basic, env);
    expect(env.DB.payloads.size).toBe(0);
  });
});

async function call(
  path: string,
  body: unknown,
  authorization: string,
  env: Record<string, unknown>,
): Promise<Response> {
  const payload = typeof body === "string" ? body : JSON.stringify(body);
  return worker.fetch(new Request(`https://relay.example${path}`, {
    method: "POST",
    headers: { authorization, "content-type": "application/json" },
    body: payload,
  }), env);
}

interface PayloadRow {
  id: string;
  payload: string;
  receivedAt: number;
  leaseToken: string | null;
  leaseExpiresAt: number | null;
}

class FakeD1 {
  readonly payloads = new Map<string, PayloadRow>();
  leaseExpiresAt = 0;

  prepare(sql: string): FakeStatement {
    return new FakeStatement(this, sql);
  }

  async batch(statements: FakeStatement[]) {
    const out = [];
    for (const statement of statements) out.push(await statement.run());
    return out;
  }
}

class FakeStatement {
  private args: unknown[] = [];

  constructor(
    private readonly db: FakeD1,
    private readonly sql: string,
  ) {}

  bind(...args: unknown[]): FakeStatement {
    this.args = args;
    return this;
  }

  async run() {
    const sql = compact(this.sql);
    if (sql.startsWith("DELETE FROM encrypted_payloads WHERE received_at")) {
      const before = Number(this.args[0]);
      let changes = 0;
      for (const [id, row] of this.db.payloads) {
        if (row.receivedAt < before) {
          this.db.payloads.delete(id);
          changes++;
        }
      }
      return result(changes);
    }
    if (sql.startsWith("INSERT INTO encrypted_payloads")) {
      const [id, payload, receivedAt] = this.args as [string, string, number];
      this.db.payloads.set(id, {
        id,
        payload,
        receivedAt,
        leaseToken: null,
        leaseExpiresAt: null,
      });
      return result(1);
    }
    if (sql.startsWith("INSERT INTO relay_control")) {
      this.db.leaseExpiresAt = sql.includes("VALUES (1, 0,")
        ? 0
        : Number(this.args[0] ?? 0);
      return result(1);
    }
    if (sql === "DELETE FROM encrypted_payloads") {
      const changes = this.db.payloads.size;
      this.db.payloads.clear();
      return result(changes);
    }
    if (sql.startsWith("UPDATE encrypted_payloads")) {
      const [leaseToken, leaseExpiresAt, now, limit] = this.args as [string, number, number, number];
      const rows = [...this.db.payloads.values()]
        .filter((row) => row.leaseExpiresAt == null || row.leaseExpiresAt < now)
        .sort((a, b) => a.receivedAt - b.receivedAt)
        .slice(0, limit);
      for (const row of rows) {
        row.leaseToken = leaseToken;
        row.leaseExpiresAt = leaseExpiresAt;
      }
      return result(rows.length);
    }
    if (sql.startsWith("DELETE FROM encrypted_payloads WHERE id")) {
      const [id, leaseToken] = this.args as [string, string];
      const row = this.db.payloads.get(id);
      if (!row || row.leaseToken !== leaseToken) return result(0);
      this.db.payloads.delete(id);
      return result(1);
    }
    throw new Error(`unsupported fake D1 run: ${sql}`);
  }

  async first() {
    const sql = compact(this.sql);
    if (sql.startsWith("SELECT lease_expires_at FROM relay_control")) {
      return { lease_expires_at: this.db.leaseExpiresAt };
    }
    throw new Error(`unsupported fake D1 first: ${sql}`);
  }

  async all() {
    const sql = compact(this.sql);
    if (sql.startsWith("SELECT id, payload_ciphertext AS payload")) {
      const leaseToken = String(this.args[0]);
      return {
        results: [...this.db.payloads.values()]
          .filter((row) => row.leaseToken === leaseToken)
          .sort((a, b) => a.receivedAt - b.receivedAt)
          .map((row) => ({ id: row.id, payload: row.payload, receivedAt: row.receivedAt })),
      };
    }
    throw new Error(`unsupported fake D1 all: ${sql}`);
  }
}

function compact(sql: string): string {
  return sql.replace(/\s+/g, " ").trim();
}

function result(changes: number) {
  return { success: true, meta: { changes } };
}
