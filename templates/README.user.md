# PigMemory — runtime data

This directory holds **your** memory data and configuration. The plugin's
source code lives somewhere else (typically under `~/.<agent>/plugins/…/`) and
can be uninstalled or upgraded freely without touching anything here.

## What's in here

```
config.yaml      # all configuration (including API keys); chmod 600
data/            # SQLite database, vector blobs
skills/          # crystallized skill packages (one per directory)
logs/            # rotating logs (memos.log, error.log, audit.log, llm.jsonl, perf.jsonl, events.jsonl)
daemon/          # bridge pid/port files (auto-managed)
```

## Editing your config

Open `config.yaml` in any editor. The viewer's *Settings* page can also write
back to this file; it preserves comments and field order.

API keys go directly inside `config.yaml`. The file is created with `chmod 600`
so only your user can read it.

## Resetting

- **Lose everything**: delete this whole directory. The next time you start
  your agent, it will be recreated empty.
- **Lose only memory, keep config**: delete `data/` and `skills/`.
- **Lose only logs**: delete the contents of `logs/`. Audit logs are gzipped,
  not deleted, so keeping them around forever is the default.

## Multiple agents on the same machine

Each agent has its own home directory (e.g. `~/.openclaw/memos-plugin/` and
`~/.hermes/memos-plugin/`). They never share data unless you explicitly
configure team sharing in `config.yaml`'s `hub:` section.

## Feishu interview cards

When PigMemory runs inside a Hermes Feishu session, it can send a 1–5 memory
rating card after an eligible successfully persisted turn and ask for a
structured or free-text reason. Card buttons are resolved inline without
entering the Hermes agent loop. The user can skip an interview; the same task
episode is then not prompted again automatically. It reuses Hermes' existing `FEISHU_APP_ID`,
`FEISHU_APP_SECRET`, and optional `FEISHU_DOMAIN` environment settings.

The current interview-only phase does not update memory scores. Raw UI events
are appended to `logs/feishu-interviews.jsonl`. Automatic cards require a
memory that was actually delivered to the completed turn and a configurable
trigger score above `algorithm.reviewInterview.threshold`. Tool, difficulty,
memory-value weights, tool-count bands, signal points, delay, cooldown, and
daily cap all live under `algorithm.reviewInterview` and can also be edited in
the viewer's Settings page. The memory component uses retrieval relevance plus
rating uncertainty (`1/sqrt(1 + ratingCount)`), never the historical average
rating, so highly rated memories do not receive preferential re-rating.

After the final response is delivered, the card waits for
`sendDelaySeconds`; a new user message cancels it. `/review` manually opens the
previous turn's card without the automatic threshold. It still refuses turns
that used no memory, and it does not duplicate an already completed rating.
Set `algorithm.reviewInterview.enabled: false` to disable automatic cards;
`manualEnabled` independently controls `/review`. The legacy
`MEMOS_FEISHU_INTERVIEW_ENABLED=false` remains an emergency kill switch for
both paths.

## Need help?

- User docs:   open the viewer's *Help* link.
- Bug reports: include `logs/error.log` and the relevant slice of
                `logs/events.jsonl`.
