# Windows Desktop 首版实施计划

状态：仅计划，未开始实现。计划要求批准不等于用户已经批准。
目标：让执行模型按文件、契约和验收条件实施，不自行设计架构。
不保证一次实现零缺陷。用小任务、真实契约测试和停止门槛限制返工。
写法：短句、明确动作、一次一个任务。此文不是 ASD-STE100 符合性认证。

## 0. 给执行模型的指令

1. 先读本文件，再读目标仓库的 AGENTS.md。
2. 每次只执行一个任务编号。
3. 先写失败测试，再写实现。
4. 完成当前任务的验收后，再开始下一项。
5. 发现接口与本计划不符时，停止并报告差异。
6. 不把未执行的测试写成“通过”。
7. 不用 mock 测试代替 SDK 集成测试或安装包测试。
8. 不通过删除断言、放宽授权或吞掉异常来使测试通过。
9. 不更新无关依赖。不重构无关代码。
10. 不改 node_modules，不在 Web 当前工作目录执行 next build。
11. 不提交、推送、打 tag、创建远程仓库或发布包，除非用户另行授权。
12. 每项结束后，使用本文末尾的交接模板。

### 0.1 保护现有修改

规划时发现以下现有修改。它们不是本任务产生的：

- `weclio-web/docs/citations.md`：已暂存修改。
- `weclio-web/hooks/useAgentSession.ts`：未暂存修改。
- `weclio-web/hooks/useAgentSession.test.mjs`：未跟踪文件。

执行前重新运行每个仓库的 `git status --short`。
不得 reset、覆盖、顺手提交或删除这些修改。
若当前任务必须修改同一段代码，先请用户安排合并。

### 0.2 状态词

- `待开始`：尚未执行。
- `进行中`：仅当前任务可使用。
- `阻塞`：说明缺失的批准、环境或证据。
- `完成`：代码、测试、证据均齐全。

禁止把“代码已写”直接标为“完成”。

## 1. 范围与批准门槛

### 1.1 用户已确认

- 保留在线安装用户包。
- 关闭窗口时，确认后终止任务。
- 首版供内部试用。
- 暂不考虑 macOS。

### 1.2 本计划采用的建议，T00 必须确认

| 编号 | 建议 | 未批准时的动作 |
|---|---|---|
| D01 | 新建相邻的 weclio-desktop 仓库；Electron 薄壳 | 不创建仓库或安装依赖 |
| D02 | 首版 Windows x64；确定最低 Windows 版本 | 不声称支持未测试系统 |
| D03 | 三个插件；CLI skills 仅 sci-search、tox-eval | 不复制整个 skills 目录 |
| D04 | Electron、electron-builder、测试工具和共享运行库依赖 | 先列依赖与版本，再申请批准 |
| D05 | 同一规范化数据目录只运行一个受管后端 | 不自行引入跨进程写入协调 |
| D06 | 内置包优先；同名用户包不并行加载 | 不静默执行两个版本 |
| D07 | 首版手动覆盖升级；按用户安装；卸载保留数据 | 不增加自动更新或管理员安装 |
| D08 | 独立 Web 保持可用；首版不增加“浏览器连接桌面服务”入口 | 不绕过桌面认证来支持浏览器 |

D08 不取消 Web 支持。独立 Web 仍是同一业务代码的运行方式。
浏览器与桌面服务共用后端可后续增加，需要独立授权入口。
这是对此前“浏览器可直接连接桌面后端”的首版范围收缩，必须确认。

### 1.3 不做

- 不重写 UI，不复制 Web 业务源码到 Desktop。
- 不创建第二套 Agent 协议或第二套会话格式。
- 不增加自动升级、托盘后台驻留、插件市场或云端多租户。
- 不把 Python、Docker、WSL 作为首版必装组件。
- 不保证任意第三方插件都可运行。
- Electron 页面沙箱不隔离 Agent 工具或已安装扩展。
- 安装用户包意味着允许该包按宿主权限执行代码，界面需明确提示。
- 不保证离线模型请求或离线在线装包。
- 不保证阻止旧版 Web、原生 Pi CLI 或外部编辑器访问同一目录。

最后一项是边界，不是漏洞修复完成声明。首版目录锁只约束接入该协议的后端。

## 2. 已核对的代码事实

| 事实 | 代码证据 | 对实施的影响 |
|---|---|---|
| Web 已有 Node 生产启动器 | `bin/pi-web.js` | 先复用生产产物，不强制改 standalone |
| 当前默认端口为 8888 | `bin/pi-web-options.js` | 桌面端使用独立、持久的端口配置 |
| Agent 注册表仅在进程内 | `lib/rpc-manager.ts` | Electron 单实例锁不能替代后端目录锁 |
| Web 已有项目信任判断 | `lib/project-trust.ts` | 复用语义，不另造信任数据库 |
| submarine 强制 projectTrusted=true | `../weclio-plugins/extensions/pi-submarine/src/runner.ts` | 修复 fresh、fork、resume 三条路径 |
| skill 开关修改 SKILL.md | `app/api/skills/route.ts` | 内置 skill 必须改用用户状态文件 |
| 多处各自创建资源服务 | rpc-manager、skills-service、models、plugins、submarine | 所有入口必须使用统一适配层 |
| 包管理器读取原始 global/project settings | SDK `dist/core/package-manager.js` 的 resolve | 只调用 applyOverrides({packages}) 无效 |
| reload 会重新读取 SettingsStorage | SDK `dist/core/settings-manager.js` | 内置包注入必须经受 reload |
| SDK 提供自定义存储接口 | SettingsManager.fromStorage、FileSettingsStorage | 先验证配置叠加适配器，不修改 SDK |
| CLI bin 是 JS 入口 | `../weclio-cli/bin/weclio.js` | 提供 Windows 命令启动器和固定 Node |
| CLI 发布范围小于仓库范围 | `../weclio-cli/package.json` 的 files | 以打包文件清单验收 |
| Web 已有 PowerShell 回退 | `lib/tool-presets.ts` | 不把 Bash 缺失直接当作应用失败 |
| file flush 不一定代表所有保存完成 | `lib/file-draft.ts` 的 flush | 退出必须等待真实保存状态 |
| npm 执行方式可配置 | SDK Settings.npmCommand | 使用内置 node + npm-cli.js |
| Windows smoke 已存在但有开发工具 | `.github/workflows/webpack-package-smoke.yml` | 不能代替无依赖环境测试 |

以上是规划时的本地事实。执行时若代码已变，先更新证据，不盲改。

## 3. 固定架构

### 3.1 仓库职责

```text
weclio/
  weclio-web/           UI、API、Agent、桌面适配入口
  weclio-plugins/       extensions、共享资源配置适配器
  weclio-cli/           CLI 与可发布 skills
  weclio-desktop/       Electron、运行包组装、安装、验收
```

共享适配器建议为 `@weclio/runtime-config`。
放在 `weclio-plugins/packages/runtime-config/`，不是第五个仓库。
它是普通 Node 库，不是新的 Pi extension。
它不依赖 Web 或 Electron，也不自动执行插件。
Web 与 submarine 显式依赖它；Pi SDK 使用 peerDependencies。
新增此包需 D04 批准。不要把这份逻辑复制到两个仓库。

### 3.2 最终安装目录

```text
resources/
  app.asar                         Electron 壳
  runtime/
    node/node.exe
    node/node_modules/npm/         npm 完整运行依赖
    git/                           经过验证的便携 Git
    bin/weclio.cmd                 PowerShell/cmd 入口
    bin/weclio                     Bash 入口，如发行包提供 Bash
    web/node_modules/              Web、插件、CLI、共享库及依赖
    builtin-manifest.json
    components.json                固定版本和构建摘要
    THIRD-PARTY-NOTICES.txt
```

`web/node_modules/@weclio/pi-web/` 内保留 `.next`、public、bin 和配置。
采用当前发布方式，不把 Electron 的 process.execPath 当成 Node。
服务由内置 `node.exe` 直接启动 Next CLI，避免多加一层 pi-web 启动器。
服务 cwd 固定为 Web 包根目录。
不从开发仓库或用户全局 node_modules 回退查找依赖。

### 3.3 数据与权限

- Agent 数据位置使用 SDK `getAgentDir()`；保留现有目录行为。
- 默认工作区保留 `~/.weclio/default-workspace`。
- 新增 `${agentDir}/weclio-builtin-state.json`，存内置资源选择。
- Desktop 偏好与日志放 Electron userData，不放安装目录。
- CLI 缓存保留 `WECLIO_CACHE_DIR` / 现有平台默认路径。
- 系统 PATH、用户全局 npm、用户 Pi settings 不写入安装路径。
- 允许项目内安装的包进入项目目录，但必须通过现有项目信任。
- 不把安装目录加入通用文件写入白名单。

### 3.4 版本与产物

`weclio-desktop/runtime-lock.json` 锁定每个组件的版本、来源与摘要。
不能出现 latest、分支名或未记录的本地路径。
若包尚未发布，使用经批准的不可变 CI artifact 或私有制品。
每个产物都要记录源 commit 与 SHA-256。
不要为了获取产物擅自 npm publish。

观察到的版本只作基线：Web 0.1.9、CLI 0.3.0、Pi SDK 1.0.2。
本计划不要求把修复后的包伪装成这些旧版本。
修复产物必须使用新的版本或明确的内部构建标识。

## 4. 两份固定数据契约

以下字段是拟新增契约，不是已经存在的接口。
修改字段前必须同步生产者、消费者和契约测试。

### 4.1 内置资源清单

```ts
interface BuiltinManifest {
  schemaVersion: 1;
  packages: Array<{
    name: string;
    version: string;
    relativeRoot: string;
  }>;
}
interface BuiltinState {
  schemaVersion: 1;
  disabledPackages: string[];
  skillOverrides: Record<string, {
    disableModelInvocation: boolean;
  }>;
}
```

规则：

- 包根目录相对 manifest 所在目录解析。
- 拒绝绝对 relativeRoot、路径逃逸和符号链接逃逸。
- 名称与版本必须匹配实际 package.json。
- 同一 name 在 manifest 内只能出现一次。
- resource id 使用 `packageName:packageRelativePath`，统一 `/`。
- 状态不记录绝对安装路径，升级换目录后仍有效。
- `disableModelInvocation` 保持当前语义，不等于删除整个 skill。
- 状态文件缺失代表默认启用；损坏必须报告，不静默恢复默认。
- 写入采用串行 read-modify-write 与同目录临时文件替换。
- manifest 必需包缺失时拒绝进入可对话状态，显示包名与错误。
- manifest 路径由可信启动环境传入，不从项目 settings 或 HTTP 获取。

建议环境名：`WECLIO_BUILTIN_MANIFEST`。
未设置时，独立 Web 与原生插件行为保持兼容，不凭空扫描相邻仓库。

### 4.2 Desktop 到 Web 的启动契约

非秘密配置：`WECLIO_DESKTOP=1`、manifest 路径、固定监听地址和端口。
秘密配置：每次启动生成的实例 token，仅经父子 IPC 发送。
不得放进命令行、URL、localStorage、日志或长期配置。

建议控制消息：

```ts
type BootstrapMessage = {
  type: "weclio:init";
  protocolVersion: 1;
  instanceId: string;
  apiToken: string;
};
type BootstrapReply = {
  type: "weclio:initialized";
  protocolVersion: 1;
  instanceId: string;
};
```

控制通道只接收预定消息。校验类型、版本和状态。
Web 初始化成功前不接受业务请求。
健康检查返回 protocolVersion、instanceId、组件版本和 ready。
健康检查不返回凭据、token、用户路径或完整环境变量。

退出使用受实例认证保护的控制接口；不得接受任意命令或任意 PID。
禁止为方便调试新增无认证 shutdown 接口。

## 5. 执行任务

依赖顺序：T00 → T01 → T02 → T03 → T04 → T05 → T06 → T07 → T08 → T09 → T10 → T11 → T12。
首轮串行执行。不要安排多个模型同时改资源加载或退出状态机。

### T00 — 固定批准、环境与基线

**文件**：本计划；新增 `docs/windows-desktop-validation.md`。

动作：

1. 向用户确认 D01–D08，逐项记录结果。
2. 记录每个仓库的 HEAD、工作区状态和 Node 版本。
3. 记录现有测试失败，不修改测试来清空基线。
4. 确认 Windows 版本、架构和隔离测试环境。
5. 列出拟新增依赖的精确版本与用途。
6. 对批准后的版本核对官方支持范围。
7. 选择无开发工具的 Windows Sandbox 或虚拟机。

**通过条件**：批准表完整；无未解释的架构分歧。
**停止条件**：依赖未批准、缺少包来源权限或无法确定 Windows 支持范围。

### T01 — 先证明 SDK 配置适配可行

**仓库**：weclio-plugins。
**新增**：`packages/runtime-config/`、契约测试。
**修改**：根 package.json 的 workspaces；锁文件。

先使用临时目录和测试 Pi packages。不得读取真实用户配置。

动作：

1. 包装 SDK `FileSettingsStorage`，实现 `SettingsStorage.withLock`。
2. 读取 global 配置时，在内存中合并内置本地 package 声明。
3. 写回 global 配置时，剥离合成条目，保留真实用户字段。
4. 项目 scope 继续使用 SDK 授权机制。
5. 让 `SettingsManager.fromStorage` 使用该适配器。
6. 使用真实 `DefaultPackageManager.resolve` 验证资源发现。
7. 使用真实 `DefaultResourceLoader.reload` 连续验证两次。

适配器必须区分“只读回调返回 undefined”和“写入回调返回字符串”。
不能把只读操作变成写盘操作。
不能依靠修改私有字段、monkey patch 或 applyOverrides({packages})。
内置状态每次 reload 重读；不得永久缓存第一次选择。
SDK 的存储锁内保留原始配置，写回不得误删用户原有条目。
Desktop 的 npmCommand 也通过该存储适配器作临时叠加。
它固定为内置 node.exe 与 npm-cli.js，不写入用户 settings。
写回时恢复用户原有 npmCommand；reload 后仍使用桌面临时值。
独立 Web 未配置 Desktop 运行环境时，保留用户 npmCommand。

**必测**：

- 全局原始 settings 内容在只读加载前后字节一致。
- 修改模型默认值后，值可保存；合成包路径不落盘。
- 用户包安装、更新、删除不丢失配置。
- 内置包在 reload 后仍可发现。
- 不加载未信任项目 package。
- 同名 npm、本地和已安装 git 包在执行前检测冲突。
- 不能确定身份的冲突不能静默继续加载。

**通过条件**：真实 SDK 的发现、加载、重载、写回测试全部通过。
**停止条件**：SDK 公共接口无法保持上述行为。报告最小复现，不扩大为 SDK fork。

### T02 — 实现清单、状态与冲突规则

**仓库**：weclio-plugins。
**新增建议文件**：

- `packages/runtime-config/src/manifest.ts`
- `packages/runtime-config/src/state.ts`
- `packages/runtime-config/src/settings.ts`
- `packages/runtime-config/src/resources.ts`
- `packages/runtime-config/src/index.ts`

导出明确的创建函数，不导出全局可变 SettingsManager。
函数输入至少包含 cwd、agentDir 和已有 loader options。
内部组合已有 options，不覆盖调用方的 prompt 或 skillsOverride。
先执行共享 skill 状态转换，再执行调用方 profile 选择。

固定冲突规则：

- 内置包启用时，同名用户包不加载，返回诊断。
- 用户显式禁用内置包后，可使用同名用户包。
- 不因 `update all` 改写内置包目录。
- 资源冲突在扩展工厂执行前解决。
- 不用 extensionsOverride 事后删除已执行的恶意扩展。

**必测**：

- manifest 相对路径、中文路径、空格路径。
- 路径逃逸、符号链接逃逸、版本不符。
- 禁用后重启；启用后重载；损坏状态文件。
- 升级更换安装目录，启停选择不变。
- 内置 skill 禁止模型调用时，文件内容与摘要不变。
- 全局与项目设置保持原来的优先级，内置同名规则除外。

**通过条件**：所有正反例均有行为测试。

### T03 — 修复 submarine 信任与资源继承

**文件**：

- `extensions/pi-submarine/src/runner.ts`
- `extensions/pi-submarine/src/index.ts`，仅在需要调整自注册时修改。
- `extensions/pi-submarine/package.json`
- `extensions/pi-submarine/test/runner.test.ts`
- 新增 `extensions/pi-submarine/test/trust-resources.test.ts`

动作：

1. 移除无条件 projectTrusted=true。
2. 使用 SDK 信任存储检查目标 effectiveCwd。
3. 对 fresh、fork、resume 使用同一共享配置入口。
4. 在资源 reload 时传入真实信任解析结果。
5. 对具名项目 agent 文件也应用目标目录的信任规则。
6. 保留 user agents 和已信任项目资源行为。
7. 保留 profile 的 skills=none 与指定 skills 选择。
8. 验证 submarine 自注册与预置包只注册一次。

不要自动批准项目。不要向 trust store 写入 true。
不要假定父项目获信任就代表显式 cwd 的目标项目获信任。

**必测**：

- 未信任项目扩展的 marker 文件不会生成。
- 显式 cwd 指向另一未信任项目时，也不执行其扩展。
- 授权后正常加载；撤销授权后，新建或恢复子会话不再加载。
- fresh、fork、resume 均可读取内置 resources。
- skills=none 不因预置路径而重新启用 skills。
- 注册 subagent 工具次数恰为一次。

**通过条件**：真实 SDK marker 测试和既有 submarine 测试通过。

### T04 — 接入所有 Web 资源入口

**修改文件**：

- `lib/rpc-manager.ts`
- `lib/skills-service.ts`
- `app/api/models/route.ts`
- `app/api/plugins/route.ts`
- `app/api/skills/route.ts`
- `lib/api-types.ts`
- `components/PluginsConfig.tsx`
- `components/SkillsConfig.tsx`
- `lib/i18n/messages/zh-CN.ts`、`en.ts`
- `package.json` 和锁文件。

新增 `lib/builtin-resources.ts` 作为 Web 薄适配器。
不要在各 route 内重新实现 manifest 解析。

动作：

1. 将主 Agent、模型列表、skills、plugins 接入共享入口。
2. 给内置资源添加 origin=builtin 和稳定 resource id。
3. 展示内置版本、启用状态和冲突诊断。
4. 禁止内置包的更新、移除操作；后端必须同步拒绝。
5. 将内置 skill 开关写入 BuiltinState。
6. 保留普通用户 skill 的现有写入路径与授权。
7. 状态变更前检查运行任务；忙时返回 409。
8. 变更后清理相关空闲 wrapper，失效模型和资源缓存。
9. 明确提示下一次运行使用新状态，不对忙会话热替换。

**必测**：

- 主 Agent、模型列表、插件页面、skills 页面看到同一内置集合。
- 内置资源开关不调用 SKILL.md 的 writeFileSync。
- 直接 HTTP 请求 update/remove 内置包同样失败。
- `update all` 只更新用户包。
- 空闲 reload 生效；忙时变更被拒绝且状态未写入。
- 未配置 manifest 时，原 Web 行为不回归。
- 不扩大文件 API 的可写根目录。

**通过条件**：相关单测、类型检查、lint 通过。

### T05 — 创建 Desktop 骨架与构建输入

**仓库**：获批后新建相邻 `weclio-desktop`，不创建远程仓库。

建议结构：

```text
src/main.ts
src/preload.ts
src/backend.ts
src/close-controller.ts
src/security.ts
scripts/assemble-runtime.mjs
scripts/verify-runtime.mjs
scripts/smoke-runtime.mjs
runtime-package/package.json
runtime-package/package-lock.json
runtime-lock.json
electron-builder.yml
tests/
docs/validation.md
AGENTS.md
COMMANDS.md
```

动作：

1. 添加获批的精确版本依赖和锁文件。
2. 定义 check、test、assemble、verify-runtime、pack:win、dist:win 脚本。
3. 默认开发模式连接 Web 开发服务，不复制业务源码。
4. 生产模式只读取安装资源目录。
5. 禁止生产模式回退连接已有 8888 服务。
6. 忽略组装产物、安装包、日志和私有配置。
7. 在 COMMANDS.md 写明脚本前置条件与输出路径。

**通过条件**：本地 check/test 可执行；生产路径单测证明不访问相邻仓库。

### T06 — 组装完整 Windows 运行包

**文件**：Desktop scripts、runtime-package、runtime-lock。
**Web 构建**：只在批准的隔离检出目录或 CI 执行。

动作：

1. 校验每个输入产物摘要和版本。
2. 在 Windows x64 安装锁定的生产依赖。
3. 获取固定版本 Node 分发包及完整 npm。
4. 获取固定版本便携 Git，验证其运行依赖。
5. 安装所有 Pi 包的非 host runtime dependencies。
6. 生成 manifest 和 components.json。
7. 生成 CLI 启动器，引用内置 Node 的绝对解析路径。
8. 生成第三方组件清单与许可证文件。
9. 从最终目录启动 Web，不使用开发目录。

运行环境规则：

- npm 调用使用 node.exe + npm-cli.js，不直接 execFile(npm.cmd)。
- 运行包中只保留一套兼容的 Pi host；检查 npm peer 自动安装结果。
- 不让共享库或插件嵌入第二份 Pi host，避免重复注册表。
- runNpx 使用同一 Node 分发包中的 npx-cli.js。
- npm 缓存、prefix 和临时目录必须可写且位于用户目录。
- 子进程 PATH 前缀为应用 bin、内置 Node、Git。
- 合并 Windows Path/PATH 时只保留一个大小写不敏感键。
- 不覆盖用户的整个环境；不向子进程传实例认证秘密。
- 对安装包自带的每个原生模块使用 Windows x64 产物。
- 不从 Linux node_modules 直接复制原生二进制。
- 不用删生产依赖的方式缩小体积，除非有产物测试证明安全。

**必测**：

- 将开发机 Node/Git/npm 路径从测试 PATH 移除。
- 测试 node、npm、git、weclio --help。
- 测试真实 Agent 的 PowerShell 或 Bash 调用 CLI。
- 测试固定可控的本地包安装、移除与两个版本之间的更新。
- 用获批网络环境测试 npm 源和 git 源安装。
- 测试 citation、web-search 注册、submarine、会话导出和 skills 文件。
- 检查启动与帮助命令不触发在线补依赖。

**通过条件**：运行包不依赖系统开发工具。
**停止条件**：缺少可分发文件、许可证材料或兼容原生产物。

### T07 — 接入后端启动与认证

**Web 修改**：`instrumentation.ts`、`proxy.ts`、`lib/request-security.ts`。
**Web 新增建议**：`lib/desktop-runtime.ts`、`app/api/desktop/health/route.ts`。
**Desktop 修改**：backend.ts、security.ts。

先做生产启动契约实验，再写窗口代码。

动作：

1. 用内置 Node 直接 spawn Next CLI，并建立 IPC。
2. 在 instrumentation 的 Node runtime 中等待可信启动消息。
3. 让 SDK 加载发生在初始化之后。
4. 使用 globalThis 保存当前进程的初始化状态。
5. 监听 127.0.0.1，不监听 0.0.0.0。
6. 检查带认证的 health 响应后，才加载窗口。
7. 失败时结束自己启动的进程，不连接未知端口上的服务。

端口策略：首版使用持久配置，建议默认 18888。
端口被占用时显示错误，不静默换端口。
这样避免默认随机端口导致 localStorage 偏好换 origin。
后续若改自动端口，必须同时实现偏好迁移，不只改启动器。

认证策略：

- Web 保留现有 Host/Origin 检查。
- Desktop 模式下所有 /api 请求再校验实例 token。
- 通过 Electron 专用 session 为可信应用请求注入请求头。
- 只匹配当前精确 origin，不匹配任意 localhost 端口。
- 校验发起 frame/initiator；不能为不可信 iframe 请求注入凭据。
- token 不暴露给 renderer，不使用通配 Cookie 注入方案。
- 对重定向到外域的请求移除认证头。
- Node 控制请求由 main 直接携带 token。
- 登录 callback 如由 provider 独立监听，保持其原有 state 校验。
- 不通过关闭 webSecurity 或跨域校验修复 OAuth。

**必测**：

- 无 token、错误 token、上一实例 token 均失败。
- 来自非应用 origin 的请求失败。
- iframe、外链、外域重定向拿不到 token。
- SSE、文件预览、文件下载和 OAuth 流程仍工作。
- IPC 未初始化时业务请求失败，不降级为普通 Web 模式。
- Web 单独运行时不要求 Desktop token。
- 真实 production proxy 与 route 能读取同一认证状态。

**停止条件**：Next 启动产生无法共享该状态的额外进程。
不得假设 globalThis 可以跨进程共享；提交实验报告并调整边界。

### T08 — 实现后端目录互斥

**新增建议**：Web `lib/backend-ownership.ts` 和跨进程测试。
**接入**：`instrumentation.ts`，位于业务 ready 之前。

目录标识：agentDir 创建后取 realpath；Windows 统一大小写。
若配置了共享 sessionDir，也要将其纳入互斥资源集合。
对多个资源按稳定顺序获取，失败时释放已获取的资源。

Windows 建议用目录标识摘要命名的本地 named pipe 持有权。
先在选定 Node 版本验证两进程抢占、崩溃释放和重启行为。
不要仅用 `existsSync(lock)`，不要用固定端口代替目录锁。
不接受对方 PID 就执行 kill，不把 pipe 开放为任意命令通道。

动作：

1. 在真正提供 API 的后端进程中获取互斥权。
2. 同进程重复初始化复用已有持有权。
3. 后端退出时释放；进程崩溃后允许下一次启动。
4. 同一目录冲突时返回明确错误。
5. Desktop 单独使用 Electron 单实例锁聚焦旧窗口。
6. 对 Next dev/HMR 验证不会重复获取或绕过锁。
7. 对保留支持的平台实现并测试等价互斥，不能破坏独立 Web。

**必测**：

- 两个不同端口、相同目录：仅一个 backend ready。
- 同一目录不同大小写、junction 路径：仍视为同一目录。
- 不同 agentDir、同一 sessionDir：不能同时进入 ready。
- 不同且独立目录：均可启动。
- 持锁后端被终止后，可再次启动。
- 首个启动失败时释放持有权。

**通过条件**：使用真实子进程验证，不只 mock 文件系统。
**边界**：旧版 Web 与原生 Pi CLI 不受此协议控制，文档必须说明。

### T09 — 实现关闭协议与任务清理

**Web 文件**：`lib/rpc-manager.ts`、`lib/file-draft.ts`、`components/AppShell.tsx`。
**Web 新增**：`app/api/desktop/shutdown/route.ts`、桌面 bridge 类型。
**Desktop 文件**：close-controller.ts、preload.ts、backend.ts。

关闭状态固定为：

```text
open -> confirming -> saving -> stopping -> closed
confirming -> open：用户取消
saving -> open：保存失败或输入法尚未提交
stopping -> force-confirmation：清理超时
```

动作：

1. 主进程拦截 close，禁止立即销毁窗口。
2. 向主 frame 请求关闭状态，不向 iframe 请求。
3. 汇总运行任务、启动中任务和未保存草稿。
4. 用户取消时，不保存退出、不停止任务。
5. 用户确认时，冻结新的发送与编辑动作。
6. 等待草稿真正保存完成，再发关闭请求。
7. 后端进入 draining 后拒绝新任务启动。
8. 等待启动中的 wrapper 完成或取消。
9. 关闭所有主会话及其子 Agent。
10. 清理完成后，结束服务进程和窗口。

必须增加可等待的 FileDraftCoordinator 保存屏障。
现有 flush 遇到 inFlight 或 composing 会提前返回。
flush 捕获写入错误后也不会自动抛出。
因此禁止用 `await Promise.all(flush(...))` 当作保存完成证明。
必须检查最终状态；写入失败时恢复界面并显示错误。

清理规则：

- 使用已有 wrapper.shutdown，不复制一套 dispose 逻辑。
- shutdown 期间收拢启动锁，防止新 wrapper 在清理后出现。
- 请求超时不自动判定成功。
- 正常关闭超时后，要求用户明确确认强制退出。
- 强制退出只能终止本实例启动的后端及其子进程。
- 验证主进程崩溃时后端是否收到了 IPC disconnect。
- 验证工具孙进程的回收，不能只检查 Node 主进程。
- 若 taskkill/IPC 方案不能回收残留进程，停止放行。
- 此时提交 Windows Job Object 方案与依赖审批，不自行引入原生模块。
- 不承诺断电或强杀时未保存编辑内容可以恢复。

**必测**：

- 双击关闭只出现一个确认流程。
- 用户取消后任务继续。
- 保存正在执行时不会提前退出。
- 保存失败或 IME composing 时不会静默丢内容。
- shutdown 与新任务启动竞争时，不产生漏清理 wrapper。
- 主 Agent、submarine、Shell 孙进程均退出。
- 后端 crash 时显示错误；不无限自动重启任务。

### T10 — 加固窗口、预览与权限

**Desktop 文件**：main.ts、preload.ts、security.ts。
**Web 文件**：仅增加必要 bridge 适配，不重写 UI。

动作：

1. 设置 nodeIntegration=false、contextIsolation=true、sandbox=true。
2. preload 只暴露关闭握手所需的窄接口。
3. 校验每个 IPC 的 sender、主 frame 和精确 origin。
4. 拒绝任意文件路径、任意 URL 或任意命令 IPC。
5. 拦截外部导航和新窗口。
6. 只允许审核过的 http/https 外链进入系统浏览器。
7. 区分 OAuth 外链与站内导出/预览。
8. 下载使用专用 session 的下载处理与保存位置选择。
9. 默认拒绝未声明的设备权限。
10. 保持 HTML iframe 原有隔离，不暴露 preload 给预览内容。

**必测**：

- 外部网页或 HTML 预览不能调用关闭以外的桌面权限。
- javascript、file、未知协议不能打开任意程序或本地文件。
- 站内预览、PDF、HTML 导出、复制和下载不回归。
- OAuth 使用系统浏览器后仍能完成登录。
- 下载文件名和目标路径由安全保存流程确定。

### T11 — 创建安装包与内部发行流程

**文件**：electron-builder.yml、Windows CI、docs/validation.md。

动作：

1. 使用 NSIS x64，按用户一键安装。
2. Electron 壳使用 ASAR；运行包使用 extraResources。
3. 固定 appId 和产品身份，避免覆盖升级变成第二个应用。
4. 安装后启动，不执行 npm install 或在线下载运行依赖。
5. 升级前要求关闭应用，不覆盖运行中的 Node 文件。
6. 用户数据不放安装目录，卸载默认保留。
7. 产出安装包、摘要、components.json 和已知限制。
8. 说明内部包的签名状态，不承诺绕过 Windows 安全提示。
9. CI 从不可变输入构建，不使用 `../` 仓库路径。
10. 内部发行必须显式触发，不自动公开发布。

运行目录按只读验收。
若 Next 缓存尝试写安装目录，记录准确写入路径。
优先禁用本项目不需要的缓存或配置用户缓存位置。
不得把整个安装目录改成通用可写工作区。

**必测**：安装、重复安装、覆盖升级、卸载、重装。
**通过条件**：普通用户可安装和运行；数据按约定保留。

### T12 — 干净环境放行

使用 Windows Sandbox 或独立虚拟机。
系统不安装 Node、npm、Git；不挂载宿主用户配置。
不要在真实开发机卸载这些工具来模拟干净机器。
不把清空 PATH 等同于完成干净环境测试。

按第 7 节逐项执行，并附可复核证据。
任何 P0 场景失败，停止内部发行。
网络或模型额度不足时标记 BLOCKED，不标记 PASS。

## 6. 执行命令与测试入口

以下分清已有命令与拟新增命令。
执行模型必须在报告中记录工作目录、命令、退出码。

### 6.1 已有 Web 命令

```bash
node_modules/.bin/tsc --noEmit
npm run lint
node --test lib/project-trust.test.mjs lib/rpc-manager-startup.test.mjs lib/rpc-manager-shutdown.test.mjs lib/request-security.test.mjs lib/file-draft.test.mjs
```

新增测试沿用 `.test.mjs`、node:test 和当前 jiti 导入方式。
运行每项新增测试，并重跑被修改边界的既有测试。
某条测试路径不存在时停止核对，不 silently skip。
不要在当前 Web 工作目录执行 `npm run build`。
生产构建只在批准的隔离目录或 CI 执行 `npm run build`。

### 6.2 已有 Plugins 命令

在 weclio-plugins 执行：

```bash
npm run check
npm run test:citations:pi
npm run pack:all
```

新共享 workspace 必须提供 typecheck/test，纳入根 check。
发布前阅读该仓库 `.github/workflows/publish.yml`。
若现有 workflow 只接受 extensions/*，不得伪造 packages/* tag。
先设计内部 artifact 获取或明确修改发布 workflow，再申请发布授权。

### 6.3 已有 CLI 命令

只有 CLI 发生修改时执行：

```bash
npm run typecheck
npm run lint
npm run test:unit
npm run test:contract
```

读取 CLI CONSTITUTION.md 后再修改。
组装时也必须检查实际 tgz 文件清单，不能只检查源目录。

### 6.4 Desktop 拟新增脚本

T05 实现这些脚本后才能运行，不能声称现在已有：

```bash
npm run check
npm test
npm run assemble
npm run verify-runtime
npm run pack:win
npm run dist:win
```

pack:win 生成解包运行目录；dist:win 才生成安装器。
先测试解包目录，再测试安装器，不倒过来。
对 Electron UI 自动化先读本项目 agent-browser skill。
若需新增自动化测试依赖，返回 D04 审批。

## 7. 放行矩阵

P0 全部通过才可内部试用。P1 不通过时记录限制并由用户接受。

| ID | 等级 | 场景 | 必须观察到的结果 |
|---|---|---|---|
| A01 | P0 | 无系统 Node/npm/Git，首次安装 | UI、API、Agent 服务正常启动 |
| A02 | P0 | 安装后断网启动 | 不下载运行依赖；网络功能报告错误 |
| A03 | P0 | 中文用户目录、含空格安装路径 | CLI、插件、导出正常 |
| A04 | P0 | 未信任项目 + submarine fresh/fork/resume | 项目扩展不执行 |
| A05 | P0 | 父项目已信任，目标 cwd 未信任 | 不继承父项目信任 |
| A06 | P0 | 切换内置 package/skill 状态 | 安装文件摘要不变；重启后状态保留 |
| A07 | P0 | 安装、更新、移除用户包 | 正常工作；内置包不被修改 |
| A08 | P0 | 用户包与内置包同名 | 只执行明确选中的版本 |
| A09 | P0 | Agent 调用 weclio --help | 使用内置 Node 和 CLI，退出码为 0 |
| A10 | P0 | 实际支持模型上的 web-search/citations | 工具与引用链路工作；缺账号则 BLOCKED |
| A11 | P0 | 子 Agent 使用内置资源 | fresh/fork/resume 均通过，工具不重复注册 |
| A12 | P0 | SSE、取消、重连、导出与下载 | 行为与 Web 基线一致 |
| A13 | P0 | 无 token、错误 token、跨站请求 | API 拒绝，凭据不泄露 |
| A14 | P0 | HTML iframe 请求 API/IPC | 无特权升级，无法获取实例 token |
| A15 | P0 | 同目录不同端口启动两个后端 | 只有一个成功；另一个显示冲突 |
| A16 | P0 | 关闭时取消确认 | 原任务继续，窗口保留 |
| A17 | P0 | 关闭时正在保存/保存失败/IME 输入 | 不提前退出，不静默丢弃编辑 |
| A18 | P0 | 确认关闭、强制关闭、主进程崩溃 | 已启动的受管进程无残留；无静默任务重放 |
| A19 | P0 | OAuth 登录与回调 | 系统浏览器完成流程；不放宽跨域保护 |
| A20 | P0 | 旧版覆盖升级、卸载重装 | 会话、配置、用户包按约定保留 |
| A21 | P0 | 独立 Web，未设置 Desktop 环境 | 原有启动、资源和权限行为不回归 |
| A22 | P1 | 环境代理与系统代理差异 | 模型、CLI、装包、登录分别记录结果 |
| A23 | P1 | 安装目录只读、磁盘不足 | 不静默损坏状态；显示可处理的错误 |
| A24 | P1 | 休眠唤醒、断网重连 | SSE 与运行状态恢复或明确报错 |

不得用一张 UI 截图代替整张矩阵。
SDK marker 测试、进程检查、文件摘要、退出码各自保留。
日志、截图和测试产物不得包含真实 API key 或完整会话内容。

## 8. 每个任务的交接模板

```text
任务：Txx
状态：完成 / 阻塞
基线：各仓库 HEAD；保留的用户修改
修改文件：逐项列出
实现结果：最多 5 条
测试命令：工作目录 + 原始命令 + 退出码
行为证据：测试名、日志或 artifact 路径
未验证项：明确列出；没有则写“无”
新增风险：明确列出；没有则写“无”
下一步：仅给出下一个任务编号
```

最终交接必须附固定组件清单、P0 矩阵、安装包摘要和已知限制。
“预计可以运行”不是最终交接结论。

## 9. 官方资料与使用边界

下列链接供执行时核对。版本选择仍需 T00 批准。
本计划不依赖未确认的“最新版”版本号。

- Electron Security：IPC 来源校验、隔离、导航和权限。
- Electron IPC：窄接口，不直接暴露 ipcRenderer。
- Electron ASAR：运行目录与子进程资源必须考虑归档限制。
- Electron WebRequest：限定认证头的目标和请求来源。
- Electron app：单实例窗口行为。
- Node net：Windows named pipe 行为；须在固定版本实测。
- electron-builder NSIS：oneClick、perMachine 和安装配置。

```text
https://www.electronjs.org/docs/latest/tutorial/security/
https://www.electronjs.org/docs/latest/tutorial/ipc
https://www.electronjs.org/docs/latest/tutorial/asar-archives
https://www.electronjs.org/docs/latest/api/web-request
https://www.electronjs.org/docs/latest/api/app
https://nodejs.org/api/net.html
https://www.electron.build/docs/nsis/
```

Pi 的准确接口以仓库已安装版本为准：

- `node_modules/@earendil-works/pi-coding-agent/docs/sdk.md`
- `node_modules/@earendil-works/pi-coding-agent/docs/packages.md`
- `dist/core/settings-manager.d.ts` 与 `.js`
- `dist/core/package-manager.d.ts` 与 `.js`
- `dist/core/resource-loader.d.ts` 与 `.js`

执行前阅读有关资源类型的完整 docs 与 SDK 示例。
不要根据其他 Pi 版本的示例猜当前接口。
