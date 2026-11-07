# Commands

Run from the repository root. Use project-local binaries only.

## Development

```bash
npm run dev          # Desktop :8888 (alias: dev:desktop)
npm run dev:web      # Web :8888
node --test electron/*.test.mjs
node_modules/.bin/tsc --noEmit
npm run lint
```

Desktop: `PORT` overrides 8888; requires a free port. Close window/Ctrl+C cleans up.
Desktop and Web development are alternatives: stop the existing server before switching.
One Next dev server per directory, regardless of port.

Never run `next build` during development; it pollutes `.next/`.

## Windows desktop package

```bash
npm run setup:desktop-updates               # Initialize/check external signing key + public config
npm version <version> --no-git-tag-version  # Shared Web/desktop stable version
npm run release:desktop                     # Test, build, EXE + blockmap + signed manifest + SHA256
npm run release:desktop -- --quick          # Reuse unchanged full build
```

打包前手动准备最新版 Portable Git（含 Bash）、rg、fd 至 `resources/runtime/win-x64/`；已有可用工具无需更新。
Windows x64; output `build/desktop/dist/`.
EXE 未做 Windows 代码签名；更新清单使用 Ed25519 签名。私钥必须备份到仓库外。
Manual install/upgrade/uninstall acceptance. No commit, tag or upload (`--publish never`).
Desktop release procedure: `docs/desktop-release.md`; use `desktop-v<version>` tags, not npm's `v*` tags.
Node 22.19+ with npm required on user machines; Python/Pandoc/Office not bundled.

## Publish

```bash
npm version patch --no-git-tag-version
VERSION=$(node -p "require('./package.json').version")
git add package.json package-lock.json
git commit -m "Release v$VERSION"
git tag "v$VERSION"
git push origin main "v$VERSION"
```

Source of truth: `.github/workflows/publish.yml`. Its `npm run build` uses webpack
(`next build --webpack`) so server externals remain publishable. Never run
`npm run release` for the normal publish flow.
