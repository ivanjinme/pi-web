# Desktop update: stage 2 implementation

## Scope

The production installation handoff now uses standard
`electron-updater.quitAndInstall(true, true)`: silent NSIS installation and
relaunch. No custom installer, Windows locking helper, HTTP update endpoint,
lease protocol, signing certificate dependency, or rollback system was added.

The original implementation stage used automated and blank-window tests only;
no package was built, uploaded, or installed during that stage. Subsequent
**0.1.11 → 0.1.12 packaged acceptance** is recorded below; its results must not
be conflated with the original test-only evidence.

## Click / exit sequence

1. Only a packaged app with a downloaded, explicitly installable signed update
   can enter installation. Development remains a download-only preview.
2. Inspect all application-managed tasks on click. Busy means a localized warning
   and no installation; there is no force-stop option or polling.
3. The explicit **Restart to update** button is the user's authorization. Do not
   show a redundant confirmation dialog. Disposal while inspection is pending
   cancels before acquiring a task lock.
4. Atomically recheck and lock new task admissions. A task started after the
   initial inspection blocks this attempt. Recheck the downloaded SHA512 and size.
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
publication. The original integration did not generate or publish a production
release; subsequent 0.1.12 publication is recorded below.

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

The fresh-package, genuine signed metadata and actual NSIS upgrade/relaunch
boundaries were subsequently exercised below. Successful differential transfer
remains unverified; published sidecars alone do not prove it.

## Packaged acceptance — 2026-11-07 UTC

This historical 0.1.11 → 0.1.12 run used a second native confirmation dialog.
Current source removes that fixed dialog; the explicit restart click remains
required, and task checks, artifact verification and normal-close vetoes remain.
The published 0.1.12 package has not been replaced.

- Baseline A was the installed **0.1.11**. Target B was **0.1.12**, built from
  commit `271a02ec2fcdad62fa911c17fe583301971603e1`. npm `v0.1.12` and desktop
  `desktop-v0.1.12` use that same source. The desktop release is public, stable
  and Latest; all four GitHub asset digests match local output, and the public
  Latest manifest verifies with the production Ed25519 public key.
- B's release script passed **167 Electron tests** and its production build /
  TypeScript check. The separate npm publication workflow succeeded. These are
  not an aggregate of the earlier suite counts.
- Real installed A fetched the signed production manifest and downloaded the
  **389,502,062-byte** B installer. Its SHA512 and size were independently
  checked. Normal window close with B ready did not install it: A remained
  0.1.11 and its owned server exited. Restarting A reused the verified cache.
  Cancelling the native update confirmation also left A usable.
- Explicit confirmation exercised the real production task gate and standard
  updater launch, with `--updated /S --force-run`. B was **not manually installed
  beforehand**. The installer automatically started a new B process at
  **19:47:04 UTC**, preserving the shortcut's independent profile argument.
  OS process evidence, app/service package version **0.1.12**, rendered native
  accessibility controls, and the new owned service on **8890** establish the
  automatic relaunch. The existing development service on 8888 was unaffected.
- All **407 pre-upgrade session IDs** remained present. Six sampled files
  (settings/configuration, a historical session, a test file and the remembered
  port) retained identical hashes. This is
  sampled integrity plus session membership, not exhaustive transcript-content
  validation. A browser localStorage marker also survived the upgrade, verified
  during the separately identified diagnostic restart below.
- **Diagnostic limitation:** the CDP observer could not reconnect after automatic
  relaunch, so `upgrade-observation-result.json` remains a timeout / false result. Automatic
  relaunch was established independently before any manual B launch. Only then
  was B normally closed and reopened at the same version for CDP inspection of
  the retained browser marker, same-version idle updater state and screenshot.
  That diagnostic launch must not be cited as the automatic-relaunch evidence.
- Differential download fell back to full download because A's unpublished old
  blockmap returned 404. Full fallback succeeded; **successful differential
  transfer was not verified**. B's paired blockmap is published and the current
  NSIS installer cache matches the published B EXE. Observe differential transfer
  during a future genuine release rather than creating another package solely
  for this check.
- Evidence is under ignored `build/desktop/update-acceptance/`, particularly
  `upgrade-core-verified.json`, `automatic-B-ui-ready.json`,
  `installed-B-version.json`, `data-before-B.json`, `data-after-B.json`,
  `B-manual-diagnostic-restart.json`, and publication receipts. The earlier
  failed/timeout diagnostics are retained. Independent read-only evidence review
  supports the qualified core acceptance conclusion.

Packaged busy-task races, beforeunload veto and installer-failure paths were not
all repeated in this run; their earlier automated/blank-window evidence remains
separate. No post-exit recovery or rollback guarantee has been added.
