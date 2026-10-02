# Subagent Artifacts Design Spec

Status: implementation-ready  
Date: 2026-09-10  
Scope: `weclio-web` + `@weclio/pi-submarine`

## 1. Goal

When the parent agent calls `subagent` or `subagent_resume`:

- Keep the tool card compact in the parent conversation.
- Clicking the card opens the child conversation as an artifact tab in the right workspace.
- The artifact uses the same transcript rendering and streaming behavior as the main conversation.
- The artifact is read-only: no composer, fork, edit-from-here, queue controls, or session commands.
- Completed child conversations remain inspectable after refresh and after the parent run finishes.

## 2. Locked product decisions

These decisions do not require further product input.

1. **Artifact location:** open as a tab in the existing right workspace tab bar.
2. **Artifact width:** while a subagent tab is active, hide the file Explorer and give the transcript the entire right workspace body.
3. **File behavior:** clicking a file link inside the child transcript opens a normal file tab. Switching back to a subagent tab restores the artifact transcript.
4. **Parent card:** fixed compact height; never stream the full child transcript inside the card.
5. **Read-only behavior:** child transcript has no message input and no mutation actions.
6. **Live transport:** child progress travels through the already-open parent session SSE stream.
7. **History source:** the child JSONL is canonical for completed messages.
8. **No competing runtime:** the Web app must not call `startRpcSession()` for a child while Pi Submarine owns that child `AgentSession`.
9. **Nested subagents:** a subagent card inside an artifact opens that nested child as another artifact tab.
10. **Tab identity:** one tab per child `sessionId`; `subagent_resume` reuses the same artifact tab.
11. **Parallel children:** sibling subagents update independently; one child never auto-opens, focuses, closes, or scrolls another artifact tab.
12. **Background tabs:** retain each hidden child’s latest validated snapshot and reconcile from JSONL when focused again.

## 3. User experience

### Parent conversation

A `subagent` / `subagent_resume` tool card keeps the existing visual language but changes its click behavior.

```text
┌ reviewer · running                                  42s ┐
│ using bash {"command":"npm test"}                      │
└─────────────────────────────────────────────────────────┘
```

Required card content:

- agent name (`run.agent`)
- status: running / completed / failed / interrupted
- latest compact activity (`run.activity`)
- elapsed duration when available
- optional turn count and context percentage when space permits

Interaction:

- Clicking anywhere on a recognized subagent card opens/focuses its artifact tab.
- Do not expand raw tool input/result for recognized subagent cards.
- Preserve the existing expandable behavior for every other tool.
- Use a clear hover/focus state and `cursor: pointer`.

### Right workspace

```text
┌ reviewer ● ──────────────── x ┬ src/file.ts ─────── x ┐
├─────────────────────────────────────────────────────────┤
│ User prompt                                             │
│                                                        │
│ reviewer-model                                         │
│ Thinking                                                │
│ ┌ bash ... ┐                                            │
│ └──────────┘                                            │
│ Streaming response…                                     │
│                                                        │
│                                                        │
└─────────────────────────────────────────────────────────┘
```

- Reuse the main conversation spacing, markdown, thinking blocks, tool cards, process grouping, lazy history, minimap, and auto-follow behavior.
- Hide the minimap only when the artifact pane itself is narrower than the existing usable threshold; measure the pane, not the browser viewport.
- Do not render `ChatInput`, extension dialogs/widgets, parent notices, branch actions, edit actions, or fork actions.
- Show the normal transcript empty/loading/error states inside the workspace body.
- A running status dot may appear in the tab label; avoid a separate decorative header.

### Scrolling

Match the main conversation exactly:

- If the user is within 24 px of the bottom, continue following streamed growth.
- If the user scrolls upward, do not pull them back down.
- Do not add artifact-only scroll controls.

### Responsive behavior

- Desktop/tablet: artifact occupies the full right workspace body.
- Existing right-panel resizing remains unchanged.
- Mobile: the existing right workspace is full-screen; opening a subagent artifact uses that same presentation.
- Do not introduce a second mobile modal or drawer.

## 4. Existing system facts

### Pi Submarine

The maintained extension already provides:

- stable child `sessionId`
- stable execution `episodeId`
- persisted child JSONL under `<root-session>.jsonl.subagents/`
- a root `manifest.jsonl`
- `SubagentRunView` status/activity trees
- partial tool updates through `onUpdate()`
- resumable child sessions

Current partial updates only contain compact activity:

```ts
interface SubagentToolDetails {
  run: SubagentRunView;
}
```

Repeated token deltas intentionally do not trigger repeated updates, so this is insufficient for a live transcript.

### Weclio Web

- `lib/agent-event-wire.ts` currently drops `tool_execution_update`.
- `hooks/useAgentSession.ts` currently handles tool start/end but not tool updates.
- `ChatWindow.tsx` combines session ownership, transcript rendering, input, global abort registration, dialogs, and branch actions.
- `AppShell.tsx` right-workspace tabs are file-only.
- Child session IDs are not discoverable through `resolveSessionPath()`, because normal `SessionManager.listAll()` does not index nested `.subagents` directories.

## 5. Architecture

```text
Pi Submarine child AgentSession
  │ child AgentSession events
  ▼
Submarine artifact snapshot builder
  │ onUpdate({ details: { run, artifact } })
  ▼
Parent AgentSession tool_execution_update
  │
  ▼
weclio-web AgentSessionWrapper
  │ caches latest active tool partials for reconnect
  ▼
Parent /api/agent/[id]/events SSE
  │
  ├─ Parent tool card receives compact run state
  └─ Open artifact receives child live snapshot

Completed history:
Parent session id
  ▼ authorize through root manifest
GET /api/sessions/[parentId]/subagents/[childId]
  ▼
Child JSONL → existing session normalization → read-only transcript
```

### Why not connect to the child through the existing agent API?

Pi Submarine creates and owns the child `AgentSession` inside the parent extension execution. It is not registered in `rpc-manager.ts`. Starting another wrapper for the same JSONL would create competing ownership, duplicate extension lifecycle, and unsafe write behavior.

## 6. Cross-package data contract

Add the following exported contract to `@weclio/pi-submarine`.

```ts
export const SUBAGENT_ARTIFACT_PROTOCOL_VERSION = 1;

export interface SubagentArtifactToolSnapshot {
  toolCallId: string;
  toolName: string;
  args: Record<string, unknown>;
  partialResult?: {
    content: Array<{ type: "text" | "image"; [key: string]: unknown }>;
    details?: unknown;
  };
}

export interface SubagentArtifactSnapshotV1 {
  version: 1;
  revision: number;
  sessionId: string;
  episodeId: string;
  /** Cumulative live assistant message. Null outside assistant streaming. */
  streamingMessage: unknown | null;
  /** Running tools, including their latest partial result. */
  activeTools: SubagentArtifactToolSnapshot[];
  /** Latest structural child event; omit high-frequency raw token deltas. */
  event?: unknown;
}

export interface SubagentToolDetails {
  run: SubagentRunView;
  artifact?: SubagentArtifactSnapshotV1;
}
```

`unknown` at the package boundary avoids re-exporting unstable Pi runtime types. Runtime validators on both sides must narrow the values before use.

### Snapshot semantics

- `revision` increases monotonically within one execution episode.
- `streamingMessage` is a cloned cumulative assistant message from the child event's `message` field.
- `activeTools` is a complete replacement snapshot, not a delta.
- `event` carries only events needed to update completed transcript state immediately:
  - `message_start`
  - `message_end`
  - `tool_execution_start`
  - `tool_execution_end`
  - `agent_start`
  - `agent_end`
  - `compaction_start`
  - `compaction_end`
  - retry events
- Do not forward raw `thinking_delta` as a separate event. The cumulative `streamingMessage` already contains it.
- Tool execution partial output belongs in `activeTools[].partialResult`.

### Emission rate

- Structural events emit immediately.
- Cumulative assistant snapshots emit at most once per 100 ms.
- A skipped update must be replaced by a trailing update or by the next structural event.
- Flush the latest snapshot before returning, throwing, or disposing the child session.
- Cloning is mandatory; later Pi mutation must not change an emitted snapshot.

## 7. Pi Submarine changes

Repository: `../weclio-plugins/extensions/pi-submarine`

### `src/types.ts`

- Add and export the versioned artifact snapshot types.
- Extend `SubagentToolDetails` with optional `artifact`.
- Keep `run` unchanged for compatibility with existing clients.

### New `src/artifact-snapshot.ts`

Implement a small state holder:

```ts
interface ArtifactSnapshotState {
  revision: number;
  streamingMessage: unknown | null;
  activeTools: Map<string, SubagentArtifactToolSnapshot>;
}
```

Responsibilities:

- reduce child `AgentSessionEvent` into a replacement snapshot
- clone messages, args, content, and details
- retain the latest partial result for each active tool
- remove tools on `tool_execution_end`
- sanitize events to the supported set
- throttle cumulative streaming snapshots
- expose `flush()` and `dispose()`

Do not merge this into `activity.ts`; compact status and transcript snapshots have different update-frequency requirements.

### `src/runner.ts`

- Build one artifact snapshot state per execution episode.
- Feed every child event to both:
  1. existing compact activity reducer
  2. new artifact snapshot reducer
- Call `onUpdate()` when either representation changes.
- Include `{ run, artifact }` in partial updates.
- Include the final artifact snapshot in successful final details.

### Failed/aborted structured details

Today `runSubagent()` throws, and Pi's generated error tool result loses `details`. That breaks artifact discovery after refresh.

Implement a package-local error-details bridge:

1. Define `SubagentExecutionError extends Error` carrying `SubagentToolDetails`.
2. In `index.ts`, retain failed details by parent `toolCallId` before rethrowing.
3. Register a `tool_result` handler for `subagent` and `subagent_resume`.
4. When the corresponding thrown tool result arrives, patch `details` with the retained structured details and delete the retained entry.
5. Clear retained entries on `session_shutdown`.

Result: successful, failed, and aborted persisted tool results all contain `details.run.sessionId`.

### Package tests

Add tests for:

- cumulative assistant snapshot updates
- 100 ms throttle and trailing flush
- active tool start/update/end replacement semantics
- immutable emitted snapshots
- final successful details include artifact
- failed/aborted `tool_result` receives structured details
- nested subagent snapshots remain represented by their own `sessionId`
- existing compact activity tests remain unchanged

## 8. Web server changes

### `lib/subagent-artifacts.ts` (new)

This is the only Web module aware of the Submarine file contract.

Responsibilities:

- runtime-validate `details.run`
- runtime-validate protocol-v1 artifact snapshots
- identify tool names `subagent` and `subagent_resume`
- resolve a child session through the root parent manifest
- verify containment and header identity
- convert child session entries using existing `buildSessionContext()`

Do not import source files from the sibling `weclio-plugins` repository. The Web package must work when the extension is absent. Structural validation keeps this an optional integration.

### Child authorization

Add:

```text
GET /api/sessions/[parentId]/subagents/[childId]
```

Resolution algorithm:

1. Resolve `parentId` through existing `resolveSessionPath()`.
2. Set `subagentsDir = parentPath + ".subagents"`.
3. Read only `subagentsDir/manifest.jsonl`.
4. Find exactly one `type: "started"` record whose `sessionId === childId`.
5. Resolve and realpath the recorded child file.
6. Require the child file to be contained inside the realpath of `subagentsDir`.
7. Read the bounded child header.
8. Require header `type === "session"` and `header.id === childId`.
9. Require normalized header cwd to match the manifest cwd.
10. Open read-only with `SessionManager.open()` and return normalized history.

Never accept a child path from the browser. Never add nested child sessions to the normal sidebar session index.

Response shape:

```ts
interface SubagentSessionResponse {
  parentSessionId: string;
  sessionId: string;
  info: {
    id: string;
    cwd: string;
    created: string;
    modified: string;
    messageCount: number;
  };
  context: {
    messages: AgentMessage[];
    entryIds: string[];
    model?: { provider: string; modelId: string };
    thinkingLevel?: string;
  };
}
```

No tree or mutation endpoints are needed in v1.

### `lib/agent-event-wire.ts`

- Stop globally dropping `tool_execution_update`.
- Project it to the minimum browser shape:

```ts
{
  type: "tool_execution_update",
  toolCallId,
  toolName,
  partialResult
}
```

- Omit repeated `args`; the parent assistant tool call already contains them.
- Keep `turn_start` and `turn_end` filtered.

### Reconnect snapshot

`AgentSessionWrapper` must retain active tool progress:

```ts
private activeToolUpdates = new Map<string, {
  toolName: string;
  partialResult: unknown;
}>();
```

Lifecycle:

- `tool_execution_update`: replace map entry.
- `tool_execution_end`: replace the entry with the final result and mark it final.
- matching `message_end` for the parent `toolResult`: remove the entry after the persisted result is emitted.
- `agent_end` / destroy: clear.

Keeping the final result through `message_end` closes the reconnect gap between tool completion and persistence.

Expose a cloned array through the SSE `connected` event:

```ts
{
  type: "connected",
  sessionId,
  isStreaming,
  activeToolUpdates: [...]
}
```

This lets a newly opened/reconnected browser recover the current child live snapshot without replaying old SSE events.

### Server tests

Cover:

- valid parent → child resolution
- unknown child ID
- duplicate manifest records
- malformed manifest record
- child path escape using `..`
- symlink escape
- child header ID mismatch
- cwd mismatch
- child sessions excluded from normal session listing
- SSE wire includes minimized tool updates
- connected snapshot includes active tool updates

## 9. Web client state

### Generic tool-progress state

In `hooks/useAgentSession.ts`, add:

```ts
interface ToolExecutionProgress {
  toolName: string;
  result: ToolResultMessage;
  isFinal: boolean;
}

Map<string, ToolExecutionProgress> // key: parent toolCallId
```

Behavior:

- On `connected`, hydrate entries from `activeToolUpdates`.
- On `tool_execution_update`, normalize `partialResult` into a non-error `ToolResultMessage` and replace the entry.
- On `tool_execution_end`, replace it with the final result temporarily.
- On the corresponding persisted `message_end` tool result, remove the transient entry.
- Clear on run completion/session remount.

Expose the map to `ChatWindow`.

### Artifact frame propagation

Add a callback from `ChatWindow` to `AppShell`:

```ts
onSubagentArtifactSnapshot?: (
  parentSessionId: string,
  snapshot: ValidatedSubagentArtifactSnapshot,
  run: ValidatedSubagentRun,
) => void;
```

`ChatWindow` emits only validated snapshots extracted from tool progress. `AppShell` stores latest snapshots by child `sessionId`, ignoring revisions less than or equal to the stored revision for the same `episodeId`.

A resume episode has a new `episodeId` but the same `sessionId`; replace the live episode for that tab.

### Parallel subagent isolation

Parent tool events may interleave when several distinct children run concurrently.

- Parent transport state remains keyed by parent `toolCallId`, so simultaneous calls cannot overwrite each other before child identity is known.
- Artifact state remains keyed by `{ parentSessionId, childSessionId }`, so equal agent names do not collide.
- Revision comparison is scoped to `episodeId`; never compare revisions across different children or episodes.
- An inactive artifact tab accepts replacement snapshots but performs no rendering or scroll work.
- Only the active artifact tab renders high-frequency snapshots; background tabs retain the latest snapshot until focused.
- A child completion changes only its own card and tab status.
- Live updates never steal focus; opening an artifact is always a user action.
- Closing a running artifact tab closes only the view, not the child. A later card click recreates it from retained/live state.
- Parent abort behavior remains unchanged. V1 adds no per-child stop control.

## 10. Transcript component extraction

### New `components/ConversationTranscript.tsx`

Move transcript-only behavior out of `ChatWindow.tsx`:

- message and tool-result pairing
- turn grouping and `ProcessDetailsGroup`
- lazy history rendering
- streaming message rendering
- auto-follow
- message refs required by minimap

Suggested props:

```ts
interface ConversationTranscriptProps {
  messages: AgentMessage[];
  entryIds: string[];
  streamState: StreamingState;
  modelNames?: Record<string, string>;
  cwd?: string;
  sessionId?: string;
  busy: boolean;
  phase?: AgentPhase;
  toolProgress?: ReadonlyMap<string, ToolExecutionProgress>;
  notices?: NoticeItem[];
  compacting?: boolean;
  visiblePageSize?: number;
  interaction?: {
    onFork?: (entryId: string) => void;
    forkingEntryId?: string;
    onEditFromHere?: EditFromHereHandler;
  };
  onOpenFile?: (filePath: string) => void;
  onOpenSubagent?: (artifact: SubagentArtifactRef) => void;
  showMinimap?: boolean;
  aboveContent?: ReactNode;
}
```

Rules:

- Main chat passes its current actions/notices/widgets and keeps current behavior.
- Artifact passes no interaction object, notices, or widgets. It enables the same minimap when its own pane width is sufficient.
- `ConversationTranscript` must not call `useAgentSession`, register global shortcuts, render dialogs, or render an input.
- Do not create a second copy of transcript grouping/rendering logic.

### `components/ChatWindow.tsx`

After extraction, keep responsibility for:

- `useAgentSession`
- `ChatInput`
- drag/drop
- extension UI/dialogs/widgets
- global abort registration
- parent session callbacks
- empty new-chat state

Render `ConversationTranscript` for the conversation body.

## 11. Subagent artifact component

### New `components/SubagentArtifact.tsx`

Props:

```ts
interface SubagentArtifactProps {
  parentSessionId: string;
  childSessionId: string;
  liveSnapshot?: ValidatedSubagentArtifactSnapshot;
  onOpenFile: (filePath: string) => void;
  onOpenSubagent: (artifact: SubagentArtifactRef) => void;
}
```

Responsibilities:

1. Fetch canonical child history from the new read-only endpoint.
2. Keep fetched `messages` and `entryIds` as the settled base.
3. Apply structural live events newer than the fetched state.
4. Treat `liveSnapshot.streamingMessage` as authoritative for the current assistant bubble.
5. Treat `liveSnapshot.activeTools` as transient tool progress.
6. On `message_end`, append/deduplicate by timestamp + role + tool-call identity, then clear the matching streaming bubble.
7. Refetch canonical history when:
   - the live episode reaches a terminal status
   - the tab becomes visible after being hidden
   - the browser returns online
8. Canonical refetch replaces speculative live-completed messages while retaining a still-running streaming snapshot.
9. Render `ConversationTranscript` in read-only mode.

Do not open an EventSource for the child session.

## 12. Tool card integration

### `components/MessageView.tsx`

Add props through `MessageView` → `AssistantMessageView` → `BlockView` → `ToolCallBlock`:

```ts
onOpenSubagent?: (artifact: SubagentArtifactRef) => void;
toolProgress?: ReadonlyMap<string, ToolExecutionProgress>;
```

For `subagent` / `subagent_resume`:

1. Prefer persisted `result.details.run`.
2. Otherwise use transient `toolProgress.get(toolCallId)?.result.details.run`.
3. Validate before rendering or enabling click.
4. Render `SubagentToolCard`, not the generic expandable result card.
5. Pass root parent session ID plus child `sessionId` to `onOpenSubagent`.

If details are absent or invalid, fall back to the existing generic tool card; never parse the human-readable result text for a session ID.

### New `components/SubagentToolCard.tsx`

Keep this component presentation-only. It receives validated data and emits `onOpen`.

Status treatment:

- running: accent pulse dot
- completed: success dot
- failed: error dot
- aborted: muted warning dot, label `Interrupted`

Avoid new gradients, large icons, or a separate visual system. The artifact is part of the existing developer workspace, not a dashboard.

## 13. Right workspace tabs

### Generalize `components/TabBar.tsx`

Replace file-only `Tab` with:

```ts
type WorkspaceTab =
  | {
      kind: "file";
      id: string;
      label: string;
      filePath: string;
      sourceSessionId?: string | null;
      initialDisplayMode?: "source" | "preview" | "diff";
    }
  | {
      kind: "subagent";
      id: string;
      label: string;
      parentSessionId: string;
      childSessionId: string;
      status: SubagentRunStatus;
    };
```

- File tab icon remains unchanged.
- Subagent tab uses a small terminal/agent glyph and status dot.
- Tab title for subagents: `${agent} — ${status}`.

### `components/AppShell.tsx`

Rename state conceptually:

- `fileTabs` → `workspaceTabs`
- `activeFileTabId` → `activeWorkspaceTabId`

Opening a subagent:

```ts
id = `subagent:${parentSessionId}:${childSessionId}`
```

- Reuse an existing tab with that ID.
- Update its label/status from newer run snapshots.
- Open the right panel.
- On mobile, preserve existing behavior that reveals the right workspace.

Body rendering:

- Active file tab: preserve current Explorer + file pane layout exactly.
- Active subagent tab: render `SubagentArtifact` as the only child of `right-workspace-body`; do not render Explorer or its resizer.
- No active tab: preserve current empty-file behavior.

Project/session changes:

- Existing file tabs still clear when changing project.
- Subagent tabs clear when their root parent session does not belong to the newly selected project.
- Switching between sessions in the same project may keep artifact tabs; authorization remains rooted in each tab's recorded parent session ID.

## 14. Data consistency rules

1. Child JSONL is authoritative for settled entries.
2. Parent SSE artifact snapshot is authoritative only for currently streaming content and active tool partials.
3. `episodeId` identifies one execution/resume episode.
4. `sessionId` identifies the durable child conversation and artifact tab.
5. Ignore lower/equal revisions within the same episode.
6. A new episode for the same session replaces the tab's live episode.
7. Never write to a child JSONL from the artifact UI.
8. Never expose child sessions in the main session sidebar.
9. Never trust file paths supplied in tool details from the browser; resolve through the server-side manifest.

## 15. Failure and empty states

| Condition | UI |
|---|---|
| Child starting; JSONL not materialized yet | Transcript skeleton + `Starting subagent…`; continue using live snapshot |
| Manifest exists but JSONL not yet present | Retry fetch while run is `running`; do not show permanent 404 |
| Unknown/unauthorized child | `Subagent artifact is unavailable.` |
| Child failed | Keep transcript; tab/card show failed status |
| Child interrupted | Keep transcript; show interrupted status |
| Parent SSE disconnect | Keep last snapshot; show existing connection recovery behavior; canonical history remains readable |
| Plugin lacks protocol-v1 artifact snapshot | Card can open completed history from `details.run`; live transcript is unavailable, compact activity still works |
| Invalid structured details | Fall back to generic tool rendering |

## 16. Compatibility and rollout

- `artifact` is optional in `SubagentToolDetails`; old Submarine versions continue to show normal tool cards.
- Web detects the integration structurally; no hard dependency on `@weclio/pi-submarine`.
- Release the Submarine protocol change before or together with the Web UI.
- The Web endpoint may support existing completed sessions because their manifest and child JSONL already exist.
- Existing failed sessions without persisted structured details are not guaranteed clickable; do not add text parsing solely for migration.

## 17. Implementation order

1. **Submarine protocol and tests**
   - artifact snapshot state
   - throttled updates
   - failed-result details bridge
2. **Web server support**
   - validators/resolver
   - read-only child endpoint
   - SSE tool-update forwarding and reconnect snapshot
3. **Web client transport**
   - transient tool progress map
   - snapshot callback to `AppShell`
4. **Transcript extraction**
   - create `ConversationTranscript`
   - verify main chat behavior is unchanged
5. **Workspace tab generalization**
   - discriminated tabs
   - full-width subagent body
6. **Artifact and card UI**
   - `SubagentArtifact`
   - `SubagentToolCard`
   - nested artifact opening
7. **Regression and browser QA**

Do not start with UI mocks before the protocol and authorization tests pass.

## 18. Web tests

### Unit tests

- artifact details validators
- revision ordering across resume episodes
- tool progress normalization
- manifest authorization and path containment
- workspace-tab reducer/open/close behavior
- stream/base-history reconciliation

### Component tests

- recognized subagent card opens artifact
- invalid details use generic tool card
- read-only transcript has no composer/actions
- active subagent tab hides Explorer
- active file tab restores Explorer
- same child session reuses tab on resume
- simultaneous siblings keep separate cards, snapshots, statuses, and tabs
- background child updates do not steal focus or alter active-tab scroll
- closing one running child tab does not stop it or affect siblings
- nested child opens a distinct tab

### Browser QA

1. Start a slow subagent that emits thinking, text, read, bash output, and a final answer.
2. Open its card while running.
3. Verify cumulative text streams in the artifact, tools update in place, and the parent card remains compact.
4. Scroll upward; verify streaming does not steal scroll.
5. Close/reopen the right panel; verify state remains.
6. Refresh during execution; verify active snapshot recovers from parent SSE `connected` payload.
7. Refresh after completion; verify history loads from child JSONL.
8. Run `subagent_resume`; verify the existing tab updates rather than duplicating.
9. Run several sibling subagents concurrently; verify interleaved updates remain isolated and no tab steals focus.
10. Close one running child tab; verify the child and its siblings continue, then reopen it from the card.
11. Run a nested subagent; verify its card opens another artifact tab.
12. Fail and abort children; verify structured links and transcripts survive refresh.
13. Open a file from the artifact, then switch back; verify both tabs retain state.

## 19. Acceptance criteria

The feature is complete when:

- A running Submarine card opens a live, read-only child transcript in the right workspace.
- The transcript visually and behaviorally matches the main conversation for messages, thinking, tools, grouping, markdown, and scrolling.
- The card height does not grow with child output.
- Refresh/reconnect recovers a running child without starting a second child runtime.
- Completed, failed, and interrupted children remain accessible by structured session identity.
- Nested and concurrently running sibling children remain isolated.
- Existing file workspace and main conversation behavior remain unchanged.
- Security tests prove a parent session cannot access child files outside its own `.subagents` root.
