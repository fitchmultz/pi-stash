import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const guidePath = join(
  root,
  "docs",
  "standards",
  "Strict-Oxlint-Oxfmt-Engineering-Guide-v5.1.2.md",
);
const actualConfigPath = join(root, ".oxlintrc.json");
const oxlint = join(root, "node_modules", ".bin", "oxlint");

/**
 * The test-fixture profile glob extends the baseline test override to exclusively test-used
 * fixture support; see the adoption record in the adopted guide copy.
 */
const fixtureProfileGlob = "test/fixtures/**/*.{js,jsx,ts,tsx,mjs,cjs,mts,cts}";

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isRecord(value) {
  return typeof value === "object" && value !== null;
}

/**
 * Extract the Appendix A baseline configuration from the repository's adopted guide copy.
 *
 * @returns {Record<string, unknown>}
 */
function baselineConfig() {
  const guide = readFileSync(guidePath, "utf8");
  const marker = guide.indexOf("## Appendix A");
  if (marker < 0) {
    throw new Error("adopted guide copy must contain Appendix A");
  }
  const start = guide.indexOf("```json", marker);
  const end = guide.indexOf("```", start + 7);
  if (start < 0 || end < 0) {
    throw new Error("Appendix A must contain a JSON configuration block");
  }
  /** @type {unknown} */
  const parsed = JSON.parse(guide.slice(start + 7, end));
  if (!isRecord(parsed)) {
    throw new Error("Appendix A baseline must be a JSON object");
  }
  return parsed;
}

/**
 * Print the effective configuration a target file resolves under the given config.
 *
 * @param {string} configPath
 * @param {string} target
 * @returns {Record<string, unknown>}
 */
function printConfig(configPath, target) {
  const result = spawnSync(oxlint, ["--print-config", "-c", configPath, target], {
    cwd: root,
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(`oxlint --print-config failed for ${configPath}: ${result.stderr}`);
  }
  /** @type {unknown} */
  const parsed = JSON.parse(result.stdout);
  if (!isRecord(parsed)) {
    throw new Error("oxlint --print-config must emit a JSON object");
  }
  return parsed;
}

/**
 * @param {unknown} value
 * @returns {string[]}
 */
function pluginList(value) {
  if (!Array.isArray(value)) {
    throw new Error("printed config must contain a plugins array");
  }
  return value.filter((entry) => typeof entry === "string");
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function severityOf(value) {
  if (Array.isArray(value)) {
    /** @type {unknown} */
    const first = value[0];
    return typeof first === "string" ? first : String(first);
  }
  return String(value);
}

/**
 * Extract the options record from a printed rule setting.
 *
 * @param {unknown} value
 * @returns {Record<string, unknown> | null}
 */
function optionsOf(value) {
  if (!Array.isArray(value) || value.length < 2) {
    return null;
  }
  /** @type {unknown} */
  const options = value[1];
  if (!Array.isArray(options) || options.length < 1) {
    return null;
  }
  /** @type {unknown} */
  const record = options[0];
  return isRecord(record) ? record : null;
}

/**
 * Deny-level categories must stay denied in the actual config.
 *
 * @param {Record<string, unknown>} baselinePrinted
 * @param {Record<string, unknown>} actualPrinted
 * @param {string[]} failures
 */
function compareCategories(baselinePrinted, actualPrinted, failures) {
  const baselineCategories = isRecord(baselinePrinted.categories) ? baselinePrinted.categories : {};
  const actualCategories = isRecord(actualPrinted.categories) ? actualPrinted.categories : {};
  for (const [name, level] of Object.entries(baselineCategories)) {
    if (level !== "deny") {
      continue;
    }
    if (actualCategories[name] !== "deny") {
      failures.push(
        `policy: category ${name} is denied by the baseline but not by the actual config`,
      );
    }
  }
}

/**
 * Baseline plugins must remain enabled.
 *
 * @param {Record<string, unknown>} baselinePrinted
 * @param {Record<string, unknown>} actualPrinted
 * @param {string[]} failures
 */
function comparePlugins(baselinePrinted, actualPrinted, failures) {
  const baselinePlugins = pluginList(baselinePrinted.plugins);
  const actualPlugins = pluginList(actualPrinted.plugins);
  for (const plugin of baselinePlugins) {
    if (!actualPlugins.includes(plugin)) {
      failures.push(`policy: plugin ${plugin} is missing from the actual config`);
    }
  }
}

/**
 * Compare one rule's options against the baseline plus recorded exceptions.
 *
 * @param {string} rule
 * @param {Record<string, unknown> | null} baselineOptions
 * @param {Record<string, unknown> | null} actualOptions
 * @param {string[]} failures
 */
function compareRuleOptions(rule, baselineOptions, actualOptions, failures) {
  if (baselineOptions === null) {
    return;
  }
  if (actualOptions === null) {
    failures.push(`policy: rule ${rule} lost its baseline options`);
    return;
  }
  if (rule === "typescript/no-floating-promises") {
    // QX-001: the only recorded baseline delta, the node:test registration allowance.
    const expected = { ...baselineOptions };
    expected.allowForKnownSafeCalls = [
      { from: "package", package: "node:test", name: ["nodeTest", "nodeAfter"] },
    ];
    if (JSON.stringify(actualOptions) !== JSON.stringify(expected)) {
      failures.push(
        `policy: rule ${rule} options differ from the baseline plus the recorded QX-001 allowance`,
      );
    }
    return;
  }
  if (JSON.stringify(actualOptions) !== JSON.stringify(baselineOptions)) {
    failures.push(
      `policy: rule ${rule} options differ from the baseline without a recorded exception`,
    );
  }
}

/**
 * Every baseline-enabled rule must stay enabled with baseline options unless a recorded exception applies.
 *
 * @param {Record<string, unknown>} baselineRules
 * @param {Record<string, unknown>} actualRules
 * @param {string} rule
 * @param {string[]} failures
 */
function compareRule(baselineRules, actualRules, rule, failures) {
  const baselineSetting = baselineRules[rule];
  if (!(rule in actualRules)) {
    failures.push(
      `policy: rule ${rule} is enabled by the baseline but absent from the actual config`,
    );
    return;
  }
  const actualSetting = actualRules[rule];
  const baselineSeverity = severityOf(baselineSetting);
  const actualSeverity = severityOf(actualSetting);
  if (baselineSeverity === "deny" && actualSeverity !== "deny") {
    failures.push(
      `policy: rule ${rule} is denied by the baseline but weakened to ${actualSeverity}`,
    );
    return;
  }
  compareRuleOptions(rule, optionsOf(baselineSetting), optionsOf(actualSetting), failures);
}

/**
 * @param {Record<string, unknown>} baselinePrinted
 * @param {Record<string, unknown>} actualPrinted
 * @param {string[]} failures
 */
function compareRules(baselinePrinted, actualPrinted, failures) {
  const baselineRules = isRecord(baselinePrinted.rules) ? baselinePrinted.rules : {};
  const actualRules = isRecord(actualPrinted.rules) ? actualPrinted.rules : {};
  for (const rule of Object.keys(baselineRules)) {
    compareRule(baselineRules, actualRules, rule, failures);
  }
}

/**
 * Assert the actual overrides equal the baseline plus the recorded fixture-profile glob.
 *
 * @param {unknown[]} baselineOverrides
 * @param {unknown[]} actualOverrides
 * @param {string[]} failures
 */
function compareOverrides(baselineOverrides, actualOverrides, failures) {
  const expected = structuredClone(baselineOverrides);
  const first = expected.length > 0 ? expected[0] : undefined;
  if (!isRecord(first) || !Array.isArray(first.files)) {
    assert.fail("the baseline test override must declare a files array");
  }
  if (!first.files.includes(fixtureProfileGlob)) {
    first.files.push(fixtureProfileGlob);
  }
  if (JSON.stringify(actualOverrides) !== JSON.stringify(expected)) {
    failures.push(
      "policy: overrides differ from the baseline plus the recorded test-fixture profile glob",
    );
  }
}

/** @type {string[]} */
const failures = [];
const temp = mkdtempSync(join(tmpdir(), "pi-stash-policy-"));
try {
  const baselinePath = join(temp, "baseline.oxlintrc.json");
  writeFileSync(baselinePath, `${JSON.stringify(baselineConfig(), null, "\t")}\n`);
  /** @type {string[]} */
  const targets = ["scripts/smoke-package-load.mjs", "test/state.test.ts"];
  for (const target of targets) {
    const baselinePrinted = printConfig(baselinePath, target);
    const actualPrinted = printConfig(actualConfigPath, target);
    compareCategories(baselinePrinted, actualPrinted, failures);
    comparePlugins(baselinePrinted, actualPrinted, failures);
    compareRules(baselinePrinted, actualPrinted, failures);
  }

  /** @type {unknown} */
  const rawActual = JSON.parse(readFileSync(actualConfigPath, "utf8"));
  if (!isRecord(rawActual) || !Array.isArray(rawActual.overrides)) {
    throw new Error(".oxlintrc.json must contain an overrides array");
  }
  const rawBaseline = baselineConfig();
  if (!isRecord(rawBaseline) || !Array.isArray(rawBaseline.overrides)) {
    throw new Error("Appendix A baseline must contain an overrides array");
  }
  compareOverrides(rawBaseline.overrides, rawActual.overrides, failures);

  const rawOptions = isRecord(rawActual.options) ? rawActual.options : {};
  const baselineOptions = isRecord(rawBaseline.options) ? rawBaseline.options : {};
  for (const [key, value] of Object.entries(baselineOptions)) {
    if (JSON.stringify(rawOptions[key]) !== JSON.stringify(value)) {
      failures.push(`policy: option ${key} differs from the baseline`);
    }
  }
} finally {
  rmSync(temp, { recursive: true, force: true });
}

console.log("policy: Appendix A baseline comparison complete");
if (failures.length > 0) {
  for (const failure of failures) {
    console.error(`policy: FAIL ${failure}`);
  }
  process.exitCode = 1;
} else {
  console.log("policy: PASS");
}
