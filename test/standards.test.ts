import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test as nodeTest } from "node:test";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const oxlint = join(root, "node_modules", ".bin", "oxlint");

/** Diagnostic identity from `oxlint --format=json`; directives carry no code. */
interface Diagnostic {
  code?: string | undefined;
  message: string;
  filename: string;
  line: number;
}

interface LintReport {
  diagnostics: Diagnostic[];
  fileCount: number;
}

interface LintRun {
  status: number;
  report: LintReport;
}

/**
 * @param {unknown} value
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function parseDiagnostic(entry: unknown): Diagnostic {
  if (
    !isRecord(entry) ||
    typeof entry.message !== "string" ||
    typeof entry.filename !== "string" ||
    ("code" in entry && typeof entry.code !== "string")
  ) {
    assert.fail("oxlint diagnostic must carry message, filename, and a string code when present");
  }
  const code = typeof entry.code === "string" ? entry.code : undefined;
  const labels: unknown[] = Array.isArray(entry.labels) ? entry.labels : [];
  const first = labels.length > 0 ? labels[0] : undefined;
  if (!isRecord(first) || !isRecord(first.span) || typeof first.span.line !== "number") {
    assert.fail("oxlint diagnostic must carry a location label with a line");
  }
  return { code, message: entry.message, filename: entry.filename, line: first.span.line };
}

function parseReport(stdout: string): LintReport {
  const parsed: unknown = JSON.parse(stdout);
  if (
    !isRecord(parsed) ||
    !Array.isArray(parsed.diagnostics) ||
    typeof parsed.number_of_files !== "number"
  ) {
    assert.fail("oxlint JSON output must contain a diagnostics array and a numeric file count");
  }
  return {
    diagnostics: parsed.diagnostics.map(parseDiagnostic),
    fileCount: parsed.number_of_files,
  };
}

function lintDir(dir: string): LintRun {
  const result = spawnSync(oxlint, ["--format=json", "--deny-warnings", "test"], {
    cwd: dir,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });
  if (result.error !== undefined || result.status === null || typeof result.stdout !== "string") {
    throw new Error(`oxlint failed to run: ${String(result.error)}`);
  }
  return { status: result.status, report: parseReport(result.stdout) };
}

/**
 * Build an isolated scaffold with the repository policy, compiler context, and dependency cohort.
 *
 * @param files record of `test/`-relative file names to contents
 */
function scaffold(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "pi-stash-standards-"));
  symlinkSync(join(root, "node_modules"), join(dir, "node_modules"), "dir");
  writeFileSync(join(dir, ".oxlintrc.json"), readFileSync(join(root, ".oxlintrc.json"), "utf8"));
  const raw: unknown = JSON.parse(readFileSync(join(root, "tsconfig.json"), "utf8"));
  if (!isRecord(raw) || !isRecord(raw.compilerOptions)) {
    assert.fail("repository tsconfig must contain compilerOptions");
  }
  const mirrored = { ...raw, include: ["test/**/*.ts"], exclude: ["node_modules"] };
  writeFileSync(join(dir, "tsconfig.json"), `${JSON.stringify(mirrored, null, "\t")}\n`);
  mkdirSync(join(dir, "test"));
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(dir, "test", name), content);
  }
  return dir;
}

/** Repeat a source line for generated boundary fixtures. */
function repeat(line: string, count: number): string {
  return Array.from({ length: count }, () => line).join("\n");
}

function expectFloating(report: LintReport, file: string, line: number): void {
  const lines = report.diagnostics
    .filter(
      (entry) => entry.filename.endsWith(file) && entry.code === "typescript(no-floating-promises)",
    )
    .map((entry) => entry.line);
  assert.deepEqual(
    lines,
    [line],
    `${file} must carry exactly one no-floating-promises diagnostic at line ${line}`,
  );
}

function expectRule(report: LintReport, file: string, code: string, line: number): void {
  const lines = report.diagnostics
    .filter((entry) => entry.filename.endsWith(file) && entry.code === code)
    .map((entry) => entry.line);
  assert.deepEqual(
    lines,
    [line],
    `${file} must carry exactly one ${code} diagnostic at line ${line}`,
  );
}

function expectClean(report: LintReport, file: string): void {
  const found = report.diagnostics.filter((entry) => entry.filename.endsWith(file));
  assert.deepEqual(found, [], `${file} must lint clean under the adopted policy`);
}

/** The only node:test forms the repository uses: `test` and `after` registrations. */
const allowancePassSource = [
  'import assert from "node:assert/strict";',
  'import { test as nodeTest, after as nodeAfter } from "node:test";',
  "",
  "nodeAfter(() => {",
  "\tassert.equal(1 + 1, 2);",
  "});",
  "",
  'nodeTest("unawaited registration", () => {',
  "\tassert.equal(1 + 1, 2);",
  "});",
  "",
].join("\n");

function boundaryFixtures(): Record<string, string> {
  return {
    "boundaries-complexity.ts": [
      "export function branches(value: number): number {",
      "\tlet acc = 0;",
      ...repeat("\tif (acc === 0) { acc += 1; }", 11).split("\n"),
      "\treturn acc;",
      "}",
      "",
    ].join("\n"),
    "boundaries-depth.ts": [
      "export function nested(value: number): number {",
      "\tif (value > 0) {",
      "\t\tif (value > 1) {",
      "\t\t\tif (value > 2) {",
      "\t\t\t\tif (value > 3) {",
      "\t\t\t\t\treturn value;",
      "\t\t\t\t}",
      "\t\t\t}",
      "\t\t}",
      "\t}",
      "\treturn 0;",
      "}",
      "",
    ].join("\n"),
    "boundaries-params.ts": [
      "export function five(a: number, b: number, c: number, d: number, e: number): number {",
      "\treturn a + b + c + d + e;",
      "}",
      "",
    ].join("\n"),
    "boundaries-statements.ts": [
      "export function statements(): number {",
      "\tlet acc = 0;",
      ...repeat("\tacc += 1;", 40).split("\n"),
      "\treturn acc;",
      "}",
      "",
    ].join("\n"),
    "boundaries-function-lines.ts": [
      "export function longFunction(): number {",
      "\tlet acc = 0;",
      ...repeat("\tacc += 1;", 80).split("\n"),
      "\treturn acc;",
      "}",
      "",
    ].join("\n"),
    "boundaries-file-lines.ts": [
      "let acc = 0;",
      ...repeat("acc += 1;", 500).split("\n"),
      "export const total = acc;",
      "",
    ].join("\n"),
    "boundaries-long.test.ts": [
      'import assert from "node:assert/strict";',
      'import { test as nodeTest } from "node:test";',
      "",
      'nodeTest("long test stays within the relaxed test profile", () => {',
      "\tlet acc = 0;",
      ...repeat("\tacc += 1;", 100).split("\n"),
      "\tassert.equal(acc, 100);",
      "});",
      "",
    ].join("\n"),
    "boundaries-test-limits.test.ts": [
      'import assert from "node:assert/strict";',
      'import { test as nodeTest } from "node:test";',
      "",
      "function seven(a: number, b: number, c: number, d: number, e: number, f: number, g: number): number {",
      "\treturn a + b + c + d + e + f + g;",
      "}",
      "",
      'nodeTest("excessive complexity fails", () => {',
      "\tlet acc = 0;",
      ...repeat("\tif (acc === 0) { acc += 1; }", 16).split("\n"),
      "\tacc = seven(1, 2, 3, 4, 5, 6, 7);",
      "\tassert.ok(acc > 0);",
      "});",
      "",
      'nodeTest("excessive depth fails", () => {',
      "\tlet acc = 0;",
      "\tif (acc >= 0) {",
      "\t\tif (acc >= 0) {",
      "\t\t\tif (acc >= 0) {",
      "\t\t\t\tif (acc >= 0) {",
      "\t\t\t\t\tif (acc >= 0) {",
      "\t\t\t\t\t\tacc += seven(1, 2, 3, 4, 5, 6, 7);",
      "\t\t\t\t\t}",
      "\t\t\t\t}",
      "\t\t\t}",
      "\t\t}",
      "\t}",
      "\tassert.equal(acc, 7);",
      "});",
      "",
    ].join("\n"),
    "explicit-debugger.ts": ["debugger;", ""].join("\n"),
    "category-unused.ts": ["const unused = 1;", ""].join("\n"),
    "unsafe-member.ts": [
      'const parsed = JSON.parse("{}");',
      "",
      "export const text = parsed.foo.trim();",
      "",
    ].join("\n"),
    "directive-unused.ts": [
      "// oxlint-disable-next-line eslint/no-debugger",
      "export const value = 1;",
      "",
    ].join("\n"),
    "directive-load-bearing.ts": [
      "// oxlint-disable-next-line eslint/no-debugger",
      "debugger;",
      "",
      "export const done = true;",
      "",
    ].join("\n"),
  };
}

nodeTest("valid registrations and long tests pass the adopted policy", () => {
  const valid = scaffold({ "allowance-pass.ts": allowancePassSource });
  try {
    const run = lintDir(valid);
    assert.equal(run.status, 0, "valid sources must pass with a zero exit status");
    assert.deepEqual(run.report.diagnostics, [], "valid sources must produce no diagnostics");
    assert.equal(run.report.fileCount, 1, "the scaffold file must enter the lint selection");
  } finally {
    rmSync(valid, { recursive: true, force: true });
  }
});

nodeTest("the node:test registration allowance keeps all six section 6.4 boundaries", () => {
  const controls = scaffold({
    "allowance-pass.ts": allowancePassSource,
    "allowance-context-subtest.ts": [
      'import assert from "node:assert/strict";',
      'import { test as nodeTest } from "node:test";',
      "",
      'nodeTest("outer", (t) => {',
      '\tt.test("inner", () => {',
      "\t\tassert.equal(1 + 1, 2);",
      "\t});",
      "});",
      "",
    ].join("\n"),
    "allowance-local-name.ts": [
      "function nodeTest(): Promise<void> {",
      "\treturn Promise.resolve();",
      "}",
      "",
      "nodeTest();",
      "",
    ].join("\n"),
    "helper-module.ts": [
      "export function nodeTest(): Promise<void> {",
      "\treturn Promise.resolve();",
      "}",
      "",
    ].join("\n"),
    "allowance-other-module.ts": [
      'import { nodeTest } from "./helper-module.ts";',
      "",
      "nodeTest();",
      "",
    ].join("\n"),
    "allowance-inside-test.ts": [
      'import assert from "node:assert/strict";',
      'import { test as nodeTest } from "node:test";',
      "",
      "async function helper(): Promise<void> {",
      "\tassert.equal(1 + 1, 2);",
      "}",
      "",
      'nodeTest("body", () => {',
      "\thelper();",
      "});",
      "",
    ].join("\n"),
    "allowance-unrelated.ts": [
      'import assert from "node:assert/strict";',
      'import { test as nodeTest } from "node:test";',
      "",
      "function unrelated(): Promise<void> {",
      "\treturn Promise.resolve();",
      "}",
      "",
      "unrelated();",
      "",
      'nodeTest("suite", () => {',
      "\tassert.equal(1 + 1, 2);",
      "});",
      "",
    ].join("\n"),
  });
  try {
    const run = lintDir(controls);
    assert.equal(run.status, 1, "boundary violations must fail the lint gate");
    assert.equal(run.report.fileCount, 7, "every scaffold file must enter the lint selection");
    expectClean(run.report, "allowance-pass.ts");
    expectClean(run.report, "helper-module.ts");
    expectFloating(run.report, "allowance-context-subtest.ts", 5);
    expectFloating(run.report, "allowance-local-name.ts", 5);
    expectFloating(run.report, "allowance-other-module.ts", 3);
    expectFloating(run.report, "allowance-inside-test.ts", 9);
    expectFloating(run.report, "allowance-unrelated.ts", 8);
  } finally {
    rmSync(controls, { recursive: true, force: true });
  }
});

nodeTest("structural, composition, and directive boundaries fail beyond their limits", () => {
  const controls = scaffold(boundaryFixtures());
  try {
    const run = lintDir(controls);
    assert.equal(run.status, 1, "boundary violations must fail the lint gate");
    assert.equal(run.report.fileCount, 13, "every scaffold file must enter the lint selection");
    expectRule(run.report, "boundaries-complexity.ts", "eslint(complexity)", 1);
    expectRule(run.report, "boundaries-depth.ts", "eslint(max-depth)", 5);
    expectRule(run.report, "boundaries-params.ts", "eslint(max-params)", 1);
    expectRule(run.report, "boundaries-statements.ts", "eslint(max-statements)", 1);
    expectRule(run.report, "boundaries-function-lines.ts", "eslint(max-lines-per-function)", 1);
    expectRule(run.report, "boundaries-file-lines.ts", "eslint(max-lines)", 502);
    expectRule(run.report, "boundaries-test-limits.test.ts", "eslint(complexity)", 8);
    expectRule(run.report, "boundaries-test-limits.test.ts", "eslint(max-depth)", 36);
    expectRule(run.report, "boundaries-test-limits.test.ts", "eslint(max-params)", 4);
    expectClean(run.report, "boundaries-long.test.ts");
    expectRule(run.report, "explicit-debugger.ts", "eslint(no-debugger)", 1);
    expectRule(run.report, "category-unused.ts", "eslint(no-unused-vars)", 1);
    expectRule(run.report, "unsafe-member.ts", "typescript(no-unsafe-member-access)", 3);
    expectClean(run.report, "directive-load-bearing.ts");
    const unused = run.report.diagnostics.filter((entry) =>
      entry.filename.endsWith("directive-unused.ts"),
    );
    assert.equal(unused.length, 1, "an unused directive must produce exactly one diagnostic");
    assert.match(unused[0]?.message ?? "", /^Unused oxlint-disable directive/);
    assert.equal(unused[0]?.line, 1);
  } finally {
    rmSync(controls, { recursive: true, force: true });
  }
});
