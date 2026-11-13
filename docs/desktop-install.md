# Weclio 桌面版安装说明

> 本文件是随安装包分发的那份 `readme.md` 的**唯一源头**（`build/desktop/dist/readme.md` 是副本，
> `/build` 被 gitignore，不要只改副本）。发布桌面安装包时核对并同步过去一起发给用户；修改本文件不会自动更新已有副本或安装包。

## 一、前置条件（按顺序装，缺一不可）

**1. Node.js 22.19 或更高**

- 安装 Node.js 22.19 或更高版本的 Windows x64 安装包，一路默认「下一步」。
- 验证：打开「命令提示符」输入 `node -v`，应显示 `v22.19.0` 或更高。
- 版本过低时应用会拒绝启动，需先升级 Node。

**2. Git for Windows（含 Git Bash）**

- 打开 https://git-scm.com/download/win ，下载 **64-bit Git for Windows Setup**。
- 安装时**全部默认选项**即可，默认路径 `C:\Program Files\Git`。
- **不需要手动改 PATH**：应用会自动到默认安装路径找 `Git\bin\bash.exe`。
- 验证：命令提示符输入 `git --version`，能显示版本号即可。

**3. Weclio 安装包**

- 双击本次收到的 `Weclio-<版本>-x64-Setup.exe`，安装到默认目录。
- 重复双击不会启动第二个实例；已在运行时只会把窗口唤到前面。

## 二、为什么需要 Node 和 Git

- **Node**：应用的服务端（Next）用系统 Node 运行，不内置。
- **Git**：文件改动标记与 diff、技能更新检查都依赖它；
  对话里的 `bash` 工具用的是 Git 自带的 Git Bash。
- 未安装 Git 时：相关 Git 功能可能不可用或报错，`bash` 不可用时可使用 PowerShell 工具。
  **这是环境缺前置，不是程序故障**——装上 Git 重启应用即可恢复。
- rg/fd 搜索工具由安装包提供并缓存复用，无需另装；它们不替代 Git Bash。

## 三、升级

- **所有桌面更新使用同一安装包通道**，没有独立业务 ZIP 或 npm 更新。
  后台下载期间旧版可继续使用；准备完成后点击「重启更新」，任务忙碌时会阻止安装。
  正常关闭应用不会自动安装更新。
- 更新使用 EXE/blockmap 差异下载，必要时回退全量；仍需安装并重开，**不保证几十秒完成**。
  真实 Windows VM 的成功差异传输尚未验证。
- 也可双击新版 `Setup.exe` 覆盖安装，无需先卸载。安装期间窗口会关闭，
  **请让它跑完**，不要提前结束进程；耗时受磁盘与安全软件影响。没有健康检测自动回滚保证。
- 更新清单有 Ed25519 签名，但安装包尚无 Windows Authenticode 发布者签名；
  Windows 可能仍显示发布者／安全提示。仅使用可信来源提供的安装包。

## 四、使用

1. 双击桌面快捷方式打开 app。
2. 选择模型：
   - 已有自购订阅 token plan → settings / model → add provider；
   - 没有购买任何 token → 联系 ivanjin@weclio.com 获取测试额度。

## 五、内置 skills

1. `tox-eval`：生成物质摘要。可直接说「使用 tox-eval skill，写抗氧剂 168 的摘要，
   目标人群成人，骨植入，终生暴露，ISO 10993-17 标准」；或在对话框输入 `/` 选择该 skill 再提要求。
2. `tra-md`：完整的医疗器械毒理学风险评估（TRA）。
3. `tra-md2word`：把 final 版报告转换为 Word。
4. `read-across`：生成 read-across 论据（仍在改进中）。
5. `docx`：修改编辑 Word。

## 六、出问题时

- 对 AI 说「本次会话的 trajectory trace file 在哪里？」，把该文件发给 ivanjin@weclio.com，
  并说明你的预期结果与实际结果。
- 其它问题：ivanjin@weclio.com