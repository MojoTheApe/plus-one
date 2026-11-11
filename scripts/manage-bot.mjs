import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";

const rootDir = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const lockFile = path.resolve(rootDir, process.env.BOT_LOCK_FILE || "bot.pid");
const logFile = path.resolve(rootDir, process.env.BOT_LOG_FILE || "telegram-bot.log");
const nodeBin = process.env.NODE_BIN || process.execPath;
const action = process.argv[2] || "status";

if (!["start", "stop", "restart", "status"].includes(action)) {
  console.error("Usage: node scripts/manage-bot.mjs <start|stop|restart|status>");
  process.exit(2);
}

if (action === "status") {
  const pid = await readPidFile(lockFile);
  if (pid && isProcessAlive(pid)) {
    console.log(`running pid=${pid}`);
  } else if (pid) {
    console.log(`stale pidfile pid=${pid}`);
    process.exitCode = 1;
  } else {
    console.log("stopped");
    process.exitCode = 1;
  }
} else if (action === "start") {
  await startBot();
} else if (action === "stop") {
  await stopBot();
} else if (action === "restart") {
  await stopBot({ allowStopped: true });
  await startBot();
}

async function startBot() {
  const pid = await readPidFile(lockFile);
  if (pid && isProcessAlive(pid)) {
    console.log(`already running pid=${pid}`);
    return;
  }
  if (pid) await fs.promises.rm(lockFile, { force: true });

  const out = fs.openSync(logFile, "a", 0o600);
  const child = spawn(nodeBin, ["src/bot.js"], {
    cwd: rootDir,
    detached: true,
    stdio: ["ignore", out, out],
  });
  child.unref();

  await waitFor(async () => {
    const startedPid = await readPidFile(lockFile);
    return startedPid && isProcessAlive(startedPid) ? startedPid : null;
  }, 10000);

  const startedPid = await readPidFile(lockFile);
  if (!startedPid || !isProcessAlive(startedPid)) {
    console.error(`start failed: no pidfile within 10s (spawned ${child.pid}); check ${logFile}`);
    process.exitCode = 1;
    return;
  }
  console.log(`started pid=${startedPid}`);
}

async function stopBot(options = {}) {
  const pid = await readPidFile(lockFile);
  if (!pid || !isProcessAlive(pid)) {
    if (!options.allowStopped) {
      console.log(pid ? `not running stale_pid=${pid}` : "not running");
    }
    if (pid) await fs.promises.rm(lockFile, { force: true });
    return;
  }

  process.kill(pid, "SIGTERM");
  await waitFor(() => !isProcessAlive(pid), 15000);
  if (isProcessAlive(pid)) {
    throw new Error(`bot did not stop after SIGTERM pid=${pid}`);
  }
  await fs.promises.rm(lockFile, { force: true });
  console.log(`stopped pid=${pid}`);
}

async function readPidFile(filePath) {
  try {
    const value = (await fs.promises.readFile(filePath, "utf8")).trim();
    const pid = Number.parseInt(value, 10);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

async function waitFor(check, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await check();
    if (result) return result;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return null;
}
