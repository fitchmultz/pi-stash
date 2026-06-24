import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const pi = process.env.PI_BIN ?? "pi";
const agentDir = mkdtempSync(join(tmpdir(), "pi-stash-smoke-"));

function run(args, input) {
	const result = spawnSync(pi, args, {
		cwd: process.cwd(),
		input,
		encoding: "utf8",
		env: { ...process.env, PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1" },
	});

	if (result.status !== 0) {
		throw new Error(`pi ${args.join(" ")} failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
	}

	return result.stdout;
}

try {
	run(["install", ".", "--approve"]);
	const stdout = run(
		[
			"--mode",
			"rpc",
			"--no-session",
			"--approve",
			"--no-skills",
			"--no-prompt-templates",
			"--no-themes",
			"--no-context-files",
			"--no-builtin-tools",
		],
		`${JSON.stringify({ type: "get_commands" })}\n`,
	);

	if (!stdout.includes('"name":"stash"') || !stdout.includes('"name":"stash-list"')) {
		throw new Error(`pi-stash commands were not loaded\nstdout:\n${stdout}`);
	}
} finally {
	rmSync(agentDir, { recursive: true, force: true });
}
