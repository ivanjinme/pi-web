# Windows 文档运行环境

## 范围

`launch-weclio-web.bat` 在冷启动时一次准备 `tra-md2word`、`docx` 的运行依赖，不让模型临时选择下载地址或安装命令。仍只交付一个 BAT，不需要额外交付安装脚本。

- 优先复用通过执行探测的已有工具；Python 还必须能导入所需库，且 lxml 至少为 6.1.3。
- 现有 Python 缺库时，不向它装包，使用用户目录下可解压的 PSF Python 发行包及其私有 site-packages。
- 私有运行环境放在 `%LOCALAPPDATA%\WeclioWeb\runtimes`，不安装系统服务、不改永久 PATH、文件关联、用户 npmrc 或全局 npm prefix，不自动提权。
- 准备失败会报错，不进入新的 Web 服务启动步骤；重新点击可复用已完成的部分并重试。已运行的自有服务仍直接复用，不下载、不改变其环境；要应用新依赖须先关闭旧服务控制台，再用新版 BAT 启动。
- 安装 skill 文件与准备运行依赖是独立步骤。CLI 发布包必须实际包含两个 skills 的完整资源；安装依赖不会凭空补齐未发布的 skill。

## 固定产物

下表版本是本次验证的固定版本，不在客户机器上动态选择 latest。

| 组件 | 私有版本／来源 | 用途 |
| --- | --- | --- |
| Python | 3.13.17，PSF 在 NuGet 发布的 `python` 包 | 执行 skill 脚本；完整 Python，非嵌入式精简包 |
| defusedxml | 0.7.1，PyPI／清华镜像 | 安全 XML 解析、合并和批注 |
| lxml | 6.1.3，PyPI／清华镜像 | XML／XSD 校验；仅接受二进制 wheel，不现场编译 |
| Pandoc | 3.13，jgm/pandoc Windows ZIP | Markdown／DOCX 转换 |
| LibreOffice | 26.8.2（内部版本 26.8.2.2），TDF 官方 MSI／归档 | 文档转换与渲染 |
| Poppler | 26.09.0，oschwartz10612/poppler-windows ZIP | `pdftoppm` 将 PDF 转为图片 |
| ZIP | GnuWin32 Zip 3.0 与配套 bzip2 DLL | 原生 ZIP 重打包 |
| unzip | 复用 Git Bash 提供的 UnZip 6.x | 解包 DOCX |
| npm docx | 9.15.0，现有 npm 镜像优先／官方兜底 | 创建 DOCX；使用独立私有 npm prefix |

Python、Pandoc、LibreOffice、Poppler、ZIP 下载归档的 SHA-256 固定在 BAT 中，校验后才展开或运行。Python／npm 包使用固定版本及各包管理器的校验机制。不增加独立更新器或自动清缓存机制。

LibreOffice 通过 `msiexec /a /qn TARGETDIR=...` 生成用户目录中的管理映像，不进行普通产品安装。管理映像中 `System64` 的 VC 运行库复制到私有 `program`，避免仅在安装过开发工具的电脑上碰巧可用。使用 `soffice.com` 执行可等待的命令行操作。

首次文档归档下载合计约 478 MB，另有 Python／npm 包；已有兼容工具会跳过对应下载。这不包括 Web 与默认资源包本身的下载量。

## 环境与健康检查

- 仅为启动器、Web、Agent 及其子进程设置 PATH；合并 Windows `Path`／`PATH` 时只保留一个键。
- 通过子进程 `NODE_PATH` 提供私有 npm `docx`，支持 skill 指示的 CommonJS `require('docx')`，不将 npm 全局安装等同于模块可解析。ESM 的任意裸 `import` 不属于该机制。
- 清除子进程继承的 `PYTHONHOME`／`PYTHONPATH`，设置 `PYTHONNOUSERSITE=1`，避免把宿主 Python 路径误带入选择的解释器；不写用户配置。
- 每次冷启动执行工具及 Python 导入探测、独立 Node 进程加载 docx；健康时不重复装包。
- 首次准备或工具路径变化时，用独立临时目录实际执行：docx-js 创建 → unzip／zip 重打包 → defusedxml／lxml 解析 → Pandoc 回读内容 → LibreOffice 转 PDF → Poppler 转 JPEG。
- 只有上述组件检查成功才写 `document-runtime.json`；检查目录及临时工具清单按本次精确路径清理，失败不标记就绪、不自动清理其他目录。
- 该记录仅表示运行组件健康，不代表所有 skill 工作流、模板排版或模型调用已经验收。

## 安装过程反馈

安装按以下阶段输出提示；已运行的服务直接打开，不假装重新执行安装阶段：

```text
[基础环境] 检查 Node.js 和 Git…
[Web 程序] 检查版本和更新…
[文档组件] 检查转换、校验和渲染工具…
[默认资源] 检查插件和技能…
[启动服务] 等待本地 Web 服务就绪…
[打开页面] 正在打开浏览器…
```

- 已有兼容组件提示已就绪／跳过下载，已有归档提示使用已校验的缓存。
- 下载在同一行刷新实际已下载 MB 和耗时，不显示虚假的整体百分比或预计完成时间。保留原 `Invoke-WebRequest` 及其默认 `TimeoutSec=180` 设置、SHA-256 校验、缓存和按来源兜底；动画只观察临时文件大小，不接管下载、不添加断点续传。
- 静默的版本检测、解压、LibreOffice 展开和文档验证使用同一行的 `.`／`..`／`...` 动画。不按 15 秒或其他周期追加“仍在进行”提醒。
- npm／pip 安装保留自身的实时输出，不在其输出中叠加动画。动画仅说明操作仍在进行，不把操作结束冒充成功；成功和失败路径都会停止动画。
- PowerShell 动画的计时器仅写控制台，不在线程池中执行安装脚本；包装后的作用域、返回值与进程退出码有独立回归覆盖。

## 验证记录（2026-10-30）

- 启动器、文档依赖与安装进度共 63 项自动化测试通过，无跳过；包含私有 npm prefix、重复运行不重装、未知目录保护、坏模块拒绝、失败不写就绪记录、子进程环境边界、PowerShell 引号／stderr 探测及 Python 只读复用。
- TypeScript、三份测试与内嵌 Node 代码 lint、UTF-8／CRLF 检查通过。
- 进度回归使用本地 HTTP 服务验证慢速流式下载在完成前同一行刷新、缓存复用不请求网络、HTTP 错误／超时后切源、坏摘要拒绝、`.part` 清理；Node／PowerShell 动画结束和异常后的停止、包装归档解压及进程退出码保持均通过。
- 小型公网包对照中，本机 .NET 下载与原 `Invoke-WebRequest` 均发生超时，Node Fetch 则成功。原因尚未定位，未修改代理、TUN 或证书校验；不把本地 HTTP 回归当作所有真实下载源均通过。
- 所有新增归档从其发行源实际下载，摘要与 BAT 一致。LibreOffice 用户目录管理映像展开成功；未普通安装或修改已有 Office。
- 在本机非提权进程中、隔离临时目录隐藏已有 Python／Pandoc 等工具后，从已校验缓存归档实际安装私有环境；中文、空格、`&`、`%`、`!` 路径下的完整组件检查通过。私有 Python／Pandoc／LibreOffice／Poppler／ZIP 均使用新目录，unzip 使用已有 Git Bash。该测试不是无缓存、无既有 Git／Node 的干净 VM 全流程。
- 普通复用分支的准备流程及连续重跑通过；健康重跑不调用 npm、不重复执行首次渲染检查。
- 使用相邻 CLI 当前脚本和独立临时样例，TRA 转换、数字引用检查、合并 runs、添加批注、XSD 校验通过；没有修改用户报告、模板或 CLI 源码。

### 已发现的 skill 兼容性问题

`weclio-cli/skills/docx/scripts/office/soffice.py` 在 Windows Python 上直接访问 `socket.AF_UNIX`，实际报 `AttributeError`。即使 LibreOffice 已正确安装且直接渲染成功，skill 的这层包装仍会失败，需要在 CLI 仓库适配后重新发布。

`docx/scripts/accept_changes.py` 还包含固定 `/tmp/libreoffice_docx_profile` 与 Unix 风格的文件 URI。为避免在临时目录以外创建文件，本次未运行该流程，不能声称接受修订在 Windows 已验收。

本次未擅自修改相邻 CLI 仓库，也不通过修改已安装 skill 或运行时 monkey patch 绕过问题。

### 剩余验收

- 新 CLI 发布包完整性及两个 skills 的真实安装／升级。
- 当前 BAT 的干净 Windows、无缓存首次完整联网安装与真实桌面启动。
- 不同网络、无管理员权限／受策略限制环境、断网及失败重试。
- CLI 修复 Windows 脚本后，复验 skill 包装渲染与接受修订；再进行实际模型任务与视觉验收。

本机临时证据位于 `C:/Users/ivanj/AppData/Local/Temp/weclio-doc-runtime-HsBZ6K/`：`validation-summary.json`、`private-branch-result.json`、`document-runtime.json`、`skill-smoke-result.json`、初次 MSI 展开日志及独立 skill 样例。已仅清理本次下载的大文件、解压运行目录和私有分支目录；报告是运行时快照，其中路径不再表示当前有安装。临时资料可能继续清理，不是交付文件或跨机器证据。

## 回归命令

```bash
node --test scripts/launch-weclio-web.test.mjs scripts/launch-weclio-documents.test.mjs scripts/launch-weclio-progress.test.mjs
node node_modules/eslint/bin/eslint.js scripts/launch-weclio-web.test.mjs scripts/launch-weclio-documents.test.mjs scripts/launch-weclio-progress.test.mjs
node node_modules/typescript/bin/tsc --noEmit --incremental false
git diff --check
```

不要在开发目录执行 `next build`；不要直接运行真实 BAT 代替隔离测试，以免改动真实资源配置或用户桌面。
