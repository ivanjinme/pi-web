# File Source 编辑 + Markdown 富文本编辑实施计划

## 0. 给新线程的执行说明

目标：接入 CodeMirror 6 作为统一 Source 编辑器，接入 MDXEditor 作为 Markdown 文档编辑器，两者共享文件草稿和自动保存。

本文件是实施计划，不代表依赖已安装或兼容性已经验证。开始前：

1. 阅读 `AGENTS.md`、`CONSTITUTION.md`、`ARCHITECTURE.md`、`COMMANDS.md`。
2. 检查当前工作区和实际源码；不要覆盖用户的既有修改。
3. UI 实现前阅读 `.pi/skills/frontend-design/SKILL.md`；浏览器验证前阅读 `.pi/skills/agent-browser/SKILL.md`。
4. 核对拟选版本、React/Next.js 兼容性、许可证和打包影响；列出确切的新增依赖并请求用户确认，获得确认后才安装。
5. 先做阶段 A 的保真验证。若 MDXEditor 无法安全承载我们的文件，明确报告限制，不擅自删减现有能力、不直接替换成 Tiptap。
6. 默认连续执行阶段 A → B → C → D → E → 第 9 节验证，直到达到第 10 节完成条件。每阶段通过后自动继续，不以“阶段完成，是否继续？”作为停点；过程用简短更新报告进展。不要进行无关重构，不运行 `next build`，未经请求不要创建 git commit。

### 连续执行与暂停规则

- 阶段 A 是验证门槛，不是最终交付。通过后立即继续完整实现。
- 计划已定义的特殊语法 fallback 可以直接实施并测试，不必逐项请求确认；不能把所有 Markdown 都退回只读 Preview 来宣称富文本编辑完成。
- 实现中的常规缺陷、类型/测试失败自行定位修复并重新验证，不仅报告问题就停止。
- 仅在需要依赖批准、接受新的格式规范化取舍、发现重大兼容性/保真阻塞、必须扩大范围或依赖不可用的外部条件时暂停。暂停时明确已完成内容、证据、待确认的最小决策和继续步骤，不绕过安全门槛。
- 最终交付报告包含实际改动文件、验证命令及结果、浏览器验证、Markdown 支持/fallback 范围和未解决问题。未执行的验证明确标注，不把部分实现称为全部完成。

新线程启动提示：

> 按 `docs/file-editors-impl-plan.md` 执行，从阶段 A 连续推进到最终验收；阶段通过后自行继续，只有计划规定的批准项或重大阻塞才暂停。不自动提交 git commit。

## 1. 已确定的产品行为

- 不提供 Edit mode，不提供 Edit / Save / Cancel 按钮。
- Source 一进入就是可编辑文本，不要求先点击编辑。
- 自动保存：800ms trailing debounce；持续输入时建议增加 5s max-wait，组合输入期间不强制提交。该参数集中定义，避免散落。
- Ctrl/Cmd+S 立即提交；切换文件、显示模式和离开编辑区时提交最新完整输入。
- 轻量状态：未保存 / 保存中 / 已保存 / 保存失败；不只用颜色表达失败。
- 用户与 agent 同时修改采用 last-write-wins：最后实际落盘的写入生效，不做文件版本冲突检测、锁、合并或冲突弹窗。
- last-write-wins 不代表允许本客户端自己的请求乱序，也不代表允许 SSE 清掉尚未提交的用户输入。
- 默认打开模式保持现状：Markdown 默认 Preview；从 Changes 打开时遵守 initialDisplayMode=diff。
- Markdown Preview 在兼容文件上变为可直接编辑的文档；Source 始终提供原始 Markdown 编辑入口。
- HTML Preview 继续使用现有 sandbox iframe，仅 Source 可编辑。不要让 iframe 内交互成为文件写入入口。
- Git Diff 保持现有实现；图片、音频、PDF、DOCX 等保持只读。
- 首版支持现有读取大小限制内、有效 UTF-8 的普通文本文件；不能把未知二进制当成可编辑文本。
- 项目外仅凭 session reference 可读的文件保持只读；读权限不隐含写权限。

## 2. 当前实现和主要风险

需以执行时源码为准，当前相关入口：

- `components/FileViewer.tsx`
  - TextFileViewer 统一读取文本，Source 使用 SyntaxHighlighter / 大文件轻量渲染。
  - Source 支持行号、换行、选中行引用及 Ctrl/Cmd+I。
  - Markdown Preview 使用 ReactMarkdown，HTML Preview 使用 iframe。
  - SSE change 当前直接重新读取并 setData，同时请求 Git diff。
- `components/AppShell.tsx`
  - 维护 fileTabs / activeFileTab，只渲染当前 FileViewer。
  - 切项目、关闭文件或面板状态变化必须检查组件生命周期。
- `app/api/files/[...path]/route.ts`
  - GET 支持 read / preview / watch 等；POST 为上传；目前没有文本保存接口。
- `lib/file-access.ts`、`lib/path-security.ts`、`lib/request-security.ts`
  - 复用既有允许根目录、realpath containment 和请求来源检查。
- `lib/file-types.ts`
  - TEXT_PREVIEW_MAX_BYTES 当前为 256 KiB。
- `lib/markdown.ts`、`lib/file-links.ts`
  - 现有 GFM、数学公式、HTML 清理、特殊标签、Windows / 相对文件路径处理。
- `components/FileViewer.test.mjs`
  - 当前有只读大文件 Source 的源码结构测试；不能为了通过测试而直接删掉有意义的覆盖。

关键约束：自动保存状态不能只存在于随文件切换而销毁的编辑器组件；MDXEditor 的解析/序列化不能被当作无损字符串编辑。

## 3. 架构和改动边界

建议新增，文件名可按项目风格调整：

| 文件 | 职责 |
| --- | --- |
| `components/SourceEditor.tsx` | CodeMirror React 适配，输入、语言、主题、选区、行引用 |
| `components/MarkdownEditor.tsx` | MDXEditor 客户端加载外壳 |
| `components/InitializedMarkdownEditor.tsx` | 插件初始化、富文本事件、外部更新、解析错误 |
| `hooks/useFileDraft.ts` | 共享草稿与保存状态的 React 接口 |
| `lib/file-draft.ts` | 如有需要，提取可测试的防抖/串行保存状态机；不搭建通用状态框架 |
| `lib/file-write.ts` | 如有需要，提取可测试的文本写入授权/验证逻辑 |
| 对应 `*.test.mjs` | 保存状态机、写入安全和回归测试 |

既有文件按需修改：FileViewer、AppShell、files API、file-types、相关 CSS/i18n、package.json/package-lock.json。

关系：

```text
CodeMirror Source ──┐
                   ├── 单一文件草稿 ── 自动保存队列 ── PUT /api/files/...
MDXEditor 文档 ─────┘         ↑
                           SSE / GET（仅可接受的外部更新）
```

- 编辑器只处理显示、输入与选区，不各自持有权威草稿，不各自发保存请求。
- 共享保存状态由稳定的文件面板/应用层持有，按规范化文件路径区分。sourceSessionId 是读取上下文，不是写权限凭据。
- 最小范围内选择状态提升或实例级小 coordinator；不要引入全局持久化 store、跨窗口协调或 localStorage 草稿系统。
- 不启用 MDXEditor 的 diffSourcePlugin；Source 和 Git Diff 已有独立入口。
- MDXEditor 内部间接依赖 CodeMirror，不代表它是通用源码组件。项目直接 import 的 CodeMirror 包须列为直接依赖。

## 4. 阶段 A：依赖与 Markdown 保真验证

### A1. 依赖确认

- CodeMirror：列出实际 import 的核心包、基础扩展和语言包。覆盖现有常用 Markdown、HTML、JS/TS、JSON、CSS 等语言；对现有其他语言核对语法支持策略，避免静默丢失高亮。必要时评估 legacy modes，plain-text fallback 要明确。
- MDXEditor：检查 Next.js client-only 加载、React 版本、依赖去重及样式导入。
- 不默认再加 React CodeMirror wrapper；先评估官方 EditorView 在小组件内是否足够。
- 不添加第二套 Markdown 富文本库。

### A2. 在不写磁盘的验证页/测试夹具中比较输出

使用实际仓库 Markdown 和小型 fixture，至少覆盖：

- 标题、强调、链接、列表、嵌套列表、引用、表格、任务列表。
- fenced code、语言名、Mermaid；公式 `$...$` / `$$...$$` / 现有 LaTeX 变体。
- raw HTML、未知 XML-like 标签、frontmatter。
- 相对图片、Windows 文件链接、URL、链接引用定义。
- CRLF、LF、UTF-8 BOM、尾部换行、空行、转义字符。

操作：打开不修改 → 切到 Source → 切回文档 → 改一个普通字符 → 查看输出 diff。

门槛：

1. 只打开或切模式不得写磁盘，不得把初始化规范化标为用户修改。
2. 编辑一个段落不得丢弃其他节点、资源引用或语义。
3. 如有纯格式规范化，列出实际 diff 并让用户确认可接受程度；不能宣称逐字保真。
4. 不支持的语法不能以空编辑区或被移除节点继续自动保存。
5. 未通过的文件保留现有只读 ReactMarkdown Preview + 可编辑 Source，并给出简短原因。

Fallback 不能只依赖 onError：某些语法损失未必产生解析异常。为实际支持范围建立保守、可测试的判断或 round-trip 检查；不要靠脆弱的单个 regex 声称全面安全。若需要大量自定义 AST adapter 才能达标，暂停并重新确认范围，不把它隐含进首版。

验证页若仅用于实验，完成后删除自己的临时代码，保留有价值的测试夹具。

## 5. 阶段 B：安全的文本写入 API

建议契约：

```text
PUT /api/files/<encoded absolute path>
Content-Type: text/plain; charset=utf-8
Body: 完整 UTF-8 文本（允许空字符串）
Success: { size: number }
Failure: { error: string }
```

选择 raw text 可避免 JSON 转义膨胀；与现有 read/download/watch 共用路径编码，但不扩大 GET/POST 的既有语义。

要求：

- 使用 isApiRequestAllowed。
- 目标必须位于既有 allowed roots 内，通过词法和 realpath-aware 校验；session reference 不可作为写入授权。
- 只写已有普通文件；不自动创建目录或文件，不复活已删除文件。
- 按项目的 path-security 边界处理 symlink：不能通过软链接写到根目录外；验证和实际写入应尽量使用同一解析目标，避免明显的 check-then-write 绕过。
- 验证目标和请求为可编辑 UTF-8 文本，拒绝已识别的图片/音频/文档/未知二进制。保留有效 BOM、CRLF/LF 和末尾换行；不能无条件 trim 或 normalize。
- 请求流在解析前限制真实字节数，不能只信 Content-Length。上限复用 TEXT_PREVIEW_MAX_BYTES，并检查目标大小。
- 不增加版本号、mtime compare、409 文件冲突协议；遵守 last-write-wins。
- 返回明确的非法请求、无权限、不存在、过大、非文本、磁盘写入失败响应。
- 给 read/meta 增加最小的 editable 能力字段，让前端只读状态与服务端权限/文本判断一致；权限安全最终仍由 PUT 决定。
- 不依赖 AgentSession wrapper 才能保存文件。

测试：正常/空文本写入、Unicode 字节限额、CRLF/BOM 保留、越界路径、目录、symlink escape、只读外部引用、删除文件、无 Content-Length 超限、未知二进制和无效 UTF-8。

## 6. 阶段 C：草稿与自动保存

每个文件至少区分：已确认内容、当前草稿、草稿 revision、当前 in-flight snapshot、保存状态/错误。具体实现保持小而可测试。

### C1. 本地保存顺序

- 输入立即更新草稿；未变化内容不发请求。
- 800ms debounce + 建议 5s max-wait；中文组合输入结束后才提交完整输入。
- 每个路径最多一个保存请求在途；在途期间的输入只保留最新快照等待下一次提交。
- 成功只确认本次提交的 revision；若用户已继续输入，不能把新草稿标为 saved。
- 不能因为修改后撤销回旧内容就取消所有后续保存：若另一个不同 snapshot 正在落盘，仍需排队把最新撤销结果写回。
- 请求快照绑定原路径、原文本和 revision；绝不在完成时读取“当前活动文件”来决定目标。
- 程序化导入/外部同步不冒充用户输入；两种编辑器使用同一规则。

### C2. 生命周期和失败

- 文件切换/关闭、模式切换、blur、Ctrl/Cmd+S flush；编辑器 blur（例如打开链接菜单）不能破坏 IME，也不应每个内部焦点变化都重复保存。
- 切到 Preview 时使用最新草稿，不必等网络成功才显示。
- 编辑器销毁不销毁尚未完成的保存任务；快速切 A→B→A 应拿到 A 的最新草稿。
- 保存失败保留草稿和错误，可通过状态处的重试操作或 Ctrl/Cmd+S 重试，不出现主 Save 按钮。
- 文件离开后失败也必须可见、可恢复；成功且不再需要的草稿可以释放，避免无限缓存。
- dirty / saving / failed 时注册 beforeunload 提醒；不能承诺关闭页面时异步请求一定成功，也不把 keepalive 当可靠持久化。
- 不重试无限循环，不设计离线队列或恢复历史数据库。

### C3. SSE 与异步读取

- 有本地未保存修改或保存请求在途时，不把外部读取结果灌回编辑器。
- 无本地修改时接受 agent 的最新内容；内容相同则不替换文档，不重置光标、选区和 Undo。
- 慢 GET 在返回时再次检查路径/读取 generation/草稿 revision，不能用请求发出时的 clean 判断覆盖新输入。
- 有本地修改时可合并记录一次待协调的外部变化；本地保存队列完成后按需要重新读最终磁盘内容，避免丢掉最后一个外部事件。
- 不使用“忽略下一次 SSE”的计数法，事件可能合并或来自 agent。
- 自己保存不触发再次保存的反馈循环。
- Git diff/explorer refresh 与按键解耦；合并保存/watch 引发的刷新，在稳定保存后更新，避免每键计算 diff。

验证：持续输入、防抖/max-wait、IME、保存中输入/撤销、连续失败、切文件、关闭文件、旧响应、SSE 相同/不同内容、外部事件被合并后的最终同步。

## 7. 阶段 D：CodeMirror 接入 Source

- 实例只在必要时创建/销毁；按键不重建 EditorView，不把每次本地 onChange 再作为外部全文替换。
- 使用 extensions 配置基础编辑、行号、历史、搜索、语言、主题和换行。
- 通过事务来源/annotation 区分外部更新和用户编辑，避免保存循环。
- 配置 Ctrl/Cmd+S，确保阻止浏览器 Save Page；Ctrl/Cmd+I 保留选中行引用，避免与其他快捷键冲突。
- 行范围来自 CodeMirror 文档与选区，不再依赖 .file-source-line DOM；保留跨行边界行为和对应测试。
- 如 Source 不可写，使用同一编辑器的 read-only 模式或保留当前只读 renderer；保留现有性能和选中行能力。不要不加理由地保留两套重复渲染逻辑。
- 支持容器 resize、长行、浅色/暗色主题、字体和当前侧边栏布局。
- 有选择地保留旧 SyntaxHighlighter：如果还有只读使用点就保留；只有本次替换造成的孤立代码才删除。
- 现有大文件测试覆盖应迁移为真实的性能/只读回归验证。如果语义已被 CodeMirror 替代，可相应调整结构测试，但不能只是删除失败断言。

验收：Markdown/HTML/TS 等 Source 直接输入、自动保存、语法高亮/行号/换行、Undo、搜索、选中行引用、保存状态、默认模式与 Changes→Diff 不退化。

## 8. 阶段 E：MDXEditor 接入 Markdown 文档

- Next.js client-only dynamic import（ssr:false），插件仅客户端初始化；样式只引入一次。
- 基础插件按阶段 A 确认的支持范围配置，不开启自带 diffSourcePlugin。
- 不新增大工具栏；先保证直接输入、粘贴、选择、Undo 和现有布局。如必要格式/链接控件超出轻量适配，先说明范围。
- 对接同一草稿层；onChange 的 initialMarkdownNormalize 不产生 dirty/save。
- 核验 setMarkdown 和模式切换是否触发 onChange；显式抑制程序化同步造成的保存，不能假设标志覆盖全部路径。
- 不在每次用户输入后 setMarkdown 回灌整个文件。文件身份改变再初始化；同文件外部更新仅按共享草稿规则同步。
- 对接本地图片读取、图片原始地址序列化和本地链接打开；用于显示的 /api/files URL 不得被保存成原 Markdown 地址。
- Math / Mermaid / HTML 等依阶段 A 门槛处理：可安全适配则支持，否则保留现有只读 Preview，不静默删除/降级。
- MDXEditor 解析错误或不安全 round-trip 时：停止其写回，保留原草稿，显示只读 Preview / Source 入口；不能持久化空内容或半解析内容。
- `.mdx` 的 JSX/import/export 不是普通 `.md`，除非另行验证通过，否则保持 Source 可编辑，文档 Preview 采用安全 fallback。
- 匹配现有明暗主题、排版、滚动、侧栏 resize；链接/图片内容作为不可信输入处理，不放宽现有 HTML/URL 安全边界。

## 9. 验证与测试策略

### 自动测试

- 优先行为测试：保存状态机和授权/写入 helper 可用已有 node:test 模式验证，不为首版引入新测试框架。
- 新增覆盖见各阶段，尤其是 revision 和请求乱序、UTF-8/路径安全、初始化绝不写盘。
- MDXEditor 的保真 fixture 保留为回归材料；如没有现成 DOM 测试环境，先用浏览器验证并记录差异，不用源码字符串测试冒充交互验证。
- 运行受影响的既有测试：FileViewer、AppShell、file-access、file-paths、file-links、markdown、stream-route 等；先用 rg/find 确认实际路径。
- 不更改与本功能无关的既有失败测试。

### 浏览器矩阵

使用现有 dev server 和 agent-browser；操作测试只针对临时 fixture 文件，不覆写真实项目文档。

1. Markdown 默认文档、Source 输入、切模式，文件内容与保存状态正确。
2. HTML Source 编辑后 Preview 使用最新内容，sandbox 不变。
3. 代码高亮、行号、长行换行、Ctrl/Cmd+I、Ctrl/Cmd+S、Undo/Redo。
4. 连续输入、中文 IME、保存时继续输入/撤销、快速切文件和项目、关闭文件。
5. 网络/权限/删除文件/磁盘错误时草稿不丢、错误可见、可重试。
6. agent 外部修改：clean 时同步；dirty 时不打断；最终遵守 last-write-wins。
7. Markdown 特殊语法保真；不支持文件 fallback 仍完整可读、可在 Source 修改。
8. 近 256 KiB 文本的输入和加载响应；按键不导致全文预览/diff 重算；窄侧栏/主题/全局快捷键不回归。
9. 图片、音频、PDF/DOCX、download 和 Git Diff 仍正常。
10. 不修改直接打开/切模式/关闭，没有 PUT 请求或文件 diff。

### 命令

从仓库根目录，使用项目本地工具：

```bash
node --test <实际受影响的 .test.mjs 路径>
node_modules/.bin/tsc --noEmit
npm run lint
```

按项目运行时要求处理 TS module 加载，不新增全局工具。开发验证不运行 next build / npm run build / npm run release。

## 10. 完成条件和非目标

完成条件：

- 可写 UTF-8 文本的 Source 可直接编辑，保留高亮、行号、换行和选中行引用。
- 兼容 Markdown 的 Preview 可直接编辑；不兼容文档明确、安全退回只读 Preview + 可编辑 Source。
- 两套编辑器共用保存链路，无 Edit / Save / Cancel 按钮。
- 切文件不串写，输入不被 SSE/旧请求清掉，初始化不改文件，失败保留草稿且可见。
- PUT 不扩大现有路径权限，不把二进制覆盖成文本，不创建被删除文件。
- 默认模式、Git Diff 和非文本预览不回归；验证报告注明支持范围和剩余限制。

非目标：协同编辑、冲突检测、自动合并、跨标签页锁、离线草稿恢复、自动格式化、HTML 所见即所得编辑、完整 IDE 功能、MDX 应用执行、大量自定义富文本 AST 插件。

## 官方参考（执行时核对选定版本）

- CodeMirror 基础扩展：https://codemirror.net/examples/basic/
- CodeMirror 状态/事务/视图：https://codemirror.net/docs/guide/
- CodeMirror API：https://codemirror.net/docs/ref/
- MDXEditor Next.js 集成：https://mdxeditor.dev/editor/docs/getting-started
- MDXEditor API / onChange / setMarkdown：https://mdxeditor.dev/editor/api/interfaces/MDXEditorProps
- MDXEditor 源码：https://github.com/mdx-editor/editor/blob/main/src/MDXEditor.tsx
- MDXEditor 错误处理：https://mdxeditor.dev/editor/docs/error-handling
- MDXEditor 内置 Source/Diff（本方案不启用）：https://mdxeditor.dev/editor/docs/diff-source

以上参考确认库接口方向，不代表我们的语法支持、保真或性能已经通过验证。
