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

/** @typedef {"stdout" | "stderr"} OutputChannel */
/** @typedef {(channel: OutputChannel, chunk: string) => void} OutputHandler */
/** @typedef {() => string} TailReader */
/**
 * @typedef {import("node:child_process").ChildProcessByStdio<
 *   null,
 *   import("node:stream").Readable,
 *   import("node:stream").Readable
 * >} ServoChild
 */
/**
 * @typedef {{
 *   code: number | null,
 *   signal: NodeJS.Signals | null,
 *   error: Error | undefined
 * }} ChildExitStatus
 */
/**
 * @typedef {{
 *   method?: string,
 *   body?: unknown,
 *   timeout: number,
 *   signal?: AbortSignal
 * }} WebDriverRequestOptions
 */
/**
 * @typedef {{
 *   method?: string,
 *   body?: unknown,
 *   timeout?: number,
 *   signal?: AbortSignal
 * }} WebDriverCommandOptions
 */
/**
 * @typedef {{
 *   executable: string,
 *   args?: readonly string[],
 *   env?: Readonly<Record<string, string | undefined>>,
 *   headless?: boolean,
 *   screenSize?: string,
 *   startupTimeout?: number,
 *   commandTimeout?: number,
 *   navigationTimeout?: number,
 *   shutdownTimeout?: number,
 *   signal?: AbortSignal,
 *   onOutput?: OutputHandler
 * }} StartServoWebDriverOptions
 */
/**
 * @typedef {{
 *   navigate(url: string): Promise<void>,
 *   execute(script: string, args?: readonly unknown[]): Promise<unknown>,
 *   executeAsync(script: string, args?: readonly unknown[]): Promise<unknown>,
 *   close(): Promise<void>
 * }} ServoWebDriver
 */
/** @typedef {{ value: unknown, message?: unknown }} WebDriverEnvelope */

/**
 * @param {number} milliseconds
 * @returns {Promise<void>}
 */
function delay(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

/**
 * @param {number | undefined} value
 * @param {number} fallback
 * @param {string} name
 */
function positiveTimeout(value, fallback, name) {
  if (value === undefined) return fallback;
  if (!Number.isFinite(value) || value <= 0) {
    throw new TypeError(`${name} must be a positive number`);
  }
  return value;
}

/**
 * @param {import("node:stream").Readable} stream
 * @param {OutputChannel} channel
 * @param {OutputHandler | undefined} onOutput
 * @returns {TailReader}
 */
function tailCollector(stream, channel, onOutput) {
  let tail = "";
  stream.setEncoding("utf8");
  stream.on("data", (/** @type {string} */ chunk) => {
    tail = `${tail}${chunk}`.slice(-LOG_TAIL_LIMIT);
    onOutput?.(channel, chunk);
  });
  return () => tail.trimEnd();
}

/** @returns {Promise<number>} */
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

/**
 * @param {TailReader} stdoutTail
 * @param {TailReader} stderrTail
 */
function describeLogs(stdoutTail, stderrTail) {
  const stdout = stdoutTail();
  const stderr = stderrTail();
  return [
    stdout ? `Servo stdout (tail):\n${stdout}` : "",
    stderr ? `Servo stderr (tail):\n${stderr}` : ""
  ].filter(Boolean).join("\n");
}

/**
 * @param {unknown} error
 * @param {TailReader} stdoutTail
 * @param {TailReader} stderrTail
 */
function withLogs(error, stdoutTail, stderrTail) {
  const message = error instanceof Error ? error.message : String(error);
  const logs = describeLogs(stdoutTail, stderrTail);
  return new Error(logs ? `${message}\n${logs}` : message, { cause: error });
}

/** @param {string | undefined} current */
function mergeNoProxy(current) {
  const values = new Set(
    String(current || "").split(",").map(value => value.trim()).filter(Boolean)
  );
  values.add("127.0.0.1");
  values.add("localhost");
  return [...values].join(",");
}

/**
 * @param {Readonly<Record<string, string | undefined>>} overrides
 * @returns {NodeJS.ProcessEnv}
 */
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

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * @param {unknown} value
 * @returns {value is WebDriverEnvelope}
 */
function isWebDriverEnvelope(value) {
  return isRecord(value) && Object.hasOwn(value, "value");
}

/** @param {string} message */
function connectionResetError(message) {
  return Object.assign(new Error(message), { code: "ECONNRESET" });
}

/**
 * @param {string} baseUrl
 * @param {string} pathname
 * @param {WebDriverRequestOptions} options
 * @returns {Promise<unknown>}
 */
async function request(baseUrl, pathname, {
  method = "GET",
  body,
  timeout,
  signal
}) {
  const serializedBody = body === undefined ? undefined : JSON.stringify(body);
  /** @type {Promise<{ statusCode: number, text: string }>} */
  const responsePromise = new Promise((resolve, reject) => {
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
      response.on("data", (/** @type {string} */ chunk) => { text += chunk; });
      response.on("end", () => resolve({ statusCode: response.statusCode || 0, text }));
      response.once("error", reject);
      response.once("aborted", () => {
        reject(connectionResetError(
          `WebDriver response was aborted (${method} /${pathname})`
        ));
      });
      response.once("close", () => {
        if (!response.complete) {
          reject(connectionResetError(
            `WebDriver response ended early (${method} /${pathname})`
          ));
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
  const { statusCode, text } = await responsePromise;
  /** @type {unknown} */
  let payload;
  try {
    payload = text ? JSON.parse(text) : { value: null };
  } catch (error) {
    throw new Error(
      `WebDriver returned invalid JSON (HTTP ${statusCode}): ${text.slice(0, 500)}`,
      { cause: error }
    );
  }

  if (!isWebDriverEnvelope(payload)) {
    throw new Error(
      `WebDriver returned an invalid response envelope (HTTP ${statusCode}): ${text.slice(0, 500)}`
    );
  }

  const errorValue = isRecord(payload.value) && typeof payload.value.error === "string"
    ? payload.value
    : undefined;
  if (statusCode < 200 || statusCode >= 300 || errorValue) {
    const detail = typeof errorValue?.message === "string"
      ? errorValue.message
      : typeof payload.message === "string"
        ? payload.message
        : `HTTP ${statusCode}`;
    const error = new Error(`WebDriver command failed (${method} /${pathname}): ${detail}`);
    if (typeof errorValue?.stacktrace === "string") {
      error.stack = `${error.stack}\n${errorValue.stacktrace}`;
    }
    throw error;
  }
  return payload.value;
}

/**
 * @param {number} port
 * @param {AbortSignal | undefined} signal
 * @returns {Promise<boolean>}
 */
function canConnect(port, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new Error("Servo startup was aborted"));
      return;
    }
    const socket = createConnection({ host: HOST, port });
    const abort = () => socket.destroy(
      signal?.reason ?? new Error("Servo startup was aborted")
    );
    signal?.addEventListener("abort", abort, { once: true });
    socket.setTimeout(250);
    socket.once("connect", () => {
      signal?.removeEventListener("abort", abort);
      socket.destroy();
      resolve(true);
    });
    socket.once("timeout", () => socket.destroy());
    socket.once("error", (/** @type {Error} */ error) => {
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

/**
 * @param {Promise<ChildExitStatus>} childDone
 * @param {number} milliseconds
 */
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

/**
 * @param {ServoChild} child
 * @param {Promise<ChildExitStatus>} childDone
 * @param {number} shutdownTimeout
 */
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

/**
 * @param {string} message
 * @param {ChildExitStatus} status
 */
function childExitError(message, { code, signal, error }) {
  const detail = error?.message
    ?? (signal ? `signal ${signal}` : `exit code ${code}`);
  return new Error(`${message} (${detail})`, { cause: error });
}

/**
 * @param {Error[]} errors
 * @param {string} message
 * @returns {never}
 */
function throwCollectedErrors(errors, message) {
  if (errors.length === 0) throw new Error("Expected at least one Servo lifecycle error");
  if (errors.length === 1) throw errors[0];
  throw new AggregateError(errors, message);
}

/**
 * @param {string} configDirectory
 * @param {Error[]} errors
 */
async function removeConfigDirectory(configDirectory, errors) {
  try {
    await rm(configDirectory, { recursive: true, force: true });
  } catch (error) {
    errors.push(new Error(`Could not remove Servo config directory ${configDirectory}`, {
      cause: error
    }));
  }
}

/**
 * @param {{
 *   child: ServoChild,
 *   childDone: Promise<ChildExitStatus>,
 *   shutdownTimeout: number,
 *   configDirectory: string,
 *   stdoutTail: TailReader,
 *   stderrTail: TailReader,
 *   errors: Error[]
 * }} state
 */
async function finalizeServoProcess({
  child,
  childDone,
  shutdownTimeout,
  configDirectory,
  stdoutTail,
  stderrTail,
  errors
}) {
  try {
    await terminateChild(child, childDone, shutdownTimeout);
  } catch (error) {
    errors.push(withLogs(error, stdoutTail, stderrTail));
  }
  await removeConfigDirectory(configDirectory, errors);
}

/** @param {unknown} args */
function validateArguments(args) {
  if (
    !Array.isArray(args)
    || args.some((/** @type {unknown} */ argument) => typeof argument !== "string")
  ) {
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

/**
 * Start Servo and create one dependency-free W3C WebDriver session.
 *
 * @param {StartServoWebDriverOptions} options
 * @returns {Promise<ServoWebDriver>}
 */
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
  /** @type {ServoChild} */
  let child;
  try {
    child = spawn(executable, launchArguments, {
      cwd: path.dirname(executable),
      env: childEnvironment(env),
      stdio: ["ignore", "pipe", "pipe"]
    });
  } catch (error) {
    const errors = [new Error(`Could not spawn Servo at ${executable}`, { cause: error })];
    await removeConfigDirectory(configDirectory, errors);
    throwCollectedErrors(errors, "Could not spawn Servo or remove its config directory");
  }
  const stdoutTail = tailCollector(child.stdout, "stdout", onOutput);
  const stderrTail = tailCollector(child.stderr, "stderr", onOutput);
  /** @type {Error | undefined} */
  let spawnError;
  child.once("error", error => { spawnError = error; });
  /** @type {Promise<ChildExitStatus>} */
  const childDone = new Promise(resolve => {
    child.once("close", (code, signal) => resolve({ code, signal, error: spawnError }));
  });

  /** @type {string} */
  let sessionId;
  try {
    const deadline = Date.now() + startupTimeout;
    let listening = false;
    while (Date.now() < deadline) {
      if (signal?.aborted) throw signal.reason ?? new Error("Servo startup was aborted");
      if (spawnError) throw spawnError;
      if (child.exitCode !== null || child.signalCode !== null) {
        const status = await childDone;
        throw childExitError("Servo exited before WebDriver startup", status);
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
    if (!isRecord(value) || typeof value.sessionId !== "string" || !value.sessionId) {
      throw new Error("WebDriver session response did not include value.sessionId");
    }
    sessionId = value.sessionId;
  } catch (error) {
    /** @type {Error[]} */
    const errors = [withLogs(error, stdoutTail, stderrTail)];
    await finalizeServoProcess({
      child,
      childDone,
      shutdownTimeout,
      configDirectory,
      stdoutTail,
      stderrTail,
      errors
    });
    throwCollectedErrors(errors, "Servo startup and cleanup both failed");
  }

  const sessionPath = `session/${encodeURIComponent(sessionId)}`;
  /** @type {Promise<void> | undefined} */
  let closePromise;

  /**
   * @param {string} pathname
   * @param {WebDriverCommandOptions} options
   */
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

  /** @type {ServoWebDriver} */
  const driver = {
    async navigate(url) {
      if (typeof url !== "string" || url.length === 0) {
        throw new TypeError("url must be a non-empty string");
      }
      await command("url", {
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
          /** @type {Error[]} */
          const errors = [];
          const childWasRunning = child.exitCode === null
            && child.signalCode === null
            && !spawnError;
          if (childWasRunning) {
            try {
              await request(baseUrl, sessionPath, {
                method: "DELETE",
                timeout: Math.min(commandTimeout, 1_000)
              });
            } catch (error) {
              errors.push(withLogs(error, stdoutTail, stderrTail));
            }
          } else {
            const status = await childDone;
            errors.push(withLogs(
              childExitError("Servo exited unexpectedly before WebDriver teardown", status),
              stdoutTail,
              stderrTail
            ));
          }
          await finalizeServoProcess({
            child,
            childDone,
            shutdownTimeout,
            configDirectory,
            stdoutTail,
            stderrTail,
            errors
          });
          if (errors.length) throwCollectedErrors(errors, "Could not cleanly close Servo");
        })();
      }
      return closePromise;
    }
  };
  return driver;
}
