# Changelog

All notable changes to this project will be documented in this file.

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
