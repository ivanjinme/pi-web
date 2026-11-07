# Desktop update: stage 1 (download only)

Stage-1 development/test sources remain download-only. Their button only displays
a native explanation; closing the app never installs a download. Stage-2
production handoff is documented separately in `desktop-update-stage2.md` and
requires explicit installation intent inside a trusted signed manifest.
Failures are logged and hidden; checking resumes after four hours. A verified
completed download stays ready for this app session.

## Local real-download validation (Windows x64)

Do not package/build again. Reuse `build/desktop/dist/Weclio-0.1.10-x64-Setup.exe`:

```powershell
npm run fixture:desktop-update
# In a second terminal, use the absolute config path printed above:
$env:WECLIO_UPDATE_CONFIG='D:\...\build\desktop\update-fixture\desktop-update.json'
npm run dev:desktop
```

Do not run another Next/dev server concurrently. The fixture hosts only loopback
port 8899, streams the existing installer with range support, signs its real size
and SHA512 with a fresh ephemeral Ed25519 key, and writes only a public-key config
to ignored `build/desktop/update-fixture/`. No upload or release takes place.
The fixture advertises **99.0.0**, NOT the embedded installer version **0.1.10**.
Never install this mismatched fixture. Missing blockmaps fall back to full download.

Observe checking → downloading → downloaded; the ready label is `新版本` /
`New version`. Clicking the button shows a localized native stage-1 explanation
without restarting. Close normally and confirm nothing installs.
Restarting the fixture changes its key: restart desktop to load the new config.
`npm run fixture:desktop-update -- --transport-test` uses a tiny **non-installer**
only for transport/hash smoke tests; it is not real-installer validation.

## Trust / packaging

Development requires an explicit absolute `WECLIO_UPDATE_CONFIG` JSON path.
Packaged apps ignore that environment variable and read only
`resources/desktop-update.json`. This file is copied from
`resources/desktop-update.json` at package time. Production public configuration
has since been set up; see `desktop-release.md`. Never ship the fixture config.

Config fields: `manifestUrl` (HTTPS), `publicKey` (PEM Ed25519 public key).
Only unpackaged config with `devFixture: true` permits HTTP literal loopback URLs.
The signed JSON envelope is `{payload: base64, signature: base64}`; signature is
Ed25519 over the exact decoded UTF-8 payload bytes. Payload is a stable
`version` and nonempty `files` array of absolute EXE `url`, base64 SHA512 `sha512`,
and positive integer `size`. URLs must end in lowercase `.exe` (matching updater's Windows cache
filename handling). No prereleases, legacy path, or webinstaller packages.
Manifest redirects are bounded and each target must pass the same URL policy;
GitHub release attachments may redirect to HTTPS object storage.
Do not add unsigned fields to provider results. Updater verifies actual artifact
hashes (including cached downloads); provenance is the signed manifest, not
Windows Authenticode. Production prefers differential downloads with full fallback.

The sandbox preload exposes three named operations only. Main-process IPC checks
the owning window, trusted app origin, and main frame. Browser-only mode has no API.
The updater resolves its production dependency from `resources/server/node_modules`
using `resources/server/package.json`; the normal desktop build already copies
production dependencies there, with no duplicate dependency tree inside ASAR.
Updater helpers resolve from the updater's own dependency context, not from
builder's development-only dependencies.

## Validation completed

- Real Electron development window, reusing the existing Next service: discovered
  signed fixture version `99.0.0`, downloaded the existing **386,133,243-byte** EXE,
  and independently verified its SHA512 and size against the signed payload.
- Sidebar initially displayed `重启更新` (subsequently renamed to `新版本` /
  `New version`); clicking it showed the native stage-1 explanation.
  Closing the isolated window exited normally without launching an installer.
- `node --test electron/*.test.mjs components/DesktopUpdateButton.test.mjs components/AppShell.test.mjs`:
  **91 passed**. Includes actual NSIS transport/digest/cache tests with tiny
  non-installer payloads, tamper rejection, size mismatch, version gating,
  cancellation, redirect policy, restricted IPC, and frontend states.
- `node_modules/.bin/tsc --noEmit` and `npm run lint`: passed.
- Local screenshot/logs: ignored `build/desktop/update-validation/`.

That local validation required no new desktop package, upload, or installation.
The original development app/server was left running; only that isolated test
window and fixture server were stopped.

### GitHub transport validation — 2026-11-06

With explicit upload authorization, created prerelease
`desktop-update-smoke-20261106t183257` in `ivanjinme/pi-web`. It is marked
**test-only**, not Latest, and uses a non-`v*` tag that does not match the npm
publication workflow. No application source or production update config was
published. The four uploaded assets total **1,613 bytes**:

- A unique **122-byte plaintext `.exe` fixture**, explicitly NOT an installer.
- A valid Ed25519-signed manifest advertising synthetic version `99.0.0`.
- A tampered-signature manifest.
- A signed manifest with a deliberately incorrect artifact SHA512.

Verified in real Electron, without rebuilding or stopping the existing Next server:

1. Manifest request followed an actual HTTPS 302 from `github.com` to
   `release-assets.githubusercontent.com`, then returned HTTP 200.
2. A separate development window fetched the valid signed metadata, made a fresh
   network download (unique asset absent from cache), verified SHA512 and signed
   size, and displayed `新版本` with state `downloaded`.
3. Independently verified the downloaded file's Ed25519-bound SHA512 and size.
4. Separate windowless Electron checks using temporary cache/profile directories
   rejected both negative cases: invalid signature returned `checking → idle`
   without a download; invalid hash returned `checking → downloading → idle`.
   Neither reached `downloaded`.
5. Installation remained hard-blocked throughout. No packaging or installation was
   performed. The successful GitHub test window was left open for inspection.

Local public-key configs, result JSON, logs and screenshot are under ignored
`build/desktop/github-update-smoke/`. No private key was saved. Test manifests and
plaintext artifacts must never be used for installation or production clients.
The GitHub prerelease/assets remain available for inspection; no automatic cleanup
or release deletion was performed.

**Unverified at the end of stage 1:** freshly packaged-app startup/dependency
assembly, installation/upgrade, and real differential updating with matching
blockmaps. The two stage-1 download checks alone do not prove that an installed
app can update itself. Subsequent real installed **0.1.11 → 0.1.12** core upgrade
acceptance is recorded in `desktop-update-stage2.md`; successful differential
transfer remains unverified.
