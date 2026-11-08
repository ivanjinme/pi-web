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

Never run `next build` during development; it pollutes `.next/`.

## Publish desktop

Electron, main/preload, startup protocol, tools, or first migration:

```bash
npm run setup:desktop-updates              # once; key lives outside the repo
npm version 0.1.13 --no-git-tag-version
npm run release:desktop
npm run release:desktop -- --quick         # version-only change

v=$(node -p "require('./package.json').version")
gh release create "desktop-v$v" --draft --target HEAD --title "Weclio desktop $v" \
  --notes "Desktop app update." \
  "build/desktop/dist/Weclio-$v-x64-Setup.exe" \
  "build/desktop/dist/Weclio-$v-x64-Setup.exe.blockmap" \
  "build/desktop/dist/desktop-update-manifest.json" \
  "build/desktop/dist/SHA256SUMS.txt"
gh release edit "desktop-v$v" --draft=false --latest
```

Feature-only change (shell digest and toolset unchanged):

```bash
npm run build:desktop
node electron/application-release.mjs --server "$PWD/build/desktop/server" \
  --output "$PWD/build/desktop/dist" \
  --zip "$LOCALAPPDATA/electron-builder/Cache/7zip@1.0.0/7zip-win-x64-a34pt/bin/7za.exe"

v=$(node -p "require('./package.json').version")
gh release create "desktop-v$v" --draft --target HEAD --title "Weclio desktop $v" \
  --notes "Desktop app update. Shell installer: previous release." \
  "build/desktop/dist/Weclio-$v-x64-Application.zip" \
  "build/desktop/dist/Weclio-$v-x64-Application.files.json" \
  "build/desktop/dist/desktop-application-manifest.json"
gh release edit "desktop-v$v" --draft=false --latest
```

Before `--latest`, compare `Get-FileHash -Algorithm SHA256` with `SHA256SUMS.txt`.
Never `--clobber` a public release; bump the version. Details: `docs/desktop-release.md`.

## Publish npm

```bash
npm version patch --no-git-tag-version
VERSION=$(node -p "require('./package.json').version")
git add package.json package-lock.json && git commit -m "Release v$VERSION"
git tag "v$VERSION" && git push origin main "v$VERSION"
```

Tag `v*` triggers `.github/workflows/publish.yml`. Never run `npm run release`.
Desktop tags are `desktop-v*`, never `v*`.