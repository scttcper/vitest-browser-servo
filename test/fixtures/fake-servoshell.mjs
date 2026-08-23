#!/usr/bin/env node

import { appendFile, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";

if (process.env.FAKE_SERVO_FAIL === "1") {
  console.error("intentional fake Servo startup failure");
  process.exit(23);
}

const portArgument = process.argv.find(argument => argument.startsWith("--webdriver="));
const port = Number(portArgument?.slice("--webdriver=".length));
if (!Number.isInteger(port)) {
  console.error("missing --webdriver port");
  process.exit(2);
}

if (process.env.FAKE_SERVO_ARGS_FILE) {
  await writeFile(process.env.FAKE_SERVO_ARGS_FILE, JSON.stringify(process.argv.slice(2)));
}

const listenDelay = Number(process.env.FAKE_SERVO_LISTEN_DELAY_MS || 0);
if (listenDelay > 0) {
  await new Promise(resolve => setTimeout(resolve, listenDelay));
}

async function record(event) {
  if (process.env.FAKE_SERVO_EVENTS_FILE) {
    await appendFile(
      process.env.FAKE_SERVO_EVENTS_FILE,
      `${JSON.stringify({ pid: process.pid, time: Date.now(), ...event })}\n`
    );
  }
}

async function waitForParallelPeers() {
  const filename = process.env.FAKE_SERVO_PARALLEL_BARRIER_FILE;
  if (!filename) return;

  const target = Number(process.env.FAKE_SERVO_PARALLEL_BARRIER_TARGET || 2);
  await appendFile(filename, `${process.pid}\n`);
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    const peers = new Set(
      (await readFile(filename, "utf8")).trim().split("\n").filter(Boolean)
    );
    if (peers.size >= target) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for ${target} parallel fake Servo processes`);
}

function send(response, status, value) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify({ value }));
}

async function readBody(request) {
  let body = "";
  for await (const chunk of request) body += chunk;
  return body ? JSON.parse(body) : undefined;
}

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url, `http://127.0.0.1:${port}`);
    const body = await readBody(request);
    await record({ method: request.method, path: url.pathname, body });

    if (request.method === "POST" && url.pathname === "/session") {
      send(response, 200, { sessionId: "fake-session", capabilities: {} });
      return;
    }
    if (request.method === "POST" && url.pathname === "/session/fake-session/url") {
      await waitForParallelPeers();
      if (process.env.FAKE_SERVO_ABORT_NAVIGATION === "1") {
        response.writeHead(200, { "content-type": "application/json" });
        response.write('{"value":');
        response.destroy();
        return;
      }
      send(response, 200, null);
      return;
    }
    if (
      request.method === "POST" &&
      [
        "/session/fake-session/execute/sync",
        "/session/fake-session/execute/async"
      ].includes(url.pathname)
    ) {
      send(response, 200, { received: body });
      return;
    }
    if (request.method === "DELETE" && url.pathname === "/session/fake-session") {
      send(response, 200, null);
      return;
    }

    send(response, 404, { error: "unknown command", message: url.pathname });
  } catch (error) {
    send(response, 500, { error: "unknown error", message: error.message });
  }
});

server.listen(port, "127.0.0.1");

function stop() {
  server.close(() => process.exit(0));
}

process.on("SIGTERM", stop);
process.on("SIGINT", stop);
