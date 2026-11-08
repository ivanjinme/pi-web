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

## Windows desktop

Once: install Portable Git (with Bash), rg, fd in `resources/runtime/win-x64/`; create the
signing key outside the repo with `npm run setup:desktop-updates`. Back it up.

Shell installer — Electron, main/preload, startup protocol, tools, or any first migration:

```bash
npm version 0.1.13 --no-git-tag-version   # stable; shared with npm
npm run release:desktop                   # tests, Next build, NSIS, signed manifest
npm run release:desktop -- --quick        # version-only change; reuses the Next build
```

Output `build/desktop/dist/`: EXE, `.blockmap`, `desktop-update-manifest.json`,
`SHA256SUMS.txt`. Build also generates `toolset.json`/`shell.json`, bundled as
`resources/desktop-toolset.json`/`desktop-shell.json`. Never commits, tags, uploads
or installs. Ed25519 signs the manifest; the EXE is not Authenticode-signed.

Business package — ordinary feature update, no Git, requires the deployed shell:

```bash
npm run build:desktop
node electron/application-release.mjs --server "%CD%\build\desktop\server" \
  --output "%CD%\build\desktop\dist" \
  --zip "%LOCALAPPDATA%\electron-builder\Cache\7zip@1.0.0\7zip-win-x64-a34pt\bin\7za.exe"
```

Valid only while the shell digest and toolset are unchanged (`--shell` selects the
deployed descriptor; default is this build's). Anything else is a shell release.
Local only; no upload.

Users need Node 22.19+ with npm. Python/Pandoc/Office are not bundled.

## Publish

npm — tag `v*` triggers `.github/workflows/publish.yml` (webpack build). Never run
`npm run release` for this flow:

```bash
npm version patch --no-git-tag-version
VERSION=$(node -p "require('./package.json').version")
git add package.json package-lock.json && git commit -m "Release v$VERSION"
git tag "v$VERSION" && git push origin main "v$VERSION"
```

Desktop — tag `desktop-v<version>`, never `v*`. After `release:desktop`, recompute
SHA256 with `Get-FileHash -Algorithm SHA256` and compare `SHA256SUMS.txt`, then
`gh release create --draft` → attach → `gh release edit --latest`. Latest drives both
EXE and business-package discovery; a business release carries no EXE, so keep the
shell installer in its notes. Never `--clobber` a public release — bump the version.
npm publishing is unrelated to desktop updates. Full procedure: `docs/desktop-release.md`.
