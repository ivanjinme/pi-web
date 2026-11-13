# Commands

Repo root · Bash / Git Bash · stop on failure.

## Development

```bash
npm run dev
npm run dev:web
```

## Checks

```bash
node --test electron/*.test.mjs
node_modules/.bin/tsc --noEmit
npm run lint
```

## Publish Web UI (npm)

Committed source · clean worktree · `v*` triggers npm workflow.

```bash
set -e
npm version patch --no-git-tag-version
VERSION=$(node -p "require('./package.json').version")
git add package.json package-lock.json
git commit -m "Release v$VERSION"
git tag "v$VERSION"
git push origin main "v$VERSION"
```

## Publish Desktop

Windows x64 · committed source · clean worktree · signing configured · `gh` authenticated.

```bash
set -e
npm version patch --no-git-tag-version
VERSION=$(node -p "require('./package.json').version")
TAG="desktop-v$VERSION"
git add package.json package-lock.json
git commit -m "Release desktop $VERSION"
COMMIT=$(git rev-parse HEAD)
npm run release:desktop
(cd build/desktop/dist && sha256sum -c SHA256SUMS.txt)
git push origin main

gh release create "$TAG" --repo ivanjinme/weclio --draft --target "$COMMIT" \
  --title "Weclio desktop $VERSION" --notes "Desktop app update." \
  "build/desktop/dist/Weclio-$VERSION-x64-Setup.exe" \
  "build/desktop/dist/Weclio-$VERSION-x64-Setup.exe.blockmap" \
  "build/desktop/dist/desktop-update-manifest.json" \
  "build/desktop/dist/SHA256SUMS.txt"

# Verify draft assets, signature, version, source before publishing
gh release edit "$TAG" --repo ivanjinme/weclio --draft=false --latest
```

No `next build` in dev directory. No `npm run release`. No asset wildcards / `--clobber`.
