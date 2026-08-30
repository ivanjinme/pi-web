# Pi Web

[中文文档](./README.zh-CN.md)

Local web UI for the [pi coding agent](https://github.com/badlogic/pi-mono). Chat with pi in the browser, browse past sessions by project, manage models and skills, and preview project files.

## Quick Start

Requires Node.js 22.19+.

```bash
npx @weclio/pi-web@latest
# or
npm install -g @weclio/pi-web
pi-web
```

Open http://127.0.0.1:8888 (the browser opens automatically).

## Features

- Chat with streaming responses, tool calls, thinking, and images
- Browse sessions by project; resume, fork, or branch from any message
- Switch Git worktrees from the sidebar
- File explorer with preview: source, images, PDFs, and more
- Manage models, auth, and skills from the UI
- Context usage, cost, and compaction visible in the top bar

## Options

```bash
pi-web --port 8080 -H 0.0.0.0 --no-open
```

| Env / Flag | Purpose |
| --- | --- |
| `PORT` / `--port` | Server port (default `8888`) |
| `PI_WEB_HOSTNAME` / `-H` | Bind address (default `127.0.0.1`) |
| `PI_WEB_NO_OPEN` / `--no-open` | Do not open the browser automatically |
| `PI_WEB_ALLOWED_HOSTS` | Extra allowed hostnames behind a reverse proxy |
| `PI_CODING_AGENT_DIR` | Pi agent directory (default `~/.pi/agent`) |
| `PI_WEB_DEFAULT_CWD` | Fallback workspace for projectless prompts |
| `HTTP_PROXY` / `HTTPS_PROXY` / `NO_PROXY` | Proxy for server-side requests |

> **Security**: Pi Web has no authentication and drives a high-privilege agent. Keep it on loopback; bind to other addresses only on trusted networks.

More docs in [`docs/`](./docs).

## Development

```bash
npm install
npm run dev   # http://127.0.0.1:8888

node_modules/.bin/tsc --noEmit
npm run lint
```

Do not run `next build` locally — it interferes with the dev server. Builds happen in CI.

## License

MIT
