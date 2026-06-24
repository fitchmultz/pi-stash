# Changelog

All notable changes to this project will be documented in this file.

## Unreleased

## [0.1.21] - 2026-06-24

### Changed
- updated the local pi development baseline to `@earendil-works/pi-coding-agent` / `@earendil-works/pi-tui` `0.80.2` and refreshed the npm lockfile
- refreshed README compatibility notes for pi `0.80.2`
- added an isolated `pi install .` package-load smoke to the validation gate
- aligned the stash picker with Pi's positive `ctx.mode === "tui"` custom-UI guard and keybinding-aware picker hints

### Validation
- ran `npm run validate`; it now includes typecheck, transpiled tests, Node 22.19 tests, production audit, pack dry-run, and the package-load smoke

## [0.1.20] - 2026-06-23

### Changed
- updated the local pi development baseline to `@earendil-works/pi-coding-agent` / `@earendil-works/pi-tui` `0.80.1` and refreshed the npm lockfile
- refreshed README compatibility notes for pi `0.80.1`
- reviewed the Pi 0.80.0/0.80.1 changelog; no runtime source migration was required

### Validation
- release validation was deferred to the next package update.

## [0.1.19] - 2026-06-22

### Changed
- updated the local pi development baseline to `@earendil-works/pi-coding-agent` / `@earendil-works/pi-tui` `0.79.10` and refreshed the npm lockfile
- refreshed README compatibility notes for pi `0.79.10` and removed the obsolete fleet-tested marker

### Validation
- ran `npm run ci`, `npm run validate`, and an isolated Pi package-load smoke under pi `0.79.10`

## [0.1.18] - 2026-06-15

### Changed
- updated the local pi development baseline to `@earendil-works/pi-coding-agent` / `@earendil-works/pi-tui` `0.79.4` and refreshed the npm lockfile
- narrowed the release audit to production dependencies with `npm audit --omit=dev --audit-level=high`, because pi runtime packages are optional peer dependencies and are not shipped in the extension tarball

### Validation
- ran `npm run ci` and `npm run validate` under pi `0.79.4`

## [0.1.16] - 2026-06-04

### Fixed
- fixed interactive restore prompts in sessions where the extension context does not expose `ctx.mode`; the stash picker and restore flow now only use non-TUI fallbacks for explicit RPC, JSON, or print modes

## [0.1.15] - 2026-06-04

### Changed
- updated the local pi development baseline to `@earendil-works/pi-coding-agent` / `@earendil-works/pi-tui` `0.78.1` and regenerated the npm lockfile
- replaced the degraded-client picker workaround with the Pi `0.78.1` `ctx.mode` API so non-TUI clients use explicit fallback flows instead of inferring support from theme availability

### Compatibility
- reviewed the pi `0.78.1` changelog, extension docs, package guidance, keybinding docs, and current extension examples; the package still keeps pi runtime packages as optional wildcard peers and treats `0.78.1` as the tested baseline rather than a hard install requirement

## [0.1.14] - 2026-05-28

### Changed
- updated the local pi development baseline to `@earendil-works/pi-coding-agent` / `@earendil-works/pi-tui` `0.77.0` and regenerated the npm lockfile
- kept pi runtime packages as optional wildcard peers and removed the Node.js engine upper bound so future pi releases are not blocked at install time

### Compatibility
- reviewed the pi `0.77.0` changelog and package guidance; the extension still uses supported command, UI, and session-state APIs

## [0.1.13] - 2026-05-27

### Changed
- updated the local pi development baseline to `@earendil-works/pi-coding-agent` / `@earendil-works/pi-tui` `0.76.0` and regenerated the npm lockfile

### Compatibility
- reviewed the pi `0.76.0` changelog and package guidance; the extension still uses supported command, UI, and session-state APIs

## [0.1.12] - 2026-05-23

### Changed
- updated the local pi development baseline to `@earendil-works/pi-coding-agent` / `@earendil-works/pi-tui` `0.75.5`, refreshed Node tooling, and regenerated the npm lockfile

### Compatibility
- reviewed the pi `0.75.5` changelog and package guidance; the extension still uses supported command, UI, and session-state APIs

## [0.1.11] - 2026-05-18

### Changed
- updated the local pi development baseline to `@earendil-works/pi-coding-agent` / `@earendil-works/pi-tui` `0.75.3` and refreshed the npm lockfile
- raised the Node.js tooling floor to `>=22.19.0` and renamed the compatibility check from `test:node20` to `test:node22`
- removed legacy Ralph task metadata and ignored local `.cueloop/` runtime state

### Compatibility
- reviewed current pi `0.75.3` package and extension guidance and confirmed the extension still uses supported command, UI, and session-state APIs


## [0.1.10] - 2026-05-07

### Changed
- migrated the local pi development baseline and peer metadata from deprecated `@mariozechner/*` packages to maintained `@earendil-works/*` `0.74.0`
- regenerated the npm lockfile against the current stable dependency graph

### Compatibility
- reviewed the pi `0.74.0` changelog and confirmed the extension still uses supported command, UI, and session-state APIs

## [0.1.9] - 2026-05-01

### Changed
- updated the local pi development baseline to `@mariozechner/pi-coding-agent` / `@mariozechner/pi-tui` `0.72.0`
- regenerated the npm lockfile against the current stable dependency graph
- aligned pi core peer metadata with current pi package guidance

### Compatibility
- reviewed the pi `0.72.0` changelog and confirmed the extension still uses supported command, UI, and session-state APIs without relying on provider thinking metadata


## [0.1.8] - 2026-05-01

### Changed
- updated the local pi development baseline to `@mariozechner/pi-coding-agent` / `@mariozechner/pi-tui` `0.71.1`
- regenerated the npm lockfile against the current stable dependency graph

### Compatibility
- reviewed the pi `0.71.1` changelog and confirmed the extension still uses supported command, UI, and session-state APIs


## [0.1.7] - 2026-04-23

### Changed
- updated the local pi development baseline to `@mariozechner/pi-coding-agent` `0.70.0`
- regenerated the npm lockfile against the current stable dependency graph

### Compatibility
- reviewed the pi `0.70.0` changelog and confirmed the extension still relies on supported extension APIs without needing the TypeBox migration surface at runtime or the changed terminal progress defaults


## [0.1.6] - 2026-04-21

### Changed
- updated the local pi development baseline to `@mariozechner/pi-coding-agent` `0.68.0`
- regenerated the npm lockfile against the current stable dependency graph

### Compatibility
- reviewed the pi `0.68.0` changelog and confirmed the extension already uses current extension APIs rather than removed cwd-bound tool exports

## [0.1.5] - 2026-04-18

### Changed
- bumped the local pi development baseline to `@mariozechner/pi-coding-agent` / `@mariozechner/pi-tui` `0.67.68` and `typescript` `6.0.3`
- refreshed the release lockfile against the current stable pi patch line

## [0.1.4] - 2026-04-16

### Changed
- updated the local pi development baseline to `@mariozechner/pi-coding-agent` / `@mariozechner/pi-tui` `0.67.4`
- aligned `packageManager` metadata to `npm@10.9.8`, the latest stable npm line compatible with the declared Node runtime floor
- removed the published `@mariozechner/pi-coding-agent` peer dependency so installs rely on pi's bundled runtime while local development keeps the package in `devDependencies`

## [0.1.3] - 2026-04-15

### Changed
- refreshed the local development and release toolchain to `@mariozechner/pi-coding-agent` / `@mariozechner/pi-tui` `0.67.2`, `typescript` `6.0.2`, and `@types/node` `25.6.0`
- pinned `packageManager` metadata to `npm@11.12.1` and refreshed the lockfile so release verification resolves reproducibly against the current stable toolchain

## [0.1.2] - 2026-04-11

### Fixed
- Made stash state branch-aware by rehydrating from the active session branch on startup and `/tree` navigation.
- Hardened degraded-client and RPC-like behavior so missing custom overlay support no longer crashes restore/list flows.
- Added replace-editor confirmation when a client cannot safely merge restored text with existing editor contents.
- Preserved explicit `/stash` text exactly while still rejecting whitespace-only drafts.
- Removed dead stash helper code and replaced helper-only coverage with entrypoint regression tests.
- Fixed the local validation workflow to run on the declared Node 20.6 floor by transpiling tests before execution.
- Refreshed the lockfile to resolve the `basic-ftp` audit finding.

### Changed
- Added `npm run validate`, `npm run test:node20`, and pack/audit checks to the release gate.
- Documented requirements, tagged GitHub install guidance, degraded-client behavior, and the validation workflow in `README.md`.

## [0.1.1] - 2026-04-07

### Changed
- Simplified the stash command surface.

## [0.1.0] - 2026-04-07

### Added
- Initial `pi-stash` release with stash, restore, picker management, session persistence, shortcuts, and state helper tests.
