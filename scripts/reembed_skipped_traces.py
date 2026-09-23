#!/usr/bin/env python3
"""
Re-embed skipped short-text traces with bge-m3 (1024d) via SiliconFlow.

Targets: traces where shouldTraceHaveEmbeddings() would SKIP (short user/agent
text) but which still carry a 384d vector (1536 bytes) or NULL vec.
Updates ONLY vec_summary / vec_action columns for those rows.

Mirrors MemOS sourceText logic:
  vec_summary: summary || user_text || "(empty)"
  vec_action : agent_text + "\n---\n" + toolSig  (tool.name(input[:300])); joined "; "
Usage:
  python3 reembed_skipped_traces.py [--limit N] [--dry-run]
"""
import argparse
import json
import sqlite3
import struct
import sys
import time
import urllib.request

import yaml

DB = "/home/leslie/.hermes/memos-plugin/data/memos.db"
CONFIG = "/home/leslie/.hermes/memos-plugin/config.yaml"
BATCH = 32

# Same predicate as shouldTraceHaveEmbeddings() in memory-core.ts
SKIP_QUALIFICATION = """
  NOT (
    (LENGTH(TRIM(user_text)) >= 10 OR LENGTH(TRIM(agent_text)) >= 10)
    AND (LENGTH(TRIM(user_text)) + LENGTH(TRIM(agent_text)) >= 20)
  )
"""
FLOAT32_BYTES = 4
OLD_BYTES = 1536   # 384d
NEW_BYTES = 4096   # 1024d


def load_config():
    cfg = yaml.safe_load(open(CONFIG))
    emb = cfg.get("embedding", {})
    return emb.get("apiKey"), emb.get("endpoint"), emb.get("model")


def safe_json_for_embedding(value):
    if value is None:
        return ""
    if isinstance(value, str):
        return value
    try:
        return json.dumps(value, ensure_ascii=False)
    except Exception:
        return str(value)


def vec_action_text(agent_text, tool_calls_json):
    try:
        tools = json.loads(tool_calls_json or "[]")
    except Exception:
        tools = []
    sig = "; ".join(
        f"{t.get('name','')}({safe_json_for_embedding(t.get('input')).strip()[:300]})"
        for t in tools
    )
    parts = [agent_text.strip(), sig]
    return "\n---\n".join(p for p in parts if p) or "(empty)"


def embed_batch(api_key, endpoint, model, texts):
    """POST one batch to SiliconFlow embeddings. Returns list of float lists."""
    body = json.dumps({"model": model, "input": texts}).encode()
    req = urllib.request.Request(
        endpoint,
        data=body,
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {api_key}",
        },
    )
    with urllib.request.urlopen(req, timeout=60) as resp:
        data = json.loads(resp.read().decode())
    items = sorted(data["data"], key=lambda x: x["index"])
    return [it["embedding"] for it in items]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--limit", type=int, default=0, help="max rows (0=all)")
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    api_key, endpoint, model = load_config()
    if not api_key or not endpoint or not model:
        print("ERROR: embedding config missing"); sys.exit(1)

    conn = sqlite3.connect(DB)
    conn.row_factory = sqlite3.Row

    # Rows needing re-embed: skipped traces whose vec_summary/vec_action is
    # NULL or NOT 1024d (1536B old or any other wrong length).
    rows = conn.execute(
        f"""
        SELECT id, user_text, agent_text, summary, tool_calls_json,
               LENGTH(vec_summary) AS vs_len, LENGTH(vec_action) AS va_len
        FROM traces
        WHERE {SKIP_QUALIFICATION}
          AND (
            vec_summary IS NULL OR LENGTH(vec_summary) <> {NEW_BYTES}
            OR vec_action IS NULL OR LENGTH(vec_action) <> {NEW_BYTES}
          )
        ORDER BY ts
        """
    ).fetchall()
    print(f"target rows: {len(rows)}")
    if args.dry_run:
        print("dry-run: nothing will be written")
        return

    if args.limit > 0:
        rows = rows[: args.limit]

    updated = 0
    skipped = 0
    t0 = time.time()
    for i in range(0, len(rows), BATCH):
        chunk = rows[i : i + BATCH]
        summary_texts = [
            (r["summary"] or "").strip() or (r["user_text"] or "").strip() or "(empty)"
            for r in chunk
        ]
        action_texts = [vec_action_text(r["agent_text"], r["tool_calls_json"]) for r in chunk]

        try:
            svecs = embed_batch(api_key, endpoint, model, summary_texts)
            avecs = embed_batch(api_key, endpoint, model, action_texts)
        except Exception as e:
            print(f"batch {i} failed: {e}")
            skipped += len(chunk)
            time.sleep(2)
            continue

        for r, sv, av in zip(chunk, svecs, avecs):
            # sanity: dim must be 1024 → 4096 bytes
            if len(sv) * FLOAT32_BYTES != NEW_BYTES or len(av) * FLOAT32_BYTES != NEW_BYTES:
                print(f"  dim mismatch on {r['id']}: s={len(sv)} a={len(av)}")
                skipped += 1
                continue
            sb = sqlite3.Binary(struct.pack(f"<{len(sv)}f", *sv))
            ab = sqlite3.Binary(struct.pack(f"<{len(av)}f", *av))
            conn.execute(
                "UPDATE traces SET vec_summary=?, vec_action=? WHERE id=?",
                (sb, ab, r["id"]),
            )
            updated += 1

        conn.commit()
        if (i // BATCH) % 10 == 0 or i + BATCH >= len(rows):
            el = time.time() - t0
            print(
                f"progress {min(i+BATCH, len(rows))}/{len(rows)} "
                f"updated={updated} skipped={skipped} elapsed={el:.0f}s",
                flush=True,
            )

    conn.close()
    print(f"DONE updated={updated} skipped={skipped}")


if __name__ == "__main__":
    main()
