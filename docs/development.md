# Development and releases

[Back to the README](../README.md)

## GitHub installation

You can install directly from this repository:

```bash
pi install https://github.com/fitchmultz/pi-stash
```

Restart Pi after you install or update the extension.

## Local setup

Use Node.js **24.15.0 or later** and npm. The repository declares its npm version in `package.json`.

```bash
git clone https://github.com/fitchmultz/pi-stash
cd pi-stash
npm ci
pi install .
```

Restart Pi after installing or updating the extension. Pi loads its TypeScript directly; Node 24 runs the tests without a build step.

## Checks

```bash
npm run check         # typecheck + tests + pack dry-run
npm run smoke         # isolated pi install, stash, list, and restart through the real CLI
npm run check:compat  # check + smoke; used during host qualification
```

`test/native-ui.test.ts` loads the extension through the standalone SDK and native `InteractiveMode`. It checks fullscreen and regular shortcuts, draft merging, picker cancellation and mouse selection, and fork/resume/reload restoration. Reload coverage verifies command settlement and draft preservation with a picker open. On Pi 1.4 and later, it also keeps a second dialog open to check native dialog-stack cleanup. The tests use an isolated profile and memory terminal, with no model or clipboard calls.

Default-limit assertions use the documented ten-draft contract, not the production constant they are checking.

The smoke test uses an isolated HOME and agent directory. It checks shared drafts from eight independent native RPC processes, then checks persistence after restart. It resolves the installed host's `bin.pi`, or `PI_HOST_CLI` during qualification. Set `PI_BIN` to run a standalone smoke against another Pi executable; that override does not apply during host qualification.

## Latest-host qualification

Pi **1.0.0** is the support floor. Qualification requires the latest stable official Pi and the latest maintained fork `main`, resolving the version and commit once per workflow run and retaining exact SDK/CLI evidence. Locked development dependencies are reproducible snapshots, not the latest-host validation targets. Plain `npm ci` checks only that locked development snapshot.

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

Follow the [shared release procedure](https://github.com/fitchmultz/.github#automatic-npm-releases): merge a reviewed PR into `main` with an intentional `package.json` version bump and a matching versioned `CHANGELOG.md` section. Once configured and enabled, publication is unattended after the compatibility checks and candidate-tarball qualification pass. Complete any applicable package-specific release evidence before merging the bump.

Automation never bumps versions, overwrites releases, or republishes an existing version. Documentation-only changes do not need a new release. Existing manual publisher instructions remain valid.

Failed or unpublished candidates can retry daily at **12:17 UTC** or through a manual dispatch of `npm release` on `main`, without another bump. Set the repository variable `NPM_RELEASE_ENABLED` to anything other than `true` to stop new release plans; cancel pending runs separately when needed. Workflow validation is not evidence of a completed real OIDC publication.

## README diagram

The editable source and PNG export are in [`.github/readme/`](../.github/readme/). They are excluded from npm packages by the package's `files` list. Keep the SVG and PNG in sync when changing the workflow illustration.
