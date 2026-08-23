import { spawn } from "node:child_process";
import { rmSync } from "node:fs";
import { cp, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "vitest-browser-servo-packed-"));
const consumerDirectory = path.join(temporaryRoot, "consumer");
const runBrowser = process.argv.includes("--browser");
const pnpmCommand = process.platform === "win32" ? "pnpm.cmd" : "pnpm";

process.once("exit", () => {
  rmSync(temporaryRoot, { recursive: true, force: true });
});

function run(command, args, { cwd, env = process.env, capture = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env,
      stdio: capture ? ["ignore", "pipe", "inherit"] : "inherit"
    });
    let stdout = "";
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", chunk => { stdout += chunk; });
    child.once("error", reject);
    child.once("exit", code => {
      if (code === 0) resolve(stdout);
      else reject(new Error(`${command} ${args.join(" ")} exited with code ${code}`));
    });
  });
}

const packOutput = await run(
  pnpmCommand,
  ["pack", "--json", "--pack-destination", temporaryRoot],
  { cwd: packageRoot, capture: true }
);
const { filename } = JSON.parse(packOutput);
const tarball = filename;

await cp(path.join(packageRoot, "examples/react-form"), consumerDirectory, {
  recursive: true
});
const manifestPath = path.join(consumerDirectory, "package.json");
const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
manifest.dependencies["@ctrl/vitest-browser-servo"] = pathToFileURL(tarball).href;
await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

await run(
  pnpmCommand,
  ["install", "--ignore-scripts", "--no-frozen-lockfile"],
  { cwd: consumerDirectory }
);
await run(
  process.execPath,
  [
    "--input-type=module",
    "--eval",
    "import('@ctrl/vitest-browser-servo').then(({ servo }) => { if (typeof servo !== 'function') process.exit(1) })"
  ],
  { cwd: consumerDirectory }
);

if (runBrowser) {
  await run(pnpmCommand, ["run", "test"], { cwd: consumerDirectory });
} else {
  console.log(`Packed consumer import passed: ${filename}`);
  console.log("Set SERVO_SHELL_PATH and run `pnpm run test:browser` for the real Servo suite.");
}
