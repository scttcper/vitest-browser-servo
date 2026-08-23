import { constants } from "node:fs";
import { access, realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

function isPathLike(value) {
  return path.isAbsolute(value) || value.includes("/") || value.includes("\\");
}

function executableNames(command, platform, env) {
  if (platform !== "win32" || path.extname(command)) return [command];
  const extensions = (env.PATHEXT || ".EXE;.CMD;.BAT;.COM")
    .split(";")
    .filter(Boolean);
  return [command, ...extensions.map(extension => `${command}${extension.toLowerCase()}`)];
}

async function isExecutable(candidate, platform) {
  try {
    await access(candidate, platform === "win32" ? constants.F_OK : constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function findCommand(command, { cwd, env, platform }) {
  if (isPathLike(command)) {
    const candidate = path.resolve(cwd, command);
    return await isExecutable(candidate, platform) ? realpath(candidate) : undefined;
  }

  const directories = (env.PATH || "").split(path.delimiter).filter(Boolean);
  for (const directory of directories) {
    for (const name of executableNames(command, platform, env)) {
      const candidate = path.resolve(directory, name);
      if (await isExecutable(candidate, platform)) return realpath(candidate);
    }
  }
}

function applicationCandidates(platform, homeDirectory) {
  if (platform !== "darwin") return [];
  return [
    "/Applications/Servo.app/Contents/MacOS/servo",
    "/Applications/Servo.app/Contents/MacOS/servoshell",
    path.join(homeDirectory, "Applications/Servo.app/Contents/MacOS/servo"),
    path.join(homeDirectory, "Applications/Servo.app/Contents/MacOS/servoshell")
  ];
}

/** Resolve an explicit Servo path or discover `servoshell`/`servo` on PATH. */
export async function resolveServoExecutable({
  executable,
  cwd = process.cwd(),
  env = process.env,
  platform = process.platform,
  homeDirectory = os.homedir()
} = {}) {
  const requested = executable ?? env.SERVO_SHELL_PATH ?? env.SERVO_BINARY_PATH;
  if (requested !== undefined && (typeof requested !== "string" || requested.length === 0)) {
    throw new TypeError("Servo executable must be a non-empty string");
  }

  if (requested) {
    const resolved = await findCommand(requested, { cwd, env, platform });
    if (resolved) return resolved;
    throw new Error(
      `Could not execute Servo at ${JSON.stringify(requested)}. ` +
      "Pass servo({ executable: '/absolute/path/to/servoshell' }) or set SERVO_SHELL_PATH."
    );
  }

  for (const command of ["servoshell", "servo"]) {
    const resolved = await findCommand(command, { cwd, env, platform });
    if (resolved) return resolved;
  }
  for (const candidate of applicationCandidates(platform, homeDirectory)) {
    if (await isExecutable(candidate, platform)) return realpath(candidate);
  }

  throw new Error(
    "Could not find a Servo executable. Install an official Servo release, put `servoshell` " +
    "or `servo` on PATH, pass servo({ executable }), or set SERVO_SHELL_PATH."
  );
}
