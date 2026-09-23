import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const packageRoot = fileURLToPath(new URL("..", import.meta.url));
const hostDir = resolve(dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"))), "..");
const hostPackage = JSON.parse(readFileSync(join(hostDir, "package.json"), "utf8"));
const bundledCli = resolve(hostDir, hostPackage.bin.pi);
const cli = process.env.PI_HOST_CLI ?? bundledCli;
assert.equal(realpathSync(cli), realpathSync(bundledCli), "CLI must belong to the installed selected host");
if (process.env.PI_COMPAT_EXPECTED_PACKAGE_DIR) {
	assert.equal(realpathSync(hostDir), realpathSync(process.env.PI_COMPAT_EXPECTED_PACKAGE_DIR));
}
if (process.env.PI_COMPAT_EXPECTED_VERSION) {
	assert.equal(hostPackage.version, process.env.PI_COMPAT_EXPECTED_VERSION);
}
// Retain the standalone PI_BIN override; compatibility always uses the selected manifest bin.
const useBinOverride = process.env.PI_BIN && !process.env.PI_COMPAT_HOST && !process.env.PI_HOST_CLI;
const pi = useBinOverride ? process.env.PI_BIN : process.execPath;
const home = mkdtempSync(join(tmpdir(), "pi-stash-smoke-"));
const agentDir = join(home, ".pi", "agent");
mkdirSync(join(home, "tmp"));

function run(args, input) {
	const result = spawnSync(pi, useBinOverride ? args : [cli, ...args], {
		cwd: home,
		input,
		encoding: "utf8",
		timeout: 20_000,
		env: {
			HOME: home, PATH: process.env.PATH ?? "", TMPDIR: join(home, "tmp"),
			PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1", PI_TELEMETRY: "0", PI_SKIP_VERSION_CHECK: "1",
		},
	});

	if (result.status !== 0) {
		throw new Error(`pi ${args.join(" ")} failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
	}

	return result.stdout;
}

try {
	run(["install", packageRoot, "--approve"]);
	const args = [
		"--mode", "rpc", "--approve", "--no-skills", "--no-prompt-templates",
		"--no-themes", "--no-context-files", "--no-builtin-tools",
	];
	const stdout = run(
		args,
		[
			{ id: "stash", type: "prompt", message: "/stash ci-draft" },
			{ id: "list", type: "prompt", message: "/stash-list" },
		].map((command) => JSON.stringify(command)).join("\n") + "\n",
	);
	const events = stdout.trim().split("\n").map((line) => JSON.parse(line));
	assert.ok(events.some((event) =>
		event.type === "entry_appended" &&
		event.entry?.customType === "pi-stash" &&
		event.entry.data?.drafts?.[0] === "ci-draft"
	), stdout);
	assert.ok(events.some((event) =>
		event.type === "extension_ui_request" &&
		event.method === "notify" &&
		event.message?.includes("1. ci-draft")
	), stdout);
	assert.deepEqual(
		events.filter((event) => event.type === "response").map((event) => [event.id, event.success]),
		[["stash", true], ["list", true]],
	);
	assert.ok(!events.some((event) => event.type === "agent_start" || event.type === "extension_error"), stdout);

	const resumed = run([...args, "-c"], `${JSON.stringify({ id: "resume", type: "prompt", message: "/stash-list" })}\n`);
	const resumedEvents = resumed.trim().split("\n").map((line) => JSON.parse(line));
	assert.ok(resumedEvents.some((event) =>
		event.type === "extension_ui_request" &&
		event.method === "notify" &&
		event.message?.includes("1. ci-draft")
	), resumed);
	assert.deepEqual(
		resumedEvents.filter((event) => event.type === "response").map((event) => [event.id, event.success]),
		[["resume", true]],
	);
} finally {
	rmSync(home, { recursive: true, force: true });
}
