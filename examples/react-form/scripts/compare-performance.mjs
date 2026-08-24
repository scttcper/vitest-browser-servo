import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const pnpmCommand = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
const sampleCount = 6;
const expectedScenarios = [
  "renders and discovers hundreds of accessible controls",
  "updates scattered controlled fields and then replaces every value",
  "dispatches events through a large action button bank"
];
const runners = [
  { runtime: "jsdom", script: "benchmark:jsdom" },
  { runtime: "Servo", script: "benchmark:servo" }
];
const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "servo-benchmark-"));

function run(script, outputFile) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      pnpmCommand,
      ["run", script, `--outputFile=${outputFile}`],
      { stdio: "inherit" }
    );
    child.once("error", reject);
    child.once("exit", code => {
      if (code === 0) resolve();
      else reject(new Error(`pnpm run ${script} exited with code ${code}`));
    });
  });
}

function resultsFrom(report, runtime) {
  if (!report.success) throw new Error(`${runtime} reported an unsuccessful test run`);
  const assertions = report.testResults.flatMap(result => result.assertionResults);
  const passed = assertions.filter(result => result.status === "passed");
  const byScenario = new Map();
  for (const result of passed) {
    if (!expectedScenarios.includes(result.title)) {
      throw new Error(`${runtime} reported unexpected scenario ${JSON.stringify(result.title)}`);
    }
    if (!Number.isFinite(result.duration) || result.duration < 0) {
      throw new Error(`${runtime} reported an invalid duration for ${JSON.stringify(result.title)}`);
    }
    if (byScenario.has(result.title)) {
      throw new Error(`${runtime} reported duplicate scenario ${JSON.stringify(result.title)}`);
    }
    byScenario.set(result.title, result.duration);
  }
  const missing = expectedScenarios.filter(scenario => !byScenario.has(scenario));
  if (missing.length) {
    throw new Error(`${runtime} did not report: ${missing.join(", ")}`);
  }
  return byScenario;
}

async function measure(runner, label) {
  const outputFile = path.join(
    temporaryDirectory,
    `${runner.runtime.toLowerCase()}-${label}.json`
  );
  console.log(`${label}: ${runner.runtime}`);
  await run(runner.script, outputFile);
  return resultsFrom(JSON.parse(await readFile(outputFile, "utf8")), runner.runtime);
}

function median(values) {
  const ordered = values.toSorted((left, right) => left - right);
  const middle = Math.floor(ordered.length / 2);
  return ordered.length % 2 === 0
    ? (ordered[middle - 1] + ordered[middle]) / 2
    : ordered[middle];
}

function range(values) {
  return `${Math.round(Math.min(...values) * 100) / 100}–${
    Math.round(Math.max(...values) * 100) / 100
  }`;
}

try {
  for (const runner of runners) await measure(runner, "warmup");

  const samples = new Map(runners.map(runner => [
    runner.runtime,
    new Map(expectedScenarios.map(scenario => [scenario, []]))
  ]));
  for (let index = 0; index < sampleCount; index += 1) {
    const orderedRunners = index % 2 === 0 ? runners : runners.toReversed();
    for (const runner of orderedRunners) {
      const results = await measure(runner, `sample-${index + 1}`);
      for (const [scenario, duration] of results) {
        samples.get(runner.runtime).get(scenario).push(duration);
      }
    }
  }

  console.log(`\nLarge-form comparison (${sampleCount} samples; median, lower is better)`);
  console.table(expectedScenarios.map(scenario => {
    const jsdomSamples = samples.get("jsdom").get(scenario);
    const servoSamples = samples.get("Servo").get(scenario);
    const jsdomMedian = median(jsdomSamples);
    const servoMedian = median(servoSamples);
    return {
      scenario,
      "jsdom median (ms)": Math.round(jsdomMedian * 100) / 100,
      "Servo median (ms)": Math.round(servoMedian * 100) / 100,
      "Servo / jsdom": `${Math.round((servoMedian / jsdomMedian) * 100) / 100}x`,
      "jsdom range (ms)": range(jsdomSamples),
      "Servo range (ms)": range(servoSamples)
    };
  }));
} finally {
  await rm(temporaryDirectory, { recursive: true, force: true });
}
