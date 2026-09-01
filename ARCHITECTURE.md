# Architecture

Stable boundaries + non-obvious invariants. Code/tests are source of truth for
implementation details.

## System Shape

```text
Browser                Next.js Server              AgentSession (in-process)
  │                        │                               │
  ├─ GET /api/sessions ────▶ reads ~/.pi/agent/sessions/   │
  ├─ GET /api/sessions/[id] reads .jsonl file directly     │
  ├─ GET /api/agent/running/events ───▶ running id SSE     │
  │                        │                               │
  ├─ send message ─────────▶ POST /api/agent/[id]          │
  │                        │   startRpcSession() ─────────▶│ createAgentSession()
  │                        │   session.send(cmd) ─────────▶│ session.prompt()
  │                        │                               │
  ├─ SSE connect ──────────▶ GET /api/agent/[id]/events    │
  │                        │   session.onEvent() ◀─────────│ session.subscribe()
  │◀── data: {...} ─────────│                               │
```

## Load by Concern

| Concern | Read first |
| --- | --- |
| Runtime lifecycle, commands, fork, compaction | `lib/rpc-manager.ts` |
| Persisted sessions, context, lineage | `lib/session-reader.ts` |
| Browser run state, reconnect, branch navigation | `hooks/useAgentSession.ts` |
| Streaming message assembly | `lib/streaming-message.ts` |
| Persisted → browser tool calls | `lib/normalize.ts` |
| Tool selection | `lib/tool-presets.ts` |
| Project/worktree identity | `lib/worktree.ts` |
| Project trust lifecycle | `lib/project-trust.ts`, `lib/rpc-manager.ts` |
| File authorization | `lib/file-access.ts`, `lib/path-security.ts` |
| Referenced external files | `lib/session-file-references.ts` |
| Default workspace | `lib/default-workspace.ts` |

## Session Boundaries

- **Browse:** persisted JSONL via `SessionManager`; no `AgentSession`.
- **Run:** in-process `AgentSessionWrapper`; created/resumed only for runtime
  commands.
- Never make browsing require a live wrapper.

## Runtime Invariants

- One live wrapper per session id.
- Registries/start locks on `globalThis`: intentional Next.js hot-reload
  survival; module-local state would duplicate runtimes.
- Concurrent starts for one id share one promise.
- Fork creates/caches child, then shuts down original wrapper. Keeping both
  alive leaves runtime ownership on the wrong continuation.

## Two Branch Models

- **Fork / New chat:** new JSONL; sidebar lineage via `parentSession`.
  - User-message fork: branch before prompt.
  - Assistant-message fork: include selected response.
- **In-session branch:** same JSONL; switch active tree leaf via navigation.
- Never implement one model in terms of the other.
- `parentSession`: display metadata only; never conversation inheritance.
- Full session-file rewrites are valid for metadata migrations.
- Browser `entryIds[]` is parallel to `messages[]`; fork/navigation addresses
  persisted entry ids, not rendered indexes.

## Representation Boundaries

- Persisted entries ≠ Pi runtime events ≠ browser messages.
- Convert at existing adapters; do not leak storage/SDK shapes into UI state.
- Tool-call fields differ across persisted/browser shapes; normalize every
  assistant-message load and stream path through `normalizeToolCalls()`.
- `toolNames`: exact list. `toolPreset`: runtime-resolved semantic preset.
  Never infer either from the other.

## Async Correctness

- Per-session SSE: primary transport, not sufficient correctness source.
- Reconcile live wrapper state during runs and after visibility/network return;
  otherwise missed terminal events leave stale streaming UI.
- Prompt run id is monotonic. Drop late SSE and slow reconciliation from older
  runs; they must not mutate the current run.
- Running badges use a separate process-wide running-id subscription.
- Compaction stop race: stop may arrive before compaction owns its abort
  controller; retain and reapply the request on `compaction_start`.

## Project / Worktree Identity

- Linked worktree **top-level** → main repo `projectRoot`; sessions group under
  one project while retaining their own cwd.
- Repo subdirectory → keep cwd identity; do not collapse to repo root.
- Removed managed worktree → infer main project; avoid phantom project groups.
- Worktree operations must pass the same root authorization as file APIs.

## Project / File Access Boundaries

- File APIs are not a general filesystem browser.
- Browsable roots: session/project-derived or explicitly allowed.
- Existing paths: realpath-aware containment; lexical checks are insufficient.
- Out-of-root file/bash reads: require a reference from that session.
- Project extensions and `.agents/skills`: executable repo content; require
  project trust.
- Trust change: reject busy project → destroy affected wrappers →
  invalidate/reload resource and model state.
- Projectless first prompt: create exactly `~/.weclio/default-workspace`
  (`PI_WEB_DEFAULT_CWD` override); never enumerate home to discover it.
- Auth/model status APIs: never expose raw credentials.
