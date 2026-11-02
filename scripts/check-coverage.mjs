import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const lintable = new Set([".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx", ".mts", ".cts"]);
const ownable = new Set([...lintable, ".md", ".markdown", ".yml", ".yaml", ".json", ".jsonc"]);
/** npm generates and owns package-lock.json bytes; oxfmt excludes it natively. */
const generatedSkippedByOxfmt = new Set(["package-lock.json"]);

/** @returns {string[]} git-tracked and untracked-but-not-ignored maintained working-tree files */
function inventory() {
  return execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard"], {
    cwd: root,
    encoding: "utf8",
  })
    .split("\n")
    .filter((file) => file !== "" && existsSync(join(root, file)));
}

const files = inventory();
const codeFiles = files.filter((file) => lintable.has(extname(file)));
const fmtFiles = files.filter(
  (file) => ownable.has(extname(file)) && !generatedSkippedByOxfmt.has(basename(file)),
);

/** @returns {Set<string>} absolute paths the compiler checked */
function compilerFiles() {
  let output;
  try {
    output = execFileSync(join(root, "node_modules", ".bin", "tsc"), ["--listFiles"], {
      cwd: root,
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
    });
  } catch {
    // Coverage depends on a compiling tree; report the prerequisite as blocked.
    console.error("coverage: BLOCKED (typecheck prerequisite failed)");
    process.exit(1);
  }
  return new Set(
    output
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line !== "")
      .map((line) => realpathSync(line)),
  );
}

/**
 * Run oxlint over the repository and return its JSON report.
 *
 * @returns {{ diagnostics: unknown[], number_of_files: number }}
 */
function lintReport() {
  const result = spawnSync(join(root, "node_modules", ".bin", "oxlint"), ["--format=json", "."], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });
  if (result.status !== 0 && result.status !== 1) {
    throw new Error(`oxlint crashed: ${result.stderr}`);
  }
  /** @type {unknown} */
  const parsed = JSON.parse(result.stdout);
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !("diagnostics" in parsed) ||
    !("number_of_files" in parsed)
  ) {
    throw new Error("oxlint JSON output must contain diagnostics and number_of_files");
  }
  const diagnostics = parsed.diagnostics;
  const numberOfFiles = parsed.number_of_files;
  if (!Array.isArray(diagnostics) || typeof numberOfFiles !== "number") {
    throw new Error("oxlint JSON output must contain a diagnostics array and a numeric file count");
  }
  return { diagnostics, number_of_files: numberOfFiles };
}

/**
 * Run oxfmt in check mode and return the number of files it selected.
 *
 * @returns {number}
 */
function oxfmtFileCount() {
  const result = spawnSync(join(root, "node_modules", ".bin", "oxfmt"), ["--check", "."], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });
  if (result.status === null) {
    throw new Error(`oxfmt crashed: ${result.stderr}`);
  }
  const match = /on (\d+) files?/.exec(result.stdout);
  if (match === null) {
    throw new Error(`oxfmt output must report a file count: ${result.stdout}`);
  }
  return Number(match[1]);
}

/** @type {string[]} */
const failures = [];

const checked = compilerFiles();
for (const file of codeFiles) {
  if (!checked.has(realpathSync(join(root, file)))) {
    failures.push(`compiler coverage: ${file} is not in tsc --listFiles`);
  }
}

const report = lintReport();
if (report.number_of_files !== codeFiles.length) {
  failures.push(
    `lint coverage: oxlint selected ${report.number_of_files} files but ${codeFiles.length} maintained code files exist`,
  );
}

const oxfmtCount = oxfmtFileCount();
if (oxfmtCount !== fmtFiles.length) {
  failures.push(
    `format coverage: oxfmt selected ${oxfmtCount} files but ${fmtFiles.length} formatter-owned files exist`,
  );
}

const configPath = join(root, ".oxlintrc.json");
/** @type {unknown} */
const rawConfig = JSON.parse(readFileSync(configPath, "utf8"));
if (typeof rawConfig !== "object" || rawConfig === null) {
  throw new Error(".oxlintrc.json must be a JSON object");
}
const config = rawConfig;
for (const key of ["ignorePatterns", "ignorePaths"]) {
  if (key in config) {
    failures.push(`lint coverage: .oxlintrc.json must not exclude files via ${key}`);
  }
}

const nestedConfigs = readdirSync(root, { recursive: true }).filter((entry) => {
  if (typeof entry !== "string") {
    return false;
  }
  if (entry.startsWith("node_modules") || entry.startsWith(".git/")) {
    return false;
  }
  if (!entry.includes("/")) {
    return false;
  }
  return basename(entry) === ".oxlintrc.json" || basename(entry) === ".oxfmtrc.json";
});
if (nestedConfigs.length > 0) {
  failures.push(
    `coverage: nested formatter/linter configs would shadow the root policy: ${nestedConfigs.join(", ")}`,
  );
}

const probe = join(root, "coverage-probe.ts");
try {
  writeFileSync(probe, "debugger;\n");
  const probed = lintReport();
  const hit = probed.diagnostics.some(
    (entry) =>
      typeof entry === "object" &&
      entry !== null &&
      "filename" in entry &&
      typeof entry.filename === "string" &&
      entry.filename.endsWith("coverage-probe.ts") &&
      "code" in entry &&
      entry.code === "eslint(no-debugger)",
  );
  if (!hit) {
    failures.push(
      "lint coverage: a new maintained file with a violation was not selected by oxlint",
    );
  }
  if (probed.number_of_files !== codeFiles.length + 1) {
    failures.push(
      `lint coverage: oxlint counted ${probed.number_of_files} files with the probe but ${codeFiles.length + 1} were expected`,
    );
  }
} finally {
  rmSync(probe, { force: true });
}

console.log(
  `coverage: ${codeFiles.length} maintained code files, ${fmtFiles.length} formatter-owned files, probe selected`,
);
if (failures.length > 0) {
  for (const failure of failures) {
    console.error(`coverage: FAIL ${failure}`);
  }
  process.exitCode = 1;
} else {
  console.log("coverage: PASS");
}
