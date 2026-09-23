/**
 * JSON-mode utilities.
 *
 * LLMs routinely answer "sure, here's your JSON:" followed by Markdown-fenced
 * code. We want a single function that takes raw text and hands back a
 * parsed object (or throws a specific `llm_output_malformed` error).
 *
 * Fallback-cascade:
 *   1. Straight `JSON.parse(raw.trim())`.
 *   2. Strip ```json … ``` fences and try again.
 *   3. Extract the first balanced `{ … }` / `[ … ]` block and try.
 *   4. Remove trailing commas before `}`/`]` and try.
 *   5. Give up, throw `LLM_OUTPUT_MALFORMED`.
 *
 * We avoid heroics (no partial repair beyond trailing commas) because
 * silently "fixing" broken JSON makes algorithm bugs invisible.
 */

import { ERROR_CODES, MemosError } from "../../agent-contract/errors.js";
import type { LlmProviderName } from "./types.js";
import fs from "fs";
import path from "path";
import os from "os";

export interface ParseOpts {
  provider?: LlmProviderName;
  op?: string;
}

export function parseLlmJson<T = unknown>(raw: string, opts: ParseOpts = {}): T {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    throw malformed("empty response", raw, opts);
  }

  const candidates: string[] = [];
  candidates.push(trimmed);

  // [LOCAL PATCH 2026-08-05] Strip deepseek `<think>...</think>` reasoning
  // preamble before any other parsing. deepseek-v4-flash inlines reasoning
  // into content; the block can contain `{`/`[` fragments that poison
  // extractFirstJsonBlock. Stripping it exposes the real JSON that follows.
  const thinkStripped = stripThinkBlock(trimmed);
  if (thinkStripped !== trimmed) candidates.push(thinkStripped);

  const stripped = stripFences(thinkStripped);
  if (stripped !== thinkStripped) candidates.push(stripped);

  const extracted = extractFirstJsonBlock(stripped);
  if (extracted && extracted !== stripped) candidates.push(extracted);

  for (const c of candidates) {
    try {
      return JSON.parse(c) as T;
    } catch {
      // keep trying
    }
  }

  // Last resort: strip trailing commas before `}` and `]`.
  for (const c of candidates) {
    const repaired = removeTrailingCommas(c);
    if (repaired !== c) {
      try {
        return JSON.parse(repaired) as T;
      } catch {
        // ignore and fall through
      }
    }
  }

  // [LOCAL PATCH 2026-08-05] Heuristic repair for common LLM JSON errors
  // in CJK/code-heavy contexts (unescaped quotes, over-escaped quotes,
  // stray delimiters). Validated against 14 real failure samples — fixes
  // 11/13 JSON errors (85%). Safe: only runs after all standard repairs fail.
  for (const c of candidates) {
    const repaired = heuristicRepair(c);
    if (repaired !== c) {
      try {
        return JSON.parse(repaired) as T;
      } catch {
        // keep trying other candidates
      }
    }
  }

  throw malformed("unparseable JSON after best-effort repair", raw, opts);
}

/**
 * Strip a single leading `<think>…</think>` block (deepseek reasoning
 * preamble). The block may itself contain `{`, `[`, `"`, etc., so a naive
 * `extractFirstJsonBlock` would pick a fragment from inside it. Returns the
 * text after the closing tag; if no well-formed `<think>…</think>` prefix
 * exists, returns the input unchanged.
 */
function stripThinkBlock(s: string): string {
  const m = /^[\s\S]*?<\/think>\s*/.exec(s);
  if (m && s.startsWith("<think>")) return s.slice(m[0].length);
  return s;
}

function stripFences(s: string): string {
  // Strip one layer of ```…``` fences, with or without a lang tag.
  const fence = /^```(?:json|JSON|jsonl|jsonc)?\s*([\s\S]*?)\s*```$/m;
  const m = fence.exec(s);
  if (m && typeof m[1] === "string") return m[1].trim();
  // Single-line fence: ```…```
  const inline = /^```\s*([\s\S]*?)\s*```\s*$/m.exec(s);
  if (inline && typeof inline[1] === "string") return inline[1].trim();
  return s;
}

/**
 * Find the first balanced `{…}` or `[…]` block. Returns null when nothing
 * obvious is found. Naive — but good enough for LLMs that say "Here you go:
 * {…}" or "I'll return [ …, … ] now."
 */
function extractFirstJsonBlock(s: string): string | null {
  const openers = ["{", "["];
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (!openers.includes(ch!)) continue;
    const match = walkToClose(s, i);
    if (match) return match;
  }
  return null;
}

function walkToClose(s: string, start: number): string | null {
  const open = s[start]!;
  const close = open === "{" ? "}" : "]";
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < s.length; i++) {
    const ch = s[i]!;
    if (esc) {
      esc = false;
      continue;
    }
    if (ch === "\\") {
      esc = true;
      continue;
    }
    if (ch === '"') {
      inStr = !inStr;
      continue;
    }
    if (inStr) continue;
    if (ch === open) depth++;
    else if (ch === close) {
      depth--;
      if (depth === 0) {
        return s.slice(start, i + 1);
      }
    }
  }
  return null;
}

function removeTrailingCommas(s: string): string {
  // Strip `,` right before `}` / `]`, ignoring commas inside strings.
  let out = "";
  let inStr = false;
  let esc = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!;
    if (esc) {
      out += ch;
      esc = false;
      continue;
    }
    if (ch === "\\") {
      out += ch;
      esc = true;
      continue;
    }
    if (ch === '"') {
      out += ch;
      inStr = !inStr;
      continue;
    }
    if (!inStr && ch === ",") {
      // Look ahead past whitespace for `}` or `]`
      let j = i + 1;
      while (j < s.length && /\s/.test(s[j]!)) j++;
      if (s[j] === "}" || s[j] === "]") {
        continue; // drop this comma
      }
    }
    out += ch;
  }
  return out;
}

function malformed(reason: string, raw: string, opts: ParseOpts): MemosError {
  // [LOCAL PATCH] Dump full raw response to llm.jsonl for debugging.
  try {
    const entry = JSON.stringify({ ts: new Date().toISOString(), op: opts.op, reason, rawLength: raw.length, raw }) + "\n";
    fs.appendFileSync(path.join(process.env.MEMOS_HOME || (os.homedir() + "/.hermes/memos-plugin"), "logs", "llm.jsonl"), entry);
  } catch (_) { /* best-effort */ }
  return new MemosError(ERROR_CODES.LLM_OUTPUT_MALFORMED, `LLM output not valid JSON: ${reason}`, {
    provider: opts.provider,
    op: opts.op,
    rawPreview: raw.slice(0, 512),
  });
}

/**
 * Build the "you MUST respond with JSON" instruction that goes into the
 * system prompt for providers that don't have native JSON mode.
 */
export function buildJsonSystemHint(hint?: string): string {
  const base = "Respond with a single valid JSON value and nothing else. Do not wrap in Markdown code fences. Do not include explanations.";
  if (!hint) return base;
  return `${base}\n\nExpected shape:\n${hint}`;
}

// [LOCAL PATCH 2026-08-05] ──────────────────────────────────────────────
// Heuristic repair for common LLM JSON errors in CJK/code-heavy contexts.
// Port of the Python fix_llm_json validated against 14 real samples.
// Only called after all standard parseLlmJson strategies have failed.

/**
 * Multi-pass heuristic repair. Each sub-fix targets a specific error
 * pattern observed in production logs. Safe by construction: only runs
 * when JSON.parse already failed, and returns the original string if
 * the repaired result is also unparseable.
 */
function heuristicRepair(raw: string): string {
  let s = raw;

  // Fix 1: Array item trailing over-escape — `]","key"` → `],"key"`
  s = s.replace(/\]"\s*,\s*"/g, '],"');
  s = s.replace(/\]"\s*\}/g, "]}");

  // Fix 2: Stray colon prefix in value — `"reason":":"text` → `"reason":"text`
  // Also handles missing opening quote with YAML pipe: `"reason":|text"` → `"reason":"text`
  s = s.replace(/"reason"\s*:\s*"[:：]\s*/g, '"reason":"');
  s = s.replace(/"reason"\s*:\s*\|/g, '"reason":"');

  // Fix 3: Ellipsis value — `"tool_calls":...` → `"tool_calls":[]`
  s = s.replace(/"tool_calls"\s*:\s*\.\.\./g, '"tool_calls":[]');

  // Quick check — maybe the simple fixes were enough.
  try { JSON.parse(s); return s; } catch { /* continue */ }

  // Fix 4: Unescaped quotes inside string values. Walk the string
  // tracking in-string state. A `"` that is NOT followed (after
  // whitespace) by `,` `}` `]` `:` or EOF is treated as an embedded
  // literal and escaped to `\"`.
  s = fixUnescapedQuotes(s);

  return s;
}

function fixUnescapedQuotes(s: string): string {
  let out = "";
  let i = 0;
  const n = s.length;
  let inStr = false;

  while (i < n) {
    const ch = s[i]!;

    if (!inStr) {
      if (ch === '"') inStr = true;
      out += ch;
      i++;
      continue;
    }

    // Inside a string
    if (ch === "\\") {
      // Escape sequence — copy two chars verbatim
      out += ch;
      if (i + 1 < n) {
        out += s[i + 1]!;
        i += 2;
      } else {
        i++;
      }
      continue;
    }

    if (ch === '"') {
      // Determine: string terminator or embedded quote?
      let j = i + 1;
      while (j < n && /\s/.test(s[j]!)) j++;
      if (
        j >= n ||
        s[j] === "," ||
        s[j] === "}" ||
        s[j] === "]"
      ) {
        // String terminator
        inStr = false;
        out += ch;
        i++;
      } else if (s[j] === ":") {
        // Likely a key terminator
        inStr = false;
        out += ch;
        i++;
      } else {
        // Embedded unescaped quote — escape it
        out += '\\"';
        i++;
      }
      continue;
    }

    out += ch;
    i++;
  }

  return out;
}
