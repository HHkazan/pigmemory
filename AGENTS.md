# Repository Guidelines

## Project Structure & Module Organization

The TypeScript implementation is split by responsibility: `core/` contains agent-independent memory, retrieval, reward, storage, and skill logic; `agent-contract/` defines shared DTOs and JSON-RPC types; `server/` provides HTTP/SSE routes; and `bridge/`, `bridge.cts`, and `bridge.mts` connect Hermes to the core. Agent integrations live under `adapters/`; templates and maintenance utilities belong in `templates/` and `scripts/`.

Treat `dist/` and `viewer/dist/` as generated output. `data/`, `logs/`, `daemon/`, `backups/`, and root configuration files are local runtime state, not source. A full development checkout normally also contains `tests/{unit,integration,e2e}` and the Vite viewer source; this installed checkout includes only the built viewer.

## Build, Test, and Development Commands

Use Node.js 20 or newer.

- `npm run lint`: type-checks all TypeScript without emitting files.
- `npm run dev`: runs TypeScript in watch mode.
- `npm run bridge`: launches the JSON-RPC bridge in the foreground.
- `npm run bridge:daemon`: launches the bridge as a daemon.
- `npm test`: runs the complete Vitest suite once.
- `npm run test:unit`, `test:integration`, or `test:e2e`: runs one test layer.
- `npm run build:package`: builds TypeScript and the Vite viewer for packaging.

Some build and test support files are intentionally absent from the installed package. Run those commands from a full source checkout.

## Coding Style & Naming Conventions

Follow the existing strict TypeScript style: two-space indentation, double quotes, semicolons, trailing commas in multiline constructs, and `.js` suffixes in relative ESM imports. Use `camelCase` for functions and variables, `PascalCase` for types/classes, and kebab-case filenames such as `decision-guidance.ts`. Keep domain behavior in `core/`; adapters should translate host APIs rather than duplicate algorithms. Python adapter code uses four spaces, type hints, and snake_case.

## Testing Guidelines

Vitest is the TypeScript test runner. Place tests in the matching `tests/unit`, `tests/integration`, or `tests/e2e` directory and name them `*.test.ts`. Add focused unit coverage for pure logic and integration coverage for storage, bridge, or route contracts. Run `npm run lint` and the narrowest relevant test command before submitting.

## Commit & Pull Request Guidelines

Git history is absent from this runtime checkout, so no commit convention can be verified. Use short, imperative subjects (for example, `Fix retrieval tier deduplication`) and keep commits scoped. Pull requests should explain behavior changes, list verification, link issues, and include screenshots for viewer changes. Never commit API keys or local state from `config.yaml`, `.auth.json`, `telemetry.credentials.json`, `data/`, `logs/`, or `backups/`.
