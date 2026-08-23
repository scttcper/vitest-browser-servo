import { resolveServoExecutable } from "./executable.js";
import { startServoWebDriver } from "./webdriver.js";

const DEFAULT_SCREEN_SIZE = "1024x768";

function parseEnvironmentArguments(env) {
  if (!env.SERVO_SHELL_ARGS_JSON) return [];
  let value;
  try {
    value = JSON.parse(env.SERVO_SHELL_ARGS_JSON);
  } catch (error) {
    throw new Error("SERVO_SHELL_ARGS_JSON must contain a JSON array of strings", { cause: error });
  }
  if (!Array.isArray(value) || value.some(argument => typeof argument !== "string")) {
    throw new TypeError("SERVO_SHELL_ARGS_JSON must contain a JSON array of strings");
  }
  return value;
}

function resolveScreenSize(project, options, env) {
  const explicit = options.screenSize ?? env.SERVO_SCREEN_SIZE;
  if (explicit !== undefined) return explicit;

  const viewport = project.config?.browser?.viewport;
  if (viewport && Number.isInteger(viewport.width) && Number.isInteger(viewport.height)) {
    return `${viewport.width}x${viewport.height}`;
  }
  return DEFAULT_SCREEN_SIZE;
}

function isDebugEnabled(options, env) {
  if (options.debug !== undefined) return options.debug;
  return env.SERVO_PROVIDER_DEBUG === "1";
}

export class ServoBrowserProvider {
  name = "servo";
  supportsParallelism = true;
  project;
  options;
  sessions = new Map();
  closePromise;
  closing = false;

  constructor(project, options = {}) {
    this.project = project;
    this.options = options;
  }

  getCommandsContext() {
    return {};
  }

  log(message) {
    this.project.vitest?.logger?.log?.(`[servo] ${message}`);
  }

  async openBrowser(sessionId) {
    if (this.closing) throw new Error("The Servo provider is already closed");

    let session = this.sessions.get(sessionId);
    if (!session) {
      const startupAbortController = new AbortController();
      session = {
        startupAbortController,
        driverPromise: this.startBrowser(sessionId, startupAbortController.signal)
      };
      this.sessions.set(sessionId, session);
      session.driverPromise.then(undefined, () => {
        if (this.sessions.get(sessionId) === session) this.sessions.delete(sessionId);
      });
    }

    const driver = await session.driverPromise;
    if (this.closing) throw new Error("The Servo provider was closed during startup");
    return driver;
  }

  async startBrowser(sessionId, signal) {
    const processEnv = process.env;
    const executable = await resolveServoExecutable({
      executable: this.options.executable,
      env: processEnv
    });
    const args = this.options.args ?? parseEnvironmentArguments(processEnv);
    const debug = isDebugEnabled(this.options, processEnv);
    const headless = this.options.headless ?? this.project.config?.browser?.headless ?? true;
    const screenSize = resolveScreenSize(this.project, this.options, processEnv);

    this.log(`starting session ${sessionId} with ${executable}`);
    return startServoWebDriver({
      executable,
      args,
      env: this.options.env,
      headless,
      screenSize,
      startupTimeout: this.options.startupTimeout,
      commandTimeout: this.options.commandTimeout,
      navigationTimeout: this.options.navigationTimeout,
      shutdownTimeout: this.options.shutdownTimeout,
      signal,
      onOutput: debug
        ? (channel, chunk) => this.log(`session ${sessionId} ${channel}: ${chunk.trimEnd()}`)
        : undefined
    });
  }

  async openPage(sessionId, url) {
    const driver = await this.openBrowser(sessionId);
    await driver.navigate(url);
  }

  async close() {
    if (!this.closePromise) {
      this.closing = true;
      const sessions = [...this.sessions.entries()];
      this.sessions.clear();
      for (const [, session] of sessions) {
        session.startupAbortController.abort(
          new Error("Servo provider teardown interrupted startup")
        );
      }
      this.closePromise = (async () => {
        const results = await Promise.allSettled(sessions.map(async ([sessionId, session]) => {
          const driver = await session.driverPromise.catch(() => undefined);
          if (!driver) return;
          this.log(`closing WebDriver session ${sessionId}`);
          await driver.close();
        }));
        const errors = results
          .filter(result => result.status === "rejected")
          .map(result => result.reason);
        if (errors.length) {
          throw new AggregateError(errors, "Could not close every Servo WebDriver session");
        }
      })();
    }
    await this.closePromise;
  }
}
