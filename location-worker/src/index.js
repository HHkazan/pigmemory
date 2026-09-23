const MAX_BODY_BYTES = 256 * 1024;
const MAX_BATCH = 200;
const MAX_PULL_LEASE_SECONDS = 10 * 60;
const MAX_COLLECTION_LEASE_SECONDS = 10 * 60;
const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    try {
      if (url.pathname === "/pub" && request.method === "POST") {
        return await publish(request, env);
      }
      if (url.pathname === "/pull" && request.method === "POST") {
        if (!(await bearerAuthorized(request, env.LOCATION_RELAY_CONTROL_TOKEN))) {
          return json({ error: "unauthorized" }, 401);
        }
        return await pull(url, env);
      }
      if (url.pathname === "/ack" && request.method === "POST") {
        if (!(await bearerAuthorized(request, env.LOCATION_RELAY_CONTROL_TOKEN))) {
          return json({ error: "unauthorized" }, 401);
        }
        return await acknowledge(request, env);
      }
      if (url.pathname === "/control/lease" && request.method === "POST") {
        if (!(await bearerAuthorized(request, env.LOCATION_RELAY_CONTROL_TOKEN))) {
          return json({ error: "unauthorized" }, 401);
        }
        return await renewCollectionLease(request, env);
      }
      if (url.pathname === "/control/revoke" && request.method === "POST") {
        if (!(await bearerAuthorized(request, env.LOCATION_RELAY_CONTROL_TOKEN))) {
          return json({ error: "unauthorized" }, 401);
        }
        const now = Date.now();
        await env.DB.batch([
          env.DB.prepare(
            `INSERT INTO relay_control (singleton, lease_expires_at, updated_at)
             VALUES (1, 0, ?1)
             ON CONFLICT(singleton) DO UPDATE SET
               lease_expires_at=0, updated_at=excluded.updated_at`,
          ).bind(now),
          env.DB.prepare("DELETE FROM encrypted_payloads"),
        ]);
        return json({ ok: true, collectionLeaseExpiresAt: 0 });
      }
      if (url.pathname === "/health" && request.method === "GET") {
        return json({ ok: true });
      }
      return json({ error: "not_found" }, 404);
    } catch {
      return json({ error: "internal_error" }, 500);
    }
  },
};

async function publish(request, env) {
  if (!(await basicAuthorized(
    request,
    env.LOCATION_RELAY_USERNAME,
    env.LOCATION_RELAY_PASSWORD,
  ))) {
    return new Response("", {
      status: 401,
      headers: { "www-authenticate": 'Basic realm="OwnTracks"' },
    });
  }
  const contentLength = Number(request.headers.get("content-length") || 0);
  if (contentLength > MAX_BODY_BYTES) return json({ error: "payload_too_large" }, 413);
  const payload = await request.text();
  if (!payload) return json([]);
  if (new TextEncoder().encode(payload).byteLength > MAX_BODY_BYTES) {
    return json({ error: "payload_too_large" }, 413);
  }
  let envelope;
  try {
    envelope = JSON.parse(payload);
  } catch {
    return json({ error: "invalid_json" }, 400);
  }
  if (!envelope || envelope._type !== "encrypted" || typeof envelope.data !== "string") {
    return json({ error: "encrypted_payload_required" }, 400);
  }
  const now = Date.now();
  await cleanupExpired(env, now);
  const control = await env.DB.prepare(
    "SELECT lease_expires_at FROM relay_control WHERE singleton=1",
  ).first();
  if (!control || Number(control.lease_expires_at) <= now) {
    return json([]);
  }
  await env.DB.prepare(
    `INSERT INTO encrypted_payloads (
       id, payload_ciphertext, received_at, lease_token, lease_expires_at
     ) VALUES (?1, ?2, ?3, NULL, NULL)`,
  ).bind(crypto.randomUUID(), payload, now).run();
  return json([]);
}

async function pull(url, env) {
  const now = Date.now();
  await cleanupExpired(env, now);
  const limit = integerParam(url.searchParams.get("limit"), 100, 1, MAX_BATCH);
  const leaseSeconds = integerParam(
    url.searchParams.get("leaseSeconds"),
    300,
    30,
    MAX_PULL_LEASE_SECONDS,
  );
  const leaseToken = crypto.randomUUID();
  await env.DB.prepare(
    `UPDATE encrypted_payloads
        SET lease_token=?1, lease_expires_at=?2
      WHERE id IN (
        SELECT id FROM encrypted_payloads
         WHERE lease_expires_at IS NULL OR lease_expires_at<?3
         ORDER BY received_at ASC LIMIT ?4
      )
        AND (lease_expires_at IS NULL OR lease_expires_at<?3)`,
  ).bind(leaseToken, now + leaseSeconds * 1000, now, limit).run();
  const result = await env.DB.prepare(
    `SELECT id, payload_ciphertext AS payload, received_at AS receivedAt
       FROM encrypted_payloads
      WHERE lease_token=?1 ORDER BY received_at ASC`,
  ).bind(leaseToken).all();
  return json({ leaseToken, items: result.results || [] });
}

async function acknowledge(request, env) {
  const body = await safeJson(request);
  const leaseToken = typeof body.leaseToken === "string" ? body.leaseToken : "";
  const ids = Array.isArray(body.ids)
    ? [...new Set(body.ids.filter((id) => typeof id === "string" && id.length <= 100))]
      .slice(0, MAX_BATCH)
    : [];
  if (!leaseToken || ids.length === 0) return json({ acknowledged: 0 });
  const statements = ids.map((id) => env.DB.prepare(
    "DELETE FROM encrypted_payloads WHERE id=?1 AND lease_token=?2",
  ).bind(id, leaseToken));
  const results = await env.DB.batch(statements);
  const acknowledged = results.reduce(
    (total, result) => total + Number(result.meta?.changes || 0),
    0,
  );
  return json({ acknowledged });
}

async function renewCollectionLease(request, env) {
  const body = await safeJson(request);
  const ttlSeconds = integer(
    body.ttlSeconds,
    MAX_COLLECTION_LEASE_SECONDS,
    60,
    MAX_COLLECTION_LEASE_SECONDS,
  );
  const now = Date.now();
  const leaseExpiresAt = now + ttlSeconds * 1000;
  await env.DB.prepare(
    `INSERT INTO relay_control (singleton, lease_expires_at, updated_at)
     VALUES (1, ?1, ?2)
     ON CONFLICT(singleton) DO UPDATE SET
       lease_expires_at=excluded.lease_expires_at,
       updated_at=excluded.updated_at`,
  ).bind(leaseExpiresAt, now).run();
  await cleanupExpired(env, now);
  return json({ ok: true, collectionLeaseExpiresAt: leaseExpiresAt });
}

async function cleanupExpired(env, now) {
  await env.DB.prepare(
    "DELETE FROM encrypted_payloads WHERE received_at<?1",
  ).bind(now - RETENTION_MS).run();
}

async function basicAuthorized(request, username, password) {
  if (!username || !password) return false;
  return constantTimeEqual(
    request.headers.get("authorization") || "",
    `Basic ${btoa(`${username}:${password}`)}`,
  );
}

async function bearerAuthorized(request, token) {
  if (!token) return false;
  return constantTimeEqual(
    request.headers.get("authorization") || "",
    `Bearer ${token}`,
  );
}

async function constantTimeEqual(actual, expected) {
  const [actualHash, expectedHash] = await Promise.all([
    crypto.subtle.digest("SHA-256", new TextEncoder().encode(actual)),
    crypto.subtle.digest("SHA-256", new TextEncoder().encode(expected)),
  ]);
  const a = new Uint8Array(actualHash);
  const b = new Uint8Array(expectedHash);
  let different = a.length ^ b.length;
  for (let index = 0; index < Math.max(a.length, b.length); index++) {
    different |= (a[index] || 0) ^ (b[index] || 0);
  }
  return different === 0;
}

async function safeJson(request) {
  try {
    const value = await request.json();
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  } catch {
    return {};
  }
}

function integerParam(value, fallback, min, max) {
  return integer(Number(value), fallback, min, max);
}

function integer(value, fallback, min, max) {
  if (!Number.isInteger(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

function json(value, status = 200) {
  return Response.json(value, {
    status,
    headers: {
      "cache-control": "no-store",
      "content-type": "application/json; charset=utf-8",
    },
  });
}
