#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { z } = require('zod');

const DEFAULT_REPO_ROOT = process.env.THE_SOURCE_REPO || '/state/source';
const REPO_ROOT = path.resolve(process.env.THE_SOURCE_REPO || DEFAULT_REPO_ROOT);
const SERVER_NAME = process.env.THE_SOURCE_MCP_NAME || 'group-memory';
const SCOPE_NAME = process.env.THE_SOURCE_SCOPE_NAME || SERVER_NAME;
const RAW_ALLOWED_PATHS = process.env.THE_SOURCE_ALLOWED_PATHS || '';
if (!RAW_ALLOWED_PATHS.trim()) throw new Error('Set an explicit THE_SOURCE_ALLOWED_PATHS scope');
const ARCHIVE_DIR = 'Archive';
const LOCK_PATH = path.join(REPO_ROOT, '.git', 'the-source-memory.write.lock');
const LOCK_STALE_MS = 15 * 60 * 1000;
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const BOOT_ID_PATH = '/proc/sys/kernel/random/boot_id';
const ACCESS_SCOPE = parseAllowedPaths(RAW_ALLOWED_PATHS);

function result(payload) {
  return {
    content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
    structuredContent: payload,
  };
}

function ensureRepo() {
  if (REPO_ROOT !== path.resolve(DEFAULT_REPO_ROOT)) {
    throw new Error(`Unexpected THE SOURCE repository root: ${REPO_ROOT}`);
  }
  const gitDir = path.join(REPO_ROOT, '.git');
  if (fs.existsSync(REPO_ROOT) && fs.lstatSync(REPO_ROOT).isSymbolicLink()) {
    throw new Error(`Repository root must not be a symlink: ${REPO_ROOT}`);
  }
  if (!fs.existsSync(REPO_ROOT) || !fs.statSync(REPO_ROOT).isDirectory()) {
    throw new Error(`Repository root does not exist: ${REPO_ROOT}`);
  }
  if (!fs.existsSync(gitDir) || !fs.statSync(gitDir).isDirectory()) {
    throw new Error(`Repository is not a Git working clone: ${REPO_ROOT}`);
  }
}

function git(args, options = {}) {
  ensureRepo();
  try {
    const stdout = execFileSync('git', args, {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: options.timeout ?? 120000,
      maxBuffer: options.maxBuffer ?? 16 * 1024 * 1024,
    });
    return stdout;
  } catch (error) {
    const stderr = error.stderr ? String(error.stderr).trim() : '';
    const stdout = error.stdout ? String(error.stdout).trim() : '';
    const detail = [stderr, stdout].filter(Boolean).join('\n');
    throw new Error(`git ${args.join(' ')} failed${detail ? `:\n${detail}` : ''}`);
  }
}

function gitExitCode(args) {
  try {
    execFileSync('git', args, {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'ignore', 'ignore'],
      timeout: 120000,
    });
    return 0;
  } catch (error) {
    return typeof error.status === 'number' ? error.status : 1;
  }
}

function gitDirPath() {
  const raw = git(['rev-parse', '--git-dir']).trim();
  return path.isAbsolute(raw) ? raw : path.resolve(REPO_ROOT, raw);
}

function ensureGitIdle() {
  const gitDir = gitDirPath();
  const blockers = [
    'MERGE_HEAD',
    'CHERRY_PICK_HEAD',
    'REVERT_HEAD',
    'BISECT_LOG',
    path.join('rebase-merge'),
    path.join('rebase-apply'),
  ];
  const active = blockers.filter((entry) => fs.existsSync(path.join(gitDir, entry)));
  if (active.length > 0) {
    throw new Error(`Git operation already in progress: ${active.join(', ')}`);
  }
}

function statusPorcelain() {
  return git(['status', '--porcelain']);
}

function ensureCleanWorkingTree() {
  const status = statusPorcelain().trim();
  if (status) {
    throw new Error(`Working tree is not clean; refusing to continue:\n${status}`);
  }
}

function changedPaths() {
  const paths = new Set();
  const outputs = [
    git(['diff', '--name-only']),
    git(['diff', '--cached', '--name-only']),
    git(['ls-files', '--others', '--exclude-standard']),
  ];
  for (const output of outputs) {
    for (const line of output.split('\n')) {
      const rel = line.trim();
      if (rel) {
        paths.add(rel);
      }
    }
  }
  return [...paths].sort();
}

function assertOnlyExpectedChanges(expectedPaths) {
  const expected = new Set(expectedPaths);
  const actual = changedPaths();
  const unexpected = actual.filter((rel) => !expected.has(rel));
  if (unexpected.length > 0) {
    throw new Error(`Unexpected working tree changes detected: ${unexpected.join(', ')}`);
  }
}

function pullLatest() {
  ensureGitIdle();
  git(['pull', '--ff-only', 'origin', 'main'], { timeout: 180000 });
}

function syncForRead() {
  ensureGitIdle();
  ensureCleanWorkingTree();
  pullLatest();
}

function normalizeRelativeInput(input, options = {}) {
  const requireMarkdown = options.requireMarkdown ?? true;
  if (typeof input !== 'string') {
    throw new Error('Path must be a string');
  }
  const raw = input.trim();
  if (!raw) {
    throw new Error('Path is required');
  }
  if (raw.length > 512) {
    throw new Error('Path is too long');
  }
  if (raw.includes('\0') || raw.includes('\n') || raw.includes('\r')) {
    throw new Error('Path contains invalid characters');
  }
  if (raw.includes('\\')) {
    throw new Error('Use forward slashes in paths');
  }
  if (path.isAbsolute(raw)) {
    throw new Error('Absolute paths are not allowed');
  }
  const withoutLeadingDot = raw.replace(/^\.\//, '');
  const rawSegments = withoutLeadingDot.split('/');
  if (rawSegments.some((segment) => !segment || segment === '.' || segment === '..')) {
    throw new Error('Invalid path segment');
  }
  const normalized = path.posix.normalize(withoutLeadingDot);
  if (normalized === '.' || normalized === '..' || normalized.startsWith('../')) {
    throw new Error('Path traversal is not allowed');
  }
  const segments = normalized.split('/');
  if (segments.some((segment) => !segment || segment === '.' || segment === '..')) {
    throw new Error('Invalid path segment');
  }
  if (segments.includes('.git')) {
    throw new Error('Git internals are not accessible');
  }
  if (requireMarkdown && path.posix.extname(normalized).toLowerCase() !== '.md') {
    throw new Error('Only Markdown .md files are allowed');
  }
  return normalized;
}

function parseAllowedPaths(raw) {
  const specs = String(raw || '').split(/[\n,;]+/).map((item) => item.trim()).filter(Boolean);
  if (specs.length === 0 || specs.some((spec) => ['FULL', '*', '**'].includes(spec.toUpperCase()))) {
    return { full: true, rules: [], description: 'FULL' };
  }

  const rules = specs.map((spec) => {
    if (spec.endsWith('/**')) {
      const base = normalizeRelativeInput(spec.slice(0, -3), { requireMarkdown: false });
      return { type: 'prefix', rel: `${base.replace(/\/+$/, '')}/`, display: `${base.replace(/\/+$/, '')}/**` };
    }
    if (spec.endsWith('/')) {
      const base = normalizeRelativeInput(spec.replace(/\/+$/, ''), { requireMarkdown: false });
      return { type: 'prefix', rel: `${base.replace(/\/+$/, '')}/`, display: `${base.replace(/\/+$/, '')}/**` };
    }
    const rel = normalizeRelativeInput(spec, { requireMarkdown: path.posix.extname(spec).toLowerCase() === '.md' });
    if (path.posix.extname(rel).toLowerCase() === '.md') {
      return { type: 'file', rel, display: rel };
    }
    return { type: 'prefix', rel: `${rel.replace(/\/+$/, '')}/`, display: `${rel.replace(/\/+$/, '')}/**` };
  });

  if (rules.length === 0) {
    throw new Error('At least one THE SOURCE allowed path scope is required');
  }
  return { full: false, rules, description: rules.map((rule) => rule.display).join(', ') };
}

function isPathAllowed(rel) {
  if (ACCESS_SCOPE.full) {
    return true;
  }
  return ACCESS_SCOPE.rules.some((rule) => {
    if (rule.type === 'file') {
      return rel === rule.rel;
    }
    return rel.startsWith(rule.rel);
  });
}

function assertPathAllowed(rel, operation = 'access') {
  if (!isPathAllowed(rel)) {
    throw new Error(`THE SOURCE scope "${SCOPE_NAME}" denied ${operation} for path: ${rel}`);
  }
}

function assertLexicallyUnderRepo(absolutePath) {
  const rootWithSep = REPO_ROOT.endsWith(path.sep) ? REPO_ROOT : `${REPO_ROOT}${path.sep}`;
  if (!absolutePath.startsWith(rootWithSep)) {
    throw new Error('Resolved path escapes repository root');
  }
}

function assertNoSymlinkInExistingPath(absolutePath) {
  const repoRoot = path.resolve(REPO_ROOT);
  const relative = path.relative(repoRoot, absolutePath);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('Resolved path escapes repository root');
  }

  let current = repoRoot;
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    try {
      const stat = fs.lstatSync(current);
      if (stat.isSymbolicLink()) {
        throw new Error(`Symlink paths are not accessible through this MCP: ${path.relative(repoRoot, current)}`);
      }
    } catch (error) {
      if (error.code === 'ENOENT') {
        return;
      }
      throw error;
    }
  }
}

function assertExistingPathContained(absolutePath) {
  if (!fs.existsSync(absolutePath)) {
    return;
  }
  const repoReal = fs.realpathSync(REPO_ROOT);
  const targetReal = fs.realpathSync(absolutePath);
  const repoWithSep = repoReal.endsWith(path.sep) ? repoReal : `${repoReal}${path.sep}`;
  if (!targetReal.startsWith(repoWithSep)) {
    throw new Error('Real path escapes repository root');
  }
}

function validateMarkdownPath(input, options = {}) {
  const normalized = normalizeRelativeInput(input, { requireMarkdown: true });
  assertPathAllowed(normalized, options.operation || 'access');
  const absolutePath = path.resolve(REPO_ROOT, normalized);
  assertLexicallyUnderRepo(absolutePath);
  assertNoSymlinkInExistingPath(absolutePath);
  assertExistingPathContained(absolutePath);
  return { rel: normalized, abs: absolutePath };
}

function ensureReadableSize(abs) {
  const stat = fs.statSync(abs);
  if (!stat.isFile()) {
    throw new Error('Path is not a file');
  }
  if (stat.size > MAX_FILE_BYTES) {
    throw new Error(`File is too large to read through this MCP (${stat.size} bytes)`);
  }
}

function readMarkdown(relPath) {
  const target = validateMarkdownPath(relPath);
  if (!fs.existsSync(target.abs)) {
    throw new Error(`Markdown file does not exist: ${target.rel}`);
  }
  ensureReadableSize(target.abs);
  return { path: target.rel, content: fs.readFileSync(target.abs, 'utf8') };
}

function readBootId() {
  try {
    return fs.readFileSync(BOOT_ID_PATH, 'utf8').trim() || null;
  } catch {
    return null;
  }
}

function readProcessStartTime(pid) {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    const endOfCommand = stat.lastIndexOf(')');
    if (endOfCommand === -1) {
      return null;
    }
    const fields = stat.slice(endOfCommand + 2).trim().split(/\s+/);
    return fields[19] || null;
  } catch {
    return null;
  }
}

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === 'ESRCH') {
      return false;
    }
    if (error.code === 'EPERM') {
      return true;
    }
    return true;
  }
}

function createLockMetadata() {
  const hostname = os.hostname();
  const processStartTime = readProcessStartTime(process.pid);
  const bootId = readBootId();
  const lockId = crypto.randomUUID();
  return {
    lockId,
    ownerId: [hostname, process.pid, processStartTime, lockId].filter(Boolean).join(':'),
    pid: process.pid,
    ppid: process.ppid,
    hostname,
    cwd: process.cwd(),
    createdAt: new Date().toISOString(),
    processStartTime,
    bootId,
  };
}

function inspectLockFile() {
  try {
    const stat = fs.statSync(LOCK_PATH);
    const raw = fs.readFileSync(LOCK_PATH, 'utf8');
    let metadata = null;
    let parseError = null;
    try {
      metadata = JSON.parse(raw);
    } catch (error) {
      parseError = error;
    }
    return {
      exists: true,
      stat: {
        dev: stat.dev,
        ino: stat.ino,
        size: stat.size,
        mtimeMs: stat.mtimeMs,
      },
      raw,
      metadata,
      parseError,
    };
  } catch (error) {
    if (error.code === 'ENOENT') {
      return { exists: false };
    }
    throw error;
  }
}

function lockAgeMs(lock) {
  if (!lock.exists) {
    return 0;
  }
  const createdAt = lock.metadata && typeof lock.metadata.createdAt === 'string'
    ? Date.parse(lock.metadata.createdAt)
    : NaN;
  const createdAtMs = Number.isFinite(createdAt) ? createdAt : lock.stat.mtimeMs;
  return Math.max(0, Date.now() - createdAtMs);
}

function validLockPid(metadata) {
  const pid = Number(metadata?.pid);
  if (!Number.isInteger(pid) || pid <= 0) {
    return null;
  }
  return pid;
}

function classifyLock(lock) {
  if (!lock.exists) {
    return { state: 'missing', reason: 'lock does not exist' };
  }

  const ageMs = lockAgeMs(lock);
  if (!lock.metadata || typeof lock.metadata !== 'object') {
    if (ageMs > LOCK_STALE_MS) {
      return { state: 'stale', reason: 'lock metadata is unreadable and stale' };
    }
    return { state: 'active', reason: 'lock metadata is unreadable; assuming a write is in progress' };
  }

  const pid = validLockPid(lock.metadata);
  if (!pid) {
    if (ageMs > LOCK_STALE_MS) {
      return { state: 'stale', reason: 'lock has no valid owner PID and is stale' };
    }
    return { state: 'active', reason: 'lock has no valid owner PID; assuming a write is in progress' };
  }

  const currentBootId = readBootId();
  if (lock.metadata.bootId && currentBootId && lock.metadata.bootId !== currentBootId) {
    return { state: 'stale', reason: 'lock was created before the current boot' };
  }

  if (!isProcessAlive(pid)) {
    return { state: 'stale', reason: `owner PID ${pid} is not running` };
  }

  const currentStartTime = readProcessStartTime(pid);
  if (lock.metadata.processStartTime && currentStartTime && lock.metadata.processStartTime !== currentStartTime) {
    return { state: 'stale', reason: `owner PID ${pid} has been reused by another process` };
  }

  return {
    state: 'active',
    reason: `owner PID ${pid} is still running`,
    owner: {
      pid,
      ownerId: lock.metadata.ownerId || null,
      createdAt: lock.metadata.createdAt || null,
      hostname: lock.metadata.hostname || null,
    },
  };
}

function sameLockFile(a, b) {
  return Boolean(
    a.exists
    && b.exists
    && a.stat.dev === b.stat.dev
    && a.stat.ino === b.stat.ino
    && a.stat.size === b.stat.size
    && a.raw === b.raw,
  );
}

function removeStaleLock(lock) {
  const current = inspectLockFile();
  if (!current.exists) {
    return false;
  }
  if (!sameLockFile(lock, current)) {
    return false;
  }
  fs.unlinkSync(LOCK_PATH);
  return true;
}

function lockErrorMessage(classification) {
  const owner = classification.owner;
  const details = owner
    ? ` Held by PID ${owner.pid}${owner.createdAt ? ` since ${owner.createdAt}` : ''}${owner.ownerId ? ` (${owner.ownerId})` : ''}.`
    : '';
  return `Repository write currently in progress; refusing to remove active lock. ${classification.reason}.${details}`;
}

async function acquireWriteLock() {
  ensureRepo();
  while (true) {
    const metadata = createLockMetadata();
    let fd;
    let createdLockStat = null;
    try {
      fd = fs.openSync(LOCK_PATH, 'wx', 0o600);
      createdLockStat = fs.fstatSync(fd);
      fs.writeFileSync(fd, `${JSON.stringify(metadata, null, 2)}\n`, 'utf8');
      fs.fsyncSync(fd);
      fs.closeSync(fd);
      fd = undefined;
      return metadata;
    } catch (error) {
      if (fd !== undefined) {
        try {
          fs.closeSync(fd);
        } catch {
          // Ignore close errors while surfacing the original failure.
        }
      }
      if (error.code !== 'EEXIST') {
        try {
          const lock = inspectLockFile();
          const lockMatchesCreatedFile = createdLockStat
            && lock.exists
            && lock.stat.dev === createdLockStat.dev
            && lock.stat.ino === createdLockStat.ino;
          if (lockMatchesCreatedFile || (lock.exists && lock.metadata?.lockId === metadata.lockId)) {
            fs.unlinkSync(LOCK_PATH);
          }
        } catch {
          // Ignore cleanup errors while surfacing the original failure.
        }
        throw error;
      }

      const lock = inspectLockFile();
      const classification = classifyLock(lock);
      if (classification.state === 'stale') {
        if (removeStaleLock(lock)) {
          continue;
        }
        continue;
      }
      throw new Error(lockErrorMessage(classification));
    }
  }
}

function releaseWriteLock(owner) {
  try {
    const lock = inspectLockFile();
    if (!lock.exists) {
      return;
    }
    if (lock.metadata?.lockId === owner?.lockId && lock.metadata?.pid === owner?.pid) {
      fs.unlinkSync(LOCK_PATH);
      return;
    }
    console.error('Refusing to release THE SOURCE write lock because it is owned by another process.');
  } catch (error) {
    console.error(`Failed to release THE SOURCE write lock: ${error.message}`);
  }
}

function isTracked(rel) {
  return gitExitCode(['ls-files', '--error-unmatch', '--', rel]) === 0;
}

function rollbackAffected(paths) {
  const uniquePaths = [...new Set(paths)];
  if (uniquePaths.length === 0) {
    return;
  }
  try {
    git(['restore', '--staged', '--worktree', '--', ...uniquePaths]);
  } catch {
    // Some affected paths may be untracked; handle them below.
  }
  for (const rel of uniquePaths) {
    const target = validateMarkdownPath(rel);
    if (fs.existsSync(target.abs) && !isTracked(rel)) {
      fs.rmSync(target.abs, { force: true });
    }
  }
}

async function withWriteOperation(action, affectedPaths, mutate) {
  const lockOwner = await acquireWriteLock();
  let touched = [...affectedPaths];
  let committed = false;
  let mutationStarted = false;
  try {
    ensureGitIdle();
    ensureCleanWorkingTree();
    pullLatest();
    ensureCleanWorkingTree();

    mutationStarted = true;
    const mutation = mutate();
    touched = [...new Set([...(mutation.affectedPaths ?? touched)])];
    assertOnlyExpectedChanges(touched);
    git(['add', '--', ...touched]);
    if (gitExitCode(['diff', '--cached', '--quiet']) === 0) {
      throw new Error('No Git changes were produced by the write operation');
    }

    const message = `THE SOURCE: ${action}`;
    git(['commit', '-m', message], { timeout: 180000 });
    committed = true;
    const commit = git(['rev-parse', '--short', 'HEAD']).trim();
    git(['push', 'origin', 'main'], { timeout: 180000 });
    return { ok: true, commit, message, affectedPaths: touched };
  } catch (error) {
    if (mutationStarted && !committed) {
      rollbackAffected(touched);
    }
    throw error;
  } finally {
    releaseWriteLock(lockOwner);
  }
}

function assertDirectoryWithinRepo(dir) {
  if (typeof dir !== 'string' || !dir.trim()) {
    throw new Error('Search root directory is required');
  }
  const absoluteDir = path.resolve(dir);
  const repoRoot = path.resolve(REPO_ROOT);
  const relative = path.relative(repoRoot, absoluteDir);
  if (relative && (relative.startsWith('..') || path.isAbsolute(relative))) {
    throw new Error('Search root escapes repository root');
  }
  return absoluteDir;
}

function listMarkdownFilesUnder(dir, prefix = '') {
  const searchRoot = assertDirectoryWithinRepo(dir);
  if (!fs.existsSync(searchRoot)) {
    return [];
  }
  if (fs.lstatSync(searchRoot).isSymbolicLink()) {
    return [];
  }
  const entries = fs.readdirSync(searchRoot, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if (entry.name === '.git' || entry.isSymbolicLink()) {
      continue;
    }
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    const abs = path.join(searchRoot, entry.name);
    if (entry.isDirectory()) {
      files.push(...listMarkdownFilesUnder(abs, rel));
    } else if (entry.isFile() && path.extname(entry.name).toLowerCase() === '.md') {
      const target = validateMarkdownPath(rel, { operation: 'search' });
      if (target.rel === rel) {
        files.push(rel);
      }
    }
  }
  return files.sort();
}

function listMarkdownFiles() {
  if (ACCESS_SCOPE.full) {
    return listMarkdownFilesUnder(REPO_ROOT);
  }

  const files = [];
  for (const rule of ACCESS_SCOPE.rules) {
    if (rule.type === 'file') {
      const target = validateMarkdownPath(rule.rel, { operation: 'search' });
      if (fs.existsSync(target.abs)) {
        files.push(target.rel);
      }
      continue;
    }
    const prefix = rule.rel.replace(/\/+$/, '');
    const abs = path.join(REPO_ROOT, prefix);
    files.push(...listMarkdownFilesUnder(abs, prefix));
  }
  return [...new Set(files)].sort();
}

function normalizeSearchText(value) {
  return String(value)
    .normalize('NFKC')
    .toLocaleLowerCase('en-US')
    .replace(/\s+/g, ' ')
    .trim();
}

function searchTokens(value) {
  return [...new Set(normalizeSearchText(value).match(/[\p{L}\p{N}]+/gu) || [])];
}

function buildSearchQuery(query) {
  const normalized = normalizeSearchText(query);
  const tokens = searchTokens(query);
  if (!normalized || tokens.length === 0) {
    throw new Error('Search query is required');
  }
  return { normalized, tokens };
}

function matchLine(line, query) {
  const normalizedLine = normalizeSearchText(line);
  if (normalizedLine.includes(query.normalized)) {
    return 'phrase';
  }
  if (query.tokens.every((token) => normalizedLine.includes(token))) {
    return 'tokens';
  }
  return null;
}

function lineHasAnyToken(line, query) {
  const normalizedLine = normalizeSearchText(line);
  return query.tokens.some((token) => normalizedLine.includes(token));
}

function fullContentMatches(content, query) {
  const normalizedContent = normalizeSearchText(content);
  if (normalizedContent.includes(query.normalized)) {
    return true;
  }
  return query.tokens.every((token) => normalizedContent.includes(token));
}

function contextSnippet(lines, index, context) {
  const from = Math.max(0, index - context);
  const to = Math.min(lines.length - 1, index + context);
  const snippet = [];
  for (let lineNo = from; lineNo <= to; lineNo += 1) {
    snippet.push({ line: lineNo + 1, text: lines[lineNo] });
  }
  return snippet;
}

function searchMarkdown(query, maxResults, contextLines) {
  if (typeof query !== 'string' || !query.trim()) {
    throw new Error('Search query is required');
  }
  const lexicalQuery = buildSearchQuery(query);
  const limit = Math.max(1, Math.min(Number(maxResults ?? 20), 50));
  const context = Math.max(0, Math.min(Number(contextLines ?? 2), 5));
  const results = [];

  for (const rel of listMarkdownFiles()) {
    if (results.length >= limit) {
      break;
    }
    const { content } = readMarkdown(rel);
    const lines = content.split(/\r?\n/);
    const matches = [];
    for (let index = 0; index < lines.length; index += 1) {
      const matchType = matchLine(lines[index], lexicalQuery);
      if (!matchType) {
        continue;
      }
      matches.push({ line: index + 1, matchType, context: contextSnippet(lines, index, context) });
      if (matches.length >= 5) {
        break;
      }
    }
    if (matches.length === 0 && fullContentMatches(content, lexicalQuery)) {
      for (let index = 0; index < lines.length; index += 1) {
        if (!lineHasAnyToken(lines[index], lexicalQuery)) {
          continue;
        }
        matches.push({ line: index + 1, matchType: 'file-tokens', context: contextSnippet(lines, index, context) });
        if (matches.length >= 5) {
          break;
        }
      }
    }
    if (matches.length > 0) {
      results.push({ path: rel, matches });
    }
  }

  return { query, count: results.length, results };
}

async function main() {
  const server = new McpServer({ name: SERVER_NAME, version: '0.2.0' });

  server.registerTool(
    'search',
    {
      title: 'Search THE SOURCE',
      description: 'Search Markdown files in the dedicated memory repository and return matching context.',
      inputSchema: {
        query: z.string().min(1),
        maxResults: z.number().int().min(1).max(50).optional(),
        contextLines: z.number().int().min(0).max(5).optional(),
      },
    },
    async ({ query, maxResults, contextLines }) => {
      syncForRead();
      return result(searchMarkdown(query, maxResults, contextLines));
    },
  );

  server.registerTool(
    'read',
    {
      title: 'Read THE SOURCE Markdown',
      description: 'Read one Markdown file from the dedicated memory repository.',
      inputSchema: {
        path: z.string().min(1),
      },
    },
    async ({ path: relPath }) => {
      syncForRead();
      return result(readMarkdown(relPath));
    },
  );

  server.registerTool(
    'create',
    {
      title: 'Create THE SOURCE Markdown',
      description: 'Create a new Markdown file and commit/push it to main.',
      inputSchema: {
        path: z.string().min(1),
        content: z.string(),
      },
    },
    async ({ path: relPath, content }) => {
      const target = validateMarkdownPath(relPath);
      const write = await withWriteOperation(`create ${target.rel}`, [target.rel], () => {
        if (fs.existsSync(target.abs)) {
          throw new Error(`Markdown file already exists: ${target.rel}`);
        }
        fs.mkdirSync(path.dirname(target.abs), { recursive: true });
        fs.writeFileSync(target.abs, content, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
        return { affectedPaths: [target.rel] };
      });
      return result({ ...write, path: target.rel });
    },
  );

  server.registerTool(
    'append',
    {
      title: 'Append THE SOURCE Markdown',
      description: 'Append text to an existing Markdown file and commit/push it to main.',
      inputSchema: {
        path: z.string().min(1),
        text: z.string(),
      },
    },
    async ({ path: relPath, text }) => {
      const target = validateMarkdownPath(relPath);
      const write = await withWriteOperation(`append ${target.rel}`, [target.rel], () => {
        if (!fs.existsSync(target.abs)) {
          throw new Error(`Markdown file does not exist: ${target.rel}`);
        }
        ensureReadableSize(target.abs);
        fs.appendFileSync(target.abs, text, 'utf8');
        return { affectedPaths: [target.rel] };
      });
      return result({ ...write, path: target.rel });
    },
  );

  server.registerTool(
    'update',
    {
      title: 'Update THE SOURCE Markdown',
      description: 'Replace one exact text occurrence in an existing Markdown file and commit/push it to main.',
      inputSchema: {
        path: z.string().min(1),
        existingText: z.string().min(1),
        newText: z.string(),
      },
    },
    async ({ path: relPath, existingText, newText }) => {
      const target = validateMarkdownPath(relPath);
      const write = await withWriteOperation(`update ${target.rel}`, [target.rel], () => {
        if (!fs.existsSync(target.abs)) {
          throw new Error(`Markdown file does not exist: ${target.rel}`);
        }
        ensureReadableSize(target.abs);
        const current = fs.readFileSync(target.abs, 'utf8');
        const first = current.indexOf(existingText);
        if (first === -1) {
          throw new Error('Exact existing text was not found');
        }
        if (current.indexOf(existingText, first + existingText.length) !== -1) {
          throw new Error('Exact existing text occurs more than once; refusing uncontrolled replacement');
        }
        fs.writeFileSync(target.abs, current.replace(existingText, newText), 'utf8');
        return { affectedPaths: [target.rel] };
      });
      return result({ ...write, path: target.rel });
    },
  );

  server.registerTool(
    'archive',
    {
      title: 'Archive THE SOURCE Markdown',
      description: 'Move a Markdown file into Archive/ and commit/push it to main.',
      inputSchema: {
        path: z.string().min(1),
      },
    },
    async ({ path: relPath }) => {
      const source = validateMarkdownPath(relPath);
      if (source.rel === ARCHIVE_DIR || source.rel.startsWith(`${ARCHIVE_DIR}/`)) {
        throw new Error('File is already inside Archive/');
      }
      const destination = validateMarkdownPath(`${ARCHIVE_DIR}/${source.rel}`);
      const write = await withWriteOperation(`archive ${source.rel}`, [source.rel, destination.rel], () => {
        if (!fs.existsSync(source.abs)) {
          throw new Error(`Markdown file does not exist: ${source.rel}`);
        }
        if (fs.existsSync(destination.abs)) {
          throw new Error(`Archive destination already exists: ${destination.rel}`);
        }
        fs.mkdirSync(path.dirname(destination.abs), { recursive: true });
        fs.renameSync(source.abs, destination.abs);
        return { affectedPaths: [source.rel, destination.rel] };
      });
      return result({ ...write, path: source.rel, archivedPath: destination.rel });
    },
  );

  await server.connect(new StdioServerTransport());
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
