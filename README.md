# PigMemory

[![npm](https://img.shields.io/npm/v/@memtensor%2Fpigmemory)](https://www.npmjs.com/package/@memtensor/pigmemory)
[![license](https://img.shields.io/badge/license-Apache--2.0-blue)](./LICENSE)
[![node](https://img.shields.io/badge/node-%3E%3D20-green)](./package.json)

[中文文档](./README.zh-CN.md)

> **Self-evolving memory for AI agents — with private location memory.**
> One algorithm core, multiple agent adapters (OpenClaw, Hermes Agent).

PigMemory is a local-first, file-backed memory system. It records what your
agent does, reflects on how well it worked, back-propagates value along each
trace, and crystallizes high-value patterns into callable skills. At inference
time a three-tier retriever injects the right context at the right moment.

**PigMemory is an independent, heavily reworked fork of
[`memos-local-plugin`](https://github.com/MemTensor/MemOS/tree/main/apps/memos-local-plugin)
from the [MemOS](https://github.com/MemTensor/MemOS) monorepo**: same
Reflect2Evolve core, plus a new product identity, a new flagship capability,
runtime hardening, and a full Chinese documentation set. Existing
`memos-local-plugin` installations upgrade in place — data, skills, and config
are reused without migration.

## What's different from memos-local-plugin

|  | memos-local-plugin (upstream) | PigMemory |
| --- | --- | --- |
| Product identity | `@memtensor/memos-local-plugin` | `@memtensor/pigmemory`, own plugin id `pigmemory`, own installers |
| **Location memory** | — | OwnTracks + Cloudflare Worker relay, end-to-end encrypted |
| Communication bridge | one canonical entry | two entries (`bridge.cts` / pure-module `bridge.mts`) kept in lockstep by an entry-consistency test suite |
| Process detection | system-command expressions break on some shells | wide candidate listing + in-process command-line matching |
| Model retries | per-model retry count ignored | max-retry wired through config, defaults, and both model clients |
| Documentation | English | full Chinese set: 16-diagram visual guide, detailed flow + audit report |
| Agent adapters | OpenClaw, Hermes, DeepSeek Harness | OpenClaw, Hermes (upstream's newer DSH adapter is not included) |

### 1. New flagship: private location memory

The agent knows where you are — without anyone else being able to know.

- **OwnTracks on your phone → Cloudflare Worker (free tier) → your machine.**
  The Worker stores only *encrypted* JSON envelopes in D1 for at most 7 days;
  it never holds decryption keys, usernames, device names, or plaintext
  coordinates.
- Decryption and place detection happen **only on your machine**. Location is
  a separate `userProfile` bypass: it never writes into L1/L2/L3, Reward, or
  Skill, and coordinates are never given to the LLM or any notification
  channel.
- Long-term storage keeps only **semantic places** (name, city, HMAC of
  geohash-7 neighborhood) and arrival/departure times — no coordinates.
- Arrivals, departures, and a daily digest are delivered via Feishu cards.
  A new place gets one naming card; reply with `name｜city` to name it.
- Turning either switch off stops collection, deletes pending ciphertext, and
  **revokes the Worker lease** (self-expires after 10 minutes even on crash).
- Deployment is a single `wrangler deploy` with no custom domain. Full guide:
  [`docs/location-memory.zh-CN.md`](./docs/location-memory.zh-CN.md) (Chinese).

### 2. Runtime hardening (on the 2.0.x baseline)

- The two bridge entries (script-style `bridge.cts` and pure-module
  `bridge.mts`) now share startup/shutdown protection, runtime-domain
  parameters, dynamic profiles, configurable logging, process probing, and
  timed shutdown — verified by an entry-consistency test.
- Process probing no longer injects complex expressions into system commands;
  candidates are listed compatibly and matched in-process.
- Per-model maximum retry counts are respected (config → defaults → clients).

### 3. Documentation you can actually read

- [`docs/pigmemory-visual-guide.zh-CN.md`](./docs/pigmemory-visual-guide.zh-CN.md) —
  4 formula diagrams + 12 flow diagrams covering reward backprop, retrieval
  ranking, policy induction, world model, and skill lifecycle.
- [`docs/memos-detailed-flow.zh-CN.md`](./docs/memos-detailed-flow.zh-CN.md) —
  the complete system flow with a full audit report (in Chinese).

## The Reflect2Evolve loop

![PigMemory complete memory loop](viewer/public/assets/pigmemory-guide/01-system-overview.png)

Four cooperating layers of memory:

- **L1 trace** — step-level grounded records (action + observation + reflection + value).
- **L2 policy** — sub-task strategies induced across many traces.
- **L3 world model** — compressed environmental cognition derived from L2 + L1.
- **Skill** — callable, crystallized capabilities the agent can invoke directly.

The plugin learns from two feedback channels:

- **Step-level** — model ↔ environment (tool results, observation deltas).
- **Task-level** — human ↔ model (explicit ratings + implicit signals).

Reflection-weighted reward is back-propagated along each trace, and high-value
patterns crystallize into reusable Skills. At inference time, a three-tier
retriever (Skill → trace/episode → world model) injects the right context at
the right time.

## Quick start

> [!IMPORTANT]
> **Do not run `npm install -g @memtensor/pigmemory`.**
> This package is a Hermes / OpenClaw plugin, not a standalone CLI. Use the
> installer below; it is the only supported install path.

From this repository:

```bash
bash install.sh --version 2.0.12
```

Or run against the latest published package:

```bash
bash install.sh
```

The installer downloads the package from npm, deploys it to the right agent
directory, installs production dependencies, writes the initial `config.yaml`,
and restarts the agent runtime when needed. It auto-detects OpenClaw and
Hermes; in an interactive terminal it asks which agent to install for. On
Windows, run `install.ps1` from PowerShell (same flags and behavior).

To test a local package before publishing:

```bash
npm pack
bash install.sh --version ./memtensor-pigmemory-2.0.12.tgz
```

## Where data lives

The source never writes to your home directly. At install time `install.sh`
creates a per-agent runtime folder:

| Agent    | Code installed to                    | Runtime data + config in    |
| -------- | ------------------------------------ | --------------------------- |
| OpenClaw | `~/.openclaw/plugins/pigmemory/`     | `~/.openclaw/memos-plugin/` |
| Hermes   | `~/.hermes/plugins/pigmemory/`       | `~/.hermes/memos-plugin/`   |

```
config.yaml      # the only config file (includes API keys; chmod 600)
data/memos.db    # SQLite (L1/L2/L3/Skill/Episode/Feedback/…)
skills/          # crystallized skill packages
logs/            # rotating logs
daemon/          # bridge pid/port files
```

Upgrading or uninstalling the plugin **never** touches `data/`, `skills/`,
`logs/`, or `config.yaml`.

## Configuration

The plugin reads `config.yaml` from the runtime directory, resolved in this
priority order:

1. `MEMOS_HOME` — runtime root directory
2. `MEMOS_CONFIG_FILE` — direct path to the config file
3. `--home` CLI flag (bridge only)
4. Default per-agent path

For Docker deployments, set `MEMOS_HOME` explicitly:

```dockerfile
FROM nousresearch/hermes-agent:latest
RUN bash install.sh
ENV MEMOS_HOME=/opt/data/.hermes/memos-plugin
CMD node /opt/data/.hermes/plugins/pigmemory/bridge.cts --agent=hermes --daemon && hermes chat
```

When config is missing, the plugin falls back to defaults (local embedding, no
LLM provider): trace memory works, but summarization and reflection are
degraded.

## Compatibility with memos-local-plugin

Existing installations keep legacy protocol names so upgrades reuse their data
and host integrations without migration:

- tool names such as `memos_search` and `memos_skill_get`;
- environment variables `MEMOS_HOME`, `MEMOS_CONFIG_FILE`, and related flags;
- runtime data directories named `memos-plugin/` and the SQLite file
  `data/memos.db`.

The installers treat `memos-local-plugin` as a legacy plugin id and disable it
when registering the new `pigmemory` id. They never delete the legacy runtime
data directory.

## Credits & license

PigMemory is based on
[`apps/memos-local-plugin`](https://github.com/MemTensor/MemOS/tree/main/apps/memos-local-plugin)
from [MemTensor/MemOS](https://github.com/MemTensor/MemOS). We are grateful to
the MemOS team for the Reflect2Evolve architecture PigMemory builds on.

Licensed under the [Apache License 2.0](./LICENSE). See [NOTICE](./NOTICE) for
attribution.
