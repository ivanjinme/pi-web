# Windows 启动器 VMware 验收记录

> 本文的 VM 桌面验收对应下文旧 SHA-256，不是当前 BAT 候选。当前候选已新增文档运行依赖安装与六个 skills 检查；本机组件验证及已发现的 skill Windows 兼容性问题见 [Windows 文档运行环境](windows-document-runtime.md)。当前候选仍需干净 VM／真实桌面全流程验收，不沿用旧摘要作为通过证明。

## 当前结论

**最终 BAT 在当前 Windows 11 VM 的真实桌面与完整控制台生命周期已通过。** 当前 43 项本地测试、测试／内嵌代码 lint 与 TypeScript 通过；最终 SHA-256 为 `5bb686d3d80d113cdef4fa1c6b93087c49dfd6415f7c4d9c0a0e764195a55543`，仓库与 VM 固定副本一致。用户恢复桌面后，18:53Z—18:56Z 实测品牌图标可见、冷启动、关闭浏览器后服务保留、关闭实际终端后服务停止、桌面重启及复用通过；配置未变。18:59Z 独立健康检查通过，19:00Z 永久 PATH 保留，PID 6548／8888 留给用户使用。没有重启 VM、切账户、恢复快照或启动会话 0 服务冒充可见服务。

以下旧版记录作为历史保留；最终摘要的实测见“最终真实桌面交互验收”。无缓存首次完整安装、Chrome／其他网络等未验收范围不在本次通过结论内。

**此前启动方式已按用户确认改为可见服务控制台，仅修改 BAT，不修改 Web／SDK 源码。** 17:26Z—17:28Z 真实验证：关浏览器保留服务、关闭服务终端停止、删除测试输入 BAT 后桌面重启、重复点击复用；PID 4468／8888 保留运行，settings/models/auth 未改变。37 项回归、lint、TypeScript 通过。见下文可见控制台章节，后续旧 PID 和“后台无控制台”段落均为历史。

**用户确认的最小修改已完成；原损坏环境恢复、默认资源／skills、Edge 桌面启动和用户选择保留已实测通过。干净无缓存首次完整安装、Chrome 和其他网络场景仍待验收。**

新版在原目录让 npm 正常重试，14:47:49Z 至 14:57:26Z 完成、退出 0；首页及 skills API 均为 200，四个默认资源包和四份 SKILL.md 齐全，默认仅启用三个 skills。没有让启动器删除依赖目录、锁文件、缓存或单补 isexe；npm 自己调整了依赖树，最终可从 `which/node_modules/isexe/index.js` 正确解析。

桌面快捷方式在删除本次测试 BAT 源副本后连续两次退出 0、复用相同服务且配置不变；手动启用 sci-search 后，经冷启动检查仍保留，随后恢复默认禁用。15:48Z 最终只读探测复核为 PID 2316／端口 8888、自有身份与接口健康，服务保留运行供查看，Edge 页面可见（`healthy-web-final.png`）。永久 PATH 不变、用户 `.npmrc` 未创建；Pi settings 仅新增专用测试账户的正常包配置。

以下保留旧版失败与排查历史。网络、TUN、DNS、hosts 和快照均未修改；“超时直接造成空目录”的因果尚未独立证明，不据此引入自建续传或自动清理机制。

## 环境与边界

- VMware Workstation，虚拟机：`D:/ivanj/Documents/Virtual Machines/Windows 11 x64/Windows 11 x64.vmx`。
- 用户手动准备现有快照，vmrun 显示名称 `win11-home`；从当前状态启动，不回滚。
- 来宾 Windows 11 家庭版 `10.0.26300`，x64，2 vCPU／4 GiB；本地测试账户 `WeclioTest`，与微软主账户隔离。
- 初始无 Node/npm/Git 命令、启动器目录、Pi settings 或用户 `.npmrc`；已有 Edge，未完整核查 Chrome 安装位置。
- 宿主机 Clash/Mihomo TUN 已启用，运行内核 `v1.19.32`，gVisor、auto-route，mixed-port 7897，allow-lan=false；经本机命名管道只读观察，没有修改配置或开放控制端口。
- 真实执行原始 `launch-weclio-web.bat`，没有预装工具、从浏览器归档填充安装缓存或调用模型。辅助脚本仅负责启动、采集及诊断，不属于交付物。
- 来宾程序执行接口一度不稳定，用户手动运行了两轮有界网络诊断；文件读取及后续 Node 检查可用。诊断使用的公网地址只针对单次请求，保留原域名 TLS 校验，没有写入启动器、hosts 或系统 DNS。
- 凭据仅从宿主机本地 DPAPI 文件读取，未输出或写入仓库；vmrun 接收命令行密码的既有风险仍存在。

## 旧版安装与实际缺陷（历史记录）

### 前两次

- Node 经官方兜底下载、原脚本 SHA-256 校验并解压，版本 `v24.22.1`、npm `11.19.1`；第二次复用，没有重下载。
- PortableGit 的镜像／GitHub 下载失败，两次退出 1，未进入 Web 安装。
- 当时无服务、固定 BAT 或桌面快捷方式；永久 PATH 不变，Pi settings、`.npmrc` 均不存在。

### 第三次（网络与脚本均未调整）

1. 原 BAT 自动从镜像下载、校验并补齐 PortableGit；未使用浏览器下载的文件。
2. Web `0.1.10` 的镜像 npm 安装从约 13:13:24Z 运行至既有 600000 毫秒超时，期间大量 CDN 请求返回 200；随后切换官方源。
3. 官方兜底完成后，SDK 导入报 `Cannot find module 'isexe'`。启动器把它作为默认资源检查告警，仍启动服务并输出“已打开 Weclio Web”，最终退出码 0。
4. 13:32:31Z 只读核查确认：
   - `node_modules/which` 为 `2.0.2`，声明依赖 `isexe: ^2.0.0`；`cross-spawn@7.0.6` 依赖 which。
   - `node_modules/isexe` 目录存在但为空；Node 从 which 的上下文无法解析 isexe。
   - `package-lock.json` 与 `node_modules/.package-lock.json` 中的 `node_modules/isexe` 条目均为 `{}`。
   - SDK 导入失败，默认四个资源及 skills 未完成安装验收。
   - 首页 `/` 为 HTTP 200，`/api/skills?global=true` 为 HTTP 500；`current-app.json` 已选中该不完整版本。
5. 空目录与中断／复用安装的时序说明恢复路径存在缺陷；尚未用独立最小案例重现 npm 的内部行为，不能把所有原因直接归为镜像发布包错误。

### 清理与保留

- 已确认自有实例 PID 9516、端口 8888 的 Node 路径、随机命令行标记与监听归属，只停止此实例；13:38:45Z 再查已不运行。
- 不删除损坏版本目录、npm 锁文件、当前版本／旧实例记录，保留复现条件；旧实例 JSON 中的 PID 已失效，不能据文件存在判断服务仍运行。
- 永久用户／系统 PATH 与初始值一致，测试账户 `.npmrc`、Pi settings 仍不存在。
- 固定 BAT 已生成且与最初复制的 BAT 字节一致；桌面 `Weclio Web.lnk` 已生成，目标正确指向 `%LOCALAPPDATA%/WeclioWeb/launch-weclio-web.bat`，图标取 Edge。
- 尚未删除下载 BAT、点击快捷方式或验证服务复用，因为关键 API 已失败。不要将快捷方式“文件存在”记作全流程通过。

## 用户确认的最小改动与新一轮复验

- 已取消 Web 安装总共 10 分钟的强制截止，安装 stdout／stderr 直通，不再受捕获输出缓冲区限制；增加 npm HTTP 进度。
- 安装不再设置 fetch-retries=0 或 fetch-timeout=120000，使用 npm 默认／用户已有配置；版本查询仍单独保留短预算。
- 使用前独立进程检查 SDK 导入／Next 入口；坏同版本进入普通 npm 安装，不删除 node_modules、锁文件、缓存或单补 isexe。健康旧版／只读全局版本可兜底。
- 核心 SDK 失败不再当作默认资源可降级告警；最终常规健康探测检查首页和只读 `/api/models-config` 的 200／有效 JSON。skills 枚举会经 SDK 自动补装缺失来源，不作为常规探测，以保持不回填边界；本报告里的 skills HTTP 200／列表来自另行实际验收。
- 原有 26 项加新增 9 项，共 35 项自动化测试通过；测试及内嵌代码 lint、TypeScript 检查通过，BAT UTF-8／CRLF 保持。
- 14:46:12Z 复验前再次确认原服务已停止，PATH 不变、Pi settings／`.npmrc` 不存在；随后把新 BAT 复制到同一测试入口，原目录由 npm 正常重试，无快照回滚、目录清理或网络调整。
- 实时日志已验证：先检测已有 SDK 缺 isexe，再调用正常 npm。镜像 CDN 出现 ECONNREFUSED／ETIMEDOUT，npm 完成原生三次尝试后退出失败，启动器才切换官方；官方安装新增 32／移除 27 个依赖项，由 npm 自己处理树布局，SDK 随后导入成功。正常 npm 增删文件不等于启动器自行清理目录。
- 本轮最终退出 0（14:47:49.948Z—14:57:26.449Z）。独立检查：Web `0.1.10`、SDK `1.4.0`，四个资源包为 web-search `0.1.5`、submarine `0.2.2`、citations `0.1.2`、CLI `0.3.2`；四个 SKILL.md 存在；首页／skills API 均 200，diagnostics 为空，默认 skills 仅 read-across／tox-eval／tra-md。
- 本轮实际重试约 9 分 36 秒，不能据此声称真实安装已运行超过 10 分钟；无安装总截止的行为由自动化短预算用例验证。
- “原超时直接造成空目录”的因果尚未独立证明；已证实的是旧版曾接受不可用运行时。当前优先让 npm 正常完成，不自建续传或半成品管理机制。

## 新版桌面、服务与用户选择实测

- 先验证稳定 BAT 与本次复制的源文件字节一致、快捷方式目标正确，再仅删除来宾验收目录里的该 BAT；项目交付文件和固定副本不删除。
- 首次桌面辅助脚本使用 Start-Process -Wait（等待进程树）超时，不记为产品失败或成功。改为在交互式会话中仅等待实际启动进程退出后，两次真实 ShellExecute 桌面快捷方式调用均退出 0，PID／token／端口未变，核心接口健康且 settings 哈希不变。
- 临时通过 SDK 配置启用 sci-search，API 确认四个 skills；精确核对自有服务后停止 PID 11092，再通过桌面快捷方式冷启动。新 PID 2316 健康，配置和四个 skills 保留；这是冷启动检查更新的保留测试，不是新发布包版本升级测试。
- finally 通过 SDK 恢复原包配置，确认 API 又仅返回三个默认 skills，sci-search 禁用。未使用真实账号或调用模型。
- 最终截图确认 Edge 正常显示 `127.0.0.1:8888` 页面。没有测试 Chrome 分支或配置模型后的任务执行。
- 只读健康探测调整后，15:45:28Z—15:46:34Z 重新通过桌面启动两次，均退出 0、复用 PID 2316、配置不变；15:48:39Z 独立确认只读 SDK API 为 200／有效 JSON，自有服务健康。VM 固定 BAT 的 SHA-256 与仓库交付文件一致，UTF-8／CRLF、35 项回归、两处 lint 和 TypeScript 再次通过。

## 网络对照结论

- 用户浏览器下载归档为 60,087,472 字节，SHA-256 与脚本固定值一致，是正确 PortableGit 包。
- 同账户首次对照中，Invoke-WebRequest 与 curl 均下载失败；PowerShell 内部错误涉及连接 `198.18.0.15:443`。系统代理／PAC 未配置，但宿主机确有 TUN。
- 首轮手动范围请求（12:58:47Z 完成）：原 registry URL＋系统 DNS 超时；直接 CDN URL＋单次指定公网 IPv4 成功，HTTP 206／约 498 毫秒／1 字节。两者还存在重定向差异，不能凭此确定 DNS 是唯一原因。
- 第二轮（13:06:20Z 完成）三项全部成功，均为 1 字节范围响应：
  - 原 registry URL＋系统 DNS：206／424 毫秒。
  - 直接 CDN URL＋系统 DNS：206／211 毫秒。
  - 同 CDN＋单次指定公网地址：206／217 毫秒。
- 同期 Clash 记录到目标 TUN 流量、SNI 识别及 DIRECT 出口。此前失败本轮无法复现，不能认定 TUN、Fake-IP 或重定向存在固定故障，也不能认为 TUN 完全未接管。
- HEAD／范围响应成功不代表大包与全部依赖安装通过；本次后续 npm 超时就是独立的完整安装验证问题。

## 用户试用新增问题：后台命令闪窗（发现记录，后按可见控制台方案处理）

- 用户反馈发送消息和其他操作时出现两个短暂控制台窗口。
- 16:10Z 以非管理员进程轮询复现，只请求 sessions 列表和 Git 状态（不发模型消息）：捕获 Web PID 2316 的两个 git.exe 子进程，以及各自的 conhost.exe，接口均 200。该次闪窗对应后台 Git 查询，不是重新安装。
- `lib/worktree.ts`、`lib/git-changes.ts` 的 Git execFile 调用未设置 windowsHide；SDK 内其他子进程调用也需按实际触发点检查，不能据此次采样断言所有窗口都是相同命令。
- 尚未修改 Web／SDK 业务代码；此修复超出本轮只交付 BAT 的既定改动边界，需要另行确认。证据为本机 `popup-observation.json`、`popup-probes.json`，仅保存进程类型／固定命令分类，不保存消息或原始命令行。首次 WMI 事件订阅权限不足，已改为无需提权的只读轮询，没有提升权限。
- 用户质疑后进一步核查：`loadAllSessions` 为每个唯一 cwd 调用 `resolveProject`，后者在 60 秒缓存未命中时运行 git rev-parse，以识别主仓库／worktree／分支；不是用 Git 读取消息，也不是每次列表刷新固定启动两个 Git。`handleAgentEnd` 刷新侧栏及文件面板，后者通过 `/api/git/status` 独立调用 Git。没有对用户实际消息逐个窗口抓栈，不宣称所有操作的窗口都已逐一归因。
- 宿主机 8888 的 PID 20228 属于终端中启动的 next dev 父进程链。独立无窗口 Win32 探针确认该进程有控制台（AttachConsole 成功且目标在 console process list 中）；来宾 PID 2316 没有控制台（AttachConsole 返回 ERROR_INVALID_HANDLE／6）。最终依据为 `host-console-native.json`、`guest-console-native.json`，不采用受 PowerShell 自身控制台影响的中间探测结果。
- 因此先前“与 BAT 启动逻辑无关”的说法过于绝对：BAT 脱离终端的后台启动方式暴露了 Web 既有 Git 子进程未隐藏的问题。宿主机共享已有终端，不能用“不弹窗”证明“不执行 Git”。模型 Bash 工具与 Web 元数据查询是两条不同调用链；此处直接 execFile 启动 Git，没有走模型工具，SDK Bash 工具本身已有 windowsHide。

## 用户确认的可见控制台方案及验收

- 只改变 BAT 的服务启动方式：由 PowerShell Start-Process 正常打开已安装 Web 的 Node 控制台。Node detached 模式即使 windowsHide=false 仍无控制台，故未采用单改该开关的错误方案。
- 日志在可见窗口中显示并保留 server.log；首屏明确关闭浏览器不停止、关闭服务窗口将停止正在运行的任务、桌面快捷方式可重启。Next 可能把页签标题改为 next-server 版本名，首屏 Weclio Web 标识及提示仍可见。
- 新增可见控制台策略／Windows 原生参数引用用例；原生 fixture 验证正常 execFile（不加 windowsHide）启动的子进程控制台列表包含服务 PID，验证共享控制台，而不是凭“不见闪窗”猜测。37 项回归及测试／内嵌代码 lint、TypeScript 通过。
- 17:09Z 首次迁移前核对旧 PID 2316 身份、接口健康及无运行任务，仅停止该自有测试实例，保留所有配置和数据；打开可见服务 PID 9592。
- 17:26:41Z—17:28:30Z 生命周期实际验收：独立 Edge profile 窗口关闭后 PID 9592 仍健康；通过 UI Automation 关闭唯一、仅一个服务页签的 Windows Terminal 窗口后 PID 9592 及其监听退出；真实桌面快捷方式退出 0，重启为 PID 4468／8888，原生探针确认可见控制台；再次点击退出 0、复用相同实例。已删除本次测试输入 BAT，固定副本仍可用。
- 对 settings.json／models.json／auth.json 仅比较本地摘要，不输出内容，验证三者未改变；没有发模型消息、改浏览器默认、改永久 PATH／npmrc／网络或恢复快照。
- 最初对 GetConsoleWindow 兼容句柄发送 WM_CLOSE，没有关闭 Windows Terminal，本次明确不记为通过；改为实际 Terminal 窗口关闭后才验收成功。没有为迎合测试改变服务停止逻辑，也没有强杀进程冒充用户关窗口。
- 17:29Z 原只读 sessions／Git status 查询均 200；轮询捕获服务自身的 conhost 和 Git 子进程，未捕获 Git 另开 conhost。轮询有盲区，不以此宣称任意第三方进程永不另开窗口；默认后台进程继承由上述原生测试验证。
- 17:29:59Z 最终自有服务身份、首页及 SDK 配置 API 健康；交付 BAT SHA-256 为 a5208f1abd06c6e354ff06cb46a41a6e8aab30bee559089585e9db6d1fe94d38，来宾固定副本一致。

## 本轮最终候选修复与非交互核对

- 快捷方式改用安装包自带 Weclio ICO，复制到固定目录，不再引用 Edge／Chrome，不额外下载图片，不增加依赖或交付文件。独立单测不访问真实宿主机桌面。
- 默认 8888 的 EACCES 与 EADDRINUSE 都改选空闲端口；其他异常仍报错。未修改系统保留端口或网络设置。
- 损坏的应用 package.json 进入坏版本回退边界，不阻断健康全局版本／普通 npm 恢复，也不覆盖坏清单来伪造健康。
- SDK 验证仍独立运行，同时真实执行 Next CLI --version 并检查输出；缺依赖或空入口不能作为健康安装复用。依旧由普通 npm 处理修复，不自建依赖删除或单包补丁。
- Git 候选需 git／bash --version 真正成功才复用；部分解压只留下 exe 文件时，回到已校验便携包的普通提取路径，不擅自删除运行时。
- 上述新边界均先通过失败用例证明，再修复通过。最新 43 项测试全过、无跳过；lint／TypeScript 通过。
- 18:40:03Z—18:40:54Z 非交互核对：Web 0.1.10 核心运行检查通过；真实桌面 .lnk 目标为固定 BAT，图标为 `%LOCALAPPDATA%\\WeclioWeb\\weclio.ico,0`，文件与安装包品牌 ICO 字节一致且六尺寸完整；settings/models/auth 摘要不变，固定 BAT 与交付文件一致；没有警告或错误，测试输入已删除。
- 该核对没有运行 Main／浏览器／服务，更没有把会话 0 控制台当作真实桌面。当时待用户登录；后续已按下节执行最终摘要的真实 GUI 复验。上一轮品牌图标验收工具在 CIM 查询时中断，不记作产品通过。

## 最终真实桌面交互验收

- 用户恢复 WeclioTest 桌面；截图 `final-desktop-before.png` 已确认 Weclio 品牌图标实际显示，不是 Edge／Chrome 图标。
- 18:53:38Z—18:56:08Z 使用固定 BAT（最终摘要）和真实 .lnk，初始确认旧服务不在运行。第一次桌面执行退出 0，启动 PID 5836；身份／端口／核心接口健康，原生探针确认独立可见控制台。
- 仅关闭隔离测试浏览器 profile 的窗口，PID 5836 及健康接口保留。再次确认 runningSessionIds 为空及进程身份后，通过 UI Automation 关闭唯一、只有一个服务页签的 Windows Terminal，确认服务及监听停止。没有强杀冒充关闭终端。
- 再点真实桌面快捷方式退出 0，重启为 PID 6548／8888，原生探针确认可见控制台；再次点击退出 0、复用相同 PID／token。最终 BAT 字节未变，测试输入已删除，固定副本与品牌 ICO 不依赖下载源 BAT 留存。
- settings/models/auth 摘要未变；四个默认资源包分别为 web-search 0.1.5、submarine 0.2.2、citations 0.1.2、CLI 0.3.2，四份 SKILL.md 存在；本轮未发模型消息，未更改用户的资源选择。
- 18:59:57Z 最终只读健康检查：自有 PID 6548／8888、首页及 SDK 配置 API 200／有效 JSON，交付摘要一致；19:00:05Z 用户／系统永久 PATH 与初始值相同，npmrc 未创建。服务保留供用户使用，最终页面截图为 `final-desktop-running.png`。
- 证据以 `final-desktop-acceptance.json` 的 errors 空数组及各项实际结果为准；非交互检查、旧摘要记录和失败的中间辅助脚本均不替代本节。

## 已通过与未通过

已确认：真实 Node/Git 引导与摘要校验、普通 npm 修复原损坏安装、原生网络重试及失败退出后的官方兜底、SDK／关键接口可用、四个默认资源包及 skill 文件、sci-search 默认禁用、Edge 页面打开、删除测试源 BAT 后桌面启动、两次服务复用、冷启动保留手动启用并恢复默认、永久 PATH／`.npmrc` 保留及精确自有实例操作。

仍待：无已有缓存／无既有依赖的干净 Windows 首次完整安装、新 Web／资源版本升级、Chrome 分支、其他国内网络、复杂已有用户配置／固定版本的真实流程、模型任务执行及浏览器下载 BAT 的安全提示交接。本次是原损坏环境恢复，不冒充无缓存首次安装。

宿主机最新 43 项回归测试、测试及内嵌代码 lint、TypeScript 检查通过，含品牌图标、受限端口、坏清单／Next、Git 执行验证及可见控制台的默认子进程继承、日志及退出重启。原 26 项未覆盖的缺陷已补入新用例，但本地自动化仍不能替代剩余场景。

## 下一步

1. 本环境已由普通 npm 重试恢复，不需要增加自建半成品清理／续传或单补依赖逻辑。
2. 在用户授权的干净环境补无缓存首次完整安装，以及 Chrome／其他网络等剩余场景；不要擅自恢复用户快照。
3. 保持镜像优先、官方兜底和运行中只复用策略，不扩展同步检查或网络绕过。
4. 最终摘要的桌面可见图标和完整生命周期验收已通过，保留健康 PID 6548／8888 给用户使用。后续清理仍须核对实时身份，不因报告中的旧 PID 或记录文件存在就结束进程。

## 本机证据

宿主机：`C:/Users/ivanj/AppData/Local/WeclioVmTest/`；来宾辅助资料：`C:/Users/WeclioTest/AppData/Local/WeclioLauncherAcceptance/`。这些是本机证据，不是跨机器交付路径。

- `baseline.json`：初始环境；`final-state.json`：前两次失败后的状态，非第三次最终状态。
- `first-attempt-console.log`、`second-attempt-console.log`：前两次输出。
- `install-console.log`、`install-exit.txt`：第三次告警／启动输出及退出 0。
- `network.json`、`network-get.json`、`compare-download.json`：初期网络诊断与浏览器文件校验。
- `bounded-first.json`、`clash-first-dns-observation.json`：首轮手动对照；`bounded-second.json`、`clash-second-dns-observation.json`：第二轮三项成功及同期目标日志。
- `npm-progress.json`：官方兜底中的 npm 日志采样；完整 npm 日志在来宾 `%LOCALAPPDATA%/npm-cache/_logs`。
- `installed-check.json`、`server.log`：SDK 导入与服务报错。
- `recovery-check.json`：空 isexe、锁文件条目、HTTP 200／500、自有实例证据。
- `service-cleanup.json`：精确停止实例及快捷方式目标；`after-test.json`：停止后状态和 PATH／配置保留。
- `before-minimal-retry.json`：新版复验前状态；`minimal-retry-console.log`、`minimal-retry-result.json`：实时日志及最终退出 0。
- `minimal-installed-check.json`：SDK、资源包、skill 文件和 HTTP 独立核查；`minimal-recovery-check.json`：最终可解析的嵌套 isexe、健康 API 和实例。
- `desktop-acceptance-first-attempt.json`：辅助等待方式超时记录；`desktop-acceptance-before-readonly-probe.json`：首次两次成功；`desktop-acceptance.json`：最终只读探测版桌面入口两次成功、删除源后复用与配置哈希验证。
- `final-health-check.json`：最终交付文件 SHA-256、只读 SDK API 200／有效 JSON、自有服务身份／健康及配置不变。
- `choice-acceptance.json`：手动启用／冷启动保留／恢复默认；`minimal-final-state.json`：前一轮 PATH、配置与运行状态；`healthy-web-final.png`：Edge 页面可见。
- `visible-console-start.json`、`visible-console-native.json`：当前模式初次启动、空闲旧服务精确停止、可见控制台及配置不变；`visible-console-running.png`：服务窗口首屏。
- `visible-console-lifecycle.json`：最终实际浏览器／服务终端关闭、桌面重启和复用；`visible-console-lifecycle-native-close-attempt.json`：初次错误关闭兼容窗口的失败记录，不能当成最终产品结论。
- `visible-console-git-observation.json`、`visible-console-git-probes.json`：同类只读查询回归；`visible-console-final-health.json`、`visible-console-final-state.json`：上一可见控制台版本摘要、健康与 PATH／配置状态。
- `final-tests.log`：最终 BAT 的 43 项回归全部通过；`final-artifact-metadata.json`：固定副本／品牌图标引用与字节／运行时／配置不变的非交互核对；`final-audit-status.json`、`final-audit-screen.png`：登录阻断时的历史状态。`brand-icon-acceptance.json` 中间失败报告不是正式通过证据。
- `final-desktop-acceptance.json`、`final-initial-console.json`、`final-restarted-console.json`、`final-console-close.json`：最终摘要真实桌面冷启动／浏览器关闭／实际终端关闭／重启／复用及配置不变结果；console 探针原始文件在来宾验收目录。
- `final-desktop-before.png`、`final-desktop-running.png`：最终桌面品牌图标和打开的 Web；`final-release-health.json`、`final-release-state.json`：最终健康与永久 PATH／npmrc 核对。诊断脚本及探针仅供本机测试，不是交付物。

已清理首次诊断误生成的大体积 JSON 和当时仍运行的同名诊断进程；未删除用户目录或结束未知程序。未提交、推送或发布，未修改网络、宿主机／微软主账户的 Pi 配置；启动器代码仅按后续用户确认的最小方案修改。
