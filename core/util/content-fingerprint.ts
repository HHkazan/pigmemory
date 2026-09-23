import { createHash } from "node:crypto";

/** Stable content hash. Whitespace-only changes and object key order are ignored. */
export function contentFingerprint(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(normalize(value))).digest("hex");
}

function normalize(value: unknown): unknown {
  if (typeof value === "string") return value.replace(/\s+/g, " ").trim();
  if (Array.isArray(value)) return value.map(normalize);
  if (value && typeof value === "object") {
    const source = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) out[key] = normalize(source[key]);
    return out;
  }
  if (typeof value === "number" && !Number.isFinite(value)) return null;
  return value ?? null;
}
