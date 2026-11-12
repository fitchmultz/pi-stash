# Development and releases

[Back to the README](../README.md)

## GitHub installation

You can install directly from this repository:

```bash
pi install https://github.com/fitchmultz/pi-stash
```

Restart Pi after you install or update the extension.

## Local setup

Use Node.js **24.22.3 (24.x) or 26.13.1 and later** and npm. The repository declares its npm version in `package.json`.

```bash
git clone https://github.com/fitchmultz/pi-stash
cd pi-stash
npm ci
pi install .
```

Restart Pi after installing or updating the extension. Pi loads its TypeScript directly; Node 24 runs the tests without a build step.

## Checks

The repository follows the [Strict Oxlint/Oxfmt Engineering Standard](standards/Strict-Oxlint-Oxfmt-Engineering-Guide-v5.1.2.md). Its Appendix A configuration is the lint baseline, the policy check compares the effective configuration against that baseline, and deviations require recorded quality exceptions in the guide copy.

```bash
npm run check         # aggregate acceptance: format:check + lint + typecheck + coverage + policy + test + pack
npm run lint          # oxlint under the strict type-aware configuration
npm run format        # oxfmt write
npm run coverage      # compiler, lint, and formatter membership for every maintained file
npm run policy        # effective lint configuration vs the Appendix A baseline
npm run smoke         # isolated pi install, stash, list, and restart through the real CLI
npm run check:compat  # check + smoke; used during host qualification
```

Every step reports its own PASS/FAIL and the aggregate fails when any gate fails. `test/standards.test.ts` holds the standing qualification controls for the node:test registration allowance, the structural profile boundaries, and directive handling.

`test/native-ui.test.ts` loads the extension through the standalone SDK and native `InteractiveMode`. It checks fullscreen and regular shortcuts, draft merging, picker cancellation and mouse selection, and fork/resume/reload restoration. Reload coverage verifies command settlement and draft preservation with a picker open, and keeps a second dialog open to check native dialog-stack cleanup. The tests use an isolated profile and memory terminal, with no model or clipboard calls.

Default-limit assertions use the documented ten-draft contract, not the production constant they are checking.

The smoke test uses an isolated HOME and agent directory. It checks shared drafts from eight independent native RPC processes, then checks persistence after restart. It resolves the installed host's `bin.pi`, or `PI_HOST_CLI` during qualification. Set `PI_BIN` to run a standalone smoke against another Pi executable; that override does not apply during host qualification.

## Latest-host qualification

Pi **1.5.0** is the support floor. Qualification requires the latest stable official Pi and the latest maintained fork `main`, resolving the version and commit once per workflow run and retaining exact SDK/CLI evidence. Locked development dependencies are reproducible snapshots, not the latest-host validation targets. Plain `npm ci` checks only that locked development snapshot.

The GitHub compatibility workflow runs the checks against both hosts and retains qualification evidence. To qualify locally with a checkout of the [shared automation repository](https://github.com/fitchmultz/.github):

```bash
node /path/to/automation/scripts/qualify.mjs \
  --repo pi-stash --source "$PWD" \
  --host official --target latest \
  --output /tmp/pi-stash-official

node /path/to/automation/scripts/qualify.mjs \
  --repo pi-stash --source "$PWD" \
  --host fork --target /path/to/fork-package \
  --output /tmp/pi-stash-fork
```

For the fork target, use a packed build of the latest maintained fork. See the [compatibility workflow](../.github/workflows/pi-compatibility.yml) for its build and pack steps.

## Automatic npm releases

Once configured and enabled, merges to `main` trigger automatic versioning and releases to npm and GitHub after the compatibility checks and candidate-tarball qualification pass. A merge gets a new version when it changes the package users install; a merge that changes only CI, tests or development tooling ships with the next release. Follow the [shared release procedure](https://github.com/fitchmultz/.github#automatic-npm-releases) for setup, retries, and recovery.

Set the repository variable `NPM_RELEASE_ENABLED` to anything other than `true` to stop new release plans; cancel pending runs separately when needed. Workflow validation is not evidence of a completed real OIDC publication.

## README diagram

The editable source and PNG export are in [`.github/readme/`](../.github/readme/). They are excluded from npm packages by the package's `files` list. Keep the SVG and PNG in sync when changing the workflow illustration.
