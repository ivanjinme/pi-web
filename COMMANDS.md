# Commands

Run from the repository root. Use project-local binaries only.

## Development

```bash
npm run dev
node_modules/.bin/tsc --noEmit
npm run lint
```

Never run `next build` during development; it pollutes `.next/`.

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
