# 阶段 A：MDXEditor 4.3.2 保真实验

后续状态：用户已回复“接受”，批准实际富文本编辑后的纯格式规范化。最终实现、保真保护、fallback 范围与集成验收见 `docs/file-editors-validation.md`；本报告保留阶段 A 的原始实验结论，不作为完整集成验收。
环境：项目现有 dev server，React 19.2.4 / Next.js 16.3.3；agent-browser 独立 session，系统 Chrome。验证页不调用文件写入 API，真实文档仅作为输入读取。
配置：headings/lists/quote/thematicBreak/link/image/table/frontmatter/codeBlock/codeMirror 插件；trim=false；bullet="-"、rule="-"、emphasis="*"、strong="*"、fences=true。
## 实验结果
| 夹具 | 解析错误 | 初始化是否规范化 |
|---|---|---|
| basic | 无 | 是 |
| code | 无 | 是 |
| math | 无 | 是 |
| html | 无 | 是 |
| unknown-tag | Parsing of the following markdown structure failed: {"type":"mdxJsxTextElement","name":"artifact"} | 是 |
| frontmatter | 无 | 是 |
| resources | Parsing of the following markdown structure failed: {"type":"linkReference","name":"N/A"} | 是 |
| crlf-bom | 无 | 是 |
| spacing | 无 | 是 |
| plain | 无 | 否 |
| README.md | 无 | 是 |
| CONSTITUTION.md | 无 | 是 |

切 Source 再切回没有新增 onChange。初始化规范化事件带 initial=true；不能据此提交。普通段落插入一个 X 后会序列化整个文档。此处 Source 是实验性只读视图，不是最终双编辑器集成验证。

## 实际初始化 diff（不含用户输入 X）

### basic

```diff
--- original
+++ normalized
@@ -15,4 +15,4 @@
 | x | y |
 
 - [ ] todo
-- [x] done
+- [x] done
```

### math

```diff
--- original
+++ normalized
@@ -1,9 +1,9 @@
-Paragraph with $x^2$ and \(y\).
+Paragraph with $x^2$ and (y).
 
 $$
-x + y = 1
+x + y \= 1
 $$
 
 \[
-z = 2
-\]
+z \= 2
+]
```

### crlf-bom

原始：`'\ufeff# Heading\r\n\r\nParagraph with \\*literal\\*.\r\n\r\n'`

输出：`'# Heading\n\nParagraph with \\*literal\\*.'`

### spacing

```diff
--- original
+++ normalized
@@ -1,11 +1,7 @@
-Heading
-=======
-
+# Heading
 
 Paragraph with  two spaces.
 
-* item
+- item
 
-    More text.
-
-
+  More text.
```

### README.md

```diff
--- original
+++ normalized
@@ -15,7 +15,7 @@
 weclio-web
 ```
 
-Open http://127.0.0.1:8888 (the browser opens automatically).
+Open [http://127.0.0.1:8888](http://127.0.0.1:8888) (the browser opens automatically).
 
 ## Features
 
@@ -32,15 +32,15 @@
 weclio-web --port 8080 -H 0.0.0.0 --no-open
 ```
 
-| Env / Flag | Purpose |
-| --- | --- |
-| `PORT` / `--port` | Server port (default `8888`) |
-| `PI_WEB_HOSTNAME` / `-H` | Bind address (default `127.0.0.1`) |
-| `PI_WEB_NO_OPEN` / `--no-open` | Do not open the browser automatically |
-| `PI_WEB_ALLOWED_HOSTS` | Extra allowed hostnames behind a reverse proxy |
-| `PI_CODING_AGENT_DIR` | Pi agent directory (default `~/.pi/agent`) |
-| `PI_WEB_DEFAULT_CWD` | Fallback workspace for projectless prompts |
-| `HTTP_PROXY` / `HTTPS_PROXY` / `NO_PROXY` | Proxy for server-side requests |
+| Env / Flag                                | Purpose                                        |
+| ----------------------------------------- | ---------------------------------------------- |
+| `PORT` / `--port`                         | Server port (default `8888`)                   |
+| `PI_WEB_HOSTNAME` / `-H`                  | Bind address (default `127.0.0.1`)             |
+| `PI_WEB_NO_OPEN` / `--no-open`            | Do not open the browser automatically          |
+| `PI_WEB_ALLOWED_HOSTS`                    | Extra allowed hostnames behind a reverse proxy |
+| `PI_CODING_AGENT_DIR`                     | Pi agent directory (default `~/.pi/agent`)     |
+| `PI_WEB_DEFAULT_CWD`                      | Fallback workspace for projectless prompts     |
+| `HTTP_PROXY` / `HTTPS_PROXY` / `NO_PROXY` | Proxy for server-side requests                 |
 
 > **Security**: Pi Web has no authentication and drives a high-privilege agent. Keep it on loopback; bind to other addresses only on trusted networks.
 
@@ -60,4 +60,4 @@
 
 ## License
 
-MIT
+MIT
```

### CONSTITUTION.md

```diff
--- original
+++ normalized
@@ -4,6 +4,7 @@
 Don't assume. Don't hide confusion. Surface tradeoffs.
 
 Before implementing:
+
 - State your assumptions explicitly. If uncertain, ask.
 - If multiple interpretations exist, present them - don't pick silently.
 - If a simpler approach exists, say so. Push back when warranted.
@@ -11,6 +12,7 @@
 
 **2. Simplicity First**
 Minimum code that solves the problem. Nothing speculative.
+
 - No features beyond what was asked.
 - No abstractions for single-use code.
 - No "flexibility" or "configurability" that wasn't requested.
@@ -22,12 +24,14 @@
 Touch only what you must. Clean up only your own mess.
 
 When editing existing code:
+
 - Don't "improve" adjacent code, comments, or formatting.
 - Don't refactor things that aren't broken.
 - Match existing style, even if you'd do it differently.
 - If you notice unrelated dead code, mention it - don't delete it.
 
 When your changes create orphans:
+
 - Remove imports/variables/functions that YOUR changes made unused.
 - Don't remove pre-existing dead code unless asked.
 - The test: Every changed line should trace directly to the user's request.
@@ -36,14 +40,16 @@
 Define success criteria. Loop until verified.
 
 Transform tasks into verifiable goals:
+
 - "Add validation" → "Write tests for invalid inputs, then make them pass"
 - "Fix the bug" → "Write a test that reproduces it, then make it pass"
 - "Refactor X" → "Ensure tests pass before and after"
 
 For multi-step tasks, state a brief plan:
-1. [Step] → verify: [check]
-2. [Step] → verify: [check]
-3. [Step] → verify: [check]
+
+1. \[Step] → verify: \[check]
+2. \[Step] → verify: \[check]
+3. \[Step] → verify: \[check]
 
 Strong success criteria let you loop independently. Weak criteria ("make it work") require constant clarification.
 
@@ -55,5 +61,6 @@
 - Trust explicit upstream validation. Don't revalidate ruled-out states.
 
 ### LANGUAGE STANDARDS
+
 - TS/React: Functional components only. No `any`. Strict ESLint compliance.
-- Code comments: Default to concise **Chinese comments** for non-obvious intent, boundaries, and constraints; do not add comments for obvious code.
+- Code comments: Default to concise **Chinese comments** for non-obvious intent, boundaries, and constraints; do not add comments for obvious code.
```

## 待批准的最小取舍
只在用户真正富文本编辑后允许纯格式规范化：Setext 标题转 ATX、列表标记/缩进、额外空行、表格排版，以及不改变呈现语义的转义。打开、切模式不写入。Source 不做这些规范化。

BOM、CRLF/LF、尾部换行拟由适配层显式保留，不能直接保存实验输出；仍需实现与测试。Math/LaTeX、未知标签、引用式链接、MDX 等采取保守 fallback；raw HTML 的安全适配未证明，也应先 fallback。Mermaid 文档的渲染/编辑适配、资源链接单项、IME、自动保存与生命周期尚未验收。

## 安装与发布
10 个直接依赖已以精确版本安装在 dependencies；state/view 与 MDXEditor 去重。既有 CI 执行 npm ci、npm run build、npm publish。客户端 import 后可由现有发布构建包含编辑器 chunk/CSS；未运行生产构建，未宣称产物验证完成。

验证命令：node_modules/.bin/tsc --noEmit 已通过（含临时验证页）。npm install 报现有 emoji-mart React peer warning；npm audit --omit=dev 返回 next/undici 及关联依赖告警，记录在 output/file-editors/audit.json，未执行无关 audit fix。
