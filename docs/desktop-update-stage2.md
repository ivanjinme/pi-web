# Desktop update: stage 2 implementation

## Scope

The production installation handoff now uses standard
`electron-updater.quitAndInstall(true, true)`: silent NSIS installation and
relaunch. No custom installer, Windows locking helper, HTTP update endpoint,
lease protocol, signing certificate dependency, or rollback system was added.

This is implemented and automatically tested, **not packaged-install acceptance**.
No package was built, uploaded, or installed during this stage.

## Click / exit sequence

1. Only a packaged app with a downloaded, explicitly installable signed update
   can enter installation. Development remains a download-only preview.
2. Inspect all application-managed tasks on click. Busy means a localized warning
   and no confirmation/installation; there is no force-stop option or polling.
3. Ask the user to save changes and confirm restart. Cancellation does not lock
   tasks or stop services.
4. Atomically recheck and lock new task admissions. A task started during the
   confirmation blocks this attempt. Recheck the downloaded SHA512 and size.
5. Ask the existing window to close normally. A `beforeunload` veto or prevented
   close cancels the update and unlocks tasks without stopping the server.
6. Only after the actual `closed` event, hand off to standard
   `quitAndInstall(true, true)`. Suppress ordinary `window-all-closed` auto-quit
   during this handoff. Normal app exit never auto-installs.
7. Stop the owned server and dispose updater/IPC only on `will-quit`, not
   `before-quit`. A launch error received before final exit cancels the updater's
   scheduled quit while recovery unlocks tasks and recreates the window. Reset
   the pinned upstream updater's retry latch so the next explicit attempt works.

The standard updater's native process-launch / installer behavior is retained.
This does not promise recovery after the application has already exited, prevent
all same-user malicious filesystem changes, or roll back a failed installation.

## Task boundary

`electron/production.mjs` gives only the owned production Next child an IPC
channel. Production instrumentation installs one synchronous handler before
serving requests. Messages are `inspect`, `lock`, and `unlock`; replies are
correlated by id and time out after five seconds. Lock and cancellation travel
on the same ordered channel, so a timed-out lock is followed by unlock instead
of a new HTTP cancellation/expiry protocol. Disconnect releases the gate.

Reservations cover session startup, extension binding, pending RPC mutations,
prompt execution through its async tail, manual compaction, shell commands, and
background title generation. Runtime flags and queued messages also block
admission. Read/abort/UI-response controls remain available. This covers the
application's managed work, not arbitrary detached extension processes.

## Signed installation intent

The signed payload must contain **boolean `installable: true`** to authorize
production installation, alongside the stable version and EXE SHA512/size/URL.
The flag is inside the Ed25519-signed payload, never a renderer argument.
Absent, false, or string values mean download-only.

Existing local and GitHub smoke manifests omit the flag, so those synthetic
versions/plaintext `.exe` fixtures cannot enter installation even if loaded in
a packaged context. Never add the flag to test fixtures or copy their trust
config into a production package. Production public configuration is now set up
separately in `resources/desktop-update.json`; its private key stays outside the
repository. The release script now generates signed installable metadata and
retains the paired blockmap. See `desktop-release.md` for setup, backup and manual
publication. No production package or stable release has been generated or
published as part of that integration.

## Validation

- 174 related tests passed in the combined Electron/UI/RPC/gate suite; the separate
  real child-IPC integration test also passed (175 total, no skips).
- TypeScript and project ESLint passed.
- Tests call real upstream `BaseUpdater.install` / `quitAndInstall` against fake
  launch and app boundaries, including scheduled quit after failure and retry.
  No real installer is launched.
- Real Electron blank-window QA passed: `beforeunload` veto preserves the window;
  clearing the veto then closing resolves only after destruction. No updater or
  installer was loaded. Local result/logs: ignored
  `build/desktop/update-validation/close-approval-result.json`.
- A regression test covers the native `webContents` getter becoming inaccessible
  after window destruction; cleanup uses a previously captured reference.

Remaining acceptance: a fresh packaged app, genuine signed release metadata,
actual NSIS upgrade/relaunch, and production differential-download artifacts.
