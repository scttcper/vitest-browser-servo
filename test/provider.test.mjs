import assert from "node:assert/strict";
import { chmod, mkdtemp, readdir, readFile, realpath, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import { servo } from "../src/index.js";
import { resolveServoExecutable } from "../src/executable.js";
import { startServoWebDriver } from "../src/webdriver.js";

const directory = path.dirname(fileURLToPath(import.meta.url));
const fakeServo = path.join(directory, "fixtures/fake-servoshell.mjs");

async function temporaryFile(name) {
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "vitest-servo-test-"));
  return path.join(tempDirectory, name);
}

async function readEvents(filename) {
  const source = await readFile(filename, "utf8");
  return source.trim().split("\n").filter(Boolean).map(line => JSON.parse(line));
}

test("the public factory describes a Servo-only provider", () => {
  const option = servo();
  assert.equal(option.name, "servo");
  assert.deepEqual(option.supportedBrowser, ["servo"]);
  assert.equal(typeof option.providerFactory, "function");
});

test("discovers Servo on PATH and normalizes relative explicit paths", async t => {
  if (process.platform === "win32") t.skip("executable mode semantics differ on Windows");

  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "vitest-servo-path-"));
  const command = path.join(tempDirectory, "servoshell");
  await writeFile(command, "#!/bin/sh\nexit 0\n");
  await chmod(command, 0o755);

  assert.equal(
    await resolveServoExecutable({ env: { PATH: tempDirectory }, platform: process.platform }),
    await realpath(command)
  );
  await assert.rejects(
    resolveServoExecutable({
      executable: "",
      env: { PATH: tempDirectory, SERVO_SHELL_PATH: command },
      platform: process.platform
    }),
    /non-empty string/
  );
  assert.equal(
    await resolveServoExecutable({
      executable: "./servoshell",
      cwd: tempDirectory,
      env: { PATH: "" },
      platform: process.platform
    }),
    await realpath(command)
  );
});

test("starts, drives, and idempotently closes one WebDriver session", async () => {
  const eventsFile = await temporaryFile("events.jsonl");
  const driver = await startServoWebDriver({
    executable: process.execPath,
    args: [fakeServo],
    env: { FAKE_SERVO_EVENTS_FILE: eventsFile },
    startupTimeout: 3_000
  });

  await driver.navigate("http://127.0.0.1:5173/__vitest_test__/");
  const syncResult = await driver.execute("return arguments[0]", [42]);
  const asyncResult = await driver.executeAsync("arguments[0]()", []);
  assert.equal(syncResult.received.script, "return arguments[0]");
  assert.equal(syncResult.received.args[0], 42);
  assert.equal(asyncResult.received.script, "arguments[0]()");

  await Promise.all([driver.close(), driver.close()]);
  const events = await readEvents(eventsFile);
  assert.deepEqual(
    events.map(event => [event.method, event.path]),
    [
      ["POST", "/session"],
      ["POST", "/session/fake-session/url"],
      ["POST", "/session/fake-session/execute/sync"],
      ["POST", "/session/fake-session/execute/async"],
      ["DELETE", "/session/fake-session"]
    ]
  );
});

test("implements Vitest's provider lifecycle and viewport mapping", async () => {
  const argsFile = await temporaryFile("args.json");
  const eventsFile = await temporaryFile("events.jsonl");
  const messages = [];
  const project = {
    config: {
      browser: {
        headless: true,
        viewport: { width: 800, height: 600 }
      }
    },
    vitest: { logger: { log: message => messages.push(message) } }
  };
  const option = servo({
    executable: process.execPath,
    args: [fakeServo, "--fake-user-argument"],
    env: {
      FAKE_SERVO_ARGS_FILE: argsFile,
      FAKE_SERVO_EVENTS_FILE: eventsFile
    },
    startupTimeout: 3_000
  });
  const provider = option.providerFactory(project);

  assert.equal(provider.name, "servo");
  assert.equal(provider.supportsParallelism, true);
  assert.deepEqual(provider.getCommandsContext("unused"), {});
  await provider.openPage("serial", "http://127.0.0.1:5173/__vitest_test__/", {
    parallel: false
  });
  await provider.close();
  await provider.close();

  const launchArguments = JSON.parse(await readFile(argsFile, "utf8"));
  assert(launchArguments.includes("--fake-user-argument"));
  assert(launchArguments.includes("--headless"));
  assert(launchArguments.includes("--screen-size=800x600"));
  assert(messages.some(message => message.includes("starting")));
  assert(messages.some(message => message.includes("closing WebDriver session")));
});

test("runs concurrent Vitest sessions in isolated Servo processes", async () => {
  const barrierFile = await temporaryFile("parallel-barrier.txt");
  const eventsFile = await temporaryFile("parallel-events.jsonl");
  const project = {
    config: { browser: { headless: true } },
    vitest: { logger: { log() {} } }
  };
  const provider = servo({
    executable: process.execPath,
    args: [fakeServo],
    env: {
      FAKE_SERVO_EVENTS_FILE: eventsFile,
      FAKE_SERVO_PARALLEL_BARRIER_FILE: barrierFile,
      FAKE_SERVO_PARALLEL_BARRIER_TARGET: "2"
    },
    startupTimeout: 4_000
  }).providerFactory(project);

  await Promise.all([
    provider.openPage("worker-a", "http://127.0.0.1/__vitest_test__/?worker=a", {
      parallel: true
    }),
    provider.openPage("worker-b", "http://127.0.0.1/__vitest_test__/?worker=b", {
      parallel: true
    })
  ]);
  await provider.close();

  const events = await readEvents(eventsFile);
  const processIds = new Set(events.map(event => event.pid));
  assert.equal(processIds.size, 2);
  for (const processId of processIds) {
    const processEvents = events.filter(event => event.pid === processId);
    assert.deepEqual(
      processEvents.map(event => [event.method, event.path]),
      [
        ["POST", "/session"],
        ["POST", "/session/fake-session/url"],
        ["DELETE", "/session/fake-session"]
      ]
    );
  }
  assert.deepEqual(
    events
      .filter(event => event.path === "/session/fake-session/url")
      .map(event => event.body.url)
      .sort(),
    [
      "http://127.0.0.1/__vitest_test__/?worker=a",
      "http://127.0.0.1/__vitest_test__/?worker=b"
    ]
  );
});

test("surfaces Servo startup logs and still cleans up", async () => {
  await assert.rejects(
    startServoWebDriver({
      executable: process.execPath,
      args: [fakeServo],
      env: { FAKE_SERVO_FAIL: "1" },
      startupTimeout: 2_000
    }),
    error => {
      assert.match(error.message, /exited before WebDriver startup/);
      assert.match(error.message, /intentional fake Servo startup failure/);
      return true;
    }
  );
});

test("rejects a truncated WebDriver response without waiting for the timeout", async () => {
  const driver = await startServoWebDriver({
    executable: process.execPath,
    args: [fakeServo],
    env: { FAKE_SERVO_ABORT_NAVIGATION: "1" },
    commandTimeout: 5_000,
    startupTimeout: 3_000
  });

  const startedAt = performance.now();
  await assert.rejects(driver.navigate("http://127.0.0.1/"), /aborted|ended early|socket hang up/i);
  assert(performance.now() - startedAt < 1_000);
  await driver.close();
});

test("removes the temporary profile when spawn fails synchronously", async () => {
  const profiles = async () => (await readdir(os.tmpdir()))
    .filter(name => name.startsWith("vitest-servo-"))
    .sort();
  const before = await profiles();

  await assert.rejects(
    startServoWebDriver({
      executable: process.execPath,
      args: ["invalid\0argument"]
    }),
    /Could not spawn Servo/
  );

  assert.deepEqual(await profiles(), before);
});

test("provider teardown cancels every in-flight Servo startup", async () => {
  const project = {
    config: { browser: { headless: true } },
    vitest: { logger: { log() {} } }
  };
  const provider = servo({
    executable: process.execPath,
    args: [fakeServo],
    env: { FAKE_SERVO_LISTEN_DELAY_MS: "5000" },
    startupTimeout: 10_000,
    shutdownTimeout: 500
  }).providerFactory(project);

  const rejectedOpenings = ["cancelled-a", "cancelled-b"].map(sessionId => assert.rejects(
    provider.openPage(sessionId, `http://127.0.0.1/?${sessionId}`, { parallel: true }),
    /teardown|closed|aborted|startup/i
  ));
  await delay(100);

  const startedAt = performance.now();
  await provider.close();
  await Promise.all(rejectedOpenings);
  assert(performance.now() - startedAt < 2_000);
});
