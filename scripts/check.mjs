import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const withSmoke = process.argv.includes("--smoke");

/**
 * Resolve a node_modules binary without shell or npx indirection so status propagation stays exact.
 *
 * @param {string} name
 * @returns {string}
 */
function bin(name) {
  const path = join(root, "node_modules", ".bin", name);
  if (!existsSync(path)) {
    throw new Error(`missing dev dependency binary: ${name}`);
  }
  return path;
}

/** @type {{ name: string, command: string, args: string[] }[]} */
const steps = [
  { name: "format:check", command: bin("oxfmt"), args: ["--check", "."] },
  { name: "lint", command: bin("oxlint"), args: ["--deny-warnings", "."] },
  { name: "typecheck", command: bin("tsc"), args: [] },
  { name: "coverage", command: process.execPath, args: ["scripts/check-coverage.mjs"] },
  { name: "policy", command: process.execPath, args: ["scripts/check-policy.mjs"] },
  { name: "test", command: process.execPath, args: ["--test", "test/*.test.ts"] },
  { name: "pack", command: "npm", args: ["pack", "--dry-run"] },
];
if (withSmoke) {
  steps.push({
    name: "smoke",
    command: process.execPath,
    args: ["scripts/smoke-package-load.mjs"],
  });
}

let failed = false;
for (const step of steps) {
  console.log(`\n=== ${step.name} ===`);
  const result = spawnSync(step.command, step.args, { cwd: root, stdio: "inherit" });
  const ok = result.status === 0;
  if (!ok) {
    failed = true;
  }
  console.log(`=== ${step.name}: ${ok ? "PASS" : "FAIL"} ===`);
}

console.log(`\ncheck: ${failed ? "FAIL (aggregate)" : "PASS (aggregate)"}`);
process.exitCode = failed ? 1 : 0;
