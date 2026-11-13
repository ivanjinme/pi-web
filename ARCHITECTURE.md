# Architecture

Architecture boundaries and code entrypoints. Implementation details live in code/tests.

## System & Ownership

Target architecture. Code dependencies, not process layout:

```text
 Web UI                              Desktop UI
   │ HTTP / SSE                         │ preload / IPC
   ▼                                    ▼
 Next.js host                       Electron Main
   │                                    │
   └──────────────┐     ┌───────────────┘
                  ▼     ▼
        Shared Application Services
        Agent / Sessions / Files / Auth / Trust
                     │
                     ▼
                   Pi SDK
```

- Shared services have no Next.js/Electron dependencies; each host instantiates them independently.
- Hosts own transport and lifecycle; shared services own business logic.
- Pi owns agent execution, session persistence/tree semantics, and model-context construction. Do not reimplement them.

## Current Code Entrypoints

| Concern | Start here |
| --- | --- |
| Runtime lifecycle, commands, fork, compaction | `lib/rpc-manager.ts` |
| Persisted-session queries, timeline, lineage | `lib/session-reader.ts` |
| Browser run state, reconnect, branch navigation | `hooks/useAgentSession.ts` |
| Streaming assembly / tool-call adaptation | `lib/streaming-message.ts`, `lib/normalize.ts` |
| Tool selection | `lib/tool-presets.ts` |
| Project identity (session cwd) | `lib/session-reader.ts`, `components/SessionSidebar.tsx` |
| Project trust | `lib/project-trust.ts`, `lib/rpc-manager.ts` |
| File authorization | `lib/file-access.ts`, `lib/path-security.ts` |
| Referenced external files | `lib/session-file-references.ts` |
| Default workspace | `lib/default-workspace.ts` |
| Shared file drafts | `components/AppShell.tsx`, `lib/draft-store.ts`, `lib/file-draft.ts` |
| Desktop processes / bundled tools | `electron/main.mjs`, `electron/toolsets.mjs` |
| Desktop updates / releases | `electron/updates.mjs`, `docs/desktop-release.md` |
