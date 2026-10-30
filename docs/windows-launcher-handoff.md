# Windows 单文件启动器交接

## 1. 目标

用户只下载、点击一个 `launch-weclio-web.bat`，即可安装、更新并打开 Weclio Web；后续也可以点击指向同一 BAT 的桌面快捷方式。

```text
点击脚本或桌面图标
  → 检测并复用已有兼容环境，缺失才补齐
  → 未安装则安装 Web 和默认 Pi packages
  → 有更新才更新，没有更新就直接启动
  → 已有本启动器的服务则复用
  → Chrome 优先，没有则用 Edge 打开
```

边界：

- 单文件交付，PowerShell/Node 代码内嵌，不要求用户下载或运行辅助脚本。
- 不改 Web 业务代码，不覆盖未知全局 npm prefix、不清空 Pi 配置。
- 不修改永久 PATH、用户 `.npmrc`、全局 npm prefix 或系统默认浏览器。
- 公共 npm 镜像优先、官方源兜底；查询失败时保留可用版本，不当作“已是最新”，不降级。
- 默认资源沿普通 Pi packages 管理，尊重删除、禁用和手动固定版本，不自动回填。
- **当前运行策略：服务有独立可见控制台；关浏览器不停止服务，关闭服务控制台即停止，下次点桌面快捷方式重新启动。运行中只复用，不热更新；更新延后到下次服务启动。**
- 暂无托盘、系统服务、开机自启、额外退出按钮／卸载器或启动器自身远程更新；二者浏览器均不存在时明确报错，不自动安装浏览器。

## 2. 当前文件与实现

工作目录：`D:/ivanj/Documents/0-1/2_product/weclio/weclio-web`。
接手先核对 Git 当前状态，保留已有未提交修改，不做整仓 reset/clean。

| 文件 | 内容 |
| --- | --- |
| `launch-weclio-web.bat` | 唯一用户交付文件，安装／更新／启动／浏览器打开均内置 |
| `.gitattributes` | 只为此 BAT 保留 CRLF 原始字节，保证直接下载可执行 |
| `scripts/launch-weclio-web.test.mjs` | 启动器回归测试，不需要随 BAT 交付 |
| `scripts/launch-weclio-documents.test.mjs` | 文档运行依赖与隔离边界测试，不需要随 BAT 交付 |
| `scripts/launch-weclio-progress.test.mjs` | 单行动画、下载进度与失败切源测试，不需要随 BAT 交付 |
| `docs/windows-document-runtime.md` | 文档组件版本、隔离安装、健康检查与验证限制 |
| `docs/windows-launcher-handoff.md` | 本交接文档 |

持久目录为 `%LOCALAPPDATA%\WeclioWeb`，桌面快捷方式为 `Weclio Web.lnk`，指向该目录中的 `launch-weclio-web.bat` 固定副本。图标从已安装 Web 的 `public/brand/weclio-favicon.ico` 复制到固定目录 `weclio.ico`（16—256px 六尺寸），不再引用浏览器图标、不额外下载或内嵌图片。服务就绪后创建／更新快捷方式。创建成功后最初下载的 BAT 可删除，固定副本和图标不可删除。

实现要点：

- 复用兼容的 Node/npm 配对，最低 Node `22.19.0`；缺失/不兼容时使用用户目录内的 Node `24.22.1`（附 npm `11.19.1`）。
- 检测已有 Git Bash；缺失时使用用户目录内 PortableGit `2.56.0.4`。工具下载走镜像→官方源，并校验固定 SHA-256。
- 新 Web 版本安装在 `apps/<version>`；可只读发现并复用已有全局 Web，不覆盖其安装。
- Web npm 安装不设总时限、不捕获到有限缓冲区，实时直通输出；安装不覆盖 npm 请求超时／重试配置，使用其默认或用户已有配置。只有版本查询保留 8 秒请求／20 秒进程预算和零重试。
- 使用前以独立进程检查 SDK 导入及 Next CLI --version 的正常输出，不只检查入口文件存在；服务就绪要求首页和只读 `/api/models-config` 均为 200，后者返回有效 JSON。常规探测不调用可能触发 SDK 自动补装的 skills 枚举；skills 功能另作验收。坏同版本由普通 npm 重试，不自动删除依赖、锁文件或缓存，不单补 isexe。
- 使用安装版本 Web 所依赖 SDK 的公开包管理 API，按实际 agentDir 管理普通包与初始化记录。安装精确检查到的版本，登记未固定版本的普通来源，便于后续更新。
- 默认资源来源：`npm:@weclio/pi-web-search`、`npm:@weclio/pi-submarine`、`npm:@weclio/pi-citations`、`npm:weclio-cli`。
- 首次新增 CLI 来源时，使用普通包对象配置 `skills: ["!skills/sci-search/**"]` 默认禁用 `sci-search`，不删除随 CLI 下载的文件；`tox-eval`、`tra-md`、`read-across`、`tra-md2word`、`docx` 默认作为用户级全局 skills 启用。完整性检查覆盖上述六个 skills。已有 CLI 配置及用户后续启用／禁用选择不覆盖。
- `tra-md2word`、`docx` 随后续 `weclio-cli` 发布包提供，不额外执行 `npx skills add`，不复制本地未发布目录或覆盖同版本包。发布包必须包含两者完整目录（脚本、references、模板等）；旧包缺失时仅告警，不阻止 Web 启动，后续正常版本更新即可带入。文档运行依赖现已纳入 BAT 冷启动流程，见 [Windows 文档运行环境](windows-document-runtime.md)。下文 CLI 0.3.2／四个 skills 的发布审计与 VM 验收均为历史记录，不代表新包已发布或当前候选已完成干净环境交付验收。
- 冷启动时统一准备 Python／defusedxml／lxml、Pandoc、npm docx、LibreOffice、Poppler 与 ZIP 工具。已有兼容工具只读复用；否则安装到用户目录，不向已有 Python 或全局 npm 装包。组件自检通过后才记录就绪；准备失败会阻止本次新服务启动，已运行服务不受影响。
- 安装显示基础环境／Web 程序／文档组件／默认资源／启动服务／打开页面等阶段。静默操作使用同一行 `...` 动画，下载在同一行刷新已下载 MB；不定时追加提醒、不伪造整体百分比，npm／pip 保留原生实时输出。进度回归及公网下载限制见文档运行环境记录。
- 默认资源安装/查询不完整时告警，保留配置并尝试打开可用 Web；不冒充资源已全部安装成功。
- 通过当前用户 mutex 防并行安装；通过 Node 路径、PID、随机命令行标记和监听端口归属确认本启动器的服务。
- 仅监听 `127.0.0.1`，优先 8888，被占用或系统拒绝该端口时换空闲端口，不结束其他程序。
- PowerShell Start-Process 为真实 Node 服务打开可见控制台，服务输出同步保留 server.log；不改 Web／SDK 调用、不逐点加隐藏参数。后台命令默认继承该控制台；关闭窗口停止服务，退出后的旧实例记录不阻止下次启动。
- 日志为 `launcher.log`、`server.log`；实例为 `server-<agent-key>.json`，可用版本记录为 `current-app.json`。
- 不自动认领手动启动、没有本启动器身份记录的 Web 服务，不覆盖其他目标的同名快捷方式。

## 3. 公开 CLI 已补齐；镜像已同步

最近核查时间：**2026-10-29T07:20:50.484Z**。官方 `0.3.2` 已包含四个 skills。按用户授权手动触发 npmmirror 同步，任务 `6ae2f381408a9ff5350fa41e` 于 07:19:30Z 开始、约 8 秒后完成版本与 latest 标签更新。镜像精确查询／下载 `0.3.2` 已成功，实际 tgz 通过 SHA-512 SRI 校验且四个 SKILL.md 均非空。但公开镜像 `/weclio-cli/latest` 曾返回 `0.3.2` 后又命中 CDN 旧缓存返回 `0.3.1`；no-cache 请求头及查询参数未稳定消除旧缓存，不能视为所有客户端均已获取新版。接手后须重新核对。

检查方式：官方 registry 查询元数据 → 下载 `weclio-cli@0.3.2` → 校验 SHA-512 SRI → 检查实际 tgz 内容与 `pi.skills` 声明，并查询 npmmirror latest。

| skill | SKILL.md | references/*.md |
| --- | --- | --- |
| `sci-search` | 有 | 1 |
| `tox-eval` | 有 | 7 |
| `tra-md` | 有 | 6 |
| `read-across` | 有 | 0 |

四份 SKILL.md 均非空，已打包的 references Markdown 均非空。`read-across` 当前为独立 SKILL.md，未引用本地 references。公开包声明包含整个 `./skills`、排除 `pde`；未发现 evals/runs/pde 目录。

**当前结论：发布包缺失及镜像同步阻断已解除，无须重复发布。** 后续一次不加额外请求头／参数的直接 latest 请求已返回 `0.3.2`。用户确认继续使用现有 npmmirror 优先、请求／安装失败时官方兜底策略；不增加同步状态检查、官方版本对比或自动触发同步机制。上述缓存差异仅为同步后的历史观察，不再作为待解决阻断。下一步转入真实联网安装验收。

手动同步接口为官网按钮使用的 `PUT https://registry-direct.npmmirror.com/-/package/weclio-cli/syncs`；访问旧 `/sync/weclio-cli` 链接只跳转至包详情页。本次只触发一次任务，未修改脚本或用户 npm 配置。

镜像精确版本审计：`C:/Users/ivanj/AppData/Local/Temp/weclio-cli-synced-audit-YzeEVK/report.json`（临时证据，包含不同查询方式的缓存结果）。

审计报告：`C:/Users/ivanj/AppData/Local/Temp/weclio-cli-public-audit-TyoEES/report.json`（临时证据，可能被清理）。

历史记录：2026-10-29T06:11:49.104Z 核查的官方 `0.3.1` 缺少 `tra-md`、`read-across`；报告位于 `C:/Users/ivanj/AppData/Local/Temp/weclio-cli-public-audit-plDzpC/report.json`。此前交接记载相邻 CLI 仓库有发布清单和契约测试修正；本次未核对该仓库当前 Git 状态，不应据旧交接判断其当前版本或未提交修改。

## 4. 验证状态

**最终 BAT 已同步，当前 Windows 11 VM 的真实桌面及完整控制台生命周期验收已通过。** 43 项本地回归、测试与内嵌代码 lint、TypeScript 通过，UTF-8／CRLF 与仓库／VM 固定副本 SHA-256 一致：`5bb686d3d80d113cdef4fa1c6b93087c49dfd6415f7c4d9c0a0e764195a55543`。本轮补了品牌图标、EACCES 端口回退、损坏应用清单不能阻断健康回退、Next 依赖／空入口不得误判可用、Git／Bash 必须真正可执行才复用；每个缺陷均先复现为失败用例，再修复通过。没有为缩行数删除已确认能力，BAT 477 行。

2026-10-29T18:40Z 非交互检查通过后，用户恢复测试账户桌面，登录阻断解除。18:53:38Z—18:56:08Z 对同一最终摘要实测：桌面品牌图标可见；初始无运行服务，真实桌面快捷方式冷启动退出 0、PID 5836 健康且有可见控制台；关闭独立测试浏览器后服务保留；通过 UI Automation 关闭唯一单页签服务终端后服务及监听退出；再点桌面快捷方式退出 0、重启为 PID 6548／8888、有独立可见控制台；再次点击退出 0、复用同一实例。settings/models/auth 摘要未变，四个默认包及四份 SKILL.md 齐全，测试输入 BAT 已删除，固定 BAT 字节未变。18:59:57Z 核心接口、只读 SDK API／身份健康再次通过，19:00:05Z 永久用户／系统 PATH 与初始值相同、用户 npmrc 未创建，保留 PID 6548 供用户使用。没有发模型消息、重启 VM、切账户、恢复快照或启动会话 0 服务冒充可见服务。证据：`final-desktop-acceptance.json`、`final-desktop-before.png`、`final-desktop-running.png`、`final-release-health.json`、`final-release-state.json`；43 项测试日志见 `final-tests.log`。无缓存首次安装等剩余范围仍不能冒充通过。

此前可见启动模式（2026-10-29T17:28Z）：用户改为可见服务控制台，仅调整 BAT 内嵌启动逻辑，不改 Web／SDK 源码。37 项回归、lint、TypeScript 通过，新增默认子进程共享服务控制台的原生验证。VM 已实际验证关闭独立浏览器窗口不停止服务、关闭唯一单页签 Windows Terminal 服务窗口使服务退出、删除测试输入 BAT 后从桌面重启（PID 4468／8888、独立可见控制台）、再次点击复用；settings/models/auth 未改变。17:29Z SDK 只读 API 200／有效 JSON、服务身份／健康与交付文件 SHA-256 一致；该实例当时保留运行，不代表当前状态。详见 VM 报告的可见控制台章节；旧 PID 2316 已核对空闲／身份后为本次迁移停止，9592 已由实际关闭终端退出。只改 windowsHide=false 仍无控制台的试验及中间错误关闭方法，不当作正式方案。

此前安装与桌面实测（2026-10-29，详见 `windows-launcher-vm-validation.md`）：**用户确认的最小修改、原损坏环境恢复、Edge 桌面启动、默认 skills 和手动选择保留均已通过。** 新 BAT 取消安装总截止，恢复 npm 原生请求超时／重试并显示进度，增加 SDK／关键 API 检查。普通 npm 重试于 14:47:49Z—14:57:26Z 完成退出 0；镜像原生重试失败后官方兜底，npm 自行补齐／调整依赖树，isexe 正确解析到 which/node_modules。Web 0.1.10／SDK 1.4.0、四个默认资源和 skill 文件齐全，首页／skills 200、诊断为空，sci-search 默认禁用。删除测试源 BAT 后桌面快捷方式两次退出 0、复用健康实例；临时启用 sci-search 后经冷启动仍保留，再恢复默认禁用。只读健康探测调整后重跑两次桌面启动仍成功，15:48Z 独立确认 SDK 配置 API 200／有效 JSON、身份及配置不变、VM 固定 BAT 与仓库 SHA-256 一致；35 项测试、lint、TypeScript、UTF-8／CRLF 再次通过。健康服务 PID 2316／8888 留在测试账户运行，Edge 页面可见，永久 PATH 不变、`.npmrc` 未创建；Pi settings 是测试账户正常新增配置。未改网络／快照，未主动清依赖／锁／缓存、未单补依赖或用浏览器归档补缓存。

历史：旧版前两次 Git 下载失败，第三次镜像 npm 被 10 分钟总截止中断，兜底后曾接受空 isexe 目录、首页 200 但 skills 500 并退出 0。此前自有坏实例已精确停止；新版本不再误判。超时与空目录的直接因果尚未独立证明，不因此增加自建恢复／续传机制。当前恢复通过不等于无缓存首次完整安装、Chrome 或所有国内网络场景通过。

最新 `scripts/launch-weclio-web.test.mjs` 的 43 项测试全部通过（含品牌图标、受限端口、坏清单／Next 运行时、Git 执行验证、可见控制台、原生参数引用、默认后台子进程共享控制台及退出重启），新增 npm 生命周期／进度、查询短预算、坏 SDK 与关键 API 检查；原有改名与默认禁用变更保留：新增真实 SDK 隔离验证，确认四个 skills 文件保留、仅 `sci-search` 默认禁用，用户重新启用后更新不覆盖。测试及内嵌代码 lint、TypeScript 检查通过。官方 CLI `0.3.2` 已重新核查（见第 3 节），四个 skills 均存在，镜像已手动同步、校验精确版本下载，随后直接查询 latest 也已返回 `0.3.2`；当前 VM 的普通恢复、Edge 桌面入口和 skills 策略已通过；无缓存首次完整安装及其他浏览器／网络场景仍待验收。

此前交接时已通过：

- 23 项自动化测试：单文件入口、镜像回退、版本比较、已有配置、删除/禁用/pin、断网和部分失败、保存失败、浏览器候选顺序、PID/端口身份、Unicode 输出、真实 Windows BAT 中文空格路径、坏摘要回退、模拟服务启动/清理。
- 测试文件 lint、内嵌 Node 代码 lint、Web TypeScript 检查、`git diff --check`。
- 屏蔽系统工具后，用校验过的缓存归档补齐便携 Node/Git，BAT 引导成功。
- 实际 SDK 配合模拟 npm 安装：已有 Pi npm prefix 的字段/依赖和 settings 字段保留，四个普通来源登记成功。
- 正式 Web `0.1.10` 原发布产物隔离启动：根页面与 `/api/skills?global=true` 均 200。依赖使用现有仓库 node_modules junction，测试服务已停止、junction 已移除。
- 当时四个 Node/Git 镜像/官方下载地址 HEAD 均 200。

**仍需验收：**干净 Windows 首次完整联网安装、国内不同网络、真实快捷方式和 Chrome/Edge 交接、用户已有环境的完整真实流程，以及完整四个 skills 的首次安装/公开版本更新。
缓存归档、模拟 npm/浏览器、现有依赖 fixture 不等于上述真实场景已通过。

本次没有修改真实 Pi 配置、使用真实账号或调用付费模型，也没有提交、推送、发布。

### 本机证据

以下位于临时目录，可能被清理，不能当成跨机器可用或永久交付路径：

```text
C:/Users/ivanj/AppData/Local/Temp/wi-sa4cGC/
  final-validation.json
  tests-final.log
  embedded-lint-final.log
  test-lint-final.log
  typecheck-final.log
  bootstrap-final.json
  download-sources.json
  cleanup-final.json
C:/Users/ivanj/AppData/Local/Temp/wi-compat-wjjw3s/existing-prefix-compatibility.json
C:/Users/ivanj/AppData/Local/Temp/wp-DRKkKu/published-web-smoke-final.json
C:/Users/ivanj/AppData/Local/Temp/wcli-audit-QcGls3/cli-package-audit.json
```

测试生成的大体积运行包副本已清理，报告保留。接手时重新核对当前进程，不能假设没有用户正在运行的服务。

## 5. 开发与复验

先读 `AGENTS.md`、`CONSTITUTION.md`、`COMMANDS.md`；涉及生命周期/数据边界再读 `ARCHITECTURE.md`。使用项目本地工具，**不要在 Web 工作目录运行 next build**。

```bash
node --test scripts/launch-weclio-web.test.mjs scripts/launch-weclio-documents.test.mjs scripts/launch-weclio-progress.test.mjs
node node_modules/eslint/bin/eslint.js scripts/launch-weclio-web.test.mjs scripts/launch-weclio-documents.test.mjs scripts/launch-weclio-progress.test.mjs
node node_modules/typescript/bin/tsc --noEmit --incremental false
git diff --check
```

内嵌代码 lint（虚拟文件名不是需要创建或交付的辅助脚本）：

```bash
node --input-type=module <<'NODE'
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
const code = readFileSync('launch-weclio-web.bat', 'utf8')
  .split(/\r?\n:WECLIO_NODE\r?\n/)[1]
  .split(/\r?\n:WECLIO_POWERSHELL\r?\n/)[0];
const result = spawnSync(process.execPath,
  ['node_modules/eslint/bin/eslint.js', '--stdin', '--stdin-filename', 'bin/install-launcher.cjs'],
  { input: code, encoding: 'utf8' });
console.log(result.stdout + result.stderr);
process.exitCode = result.status;
NODE
```

维护约束：

- BAT 使用 UTF-8/CRLF，保留当前 `.gitattributes`，同时保证 Git 原始下载的字节格式。
- 保持 Windows PowerShell 5.1 参数引号兼容及 JSON 输出 UTF-8。
- PortableGit 使用校验过的官方自解压包与 `-y -o"<目标>"`；Node ZIP 优先系统 tar 解压，有 PowerShell fallback。
- 隔离测试使用自己的配置目录和 `PSModuleAnalysisCachePath`，不能写真实配置。
- 测试清理须确认本次自有实例；不能批量结束所有带启动器标记的进程，不能删除未知目录。

## 6. 下一步

1. 核对当前 Git 状态，保留已有修改；CLI `0.3.2` 及镜像核查已完成，不重复发布或新增同步检查机制。
2. 最终摘要的真实桌面图标、冷启动、浏览器关闭、服务控制台关闭及再次桌面启动／复用已通过；交付仅需仓库根目录的 launch-weclio-web.bat，不随附测试工具。当前保留健康服务供使用，不需要为重复验收而继续中断用户。
3. 原损坏目录已由普通 npm 重试恢复，不需要自建清理或续传机制；43 项本地回归通过。无缓存、无既有依赖的干净首次完整安装，以及 Chrome、其他网络、真实新版本升级和复杂已有环境仍是未验收范围。后续清理须重新核对实时身份，不照抄旧 PID，不擅自恢复快照。
4. 保持单 BAT 入口和普通 Pi 包管理，按发现的问题做最小修改，不自行扩展功能范围。
