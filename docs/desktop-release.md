# 桌面正式更新发布

## 当前架构与验收边界

桌面只有**一条更新通道**：完整 NSIS 安装包（EXE）及其 blockmap，由
`electron-updater` 后台下载，准备完成后由用户明确点击「重启更新」安装并重开。
不再独立发布／安装业务 ZIP 或 npm 包，不按壳摘要选择发布类型，不维护需提交的壳基线。
npm 仍可独立发布 Web/CLI 分发，但不参与桌面更新。

运行时保持 Electron + Next + 用户系统 Node.js 22.19+/npm；Git for Windows（含 Git Bash）
由用户自行安装。rg/fd 继续随安装器分发并复用安装目录外的内容寻址工具缓存；源码映射、
Next 部署追踪文件等打包裁剪保留。安装说明见 `desktop-install.md`。

- 客户端直接读取 Ed25519 签名的 `desktop-update-manifest.json`。
- 不保留旧版兼容索引、运行时索引协调器或业务包选择指针。
- 下载在后台进行，旧版下载期间可用；安装前保留托管任务检查／锁与正常关窗否决。
  普通退出不自动安装；忙任务没有强制终止选项。
- 差异下载沿用 `electron-updater` EXE/blockmap 路径，失败可回退全量。
  **真实 Windows VM 成功差异传输尚未验证**；有 blockmap 不等于验证成功。
- **不承诺点击后 ≤30 秒完成，不承诺健康确认或安装后自动回滚。** 下载差分不意味着
  NSIS 免安装／免解压。历史后端切换原型的秒数不能证明当前安装版重启性能。

`desktop-update-performance.md`、`desktop-update-stage1.md` 与
`desktop-update-stage2.md` 保留历史实测，不是现行发布流程。本次文档／源码调整不表示
已有本地产物、安装版或公开 release 已更新或删除；以对应产物的实际来源和验收记录为准。

## 密钥与信任配置

- `resources/desktop-update.json` 只包含正式更新地址、公钥与缓存目录名，可随代码提交。
- 默认私钥：`~/.weclio/release-keys/desktop-update.ed25519.pem`，位于仓库外。
- 可用 `WECLIO_DESKTOP_SIGNING_KEY` 指定仓库外的绝对路径。
- **单独安全备份私钥并限制访问。** 丢失后不能重新生成密钥来修复已有客户端；不要上传
  私钥、含私钥的备份或环境文件。

一次性初始化／检查：

```powershell
npm run setup:desktop-updates
```

命令可重复执行，不覆盖已有密钥或信任配置。配置已存在但私钥缺失、类型错误或不匹配时
停止；新电脑／新 checkout 应恢复原私钥，不要删公钥配置来重新初始化。

**Ed25519 是更新元数据的应用级签名，不是 Windows Authenticode。当前未提供
Authenticode 签名，Windows 发布者／安全提示不会因此消失。**

## 安装版端口

安装版在用户数据目录的 `desktop-port.json` 保存显式端口，NSIS 重开无需依赖临时环境变量。
优先级为 `WECLIO_DESKTOP_URL` → `PORT` → 已保存端口 → 8888；只接受裸
`http://127.0.0.1:<port>`。开发版不读写此文件；配置损坏或端口占用时明确失败，不接管
或停止其他服务。独立 Chromium profile 的启动参数也须由重开所用快捷方式保留。

## 生成发布产物

仅在获准构建后执行；本流程本身不授权构建、安装或发布：

```powershell
npm version patch --no-git-tag-version
# 检查并提交本版本源码、package.json 与 package-lock.json，记录目标 commit。
npm run release:desktop
```

唯一发布命令会预检版本与签名配置，运行 Electron 测试，在 `build/desktop/server/`
隔离构建 Next，再打包 NSIS 并生成签名元数据，不污染开发 `.next/`。
`--quick` 仅在版本、输入与服务产物均匹配已有记录时复用服务构建，仍会打包安装器。
不再有 `release:desktop:app`、业务包发布、壳摘要发布类型门禁或基线提交步骤。

保留源码／生产服务／桌面模块／工具／信任配置的构建前后指纹检查，防止构建中途变化；
这不是壳更新类型门禁。构建生成 `build/desktop/toolset.json`，随安装器放为
`resources/desktop-toolset.json`，不作为单独用户附件。Git 不在工具种子中。

输出目录 `build/desktop/dist/` 中本次应核对的文件：

| 文件 | 用途 |
| --- | --- |
| `Weclio-<版本>-x64-Setup.exe` | 完整 NSIS 安装包 |
| `Weclio-<版本>-x64-Setup.exe.blockmap` | 配对差异下载侧文件 |
| `desktop-update-manifest.json` | 客户端直接读取的 Ed25519 签名清单，绑定 EXE URL、版本、大小、SHA512 与安装意图 |
| `SHA256SUMS.txt` | EXE、blockmap 与更新清单摘要 |

签名元数据必须与本次实际 EXE／blockmap 对应。不要把旧业务 ZIP／清单当本次输出。
脚本验证新输出后保留本次文件；**不保证 dist 为空，也不会据此声称旧产物已清理。**

安装器与 updater 共用 `@wecliopi-web-updater` 缓存名，使 NSIS 留存的 `installer.exe`
可用于后续差异下载；缓存缺失时回退全量正常。旧正式 EXE/blockmap 应保留且不覆盖。

`release:desktop` 显式使用 `--publish never`：**不提交、不打标签、不上传、不安装、不设 Latest**。

## 上传准备与受控升级验收

**当前不授权公开上传或切换 Latest。** 以下仅为获得单独明确批准后的草稿上传模板。
先确认工作区、构建记录、版本与已提交源码一致；`--target` 必须是实际产物对应的 commit，
不能在旧产物生成后再随意把 HEAD 当作来源。版本修复后递增，禁止覆盖公开附件。

```powershell
$version = node -p "require('./package.json').version"
$tag = "desktop-v$version"
$commit = git rev-parse HEAD # 仅在已核实与本次产物来源一致时使用

gh release create $tag --draft --target $commit `
  --title "Weclio desktop $version" --notes "Desktop app update." `
  "build/desktop/dist/Weclio-$version-x64-Setup.exe" `
  "build/desktop/dist/Weclio-$version-x64-Setup.exe.blockmap" `
  "build/desktop/dist/desktop-update-manifest.json" `
  "build/desktop/dist/SHA256SUMS.txt"
```

逐一核对四个附件、签名、摘要、版本与来源。**永远不要上传 dist 通配符**：可能残留旧 ZIP、
旧 EXE、Node 安装器或其他产物。不要 `--clobber`；测试预发布不能标为 Latest，也不能给
合成测试 EXE 设置正式安装意图。桌面标签使用 `desktop-v*`，不用会触发 npm workflow 的 `v*`。
正式 feed 使用 Latest 路径，因此公开并切换 Latest 是影响已安装客户端的独立发布动作，
必须另获明确批准；本页不执行也不暗示已完成该动作。

验收必须用真实安装版 A→B，而非源码启动窗口；确认后台下载、旧版仍可用、显式重启、
任务门禁、自动重开、版本与用户数据保留。记录实际差分／全量传输证据和点击到可交互耗时，
在用户 Windows VM 上验证，不拿历史同版本后端计时替代。忙任务、关窗否决与失败分支也须
明确区分自动化证据和安装版证据；不要宣称健康自动回滚。
