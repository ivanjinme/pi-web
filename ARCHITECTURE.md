# Architecture

Stable boundaries + non-obvious invariants. Code/tests are source of truth for
implementation details.

## System Shape

```text
Browser                Next.js Server              AgentSession (in-process)
  │                        │                               │
  ├─ GET /api/sessions ────▶ headers + file mtimes only    │
  ├─ POST /api/sessions ───▶ titles for visible thread ids │
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

## Desktop runtime boundary

- Electron hosts the desktop; packaged Next runs under the user's system
  Node.js 22.19+/npm, outside ASAR. Git for Windows (including Git Bash) is a
  user-installed prerequisite, not a bundled runtime.
- The installer bundles rg/fd seed tools. `electron/toolsets.mjs` prepares and
  reuses their verified content-addressed per-user cache outside the installation
  directory, with canonical path checks. Source-map/deployment-trace trimming
  remains part of packaging.
- There is one desktop update: an NSIS EXE plus blockmap, downloaded in the
  background through `electron-updater` using an Ed25519-signed
  `desktop-update-manifest.json`. New clients read that manifest directly;
  there is no independent business ZIP/npm update, application slot selection,
  trial-health acknowledgement or automatic rollback channel.
- Release tooling emits only installer update metadata; there is no legacy index,
  compatibility adapter, shell-digest release-kind gate or committed shell baseline.
- Installation still requires the explicit restart action, the managed-task gate
  and normal window-close approval. Ordinary exit does not install. Differential
  download has full-download fallback; successful real Windows VM differential
  transfer remains unvalidated. Neither a ≤30-second restart nor post-exit
  recovery/health-based rollback is promised. Ed25519 is not Authenticode signing.
  Current release guidance is in `docs/desktop-release.md`; performance/stage
  documents preserve historical evidence, not the current architecture.

## Session Boundaries

- **Browse:** persisted JSONL; no `AgentSession`. Sidebar discovery reads only
  headers/mtimes; visible thread titles search backward for the latest
  `session_info`, falling back to the first 50 characters of user text.
  Search loads missing titles and matches the displayed title only, not the
  original prompt or conversation body. Full transcript parsing via
  `SessionManager` waits until a thread is opened.
- New Web sessions generate a title in the background after their first
  successful reply, reusing the naming facade once without overwriting a manual
  title. Failures keep the first-message fallback; no persistent title index.
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
- Browser timeline: full selected-leaf ancestry, including each compaction at
  its persisted position. Model context: SDK compaction projection; never feed
  the browser timeline back into model input.
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

## Artifact Workspace

- Changes reflects successful `edit` and `write` records in the selected transcript
  branch, not Git or shell/manual changes. Writes lack a pre-image and cannot
  provide accurate added/removed line counts.
- File tabs share the draft's normalized path identity. Retained viewers preserve
  state, but inactive viewers must not consume file-watch SSE connections; resuming
  them must reconcile missed changes without resetting unchanged content.

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
- Out-of-root file/bash reads: require a reference from that session; references
  never authorize writes.
- Text writes: existing regular UTF-8 files within the same lexical and realpath
  allowed roots, at most 256 KiB; validate before modifying the opened descriptor.
  Recognized media/documents and binary/invalid UTF-8 targets remain read-only.
- File drafts belong to AppShell, keyed by normalized absolute path, not sessions
  or active tabs. Source and compatible Markdown share one draft and serialized
  autosave lane. Failed/dirty drafts survive closing and project switches.
- File synchronization is last-write-wins: SSE reads only replace clean drafts;
  dirty/in-flight/composing drafts defer and coalesce external refresh. No conflict
  protocol, lock, merge, or persistent/global draft store.
- Both editors treat different external text as a new Undo/Redo baseline;
  same-content refresh and local draft echoes preserve editing history.
- Project extensions and `.agents/skills`: executable repo content; require
  project trust.
- Trust change: reject busy project → destroy affected wrappers →
  invalidate/reload resource and model state.
- Projectless first prompt: create exactly `~/.weclio/default-workspace`
  (`PI_WEB_DEFAULT_CWD` override); never enumerate home to discover it.
- Auth/model status APIs: never expose raw credentials.
