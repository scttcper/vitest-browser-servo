import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { createConnection, createServer } from "node:net";
import os from "node:os";
import path from "node:path";

const HOST = "127.0.0.1";
const DEFAULT_STARTUP_TIMEOUT = 20_000;
const DEFAULT_COMMAND_TIMEOUT = 5_000;
const DEFAULT_NAVIGATION_TIMEOUT = 60_000;
const DEFAULT_SHUTDOWN_TIMEOUT = 2_500;
const LOG_TAIL_LIMIT = 32_000;

function delay(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

function positiveTimeout(value, fallback, name) {
  if (value === undefined) return fallback;
  if (!Number.isFinite(value) || value <= 0) {
    throw new TypeError(`${name} must be a positive number`);
  }
  return value;
}

function tailCollector(stream, channel, onOutput) {
  let tail = "";
  stream?.setEncoding("utf8");
  stream?.on("data", chunk => {
    tail = `${tail}${chunk}`.slice(-LOG_TAIL_LIMIT);
    onOutput?.(channel, chunk);
  });
  return () => tail.trimEnd();
}

function reservePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.once("error", reject);
    server.listen(0, HOST, () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("Could not reserve a WebDriver port"));
        return;
      }
      server.close(error => error ? reject(error) : resolve(address.port));
    });
  });
}

function describeLogs(stdoutTail, stderrTail) {
  const stdout = stdoutTail();
  const stderr = stderrTail();
  return [
    stdout ? `Servo stdout (tail):\n${stdout}` : "",
    stderr ? `Servo stderr (tail):\n${stderr}` : ""
  ].filter(Boolean).join("\n");
}

function withLogs(error, stdoutTail, stderrTail) {
  const message = error instanceof Error ? error.message : String(error);
  const logs = describeLogs(stdoutTail, stderrTail);
  return new Error(logs ? `${message}\n${logs}` : message, { cause: error });
}

function mergeNoProxy(current) {
  const values = new Set(
    String(current || "").split(",").map(value => value.trim()).filter(Boolean)
  );
  values.add("127.0.0.1");
  values.add("localhost");
  return [...values].join(",");
}

function childEnvironment(overrides) {
  const env = { ...process.env, ...overrides };
  env.NO_PROXY = mergeNoProxy(env.NO_PROXY);
  env.no_proxy = mergeNoProxy(env.no_proxy || env.NO_PROXY);
  for (const [name, value] of Object.entries(env)) {
    if (value === undefined) delete env[name];
  }
  return env;
}

class CommandTimeoutError extends Error {
  name = "TimeoutError";
}

async function request(baseUrl, pathname, {
  method = "GET",
  body,
  timeout,
  signal
} = {}) {
  const serializedBody = body === undefined ? undefined : JSON.stringify(body);
  const { statusCode, text } = await new Promise((resolve, reject) => {
    const command = httpRequest(`${baseUrl}/${pathname}`, {
      method,
      headers: serializedBody === undefined
        ? undefined
        : {
            "content-type": "application/json",
            "content-length": Buffer.byteLength(serializedBody)
          },
      signal
    }, response => {
      response.setEncoding("utf8");
      let text = "";
      response.on("data", chunk => { text += chunk; });
      response.on("end", () => resolve({ statusCode: response.statusCode || 0, text }));
      response.once("error", reject);
      response.once("aborted", () => {
        const error = new Error(`WebDriver response was aborted (${method} /${pathname})`);
        error.code = "ECONNRESET";
        reject(error);
      });
      response.once("close", () => {
        if (!response.complete) {
          const error = new Error(`WebDriver response ended early (${method} /${pathname})`);
          error.code = "ECONNRESET";
          reject(error);
        }
      });
    });
    command.setTimeout(timeout, () => {
      command.destroy(new CommandTimeoutError(
        `WebDriver command timed out after ${timeout} ms (${method} /${pathname})`
      ));
    });
    command.once("error", reject);
    command.end(serializedBody);
  });
  let payload;
  try {
    payload = text ? JSON.parse(text) : { value: null };
  } catch (error) {
    throw new Error(
      `WebDriver returned invalid JSON (HTTP ${statusCode}): ${text.slice(0, 500)}`,
      { cause: error }
    );
  }

  if (statusCode < 200 || statusCode >= 300 || payload?.value?.error) {
    const detail = payload?.value?.message ?? payload?.message ?? `HTTP ${statusCode}`;
    const error = new Error(`WebDriver command failed (${method} /${pathname}): ${detail}`);
    if (payload?.value?.stacktrace) error.stack = `${error.stack}\n${payload.value.stacktrace}`;
    throw error;
  }
  return payload?.value;
}

function canConnect(port, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new Error("Servo startup was aborted"));
      return;
    }
    const socket = createConnection({ host: HOST, port });
    const abort = () => socket.destroy(signal.reason ?? new Error("Servo startup was aborted"));
    signal?.addEventListener("abort", abort, { once: true });
    socket.setTimeout(250);
    socket.once("connect", () => {
      signal?.removeEventListener("abort", abort);
      socket.destroy();
      resolve(true);
    });
    socket.once("timeout", () => socket.destroy());
    socket.once("error", error => {
      signal?.removeEventListener("abort", abort);
      if (signal?.aborted) reject(signal.reason ?? error);
      else resolve(false);
    });
    socket.once("close", () => {
      signal?.removeEventListener("abort", abort);
      resolve(false);
    });
  });
}

async function awaitChild(childDone, milliseconds) {
  let timeout;
  try {
    return await Promise.race([
      childDone.then(() => true),
      new Promise(resolve => {
        timeout = setTimeout(() => resolve(false), milliseconds);
      })
    ]);
  } finally {
    clearTimeout(timeout);
  }
}

async function terminateChild(child, childDone, shutdownTimeout) {
  if (child.exitCode !== null || child.signalCode !== null) {
    await childDone;
    return;
  }

  child.kill("SIGTERM");
  if (await awaitChild(childDone, shutdownTimeout)) return;
  child.kill("SIGKILL");
  if (!await awaitChild(childDone, shutdownTimeout)) {
    throw new Error("Servo did not exit after SIGKILL");
  }
}

function validateArguments(args) {
  if (!Array.isArray(args) || args.some(argument => typeof argument !== "string")) {
    throw new TypeError("args must be an array of strings");
  }
  const providerOwned = ["--webdriver", "--config-dir", "--screen-size"];
  const conflict = args.find(argument =>
    providerOwned.some(name => argument === name || argument.startsWith(`${name}=`))
  );
  if (conflict) {
    throw new Error(`Servo argument ${JSON.stringify(conflict)} is owned by the provider`);
  }
}

/** Start Servo and create one dependency-free W3C WebDriver session. */
export async function startServoWebDriver({
  executable,
  args = [],
  env = {},
  headless = true,
  screenSize = "1024x768",
  startupTimeout: startupTimeoutOption,
  commandTimeout: commandTimeoutOption,
  navigationTimeout: navigationTimeoutOption,
  shutdownTimeout: shutdownTimeoutOption,
  signal,
  onOutput
}) {
  if (typeof executable !== "string" || executable.length === 0) {
    throw new TypeError("executable must be a non-empty path");
  }
  validateArguments(args);
  if (typeof env !== "object" || env === null || Array.isArray(env)) {
    throw new TypeError("env must be an object");
  }
  if (typeof headless !== "boolean") throw new TypeError("headless must be a boolean");
  if (typeof screenSize !== "string" || !/^[1-9]\d*x[1-9]\d*$/.test(screenSize)) {
    throw new TypeError("screenSize must use WIDTHxHEIGHT syntax");
  }

  const startupTimeout = positiveTimeout(
    startupTimeoutOption,
    DEFAULT_STARTUP_TIMEOUT,
    "startupTimeout"
  );
  const commandTimeout = positiveTimeout(
    commandTimeoutOption,
    DEFAULT_COMMAND_TIMEOUT,
    "commandTimeout"
  );
  const navigationTimeout = positiveTimeout(
    navigationTimeoutOption,
    DEFAULT_NAVIGATION_TIMEOUT,
    "navigationTimeout"
  );
  const shutdownTimeout = positiveTimeout(
    shutdownTimeoutOption,
    DEFAULT_SHUTDOWN_TIMEOUT,
    "shutdownTimeout"
  );

  const port = await reservePort();
  const configDirectory = await mkdtemp(path.join(os.tmpdir(), "vitest-servo-"));
  const baseUrl = `http://${HOST}:${port}`;
  const launchArguments = [
    ...args,
    ...(headless ? ["--headless"] : []),
    "--temporary-storage",
    `--config-dir=${configDirectory}`,
    `--webdriver=${port}`,
    `--screen-size=${screenSize}`,
    "about:blank"
  ];
  let child;
  try {
    child = spawn(executable, launchArguments, {
      cwd: path.dirname(executable),
      env: childEnvironment(env),
      stdio: ["ignore", "pipe", "pipe"]
    });
  } catch (error) {
    await rm(configDirectory, { recursive: true, force: true });
    throw new Error(`Could not spawn Servo at ${executable}`, { cause: error });
  }
  const stdoutTail = tailCollector(child.stdout, "stdout", onOutput);
  const stderrTail = tailCollector(child.stderr, "stderr", onOutput);
  let spawnError;
  child.once("error", error => { spawnError = error; });
  const childDone = new Promise(resolve => {
    child.once("close", (code, signal) => resolve({ code, signal, error: spawnError }));
  });

  let sessionId;
  try {
    const deadline = Date.now() + startupTimeout;
    let listening = false;
    while (Date.now() < deadline) {
      if (signal?.aborted) throw signal.reason ?? new Error("Servo startup was aborted");
      if (spawnError) throw spawnError;
      if (child.exitCode !== null || child.signalCode !== null) {
        const status = await childDone;
        throw new Error(`Servo exited before WebDriver startup (${JSON.stringify(status)})`);
      }
      if (await canConnect(port, signal)) {
        listening = true;
        break;
      }
      await delay(50);
    }
    if (!listening) {
      throw new Error(`Servo WebDriver did not listen within ${startupTimeout} ms`);
    }

    // Creating a WebDriver session is not safely retryable: Servo can accept
    // the POST and finish it after a client-side timeout. Wait for TCP first,
    // then send exactly one session request with the remaining startup budget.
    const remainingStartupTime = Math.max(1, deadline - Date.now());
    const value = await request(baseUrl, "session", {
      method: "POST",
      body: { capabilities: {} },
      timeout: remainingStartupTime,
      signal
    });
    sessionId = value?.sessionId;
    if (!sessionId) throw new Error("WebDriver session response did not include value.sessionId");
  } catch (error) {
    await terminateChild(child, childDone, shutdownTimeout).catch(() => undefined);
    await rm(configDirectory, { recursive: true, force: true });
    throw withLogs(error, stdoutTail, stderrTail);
  }

  const sessionPath = `session/${encodeURIComponent(sessionId)}`;
  let closePromise;

  function command(pathname, options) {
    if (closePromise) throw new Error("Servo WebDriver session is closed");
    if (child.exitCode !== null || child.signalCode !== null || spawnError) {
      throw withLogs(new Error("Servo is no longer running"), stdoutTail, stderrTail);
    }
    return request(baseUrl, `${sessionPath}/${pathname}`, {
      timeout: commandTimeout,
      ...options
    }).catch(error => {
      throw withLogs(error, stdoutTail, stderrTail);
    });
  }

  return {
    navigate(url) {
      if (typeof url !== "string" || url.length === 0) {
        throw new TypeError("url must be a non-empty string");
      }
      return command("url", {
        method: "POST",
        body: { url },
        timeout: navigationTimeout
      });
    },

    execute(script, args = []) {
      if (typeof script !== "string" || !Array.isArray(args)) {
        throw new TypeError("execute expects a script string and an arguments array");
      }
      return command("execute/sync", { method: "POST", body: { script, args } });
    },

    executeAsync(script, args = []) {
      if (typeof script !== "string" || !Array.isArray(args)) {
        throw new TypeError("executeAsync expects a script string and an arguments array");
      }
      return command("execute/async", { method: "POST", body: { script, args } });
    },

    close() {
      if (!closePromise) {
        closePromise = (async () => {
          const errors = [];
          if (child.exitCode === null && child.signalCode === null && !spawnError) {
            try {
              await request(baseUrl, sessionPath, {
                method: "DELETE",
                timeout: Math.min(commandTimeout, 1_000)
              });
            } catch (error) {
              errors.push(withLogs(error, stdoutTail, stderrTail));
            }
          }
          try {
            await terminateChild(child, childDone, shutdownTimeout);
          } catch (error) {
            errors.push(withLogs(error, stdoutTail, stderrTail));
          } finally {
            await rm(configDirectory, { recursive: true, force: true });
          }
          if (errors.length === 1) throw errors[0];
          if (errors.length > 1) throw new AggregateError(errors, "Could not cleanly close Servo");
        })();
      }
      return closePromise;
    }
  };
}
