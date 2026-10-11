# 文件编辑器：实现与开发验收

日期：2026-10-10。按 `docs/file-editors-impl-plan.md` 完成 A → B → C → D → E 及开发验收。用户已批准依赖安装，并回复“接受”富文本编辑后的纯格式规范化。本次没有运行生产构建、发布或 git commit。

## 1. 实际改动

- 写入边界：`app/api/files/[...path]/route.ts`、`lib/file-write.ts`、`lib/file-write.test.mjs`。
- 共享草稿与生命周期：`lib/file-draft.ts`、`lib/file-draft.test.mjs`、`hooks/useFileDraft.ts`、`components/FileDraftStatus.tsx`、`components/AppShell.tsx`。
- Source：`components/SourceEditor.tsx`、`lib/source-lines.ts`、`lib/source-lines.test.mjs`。
- Markdown：`components/MarkdownEditor.tsx`、`components/InitializedMarkdownEditor.tsx`、`lib/markdown-editing.ts`、`lib/markdown-editing.test.mjs`。
- 视图、样式、状态文案：`components/FileViewer.tsx`、`app/globals.css`、`lib/i18n/messages/en.ts`、`lib/i18n/messages/zh-CN.ts`。
- 依赖：`package.json`、`package-lock.json`。
- 边界与实验记录：`ARCHITECTURE.md`、`docs/file-editors-phase-a-report.md`、本报告、`lib/fixtures/file-editors-markdown.json`。

输入计划 `docs/file-editors-impl-plan.md` 未修改。临时验证页面已删除；浏览器验收仅写入本次创建的临时夹具，未编辑真实仓库 Markdown。临时操作夹具和探针 JSON 已清理，日志与截图保留在 `output/file-editors/`，不纳入 npm 发布文件范围。

## 2. 保存与授权契约

- GET 的文本响应及 metadata 提供 `editable`；它只是能力提示，PUT 每次独立检查权限。
- PUT 使用原始 `text/plain` UTF-8 请求体，允许空文本；请求流、实际 UTF-8 字节及现有目标均受 256 KiB 限制，不依赖 Content-Length。
- 只写已存在的普通文件，不创建文件或目录；打开时不截断，在授权和文本验证完成后才写入、调整长度。
- lexical / realpath allowed-root 检查，复用现有允许根；打开描述符后检查普通文件、当前目标与 descriptor 的身份。session reference 不扩大写权限。
- 已识别图片、音频、文档，以及未知二进制、非法 UTF-8、不可写目标保持只读。错误提供 400/403/404/413/415/500 等明确响应。
- 写入保留请求原始字节；没有文件版本字段、mtime 冲突协议、409 流程、锁或合并。

草稿归 AppShell 所有，按规范化路径共享，与 active tab、当前项目及 AgentSessionWrapper 无绑定。保存状态为 saved / dirty / saving / failed；记录当前 revision 和已确认文本，提交快照绑定原始路径。每路径至多一个本客户端 PUT，响应丢失也不会把撤销回旧内容误判为无需重写。

自动保存为 800ms trailing debounce、5s max-wait；组合输入时暂停强制提交。Ctrl/Cmd+S、离开编辑区、切文件/模式触发 flush。失败停止自动循环，保留草稿，支持状态栏及关闭文件后的全局重试；dirty/saving/failed 时 beforeunload 只做离页警告，不承诺卸载期间异步保存成功。clean 缓存有界，dirty/failed/in-flight 草稿不淘汰。

SSE 不覆盖 dirty、saving 或 composing 草稿；事件合并后在本地队列稳定时补读。慢 GET 用请求代次与输入 revision 防回灌；即使读取期间发生“编辑再撤销”且最终 clean，也补读新磁盘状态。相同内容不替换编辑器文档，不重置选区、光标或 Undo。最终内容遵守 last-write-wins。

## 3. 编辑器支持与保真

### Source

现有范围内可写 UTF-8 文本直接使用 CodeMirror 6，无文件级 Edit/Save/Cancel。支持搜索、Undo、行号、换行、Ctrl/Cmd+S、选中行 Ctrl/Cmd+I 引用、主题切换与异步语言加载。没有匹配语言或加载失败时提供纯文本高亮提示；保留不可写内容及旧轻量预览路径。

Doc 位置统一处理 CRLF/LF/CR，写回只修改选中区间，保留未修改的原始 BOM 与混合换行；新插入的换行采用当前文件的默认风格。Source 不进行 Markdown 格式规范化。

### Markdown

兼容文档默认 Preview，使用客户端动态加载的 MDXEditor；段落、标题、强调、链接、图片、列表/嵌套列表/任务列表、引用、分隔线、表格及无 metadata 的普通 fenced code 可编辑。不同的外部正文更新初始化基线并重挂载 MDXEditor；本地草稿回显及相同内容刷新不重新导入。

初始化、模式切换和外部更新不触发保存。导入后验证序列化结果，校验失败保留原始共享草稿并退回只读预览；程序化同步标记及序列化基线共同抑制初始化/同步回调。实际用户编辑后才允许已批准的 Setext→ATX、空行、列表标记/缩进、表格排版及保守支持的不改变语义的转义规范化。

适配层独立保留 BOM、LF/CRLF 风格和原有尾部换行数量。相对图片只在展示时转换为 API 地址，存储 URL 不改写；本地链接使用已有文件打开链路。

保守只读 Preview fallback 范围：

- `.mdx`、JSX/HTML、import/export、MDX 表达式。
- Math/LaTeX、Mermaid、frontmatter、未知标签。
- 引用式链接、Windows/file 链接、危险资源协议。
- fence metadata、无法证明安全的缩进/未闭合 fence、混合或 CR-only 换行。
- 任何解析或 round-trip 不通过的文档，以及编辑器模块加载失败。

fallback 是只读 **Preview**，同一文件的 Source 仍按正常授权可编辑，并非全部 Markdown 只读。该安全判断是保守支持集，不声称覆盖任意 Markdown/MDX 扩展语法。HTML 保持 Source 默认；Preview 使用当前草稿，iframe 保持 `sandbox="allow-scripts"`，没有新增 HTML 富文本编辑或放宽 sandbox。

## 4. 自动检查

全部使用项目本地工具：

```sh
node_modules/.bin/tsc --noEmit
npm run lint
node --test lib/file-write.test.mjs lib/file-draft.test.mjs \
  lib/markdown-editing.test.mjs lib/source-lines.test.mjs \
  lib/request-security.test.mjs components/FileViewer.test.mjs \
  components/AppShell.test.mjs lib/file-access.test.mjs \
  lib/file-types.test.mjs lib/file-links.test.mjs \
  lib/session-file-references.test.mjs app/api/files/stream-route.test.mjs \
  app/api/agent/events-route.test.mjs
git diff --check
npm ls @mdxeditor/editor @codemirror/state @codemirror/view --omit=dev
```

结果：tsc 通过；lint 通过且无警告；52 项测试全部通过（0 fail、0 skipped）；diff check 通过；CodeMirror state/view 共享去重。日志：`output/file-editors/tests.txt`、`lint.txt`、`dependencies.txt`。

测试覆盖真实 Unicode 字节限制、空文本、BOM/换行、禁止创建目标、目录及非法路径、二进制/非法 UTF-8/已识别只读格式、symlink 逃逸、权限/磁盘故障、流式请求、串行写入、IME、debounce/max-wait、失败及模糊响应、慢 GET/SSE、只读输入拒绝、格式恢复、安全检测、round-trip、行引用和接近上限的 EditorState 增量编辑。原有 AppShell/FileViewer、文件链接/权限/类型/session references、流式响应/CSP 和 SSE 测试均通过。

Node 的既有 MODULE_TYPELESS_PACKAGE_JSON 提示未通过无关 package type 修改消除。Git 对 `ARCHITECTURE.md` 有 LF→CRLF 工作区提示，不是 diff whitespace 错误。

## 5. 浏览器验收

环境：Windows、系统 Chrome、已有开发服务；使用 agent-browser。完成后关闭浏览器会话，删除临时夹具。

| 检查 | 实际结果 |
| --- | --- |
| Preview / Source 共享 | 富文本输入与 Source 输入均保存同一草稿；无编辑切换不产生 PUT |
| 初始化 / 外部更新 | 空 Markdown 首次打开 0 PUT；clean 外部 Setext 文档导入并显示后仍 0 PUT |
| 常规编辑 | 段落、任务勾选、嵌套列表/表格保持、fenced TS code 编辑均正常保存；支持 Undo |
| 相同 SSE 与 Undo | 写回同一内容后富文本 Undo 仍有效，随后保存恢复正文 |
| 本地资源 | 相对图片加载；URL 不改写；本地链接打开文件 |
| Source 功能 | 搜索、Undo、Ctrl+S、选中行引用；不支持的 GraphQL 明示纯文本高亮 |
| 自动保存 / 生命周期 | 保存中编辑/撤销、模式及文件切换不丢输入；关闭后的失败草稿仍可重试 |
| 切项目 | 原文件 flush；模拟失败草稿在另一项目仍可见，重试写回原路径 |
| SSE / LWW | clean 接收 agent 更新；dirty 不被覆盖；本地稳定后补读最终 agent 更新 |
| IME | Source 和 Markdown 合成 composition 期间不 PUT；Markdown 期间 Ctrl+S 也保持请求计数不变，结束后完整中文落盘 |
| 格式 | BOM/CRLF/双尾部换行保留；Source 编辑 BOM+混合 CRLF/LF/CR 文件逐字节保持未修改区间 |
| 默认模式 | Markdown Preview、HTML Source；Changes 首次打开 Diff |
| HTML | Preview 使用本地当前草稿；sandbox 仍为 allow-scripts |
| 特殊 Markdown | Math/HTML/unknown tags/frontmatter/Mermaid/reference/metadata 等只读 Preview fallback；MDX Source 可编辑 |
| 大文本 | 258,000 字节长行可响应、虚拟化显示；插入 3 字节后 258,003 字节保存成功 |
| 非文本与删除 | 二进制只读；图片、音频、PDF iframe、DOCX sandbox 预览未回归；删除目标保存失败且不复活 |
| 请求来源 | 实际跨来源 PUT 返回 403；普通同来源保存正常 |
| 主题 / 控制台 | 明暗 Source/Markdown、窄侧栏截图检查；最终浏览器错误列表为空 |

截图：`markdown-final.png`、`dark-markdown.png`、`dark-source.png`、`large-source.png`、`changes-diff.png`、`failure.png`（位于 `output/file-editors/`）。权限、磁盘故障及模糊响应的部分情形采用自动化 mock；IME 是合成 composition 验证，不等同于原生输入法的人工验收。

## 6. 依赖与未来发布

11 个新增直接依赖均为 production、锁定精确版本（含审查后经用户批准提升为直接依赖的 commands）：

- `@mdxeditor/editor@4.3.2`
- `codemirror@6.0.2`
- `@codemirror/commands@6.11.1`
- `@codemirror/state@6.7.6`、`@codemirror/view@6.43.14`
- `@codemirror/lang-markdown@6.5.2`、`@codemirror/lang-html@6.4.12`
- `@codemirror/lang-javascript@6.2.5`、`@codemirror/lang-json@6.0.2`
- `@codemirror/lang-css@6.3.1`、`@codemirror/language-data@6.5.2`

所选直接包登记 MIT。锁文件中现有共享依赖发生以下安装解析更新，未单独进行全项目升级：Radix portal 1.1.10→1.1.18、primitive 2.1.4→2.1.11、slot 1.2.4→1.4.0、mdast-util-gfm-strikethrough 2.0.0→2.0.1、mdast-util-to-markdown 2.1.2→2.2.0；部分已有 dev 标记因 production 编辑器依赖图被提升。

MDXEditor 样式只有一处导入；Source 与 MDXEditor 都通过真实应用入口引用，后者客户端动态加载。现有 `.github/workflows/publish.yml` 使用 npm ci → build → publish；package files 包含生产 `.next` 和 static assets，排除 cache/dev/maps。未来发布构建将包含编辑器代码/样式，依赖也随 npm 安装提供。这里只验证了依赖、导入和发布配置链路，未生产构建或实测最终 tarball。

## 7. 未执行与风险

- 按项目约束未运行 next build / npm run build、发布、git commit；生产包实测交给现有 CI。
- 未测试 macOS/Safari 或原生中文输入法；Ctrl/Cmd 分支及组合输入保护已有实现、Windows 浏览器及自动化验证，但不冒充跨平台人工验收。
- `npm audit --omit=dev` 仍报告 4 个漏洞项：Next critical，sharp/source-map-js/undici high。没有安装前审计基线归因，也未执行 audit fix 或无关依赖升级；详见 `output/file-editors/audit.json`，正式发布前需单独评估。
- last-write-wins 本身允许其他客户端/agent 的后来写入覆盖已有内容；不提供冲突恢复协议。浏览器草稿仅内存保留，忽略离页警告后不保证恢复。
- Markdown 不是任意语法通吃；保真未证明的内容明确 fallback，Source 是完整文本修改入口。

## 8. 提交前修复与简化

- 修复实际输入触发 Markdown fallback 时丢失文本：先交给共享草稿，再卸载编辑器；初始化/解析失败仍禁止写回。
- FileViewer 删除本地完整 FileData 副本，正文、语言、可编辑状态和读取字节数统一来自共享快照。快照 size 为 null 时表示未成功读取，0 表示已读取的空文件；只读二进制预览保留服务端原始字节数。
- 删除未使用的 confirmedRevision、测试 reads 数组、SourceEditor editable 参数/只读配置、Markdown 外壳重复预检查及链接处理中的不可达分支。
- 保存快捷键统一由 FileViewer 捕获；编辑器仍保留 blur/卸载 flush 和组合输入通知。提取共享 scheduleSave，保留 800ms debounce、5s max-wait 和 IME 暂停行为。
- 原路径与解析目标仍分别验证文件类型，但同一 descriptor 的内容只读取、解码一次。保留授权、目标身份、UTF-8 和字节限额检查。
- 新增组件实际回调、空文件/未读取/失败读取/只读字节数及路径别名测试；确认媒体目标不能借文本别名获得写权限。

本轮相关自动测试共 62 项通过；项目本地 tsc --noEmit --incremental false、npm run lint、git diff --check 通过。未重跑浏览器验收，未运行生产构建，未提交 git commit。第 4–5 节及 output/ 日志是初次实现验收记录，不作为本轮新增验证的记录。

## 9. 提交前审查问题修复

- Source 不再设置 `EditorState.lineSeparator`；初始化、粘贴和外部导入统一使用 CodeMirror 默认的 CRLF/LF/CR 拆分，避免剪贴板换行与文件风格不同导致行号和文档位置错位。
- 新增 `lib/source-editor-state.ts`：StateField 维护原始写回文本及默认换行风格。通过 `@codemirror/commands` 的 `invertedEffects` 仅保存被删除换行的原始分隔符，配合官方历史映射支持合并编辑、多光标和 Undo/Redo；不复制整份文件历史，也不替换官方撤销队列。
- 外部导入同步 StateField，标记为非用户编辑、不进入 Undo 历史；相同文本仍不替换文档。新增换行采用文件首次出现的分隔符，包括 CR-only 文件。
- Source 挂载及卸载都报告空选区，防止 Preview → Source 后引用之前已经消失的选中行。
- 经用户确认，将已有间接依赖 `@codemirror/commands@6.11.1` 声明为直接 production 依赖；复用现有版本，state/view/commands 均去重。

新增 `lib/source-editor-state.test.mjs` 和 `components/SourceEditor.test.mjs` 共 9 项回归测试：覆盖三种文件/粘贴换行的组合、后续编辑和行引用、BOM/混合/尾部换行的精确撤销重做、合并编辑、多范围删除、50 轮随机合并编辑、外部同步及实际组件生命周期和回调。组件测试执行真实回调并使用 CodeMirror State/History，不模拟完整浏览器 DOM。

本轮相关测试共 **71 项通过**；`node_modules/.bin/tsc --noEmit --incremental false`、`npm run lint`、`git diff --check` 通过，`npm ls @codemirror/commands @codemirror/state @codemirror/view --omit=dev` 确认去重。未重跑浏览器验收，未运行生产构建、发布或 git commit。安装仍提示既有 React peer warning 和全依赖图审计告警；未执行 audit fix 或无关依赖升级。

## 10. 工作区审查修复

- Source 的行引用 `Mod-i` 使用 `Prec.high`，优先于 basicSetup 的语法选区快捷键，避免 JS/TS 标识符选区消费行引用操作。
- 不同的外部全文通过同一 EditorView 的 `setState` 建立新历史基线，保留语言、主题及换行配置，清空旧 Undo/Redo 与选区。不再把旧换行历史 effect 映射到外部文档，修复多行文本全选删除并保存后接收 agent 更新时的 RangeError，也避免撤销插回被外部替换的旧文本。
- 相同内容同步及本地输入回显仍不替换 State，不重置选区或 Undo；外部导入不触发保存。
- `components/SourceEditor.test.mjs` 新增 4 项回归测试，执行实际组件挂载/同步回调及真实 CodeMirror State/History，覆盖快捷键优先级、删除后外部同步、配置保留、旧历史清除和相同内容同步。

本轮相关测试共 **78 项通过**；`node_modules/.bin/tsc --noEmit --incremental false`、单独重跑的 `npm run lint`、`git diff --check` 通过。首次组合校验在 lint 阶段超时，随后单独运行成功。未重跑浏览器验收，未运行生产构建、发布或 git commit。

## 11. 统一外部更新后的撤销基线

- Markdown 与 Source 采用相同契约：不同的外部全文是新的 Undo/Redo 基线；相同内容刷新和本地输入回显保留历史。草稿未保存、保存中或组合输入期间仍由共享协调器暂缓外部同步。
- Markdown 仅在不同外部正文到来时更新初始化正文与实例 revision，通过 React key 重挂载 MDXEditor，清空正文及嵌套编辑区的旧历史；不操作库内部历史对象，不新增依赖。
- 原编辑器持有焦点时向新实例请求 autofocus；初始化和新基线仍经过 round-trip 校验，程序化变化不保存。
- 原失败测试已通过。新增覆盖不同外部正文后 Undo/Redo 不回写旧全文、新编辑撤销到外部基线、相同内容刷新与本地回显保留历史、清除待重做内容，以及实例 key/初始化正文和焦点请求条件。测试执行实际组件回调、MDXEditor core 与 Lexical 历史；React 重挂载、DOM 和帧调度使用替身，不冒充浏览器验收。

本轮相关测试共 **83 项通过**；`node_modules/.bin/tsc --noEmit --incremental false`、`npm run lint`、`git diff --check` 通过。未重跑浏览器验收，未运行生产构建、发布或 git commit。
