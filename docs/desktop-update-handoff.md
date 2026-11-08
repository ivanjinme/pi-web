# 桌面更新 handoff

本文只补充续作上下文；规格、实现、操作步骤和已有验证记录不在此重复。以下路径均相对仓库根目录。

## 先读现有 artifacts

| 需要了解什么 | 引用 |
| --- | --- |
| 仓库约束、架构和执行命令 | `AGENTS.md`、`CONSTITUTION.md`、`ARCHITECTURE.md`、`COMMANDS.md` |
| 下载阶段与真实 GitHub 测试证据 | `docs/desktop-update-stage1.md` |
| 当前安装交接设计、任务／退出边界及验收缺口 | `docs/desktop-update-stage2.md` |
| 正式密钥、构建产物、人工发布流程 | `docs/desktop-release.md` |
| 正式信任配置 | `resources/desktop-update.json` |
| 最新实现与回归案例 | `electron/updates.mjs`、`electron/update-install.mjs`、`electron/update-release.mjs` 及对应测试；其他入口沿 import 查阅 |

代码和测试是实现事实的来源。续作时重新检查 `git status` 和 diff，也要读取 untracked 文件；不要把文档快照当成当前工作区状态。

## 当前停点与授权

- **最新实现停点**：依赖／Next 部署元数据瘦身和独立工具存储已写入代码；未打包或发布。隔离原型证明后台准备期间旧服务可用，停止到页面及会话 API 恢复约 4.45 秒。正式业务包更新通道、不同版本 Electron 重开和 VM 验收仍未完成，不能说“30 秒更新已交付”；完整结果与后续边界见 `docs/desktop-update-performance.md`。
- **当前重点转为安装耗时与可见性，VM 升级结果仍未确认**：用户先报告 A→B 确认后窗口消失、安装目录为空、仍有 Weclio.exe；随后补充仅等待 3–5 分钟便结束进程，重装 A 已成功且耗时超过 10 分钟。因此不能据此判定升级永久失败或死锁，原现场已改变，尚需完整复测。用户明确 **B 不撤下、没有其他更新用户**；勿擅自更改线上发布。当前十余分钟的静默全量安装不能视为满足交付体验目标。
- npm 与桌面 **0.1.12 已发布**，桌面为正式 Latest。真实安装版 **0.1.11 → 0.1.12 核心升级验收通过**；成功差异传输未验证，具体证据与限制见下方最新记录及阶段 2 文档。
- 用户已明确批准所有改动 commit／push，并在后续要求 **npm 与桌面两边 publish，然后继续升级验收**；私钥独立备份已确认完成。原始 handoff 的“仅文档、无发布授权”已被后续授权取代。
- A=0.1.11，已安装 B=0.1.12；npm 与桌面标签均指向源码 `271a02e`。测试窗口已正常关闭，8890／9227 已释放；8888 开发服务和 8899 fixture 保持运行。安装目录、独立 profile 及仓库外备份见后文。首次发布前的“未分发”结论不适用于未来发布。
- 正式 setup 已执行，签名预检通过。密钥路径与恢复规则引用 `docs/desktop-release.md`，不要读取或复述私钥内容。
- GitHub 测试资产的历史与证据引用阶段 1 文档；删除、覆盖或改为 Latest 需另获授权。

## 对话中需要保留的协作上下文

- 用户强调“聪明地分阶段推进”：先低成本验证具体边界，稳定后才打包；不要每次 fix 都重跑昂贵全流程。回复中文、言简意赅。
- 用户现有 VM，并已尝试 A→B；等待 3–5 分钟后结束进程，故完整升级结果未确认。独立 Electron 窗口不等于隔离；不要擅自停当前开发服务，它可能承载 agent 和其他工作。环境事实自己检查。
- 先前复杂安装原型已撤回。不要从旧对话恢复原型；当前选定边界以 `docs/desktop-update-stage2.md` 为准。
- 用户曾要求 fresh subagent 对照参考项目。必要时直接读：
  - `D:/ivanj/Documents/0-1/2_product/playground/deepseek-harness/apps/desktop/src/update-coordinator.ts`
  - `D:/ivanj/Documents/0-1/2_product/playground/deepseek-harness/apps/desktop/src/main.ts`
  不要把参考项目的全部机制当成本项目需求。
- 续作时可能混有并行任务改动，尤其 composer/sidebar 相关内容。不要清理、撤回、顺带重构或整体暂存无关改动；以当时的 diff 为准。

## 历史自动验证入口

已有阶段验证记录直接引用阶段文档。原发布链接入最后一轮另外通过了 **67 项针对性测试**、TypeScript、lint 和复审；这不是最新全量测试，也不要与其他历史数量相加冒称全量通过。

若要复核这一轮，入口是：

```bash
node --test electron/release.test.mjs electron/update-release.test.mjs electron/release-artifacts.test.mjs electron/builder.test.mjs electron/updates.test.mjs
node --test electron/updates.integration.test.mjs electron/updates-install-service.test.mjs
```

本地忽略目录的证据入口：`build/desktop/update-validation/`、`build/desktop/github-update-smoke/`。其历史 `.pid` 不能直接用于 kill，必须重新核实进程身份；测试进程可能已经关闭。

原 handoff 编辑未执行构建、安装、上传，也未重新运行代码测试。

## 2026-11-07 续作

- 用户已确认正式私钥独立备份完成、未向其他用户分发此次更新客户端；并批准端口恢复、用户数据本地备份、A/B 构建安装及 B 发布／Latest 验收范围。
- 新增安装版端口记忆：`electron/navigation.mjs` 的 `restoreDesktopPort()` 在创建窗口和服务前恢复用户数据目录中的 `desktop-port.json`；开发版不持久化。优先级和边界见 `docs/desktop-release.md`。
- 本轮 31 项端口／导航／主进程针对性测试和相关文件 lint 通过，独立复审无发现。发布脚本另跑的 162 项 Electron 测试通过；数量不相加冒称全量。
- 用户数据已作仓库外、本用户 ACL 保护的在线备份：`C:/Users/ivanj/.weclio-backups/desktop-upgrade-2026-11-07T11-43-21-499Z/`，851 文件、841817833 字节。清单记录 14 个跳过项（私钥目录、缓存、锁及开发窗口占用的 Cookie）；不是完整冷备。私钥由用户另行备份，不读取或复制至验收目录。
- 验收保留现有 8888 开发服务和 8899 fixture，安装版使用 8890。独立 Chromium profile 计划为 `%APPDATA%/Weclio-update-acceptance`；真实 Electron 已验证 `--user-data-dir` 对此路径生效。NSIS 用于重开的开始菜单快捷方式也必须保留此参数，不能假设安装器继承进程环境或启动参数。
- A baseline 所用版本为 0.1.11；该轮生产构建和 TypeScript 通过，未改开发 `.next/`。首次 NSIS 打包在追加 elevate.exe 的 7za 子进程启动时以 3221225794 失败，无新包保留。相同参数的微型压缩检查 3 次通过；原生产构建的 `--quick` 重试已成功，不重跑 Web 构建。A 安装包 389291078 字节，SHA256 为 `52e22dfaa740ec78d1c092152c666cb74f832a898f298145a0a50bfd324d2618`，四件产物单独保留在 `build/desktop/update-acceptance/A/`。结果和进程信息见忽略目录 `build/desktop/update-acceptance/`。不要仅凭历史 PID 停进程。
- A 首次静默安装因 8 分钟等待上限被中断；随后误启动了尚未解压完整的应用，缺 cross-spawn，不能判作完整安装版的产品缺陷。该测试窗口已定向正常关闭，未停开发服务。同一安装包的无短超时补装已完成，exitCode 0，耗时约 10 分钟；状态见 `install-A-result.json`，不可仅凭 EXE 已出现就启动。安装目录为 `%LOCALAPPDATA%/Programs/Weclio`。
- **A 安装版冒烟通过**：真实运行在 8890，正式公钥配置匹配，三个 preload API 可用，`/api/sessions` 返回 200 和 406 个会话，一份历史会话 SHA256 与备份一致。正常关窗后自有 8890 服务退出；清除端口环境变量后，经 Windows `Shell.Application.ShellExecute` 调用安装器保留的开始菜单快捷方式并传入 `--updated`，仍恢复 8890 和独立 profile，localStorage 验收标记保留。这是同版本 shell 重开演练，**不是真实 A→B NSIS 升级验收**。
- A 最终已正常关闭；8890／9227 已释放，原 8888 开发服务（PID 16520）和 8899 fixture 保持运行。新建的开始菜单与桌面快捷方式仅保留 `--user-data-dir=<独立 profile>`，已移除远程调试参数。后续自动化升级若要连接 9227，须在受控验收期间重新加入调试参数，结束后移除。
- 安装版证据：`smoke-A-browser.json`、`smoke-A-installed.json`、`relaunch-A-browser.json`、`shell-relaunch-process.json`、`A-installed.png`、`A-shell-relaunch.png`，均位于 `build/desktop/update-acceptance/`。截至该轮 A 冒烟停点，B 构建／发布尚未执行；后续完成记录如下。
- 上轮停止时的源码归档阻塞随后解除：用户批准全部改动 commit／push，源码进入 `e1267b7` 及之前的 composer/sidebar commits；本轮再提交版本 0.1.12，对应发布源码如下。

## 2026-11-07 UTC：两边发布与真实 A→B 验收完成

- **发布**：源码 `271a02ec2fcdad62fa911c17fe583301971603e1`；npm 标签 `v0.1.12`，GitHub Actions run `42402925754` 成功，官方 registry 的 `latest`、版本和 gitHead 已核对。桌面标签 `desktop-v0.1.12` 指向同一 commit，正式公开、非 prerelease、Latest。草稿及公开后的四件附件哈希均已核对，公开 Latest 清单验签通过；未覆盖历史资产或修改 smoke release。
- **B 产物**：EXE 389502062 字节，SHA256 `9d815c54452db73204d22793e4f297e1a879334e8177643fb33b2977ccafef39`；配套 blockmap、签名清单和 SHA256SUMS 均保留在 `build/desktop/dist/`。B 发布脚本的 167 项 Electron 测试、生产构建和 TypeScript 通过；数量不与前轮相加。
- **真实升级**：没有先手装 B 再恢复 A。已安装 A 从正式 Latest 下载 B，独立核对 SHA512／大小；下载就绪后的普通退出不安装、取消原生确认不停止服务，均通过。再次明确确认后，标准 updater 以 `--updated /S --force-run` 启动真实 NSIS 安装器；B 于 19:47:04 UTC 自动重开，应用及服务版本均为 0.1.12，仍使用 8890 和同一独立 profile。
- **自动重开证据与监测限制**：自动进程 PID 28292 的 `--updated` 命令行、创建时间、原生渲染 UI、安装元数据和新自有服务共同证明自动重开。CDP 观测脚本未能在自动重开后重新连接，`upgrade-observation-result.json` 的 timeout／false 保留，不能改写为自动监测通过。取得上述独立证据后，才正常关闭并手动重开同版本 B 作 CDP 诊断；该次截图和浏览器标记检查不冒充自动重开证据。
- **数据**：升级前 407 个会话 ID 全部保留；设置／模型配置、历史会话、测试文件、端口等六个抽样文件的哈希保持一致。浏览器 localStorage 标记在后续同版本诊断重开中保留；B updater 对相同 Latest 版本保持 idle。此结论是抽样文件完整性和会话成员集合，不是所有会话正文逐字或所有功能验收。
- **差分**：A 未发布，旧 blockmap 请求 404 后正常回退全量；本轮未证明成功差异传输。B 的配对 blockmap 已公开，NSIS 当前 installer.exe 缓存与 B 安装包哈希一致。等下次真实版本观察即可，不为此立即打 C。
- **收尾**：B 已保持安装，测试窗口正常关闭；8890／9227 释放，原 8888 开发服务（历史 PID 16520）与 8899 fixture 未动。新建快捷方式保留独立 profile 参数，远程调试参数已移除；用户原 Electron profile 未被测试实例打开。下一次操作必须重新核实进程身份，不能拿此处历史 PID 直接 kill。
- **证据入口**（均在忽略目录 `build/desktop/update-acceptance/`）：`upgrade-core-verified.json` 汇总；`automatic-B-ui-ready.json`、`installed-B-version.json`、`installer-handoff-processes.json` 为自动链路；`data-before-B.json`／`data-after-B.json` 为数据快照；`B-manual-diagnostic-restart.json` 和对应截图为后续诊断。`release-B-remote.json`／`desktop-release-final-state.json` 为公开状态，`release-B-draft-assets-verified.json` 保留草稿验收；另有 npm、公开清单及最终运行状态回执。独立只读复核支持附有限定的核心验收结论。
- **当时验收边界**：上述本机核心闭环曾通过；忙任务竞态、beforeunload 与安装失败分支并未全部在安装版重跑，仍分别引用已有自动／空白窗口测试。后续 VM 报告及等待时长补充影响当前发布判断，见本文顶部最新状态。不新增回滚或退出后恢复承诺。以后公开发布可能已有客户端，需重新确认影响范围，不复用此次“无其他客户端”的历史前提。

## 2026-11-08 UTC：更新性能范围与初始调研

- 用户要求普通 feature 更新从确认重启到新版可交互尽量不超过 30 秒，并指出长期静默不可接受。此目标尚未验证，不能把“全量升级成功”当作性能达标。
- 本机已安装 B 的只读文件元数据统计：46280 文件，1562344899 字节（约 1.56 GB）；其中生产 node_modules 为 35829 文件／542197300 字节，Portable Git 为 9616 文件／411469746 字节。证据：忽略目录 `build/desktop/update-acceptance/installed-B-inventory.json`。统计揭示重复全量处理规模，不等于已经测出卸载／解压／复制／冷启动各阶段的耗时归因。
- 当前 NSIS 仍卸载旧安装文件，再解压及复制完整新版；差分仅优化传输，不消除此安装工作。现有 server 由系统 Node 从真实目录启动，不能不验证就把所有依赖直接塞进 ASAR。
- 用户进一步明确：**Git/Bash 应剥离出常规业务 updater**。首次准备后普通 feature 更新不重新下载／替换 Git；按需安全维护应独立处理，不能解释成永久不维护。当前源码并没有每次联网检查 Git 新版本，只做必需工具存在检查；实际浪费来自每次完整打包、随应用卸载和重装工具。不能只删打包映射：运行路径仍在安装目录内，须先设计独立稳定目录及旧安装迁移，否则旧卸载器会删掉 Git。
- 其他评估方向是 Node 打包减量、未变依赖复用，以及后台校验与准备后再进行短暂版本切换；准备进度需可见、旧版仍可用。尚未决定切换框架或加入依赖，未改安装机制、未构建或发布新版本；不得把上述初始方案写成已实现或保证任意机器 30 秒；后续实现和验证进展以 `desktop-update-performance.md` 为准。
- Node 依赖物料已进一步实数：542197300 字节／35829 文件；大头为 next 184.7 MB、Windows SWC 106.2 MB、pi-coding-agent 32.2 MB、TypeScript 23.6 MB、OpenAI 18.5 MB、Google GenAI 11.3 MB、Anthropic SDK 9.5 MB。其中 source maps 共 136418774 字节／7839 文件，已经包含在总量中，不能重复相加。数据在忽略目录 `build/desktop/update-acceptance/installed-node-dependencies.json`；只是物理大小统计，不能据此断言整个 SWC／TypeScript／某 SDK 都可删除。
