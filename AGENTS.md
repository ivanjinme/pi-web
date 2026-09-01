# Pi Web - Development Notes

## Quick Start

```bash
npm run dev   # port 8888
```

Typecheck: `node_modules/.bin/tsc --noEmit`  
Lint: `npm run lint`  
**Never run `next build` during dev** — pollutes `.next/` and breaks `npm run dev`.

---

## Architecture

```
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

**Session browsing** (read-only): reads `.jsonl` files through SDK `SessionManager` helpers and `lib/session-reader.ts` — no AgentSession created.  
**Sending a message**: `startRpcSession()` in `lib/rpc-manager.ts` creates an AgentSession in-process.

---

## File Map

```
app/api/
  sessions/route.ts               GET  list all sessions
  sessions/[id]/route.ts          GET/PATCH/DELETE session
  sessions/[id]/context/route.ts  GET ?leafId= — context for a specific leaf
  sessions/[id]/state/route.ts    GET live wrapper state without starting one
  sessions/[id]/entries/[entryId]/thinking/route.ts GET deferred thinking block
  sessions/[id]/export/route.ts   GET exported HTML for a session
  agent/new/route.ts              POST { cwd, message, toolPreset?, toolNames?, provider?, modelId? }
  agent/[id]/route.ts             GET state | POST any command
  agent/[id]/events/route.ts      GET SSE stream
  agent/[id]/bash-output/route.ts GET/download session-referenced full bash output
  agent/running/events/route.ts   GET SSE stream of currently-running session ids
  auth/all-providers/route.ts     GET API-key provider list
  auth/api-key/[provider]/route.ts GET/POST/DELETE provider API key status/storage
  auth/login/[provider]/route.ts  GET OAuth/device-code SSE | POST manual code
  auth/logout/[provider]/route.ts POST OAuth logout
  auth/providers/route.ts         GET OAuth provider list
  cwd/validate/route.ts           POST validate/select a cwd
  cwd/default/route.ts            POST lazily create the fallback workspace
  files/[...path]/route.ts        GET list/read/preview/watch/download; POST upload
  file-index/route.ts             GET cached @-mention file index/search
  git/status/route.ts             GET file-tree Git status
  git/diff/route.ts               GET file diff
  project-trust/route.ts          GET/POST project resource trust
  projects/rebind/route.ts        POST migrate persisted project cwd
  models/route.ts                 GET { models, modelList, defaultModel }
  models-config/route.ts          GET/PUT — read/write ~/.pi/agent/models.json
  models-config/default/route.ts  PUT — persist last-selected model as global default
  models-config/test/route.ts     POST test a configured model/provider
  plugins/route.ts                GET/POST package plugin management
  skills/route.ts                 GET/PATCH loaded skills and disable-model-invocation
  skills/install/route.ts         POST install skills through npx skills add
  skills/search/route.ts          POST skills.sh search
  worktrees/route.ts              GET/POST/DELETE git worktrees

lib/
  agent-client.ts      typed fetch helper for /api/agent commands
  agent-event-wire.ts  Pi events → browser SSE shape
  streaming-message.ts streaming assistant-message reducer
  allowed-roots.ts     hot-reload-safe explicit file roots
  file-access.ts       derive/check roots for file/project APIs
  path-security.ts     realpath-aware root containment
  file-paths.ts        client/server path encoding helpers
  markdown.ts          shared markdown helpers
  npx.ts               bounded npx runner used by skills
  pi-types.ts          local structural types for pi SDK objects
  project-trust.ts     gate executable project resources
  project-folders.ts   remembered/hidden client project roots
  request-security.ts  Origin/Host/Content-Type guards
  rpc-manager.ts       AgentSessionWrapper + registry + startRpcSession
  session-reader.ts    SessionManager wrappers + path cache + buildSessionContext adapter
  session-file-references.ts authorize session-referenced file/bash reads
  skills-service.ts    runtime-equivalent skill loading
  skill-frontmatter.ts surgical disable-model-invocation edits
  tool-presets.ts      dynamic preset generation + getPresetFromTools()
  types.ts             shared TypeScript types
  normalize.ts         persisted toolCall fields → browser fields
  worktree.ts          project/worktree resolution and git worktree operations

components/
  AppShell.tsx        layout + URL state + tab management
  SessionSidebar.tsx  session tree + FileExplorer
  ChatWindow.tsx      chat composition + process/extension UI
  ChatInput.tsx       input bar + model/thinking/tools/compact controls
  MessageView.tsx     renders one message (user/assistant/toolCall/toolResult)
  BranchNavigator.tsx in-session branch switcher
  MarkdownBody.tsx    markdown renderer
  ModelsConfig.tsx    model/provider/auth configuration
  PluginsConfig.tsx   plugin package management
  SkillsConfig.tsx    loaded/search/install/update skills
  FileExplorer.tsx    file tree, uploads, Git changes
  FileViewer.tsx      file content in a tab

hooks/
  useAgentSession.ts  messages + streaming + SSE + fork/navigate/reconciliation logic
```

---

## Key Design Decisions & Traps

### AgentSession lifecycle (`lib/rpc-manager.ts`)
- One `AgentSessionWrapper` per session id, keyed in `globalThis.__piSessions`
- `globalThis` survives Next.js hot-reload; plain module-level Map does not
- Idle timeout: 10 minutes. Concurrent `startRpcSession()` calls share a single start Promise (`globalThis.__piStartLocks`)

### Fork must retire the original wrapper
Fork uses `SessionManager.create()` / `createBranchedSession()` (not `AgentSession.fork()`), caches the child id, then `await this.shutdown()` on the original wrapper. Never leave that wrapper registered after creating the child file.

### Two kinds of branching — don't confuse them
- **Fork / New chat**: new independent `.jsonl`; user-message fork branches before the prompt, assistant-message fork includes that response. Sidebar lineage via `parentSession`.
- **In-session branch** (Continue button / BranchNavigator): calls `navigate_tree` within the same file. Multiple entries share the same `parentId`. Switching between them calls `/api/sessions/[id]/context?leafId=`.

### Session files can be fully rewritten
`parentSession` in the header is **display metadata only** — has zero effect on chat content. Safe to `writeFileSync` the entire file (pi does this itself during migrations). Used when cascade-reparenting children on delete.

### ToolCall field normalization
Pi stores toolCall blocks as `{type:"toolCall", id, name, arguments}` but `ToolCallContent` uses `{toolCallId, toolName, input}`. `normalizeToolCalls()` in `lib/normalize.ts` handles this — called in `session-reader.ts` (file load) and `useAgentSession`/`streaming-message.ts` (streaming).

### Tool presets
- UI requests use `toolPreset`; `toolNames[]` remains an exact list and is never inferred as a preset. Restored sessions without either are left unchanged.
- Default uses `read + Bash/PowerShell + edit + write`; Full uses Pi runtime built-ins plus extension tools; Off disables everything and clears the system prompt.
- Shell availability is probed once per process with Pi helpers and cached on `globalThis`. Full filters unavailable shells and discovers built-ins via `sourceInfo.source === "builtin"`.

### Model defaults for new sessions
`GET /api/models` returns `defaultModel` from `~/.pi/agent/settings.json`; new-session state preselects it. Model selection fire-and-forgets `PUT /api/models-config/default`, shared with the pi CLI.

### SSE reconnect on page refresh mid-stream
On `ChatWindow` mount, `GET /api/agent/[id]` is called. If `state.isStreaming === true`, SSE is reconnected automatically. `thinkingLevel` and `isCompacting` are also synced from this response.

### Compaction lifecycle
Events: `compaction_start` / `compaction_end`. A stop can land between aborting the active turn and compaction installing its AbortController; `rpc-manager.ts` retains and reapplies that abort.

### Running state SSE + reconciliation
- The sidebar listens to `/api/agent/running/events`, backed by `subscribeRunningSessions()` in `lib/rpc-manager.ts`, so running badges update without polling.
- `useAgentSession` still treats per-session SSE as primary for chat events, but while a run is active it periodically calls `GET /api/agent/[id]` and also reconciles on `visibilitychange`/`online`. This fixes missed `agent_end` events from background tabs or half-open connections.
- Prompt runs use a monotonic run id; late SSE or slow reconciliation responses from an old run must be ignored so they cannot resurrect stale streaming bubbles.

### Worktrees and project grouping
- `lib/worktree.ts` resolves linked worktree top-levels back to the main repo `projectRoot`; `listAllSessions()` attaches that to each `SessionInfo` so all worktrees for one repo are grouped together in the sidebar.
- Worktree operations are served by `/api/worktrees` and guarded by the same allowed-root rules as `/api/files`.
- New worktrees are created under `<repoRoot>-worktrees/<sanitized-branch>`. Existing branches are reused; otherwise `git worktree add -b` creates the branch.
- Removing a dirty worktree returns `409` with `{ dirty: true }` so the UI can ask before retrying with `force`.
- Sessions whose cwd points at a removed worktree are inferred back into the main project instead of becoming a phantom project row.

### Project trust and project editing
- Project extensions / `.agents/skills` are executable repo content; gate via Pi's shared `ProjectTrustStore`. Trust change: reject busy project, invalidate models, destroy project wrappers.
- Source-folder edit (`/api/projects/rebind`): rewrite matching session `cwd` headers with rollback; then replace allowed root + invalidate session/project caches.
- Sidebar “Remove project” is client-only hide/forget (`localStorage`); does not delete files or sessions.

### File access allow-list
- `/api/files` is intentionally not a general filesystem browser. Roots = session cwds/project roots + explicit `allowed-roots.ts` entries; existing-path checks resolve symlinks.
- `/api/cwd/validate` and `/api/worktrees` call `allowFileRoot()` when they make a new location browsable.
- Out-of-root file/bash-output reads require an actual reference from the specified session.
- A projectless first prompt lazily creates the exact fallback path `~/.weclio/default-workspace` (override with `PI_WEB_DEFAULT_CWD`). Never enumerate the home directory to discover it; the resulting session cwd restores access on later runs.

### Plugins and skills
- `/api/plugins` uses pi's `SettingsManager` + `DefaultPackageManager` for global/project package install, remove, update, enable, and disable. Disabling writes empty `extensions/skills/prompts/themes` arrays for that package entry.
- `/api/skills` uses `DefaultResourceLoader` so settings paths, package skills, and project `.agents/skills` are listed the same way the runtime sees them.
- Skill toggling edits only the `disable-model-invocation` frontmatter key on the target `SKILL.md`; keep that surgical so user formatting survives.
- `/api/skills/install` shells through `npx skills add ... --agent pi`; project installs run with the selected cwd.

### Auth and model config
- `ModelsConfig` combines `~/.pi/agent/models.json` with pi `AuthStorage`/`ModelRegistry`; status APIs must never expose raw keys.
- Model test route: `app/api/models-config/test/route.ts` — not `app/api/models/test/`.

### Exported session HTML
- `/api/sessions/[id]/export` delegates to pi's export helper, then patches recursive tree helpers in the generated HTML to iterative versions so very deep linear sessions do not overflow the browser call stack.

## Pi Session File Format

Location: `~/.pi/agent/sessions/<encoded-cwd>/<timestamp>_<uuid>.jsonl`

```jsonl
{"type":"session","version":3,"id":"<uuid>","timestamp":"...","cwd":"/path","parentSession":"/abs/path/to/parent.jsonl"}
{"type":"model_change","id":"<8hex>","parentId":null,"provider":"...","modelId":"...","timestamp":"..."}
{"type":"message","id":"<8hex>","parentId":"<8hex>","message":{"role":"user","content":"..."}}
{"type":"message","id":"<8hex>","parentId":"<8hex>","message":{"role":"assistant","content":[...],...}}
{"type":"message","id":"<8hex>","parentId":"<8hex>","message":{"role":"toolResult","toolCallId":"...","content":[...]}}
{"type":"compaction","id":"<8hex>","parentId":"<8hex>","summary":"...","firstKeptEntryId":"<8hex>","tokensBefore":N}
{"type":"session_info","id":"...","parentId":"...","name":"user-defined name"}
```

`entryIds[]` in `SessionContext` is a parallel array to `messages[]` — maps each displayed message back to its `.jsonl` entry id, used for fork and navigate_tree calls.
