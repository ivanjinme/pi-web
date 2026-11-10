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

One desktop release command builds the complete installer update; there is no
independent business ZIP/npm update, shell-digest release-kind gate or shell
baseline to commit.

```bash
npm run setup:desktop-updates    # once; signing key lives outside the repo
npm run release:desktop          # tests, isolated Next build, NSIS, signed metadata
```

Clients read the signed `desktop-update-manifest.json` directly. No legacy
index or compatibility adapter is generated.

The command uses `--publish never`: no commit, tag, upload, install or Latest
change. Public upload/Latest changes require explicit approval. Before any upload,
ensure the build matches the committed source/target commit. Upload only the
explicit current-version EXE, paired blockmap, signed manifest and
`SHA256SUMS.txt` listed in `docs/desktop-release.md`. Never use a dist
wildcard: old ZIPs/installers may remain. Never `--clobber` public assets; bump the
version instead. Ed25519 metadata signing is not Windows Authenticode signing.

Details and controlled validation limits: `docs/desktop-release.md`.

## Publish npm (web/CLI distribution, not desktop updating)

```bash
npm version patch --no-git-tag-version
VERSION=$(node -p "require('./package.json').version")
git add package.json package-lock.json && git commit -m "Release v$VERSION"
git tag "v$VERSION" && git push origin main "v$VERSION"
```

Tag `v*` triggers `.github/workflows/publish.yml`. Never run `npm run release`.
Desktop tags are `desktop-v*`, never `v*`.
