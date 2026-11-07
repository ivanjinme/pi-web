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

- 发布链实现已收尾，下一步是真实打包升级验收。具体未验证边界见阶段文档，不能宣称已验证安装版。
- 本次用户只要求交接文档，**不是新增打包、安装、提交、上传或切换 Latest 的授权**。
- 真实验收的 baseline／目标版本、安装位置、端口及数据备份／恢复安排尚未确定。不要预先承诺只需一个安装包。
- 正式 setup 已执行，签名预检通过；**用户尚未确认完成私钥的独立安全备份**。路径与恢复规则引用 `docs/desktop-release.md`，不要读取或复述私钥内容。
- GitHub 测试资产的历史与证据引用阶段 1 文档；删除、覆盖或改为 Latest 需另获授权。

## 对话中需要保留的协作上下文

- 用户强调“聪明地分阶段推进”：先低成本验证具体边界，稳定后才打包；不要每次 fix 都重跑昂贵全流程。回复中文、言简意赅。
- 未准备 VM 或完整隔离环境；独立 Electron 窗口不等于隔离。也不要擅自停当前开发服务，它可能承载 agent 和其他工作。环境事实自己检查。
- 先前复杂安装原型已撤回。不要从旧对话恢复原型；当前选定边界以 `docs/desktop-update-stage2.md` 为准。
- 用户曾要求 fresh subagent 对照参考项目。必要时直接读：
  - `D:/ivanj/Documents/0-1/2_product/playground/deepseek-harness/apps/desktop/src/update-coordinator.ts`
  - `D:/ivanj/Documents/0-1/2_product/playground/deepseek-harness/apps/desktop/src/main.ts`
  不要把参考项目的全部机制当成本项目需求。
- 工作区混有并行任务改动，尤其 composer/sidebar 相关内容。不要清理、撤回、顺带重构或整体暂存无关改动；以续作时的 diff 为准。

## 最新验证补充

已有阶段验证记录直接引用阶段文档。发布链最后一轮另外通过了 **67 项针对性测试**、TypeScript、lint 和复审；这不是一次最新全量测试，也不要与历史数量相加冒称全量通过。

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
- A 版本当前为 0.1.11（package 与 lock 已更新）；生产构建和 TypeScript 通过，未改开发 `.next/`。首次 NSIS 打包在追加 elevate.exe 的 7za 子进程启动时以 3221225794 失败，无新包保留。相同参数的微型压缩检查 3 次通过；原生产构建的 `--quick` 重试已成功，不重跑 Web 构建。A 安装包 389291078 字节，SHA256 为 `52e22dfaa740ec78d1c092152c666cb74f832a898f298145a0a50bfd324d2618`，四件产物单独保留在 `build/desktop/update-acceptance/A/`。结果和进程信息见忽略目录 `build/desktop/update-acceptance/`。不要仅凭历史 PID 停进程。
- A 首次静默安装因 8 分钟等待上限被中断；随后误启动了尚未解压完整的应用，缺 cross-spawn，不能判作完整安装版的产品缺陷。该测试窗口已定向正常关闭，未停开发服务。同一安装包的无短超时补装已完成，exitCode 0，耗时约 10 分钟；状态见 `install-A-result.json`，不可仅凭 EXE 已出现就启动。安装目录为 `%LOCALAPPDATA%/Programs/Weclio`。
- **A 安装版冒烟通过**：真实运行在 8890，正式公钥配置匹配，三个 preload API 可用，`/api/sessions` 返回 200 和 406 个会话，一份历史会话 SHA256 与备份一致。正常关窗后自有 8890 服务退出；清除端口环境变量后，经 Windows `Shell.Application.ShellExecute` 调用安装器保留的开始菜单快捷方式并传入 `--updated`，仍恢复 8890 和独立 profile，localStorage 验收标记保留。这是同版本 shell 重开演练，**不是真实 A→B NSIS 升级验收**。
- A 最终已正常关闭；8890／9227 已释放，原 8888 开发服务（PID 16520）和 8899 fixture 保持运行。新建的开始菜单与桌面快捷方式仅保留 `--user-data-dir=<独立 profile>`，已移除远程调试参数。后续自动化升级若要连接 9227，须在受控验收期间重新加入调试参数，结束后移除。
- 安装版证据：`smoke-A-browser.json`、`smoke-A-installed.json`、`relaunch-A-browser.json`、`shell-relaunch-process.json`、`A-installed.png`、`A-shell-relaunch.png`，均位于 `build/desktop/update-acceptance/`。B 构建、源码提交、上传和切换 Latest 尚未执行。
- 发布前仍须解决源码归档：发布规程要求 tag commit 对应安装包源码，但工作区包含未提交更新代码及并行 UI 改动。用户当前批准的操作没有明确授权提交这些并行改动；不得把实际安装包挂到不匹配的旧 HEAD，也不得顺带整体暂存／提交。
