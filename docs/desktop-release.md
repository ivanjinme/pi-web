# 桌面正式更新发布

npm 与桌面 0.1.12 均已发布；桌面为正式 Latest。真实安装版 0.1.11 → 0.1.12 的下载、明确确认、NSIS 升级、自动重开与抽样数据保留已验证。成功差异下载尚未验证；证据与限制见 `desktop-update-stage2.md` 和 `desktop-update-handoff.md`。
桌面发布与 npm 发布分开，使用 `desktop-v<版本>` 标签，不使用会触发 npm workflow 的 `v*` 标签。

## 密钥与信任配置

- 仓库中的 `resources/desktop-update.json` 只包含正式更新地址、公钥和缓存目录名，可随代码提交并打包。
- 默认私钥：`~/.weclio/release-keys/desktop-update.ed25519.pem`，位于仓库外。
- 如需指定已有私钥，设置 `WECLIO_DESKTOP_SIGNING_KEY` 为仓库外的绝对路径。
- **请单独安全备份私钥并限制访问。丢失后不能通过重新生成密钥修复已安装客户端。** 不要把私钥、包含私钥的备份或环境文件上传到 GitHub。

一次性初始化／检查：

```powershell
npm run setup:desktop-updates
```

该命令可重复执行，不会覆盖已有密钥或信任配置。已有配置但私钥缺失、类型错误或不匹配时会停止，要求恢复备份，不会静默换钥。更换电脑或全新 checkout 应恢复原私钥，而不是删除公钥配置重新初始化。

清单使用免费的 Ed25519 应用级签名；这不是 Windows Authenticode 签名，不会消除 Windows 发布者／安全提示。

## 安装版端口

安装版在用户数据目录的 `desktop-port.json` 保存显式指定的端口，升级后由 NSIS 重开时可在没有启动环境变量的情况下恢复。优先级为 `WECLIO_DESKTOP_URL` → `PORT` → 已保存端口 → 8888；仍只接受裸 `http://127.0.0.1:<port>`。开发版不读写此文件。配置损坏或端口被占用时明确失败，不自动接管或停止其他服务。

与开发服务并行验收时，为安装版选择空闲端口；不要假设 NSIS 会继承临时环境变量。若使用独立 Chromium profile，还须保证安装器使用的启动快捷方式保留相同 profile 参数。

## 生成发布产物

先确定代码与依赖已稳定、版本为正式版，再执行：

```powershell
npm version patch --no-git-tag-version
npm run release:desktop
# 仅生产服务输入完全没变时，可以复用服务构建：
npm run release:desktop -- --quick
```

脚本会预检版本、私钥与公钥，运行 Electron 测试，在 `build/desktop/server/` 构建服务并生成 NSIS 安装包，不改开发 `.next/`。`--quick` 只省略未变化的服务构建，**仍会打包安装器**；版本或依赖变更通常需要完整构建。

输出到 `build/desktop/dist/`：

| 文件 | 用途 |
| --- | --- |
| `Weclio-<版本>-x64-Setup.exe` | 完整安装包 |
| 同名 `.exe.blockmap` | 差异下载侧文件，必须与本次 EXE 配套 |
| `desktop-update-manifest.json` | Ed25519 签名清单，包含正式版本、`installable: true`、EXE 地址／大小／SHA512 |
| `SHA256SUMS.txt` | 上述三个文件的 SHA256 |

清单中的安装包地址固定指向该版本的 `desktop-v<版本>` release。客户端通过正式 Latest release 获取清单，验证后下载。旧正式版 EXE/blockmap 应保留且不覆盖；缺少旧 blockmap 时客户端可回退全量下载。

脚本先验证本次新输出再替换 dist，保留 EXE 和 blockmap，最后更新签名清单。构建／打包前后检查源码、生产服务、桌面模块、公钥配置、内置 Git/工具和 Node 版本辅助脚本是否改变。验证失败时不要上传残留产物。

安装器与客户端使用同一个缓存目录 `@wecliopi-web-updater`，使 NSIS 保留的 `installer.exe` 可用于后续差异下载。首次迁移或缺少旧缓存时回退全量是正常情况。

`release:desktop` 显式使用 `--publish never`：**不提交、不打标签、不上传、不安装**。

## 手动上传与受控升级验收

以下命令仅在明确批准后执行。必须确认源代码已提交到所指 commit、产物与该源码一致，并按既定验收范围推进。

首次引入更新能力、已确认没有其他受影响客户端时，可以明确批准先公开真实 B，再由安装版 A 完成正式 feed 的受控升级验收；本次 0.1.12 采用此路径，没有先手动安装 B。打包或上传成功不能替代升级验收。此后的公开发布可能已有客户端，不能沿用“未分发”的历史结论。

```powershell
$version = node -p "require('./package.json').version"
$tag = "desktop-v$version"
$commit = git rev-parse HEAD

gh release create $tag --draft --target $commit `
  --title "Weclio desktop $version" --notes "Desktop app update." `
  "build/desktop/dist/Weclio-$version-x64-Setup.exe" `
  "build/desktop/dist/Weclio-$version-x64-Setup.exe.blockmap" `
  "build/desktop/dist/desktop-update-manifest.json" `
  "build/desktop/dist/SHA256SUMS.txt"

# 检查草稿中的四个附件和哈希后，才正式公开并切换 Latest：
gh release edit $tag --draft=false --latest
```

不要上传整个 dist 通配符：目录可能还含旧包、ZIP 或 Node 安装器。不要用 `--clobber` 替换已公开版本的附件；修复后递增版本并创建新 release。测试预发布不能标为 Latest，也不能带正式安装意图或使用正式私钥签署虚构安装包。

源代码启动的客户端不能代替安装版更新闭环。旧版不带 updater 的用户仍需手动安装一次；本次已验证安装版 A→B 的核心闭环，但未证明成功差异传输、所有忙任务／失败分支或自动回滚。后续真实版本可继续观察差异下载，不必为此立即额外打包。
