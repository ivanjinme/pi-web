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

Release kind is computed, never chosen by hand. Both commands sign one
`desktop-release-index.json` and refuse to run when the shell digest moved the
wrong way.

```bash
npm run setup:desktop-updates    # once; signing key lives outside the repo
npm run release:desktop          # shell: Electron, main/preload, startup, tools, trust config
npm run release:desktop:app      # business package: application code only
```

Upload the printed artifacts to `desktop-v<version>` and make it Latest; the index
is the only document clients read. `release:desktop` also rewrites
`electron/desktop-shell-baseline.json` — commit it with that release. Never
`--clobber` a public release; bump the version instead.

```bash
v=$(node -p "require('./package.json').version")
gh release create "desktop-v$v" --draft --target HEAD --title "Weclio desktop $v" \
  --notes "Desktop app update." build/desktop/dist/*
gh release edit "desktop-v$v" --draft=false --latest
```

Details: `docs/desktop-release.md`.

## Publish npm

```bash
npm version patch --no-git-tag-version
VERSION=$(node -p "require('./package.json').version")
git add package.json package-lock.json && git commit -m "Release v$VERSION"
git tag "v$VERSION" && git push origin main "v$VERSION"
```

Tag `v*` triggers `.github/workflows/publish.yml`. Never run `npm run release`.
Desktop tags are `desktop-v*`, never `v*`.
