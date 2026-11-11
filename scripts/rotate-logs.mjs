import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { pipeline } from "node:stream/promises";

const rootDir = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const logFiles = (process.env.BOT_LOG_FILES || "telegram-bot.log,bot.log")
  .split(",")
  .map((item) => item.trim())
  .filter(Boolean);
const archiveDir = path.resolve(rootDir, process.env.BOT_LOG_ARCHIVE_DIR || "logs/archive");
const timestamp = new Date().toISOString().replace(/[:.]/g, "-");

await fs.promises.mkdir(archiveDir, { recursive: true, mode: 0o700 });

for (const logFile of logFiles) {
  const source = path.resolve(rootDir, logFile);
  if (!source.startsWith(`${rootDir}${path.sep}`)) {
    throw new Error(`Refusing to rotate log outside bot directory: ${logFile}`);
  }

  let stat;
  try {
    stat = await fs.promises.stat(source);
  } catch (error) {
    if (error.code === "ENOENT") continue;
    throw error;
  }

  if (!stat.isFile() || stat.size === 0) continue;

  const archivePath = path.join(archiveDir, `${path.basename(logFile)}.${timestamp}.gz`);
  await pipeline(
    fs.createReadStream(source),
    zlib.createGzip({ level: 9 }),
    fs.createWriteStream(archivePath, { mode: 0o600 }),
  );
  await fs.promises.truncate(source, 0);
  await fs.promises.chmod(source, 0o600);
  console.log(`rotated ${logFile} -> ${path.relative(rootDir, archivePath)} (${stat.size} bytes)`);
}
