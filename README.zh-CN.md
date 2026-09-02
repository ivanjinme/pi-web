# Pi Web

[English](./README.md)

[pi 编程智能体](https://github.com/badlogic/pi-mono) 的本地网页界面：在浏览器里对话、按项目管理历史会话、配置模型和技能、预览项目文件。

## 快速开始

要求 Node.js 22.19+。

```bash
npx @weclio/pi-web@latest
# 或
npm install -g @weclio/pi-web
weclio-web
```

打开 http://127.0.0.1:8888（会自动打开浏览器）。

## 功能

- 流式对话，完整展示 tool call、thinking 和图片
- 按项目浏览会话；可从任意消息恢复、Fork 或分支
- 侧边栏切换 Git worktree
- 文件浏览与预览：源码、图片、PDF 等
- 网页内管理模型、登录/API key、技能
- 顶栏实时显示上下文占用、花费和压缩状态

## 选项

```bash
weclio-web --port 8080 -H 0.0.0.0 --no-open
```

| 环境变量 / 参数 | 作用 |
| --- | --- |
| `PORT` / `--port` | 端口（默认 `8888`） |
| `PI_WEB_HOSTNAME` / `-H` | 监听地址（默认 `127.0.0.1`） |
| `PI_WEB_NO_OPEN` / `--no-open` | 不自动打开浏览器 |
| `PI_WEB_ALLOWED_HOSTS` | 反向代理下允许的主机名 |
| `PI_CODING_AGENT_DIR` | pi agent 目录（默认 `~/.pi/agent`） |
| `PI_WEB_DEFAULT_CWD` | 无项目时的默认工作目录 |
| `HTTP_PROXY` / `HTTPS_PROXY` / `NO_PROXY` | 服务端请求代理 |

> **安全**：Pi Web 没有身份验证，且驱动高权限智能体。保持 loopback 监听；仅在可信网络中绑定其他地址。

更多文档见 [`docs/`](./docs)。

## 开发

```bash
npm install
npm run dev   # http://127.0.0.1:8888

node_modules/.bin/tsc --noEmit
npm run lint
```

本地开发不要跑 `next build`——会干扰 dev server。构建交给 CI。

## 许可

MIT
