# Desktop update performance: implementation checkpoint

> **Historical record — not the current update design.** The business-ZIP channel,
> shell-digest release-kind gate, runtime release-index coordinator, trial-health
> rollback and ≤30-second target below are superseded. Desktop now has one
> EXE/blockmap update via a signed manifest, with no legacy compatibility index.
> Git Bash is user-installed; only rg/fd remain
> bundled/cached, and source-map trimming remains. Successful real Windows VM
> differential download is still unvalidated; no ≤30-second or health rollback
> guarantee applies. See `desktop-release.md` for current guidance. Measurements
> and artifact references below are preserved as history, not evidence that old
> artifacts were rebuilt, replaced or deleted.

## Scope and acceptance boundary

Keep Next and the external system Node/npm requirement. Do not migrate to Vite or
Electron's embedded Node in this work. Public desktop B 0.1.12 remains unchanged.

The target is **at most 30 seconds from the explicit restart-update click to a usable
new desktop**, for a fully prepared ordinary application update and an idle task
gate. Downloads, preparation and user decision time are outside that window, but
preparation progress must be visible and the old version must remain usable.
Electron/main/preload/startup-protocol changes may still require NSIS maintenance.
The target has **not yet passed full desktop or VM acceptance**.

## Implemented foundations (not yet released)

- `electron/package-files.mjs` filters known JS/TS/CSS source-map files while
  retaining declarations, licenses, native/WASM files, skills and arbitrary map
  resources. Directories ending in a source-map suffix are preserved.
- The desktop resource mapping omits Next deployment `.nft.json` metadata,
  build traces and JS source maps. Existing production traces included two
  approximately 98 MB path inventories, including developer-machine paths;
  these are not application runtime files. Source builds retain deployment
  traces for analysis; installers no longer copy them.
- `electron/toolsets.mjs` generates content-addressed tool manifests and prepares
  verified Git/Bash/rg/fd outside the installation directory. A completed toolset
  is reused; startup does not query Git releases or recopy the tree. Only the
  receipt and four required binary hashes/types are checked on reuse, not the
  entire directory tree. Tool maintenance remains separate and explicit.
- The preferred store is `%LOCALAPPDATA%/Weclio/toolsets`; custom installations
  overlapping that location use `%LOCALAPPDATA%/Weclio-toolsets`. Both candidates
  are canonicalized and must be outside the actual installation. Explicit store
  roots remain strict. No junction is placed inside the installed application.
- Production startup uses the independent tools, checks the port before lengthy
  preparation, and exposes throttled first-preparation progress on the startup
  page. Existing packages without a tool descriptor retain legacy behavior.
- Build/release fingerprints include the new build helpers; quick releases
  regenerate the descriptor for the actual bundled tool files and guard it
  during packaging.

**The bootstrap NSIS installer still contains the tool source.** Ordinary
server/application packages excluding Git and a new production update channel
are not implemented yet. Existing NSIS updates still perform a full installation;
these foundations alone must not be released as a completed fast-update fix.
First migration from existing A/B will need a bridge installation and may be slow.

## Isolated runtime validation

Used the existing installed B production files, not a new build. The filtered
candidate was outside the repository. A Node resolution hook rejected fallback
to repository/global packages; HOME, APPDATA, LOCALAPPDATA, agent state and CWD
were isolated and model credentials were not inherited.

| Measurement | Observed result |
| --- | --- |
| Server payload before filtering | 768,109,668 bytes |
| Server payload after filtering | 425,632,895 bytes / 28,690 files |
| Payload reduction | 342,476,773 bytes, about 342 MB |
| First tool migration | 30.62 s |
| Tool cache reuse | 0.159 s |
| Fresh isolated backend HTML/API readiness | 8.76 s |
| Warm isolated backend HTML/API readiness | 3.63 s |
| Revalidation after extra typed-map pruning | 3.76 s |

Fresh offline initialization loaded four extensions and five skills and ran the
CLI help command. The first harness run failed at a CJS `require.resolve` of an
ESM-only SDK; its receipt was retained. The harness was corrected to import the
actual ESM entry, then fresh-profile/resource checks and backend startup passed.
These measurements are backend readiness, not interactive Electron acceptance.

Evidence: ignored `build/desktop/update-acceptance/lean-server-initial-result.json`
and `lean-server-verified.json`.

## Unpublished prepared-switch prototype

The prototype reused the verified independent toolset's existing `zipinfo.exe`
and `unzip.exe`, plus the cached build-time 7za. No dependency was added. It
created a local ZIP, used a temporary in-memory Ed25519 key, checked signature,
archive/member/layout hashes and types, and extracted to a fresh isolated slot.
No formal release key was read and no installer or public feed was used.

| Measurement | Observed result |
| --- | --- |
| ZIP payload | 129,311,481 bytes |
| Extracted payload | 425,632,895 bytes / 28,690 files |
| ZIP creation (publisher-side) | 779.27 s |
| Background extraction | 176.68 s |
| Extracted-tree verification | 122.29 s |
| Old-service availability during preparation | 2,414 probes, zero failures |
| Owned server port release | 0.52 s |
| Isolated pointer rename | 0.0013 s |
| Stop to first HTML HTTP 200 | 4.43 s |
| Stop to HTML and sessions API HTTP 200 | 4.45 s |

The prepared resources contained server plus toolset descriptor, **no Git tree**.
The old tree was retained. Owned processes exited and the test port was released;
existing development 8888 and fixture 8899 remained untouched.

Both slots contained identical **0.1.12** application bytes. This proves a timing
route for background preparation and a short backend switch, **not** a semantic
version upgrade, Electron relaunch, user-data migration or production-ready
hostile-archive handling. It is one local run, not a VM/slow-disk/antivirus
percentile guarantee. Preparation is still minutes of disk work; it is moved out
of the outage, not eliminated.

Evidence: ignored
`build/desktop/update-acceptance/prepared-switch-2026-11-08T12-49-10.785Z-45987644/`
(`summary.json`, `result.json`, helper sources and logs).

## Implemented fast-update channel (not yet released)

- **Signed server-only application packages.** `application-manifest.mjs` defines a
  separate Ed25519-signed format binding application version, shell *content*
  (digest) and toolset id, with bounded archive/layout metadata; the legacy EXE
  verifier is unchanged. Compatibility deliberately ignores the shell version
  string: a business release bumps the app version while the shell digest stays
  the same, and any electron/startup/tool change changes the digest so the
  package is rejected until a shell release. Business packages never carry Git.
- **Background preparation.** `application-updates.mjs` downloads the signed
  layout and ZIP with bounded size, redirect and timeout rules, verifies both by
  SHA512, then calls `application-store.mjs` to inspect the ZIP listing with the
  already shared `zipinfo.exe`/`unzip.exe`, extract into isolated staging, and
  verify every file hash/size/count before publishing a version directory and
  receipt. Progress is reported as download → extracting → verifying and the
  restart action stays hidden until preparation is fully verified.
- **Explicit switch with automatic recovery.** Clicking **Restart to update**
  (single click; no second dialog) locks the task gate, re-verifies the prepared
  version, closes the window normally, stops the owned Next process and waits for
  it to exit, commits a per-profile selection pointer, then relaunches. Startup
  treats a committed version as a trial: the renderer acknowledges health via
  `applicationReady()`; a failed start or missing acknowledgement rolls back to
  the previous program on the next launch. Selection pointers are per profile;
  prepared version trees and toolset stay shared per user.
- **Coordinator and single index.** `release-index.mjs` defines one signed
  document declaring whether this release carries a shell installer, a business
  package, or both. `update-coordinator.mjs` refreshes the index before each
  check, skips channels the index does not advertise, checks the shell channel
  first, and pins any ready result so late events cannot overwrite it. An index
  404 means no update; a failed refresh surfaces an error instead of reusing
  stale URLs. `initializeUpdates` returns this coordinator; installs without a
  shell descriptor keep the legacy-only service.

## Remaining work

1. Real different-version acceptance: build a shell, install it, publish one
   business package, verify background preparation while the old version stays
   usable, then measure click → usable including Electron relaunch. Only then can
   the ≤30 s target be claimed. The current prototype measured the backend switch
   only.
2. VM acceptance by the user, with visible preparation progress and timings.
3. Publishing is computed, not chosen: `npm run release:desktop` (shell) and
   `npm run release:desktop:app` (business) both sign one
   `desktop-release-index.json`, refuse the wrong kind by comparing the shell
   digest with `electron/desktop-shell-baseline.json`, and never upload. Clients
   read only the index from Latest, which can point at manifests on older
   release tags.
4. Data migration compatibility and post-acknowledgement corruption recovery are
   still only partially covered: rollback applies to the trial window.

Validation for the foundation patch: 195 Electron tests, 193 passed and two
file-symlink privilege skips; affected-file ESLint and independent read-only
review passed. A custom-install store-overlap defect found in review was fixed.

Validation for the channel increment: 327 Electron tests (325 passed, two
file-symlink privilege skips), component tests, TypeScript and ESLint passed;
an independent read-only review found three integration defects (shell maintenance
suppressed by a version override, duplicate launch rolling back a healthy trial,
commit ordering before server exit) plus a duplicated toolset resolution, all
fixed and covered. No production build, NSIS installer, business package or
release was generated, and public 0.1.12 is unchanged.
