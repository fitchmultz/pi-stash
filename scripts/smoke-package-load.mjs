import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isRecord(value) {
  return typeof value === "object" && value !== null;
}

/**
 * Narrow the installed host manifest to the fields this smoke test reads.
 *
 * @param {unknown} value
 * @returns {value is { version: string, bin: { pi: string } & Record<string, string> }}
 */
function isHostPackage(value) {
  if (!isRecord(value)) {
    return false;
  }
  if (typeof value.version !== "string") {
    return false;
  }
  return (
    isRecord(value.bin) &&
    typeof value.bin.pi === "string" &&
    Object.values(value.bin).every((entry) => typeof entry === "string")
  );
}

/**
 * Narrow a parsed stash file to its persisted draft list.
 *
 * @param {unknown} value
 * @returns {value is { drafts: string[] }}
 */
function isStashFile(value) {
  return (
    isRecord(value) &&
    "drafts" in value &&
    Array.isArray(value.drafts) &&
    value.drafts.every((draft) => typeof draft === "string")
  );
}

/**
 * Compare strings in UTF-16 code-unit order, matching the default Array#sort order.
 *
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
function compareCodeUnits(a, b) {
  if (a < b) {
    return -1;
  }
  if (a > b) {
    return 1;
  }
  return 0;
}

/**
 * @param {string} line
 * @returns {Record<string, unknown>}
 */
function parseEventLine(line) {
  /** @type {unknown} */
  const parsed = JSON.parse(line);
  if (!isRecord(parsed)) {
    assert.fail("RPC output must be JSON object lines");
  }
  return parsed;
}

/**
 * @param {string} file
 * @param {string} stashDir
 * @returns {string[]}
 */
function readStoredDrafts(stashDir, file) {
  /** @type {unknown} */
  const parsed = JSON.parse(readFileSync(join(stashDir, file), "utf8"));
  if (!isStashFile(parsed)) {
    assert.fail("stash file must persist a string draft list");
  }
  return [...parsed.drafts].sort(compareCodeUnits);
}

const packageRoot = fileURLToPath(new URL("..", import.meta.url));
const hostDir = resolve(
  dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"))),
  "..",
);
/** @type {unknown} */
const parsedPackage = JSON.parse(readFileSync(join(hostDir, "package.json"), "utf8"));
if (!isHostPackage(parsedPackage)) {
  assert.fail("installed host must declare a string version and bin map");
}
const hostPackage = parsedPackage;
const bundledCli = resolve(hostDir, hostPackage.bin.pi);
const cli = process.env.PI_HOST_CLI ?? bundledCli;
assert.equal(
  realpathSync(cli),
  realpathSync(bundledCli),
  "CLI must belong to the installed selected host",
);
const expectedPackageDir = process.env.PI_COMPAT_EXPECTED_PACKAGE_DIR;
if (expectedPackageDir !== undefined) {
  assert.equal(realpathSync(hostDir), realpathSync(expectedPackageDir));
}
const expectedVersion = process.env.PI_COMPAT_EXPECTED_VERSION;
if (expectedVersion !== undefined) {
  assert.equal(hostPackage.version, expectedVersion);
}
// Retain the standalone PI_BIN override; compatibility always uses the selected manifest bin.
const piBin = process.env.PI_BIN;
const useBinOverride =
  piBin !== undefined &&
  process.env.PI_COMPAT_HOST === undefined &&
  process.env.PI_HOST_CLI === undefined;
const pi = useBinOverride ? piBin : process.execPath;
const home = mkdtempSync(join(tmpdir(), "pi-stash-smoke-"));
const agentDir = join(home, ".pi", "agent");
mkdirSync(join(home, "tmp"));

/**
 * @param {string[]} args
 * @param {string} [input=""] "RPC stdin; commands that need none pass nothing."
 * @returns {string}
 */
function run(args, input = "") {
  const result = spawnSync(pi, useBinOverride ? args : [cli, ...args], {
    cwd: home,
    input,
    encoding: "utf8",
    timeout: 20_000,
    env: {
      HOME: home,
      PATH: process.env.PATH ?? "",
      TMPDIR: join(home, "tmp"),
      PI_CODING_AGENT_DIR: agentDir,
      PI_OFFLINE: "1",
      PI_TELEMETRY: "0",
      PI_SKIP_VERSION_CHECK: "1",
    },
  });

  if (result.status !== 0) {
    throw new Error(
      `pi ${args.join(" ")} failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
    );
  }
  assert.ok(typeof result.stdout === "string", "pi RPC output must be text");
  return result.stdout;
}

try {
  run(["install", packageRoot, "--approve"]);
  const args = [
    "--mode",
    "rpc",
    "--approve",
    "--no-skills",
    "--no-prompt-templates",
    "--no-themes",
    "--no-context-files",
    "--no-builtin-tools",
  ];
  const stdout = run(
    args,
    [
      { id: "stash", type: "prompt", message: "/stash ci-draft" },
      { id: "list", type: "prompt", message: "/stash-list" },
    ]
      .map((command) => JSON.stringify(command))
      .join("\n") + "\n",
  );
  const events = stdout.trim().split("\n").map(parseEventLine);
  const stashDir = join(agentDir, "pi-stash");
  assert.deepEqual(
    readdirSync(stashDir).map((file) => readStoredDrafts(stashDir, file)),
    [["ci-draft"]],
  );
  assert.ok(
    events.some(
      (event) =>
        event.type === "extension_ui_request" &&
        event.method === "notify" &&
        typeof event.message === "string" &&
        event.message.includes("1. ci-draft"),
    ),
    stdout,
  );
  assert.deepEqual(
    events.filter((event) => event.type === "response").map((event) => [event.id, event.success]),
    [
      ["stash", true],
      ["list", true],
    ],
  );
  assert.ok(
    !events.some((event) => event.type === "agent_start" || event.type === "extension_error"),
    stdout,
  );

  const concurrentDrafts = Array.from({ length: 8 }, (_, index) => `native-window-${index}`);
  const saves = await Promise.allSettled(
    concurrentDrafts.map((draft) => {
      // oxlint-disable-next-line typescript/no-unnecessary-type-assertion -- QX-005: tsc requires this JSDoc hint so resolve() stays callable without arguments (TS2810); oxlint 1.90/tsgolint 7.0.2005 meanwhile considers the same assertion redundant.
      return /** @type {Promise<void>} */ (
        new Promise((settle, reject) => {
          const child = spawn(pi, useBinOverride ? args : [cli, ...args], {
            cwd: home,
            timeout: 20_000,
            env: {
              HOME: home,
              PATH: process.env.PATH ?? "",
              TMPDIR: join(home, "tmp"),
              PI_CODING_AGENT_DIR: agentDir,
              PI_OFFLINE: "1",
              PI_TELEMETRY: "0",
              PI_SKIP_VERSION_CHECK: "1",
            },
          });
          /** @param {string} data */
          const collectStdout = (data) => {
            stdoutText += data;
          };
          /** @param {string} data */
          const collectStderr = (data) => {
            stderrText += data;
          };
          let stdoutText = "";
          let stderrText = "";
          child.stdout.setEncoding("utf8").on("data", collectStdout);
          child.stderr.setEncoding("utf8").on("data", collectStderr);
          child.on("error", reject);
          child.on("close", (code) => {
            try {
              assert.equal(code, 0, stderrText);
              const childEvents = stdoutText.trim().split("\n").map(parseEventLine);
              assert.deepEqual(
                childEvents
                  .filter((event) => event.type === "response")
                  .map((event) => [event.id, event.success]),
                [[draft, true]],
              );
              assert.ok(
                !childEvents.some(
                  (event) => event.type === "agent_start" || event.type === "extension_error",
                ),
                stdoutText,
              );
              settle();
            } catch (error) {
              reject(error);
            }
          });
          child.stdin.end(
            `${JSON.stringify({ id: draft, type: "prompt", message: `/stash ${draft}` })}\n`,
          );
        })
      );
    }),
  );
  assert.ok(saves.every((save) => save.status === "fulfilled"));
  assert.deepEqual(
    readdirSync(stashDir).map((file) => readStoredDrafts(stashDir, file)),
    [["ci-draft", ...concurrentDrafts].sort(compareCodeUnits)],
  );
  console.log("Eight independent native RPC processes preserved all drafts below the cap.");

  const resumed = run(
    [...args, "-c"],
    `${JSON.stringify({ id: "resume", type: "prompt", message: "/stash-list" })}\n`,
  );
  const resumedEvents = resumed.trim().split("\n").map(parseEventLine);
  assert.ok(
    resumedEvents.some(
      (event) =>
        event.type === "extension_ui_request" &&
        event.method === "notify" &&
        typeof event.message === "string" &&
        event.message.includes("9. ci-draft"),
    ),
    resumed,
  );
  assert.deepEqual(
    resumedEvents
      .filter((event) => event.type === "response")
      .map((event) => [event.id, event.success]),
    [["resume", true]],
  );
} finally {
  rmSync(home, { recursive: true, force: true });
}
