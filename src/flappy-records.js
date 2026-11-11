import { createPublicKey, verify } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

// Telegram's published production Ed25519 key. The game service needs no bot token.
const telegramKey = createPublicKey({ format: 'der', type: 'spki', key: Buffer.concat([
  Buffer.from('302a300506032b6570032100', 'hex'),
  Buffer.from('e7bf03a2fa4602af4580703d88dda5bb59f32ed8b02a56c187fe7d34caed242d', 'hex'),
]) });
const validScore = value => Number.isSafeInteger(value) && value >= 0 && value <= 1_000_000;

export function playerFromInitData(raw, { botId, publicKey = telegramKey, now = Date.now() }) {
  if (typeof raw !== 'string' || raw.length > 16_384 || !/^\d+$/.test(String(botId))) throw new Error('Invalid launch');
  const fields = new URLSearchParams(raw);
  if (new Set(fields.keys()).size !== [...fields.keys()].length) throw new Error('Duplicate launch fields');
  const signature = fields.get('signature') || '';
  if (!/^[A-Za-z0-9_-]{86}(?:==)?$/.test(signature)) throw new Error('Missing Telegram signature');
  const content = [...fields].filter(([key]) => !['hash', 'signature'].includes(key))
    .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, value]) => `${key}=${value}`).join('\n');
  const signed = Buffer.from(`${botId}:WebAppData\n${content}`);
  if (!verify(null, signed, publicKey, Buffer.from(signature, 'base64url'))) throw new Error('Invalid signature');
  const date = Number(fields.get('auth_date'));
  if (!Number.isSafeInteger(date) || date > now / 1000 + 60 || date < now / 1000 - 86400) throw new Error('Expired launch');
  const user = JSON.parse(fields.get('user') || 'null');
  if (!Number.isSafeInteger(user?.id) || user.id <= 0) throw new Error('Missing user');
  const username = typeof user.username === 'string' && /^[A-Za-z0-9_]{1,32}$/.test(user.username) ? user.username : '';
  const name = [user.first_name, user.last_name].filter(value => typeof value === 'string').join(' ')
    .replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, ' ').replace(/\s+/gu, ' ').trim();
  return { id: user.id, holder: username ? '@' + username : Array.from(name || 'Гравець').slice(0, 64).join(''),
    launch: fields.get('start_param') || '' };
}

const validHolder = value => typeof value === 'string' && value.trim().length > 0 && Array.from(value).length <= 64;
const validUserId = value => Number.isSafeInteger(value) && value > 0;
const validLeader = value => value && validUserId(value.userId) && validScore(value.score) && validHolder(value.holder);
export const validFlappyLaunch = value => typeof value === 'string' && /^flappy_[a-f0-9]{32}$/.test(value);
export const validFlappyNotice = value => value && validScore(value.score) && value.score > 0
  && validHolder(value.holder) && Number.isSafeInteger(value.userId) && value.userId > 0 && validFlappyLaunch(value.launch);

async function readSavedRecord(filename) {
  let record = { score: 0, holder: null, userId: null }, notices = [], leaders = [];
  try {
    const file = await fs.readFile(filename, 'utf8');
    if (file.length > 1_000_000) throw new Error('Record file too large');
    const saved = JSON.parse(file);
    if (saved.version === 1 && saved.records && typeof saved.records === 'object' && !Array.isArray(saved.records)) {
      const entries = Object.entries(saved.records);
      if (entries.some(([key, score]) => !/^-?\d{1,20}$/.test(key) || !validScore(score))) throw new Error('Invalid legacy records');
      // Owner selected one bot-wide BEST. Preserve the largest old value without inventing its holder.
      record.score = entries.reduce((highest, [, score]) => Math.max(highest, score), 0);
    } else if ([2, 3, 4].includes(saved.version) && validScore(saved.record?.score)
        && (saved.record.holder === null || validHolder(saved.record.holder))) {
      record = { score: saved.record.score, holder: saved.record.holder, userId: null };
      if (saved.version >= 3) {
        if (!Array.isArray(saved.notices) || saved.notices.length > 256
            || saved.notices.some((notice, index) => !validFlappyNotice(notice) || notice.score > record.score
              || (index > 0 && notice.score <= saved.notices[index - 1].score))) throw new Error('Invalid record notices');
        notices = saved.notices;
        const owner = notices.find(notice => notice.score === record.score && notice.holder === record.holder);
        record.userId = owner?.userId ?? null;
      }
      if (saved.version === 4) {
        if (!(saved.record.userId === null || validUserId(saved.record.userId))
            || !Array.isArray(saved.leaders) || saved.leaders.length > 10
            || new Set(saved.leaders.map(value => value?.userId)).size !== saved.leaders.length
            || saved.leaders.some((value, index) => !validLeader(value) || value.score > record.score
              || (index > 0 && value.score > saved.leaders[index - 1].score))) throw new Error('Invalid leaderboard');
        record.userId = saved.record.userId;
        leaders = saved.leaders.map(value => ({ userId: value.userId, holder: value.holder, score: value.score }));
        if (record.userId !== null && !leaders.some(value => value.userId === record.userId
            && value.score === record.score && value.holder === record.holder)) throw new Error('Missing ranked record holder');
      } else {
        for (const notice of notices) leaders = rankPlayer(leaders, notice);
      }
    } else throw new Error('Invalid record file');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error; // Never silently erase a damaged record file.
  }
  return { record, notices, leaders };
}

// Keeping only ten entries is sufficient: the tenth-place threshold never falls.
// Move an improving player after existing equal scores, so first attainment wins ties.
function rankPlayer(leaders, player) {
  const existing = leaders.find(value => value.userId === player.userId);
  if (existing && player.score <= existing.score) {
    return leaders.map(value => value.userId === player.userId ? { ...value, holder: player.holder } : value);
  }
  return [...leaders.filter(value => value.userId !== player.userId),
    { userId: player.userId, holder: player.holder, score: player.score }]
    .sort((a, b) => b.score - a.score).slice(0, 10);
}

async function saveRecord(filename, record, notices, leaders) {
  await fs.mkdir(path.dirname(filename), { recursive: true });
  const temporary = filename + '.tmp';
  await fs.writeFile(temporary, JSON.stringify({ version: 4, record, notices, leaders }), { mode: 0o600 });
  await fs.rename(temporary, filename);
}

export async function readFlappyNotices(filename) {
  return (await readSavedRecord(filename)).notices;
}

export async function openSharedRecord(filename, legacyFiles = []) {
  let { record, notices, leaders } = await readSavedRecord(filename);
  for (const legacyFilename of [legacyFiles].flat().filter(value => value && value !== filename)) {
    const legacy = await readSavedRecord(legacyFilename);
    if (legacy.record.score > record.score) record = legacy.record;
    for (const player of legacy.leaders) {
      const existing = leaders.find(value => value.userId === player.userId);
      if (!existing || player.score > existing.score) leaders = rankPlayer(leaders, player);
    }
    notices = [...new Map([...legacy.notices, ...notices].map(notice => [notice.score, notice])).values()]
      .sort((a, b) => a.score - b.score).slice(-256);
  }
  // Separate schema-4 file preserves schema-3 rollback data and publishes migration
  // before the service starts. Import does not create any new announcement event.
  await saveRecord(filename, record, notices, leaders);
  let pending = Promise.resolve();
  const snapshot = () => ({ score: record.score, holder: record.holder, leaders: leaders.map(value => ({ ...value })) });
  return {
    async get() { await pending.catch(() => {}); return snapshot(); },
    update(score, holder, player) {
      if (!validScore(score) || !validHolder(holder)) return Promise.reject(new Error('Invalid record'));
      pending = pending.catch(() => {}).then(async () => {
        const higher = score > record.score;
        const next = higher ? { score, holder, userId: validUserId(player?.id) ? player.id : null }
          : record.userId === player?.id ? { ...record, holder } : record;
        const notice = { score, holder, userId: player?.id, launch: player?.launch };
        const nextNotices = higher && validFlappyNotice(notice) ? [...notices, notice].slice(-256) : notices;
        const nextLeaders = validUserId(player?.id) ? rankPlayer(leaders, { userId: player.id, holder, score }) : leaders;
        if (JSON.stringify([next, nextLeaders]) === JSON.stringify([record, leaders])) return snapshot();
        await saveRecord(filename, next, nextNotices, nextLeaders);
        record = next; // Value and authenticated holder are confirmed together after persistence.
        notices = nextNotices;
        leaders = nextLeaders;
        return snapshot();
      });
      return pending;
    },
  };
}

export function recordHandler(records, auth) {
  return async (req, res) => {
    const reply = (status, payload) => {
      res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff' });
      res.end(JSON.stringify(payload));
    };
    if (req.method !== 'POST') { reply(405, { error: 'method' }); return; }
    if (req.headers['content-type']?.split(';')[0].trim() !== 'application/json') { reply(415, { error: 'json_required' }); return; }
    let input;
    try {
      let bytes = 0;
      const chunks = [];
      for await (const chunk of req) {
        bytes += chunk.length;
        if (bytes > 24_576) { reply(413, { error: 'too_large' }); return; }
        chunks.push(chunk);
      }
      input = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch { reply(400, { error: 'invalid_request' }); return; }
    let player;
    try { player = playerFromInitData(input?.initData, auth); }
    catch { reply(401, { error: 'telegram_launch_required' }); return; }
    const writing = Object.hasOwn(input, 'score');
    if (writing && !validScore(input.score)) { reply(400, { error: 'invalid_score' }); return; }
    try {
      const current = writing ? await records.update(input.score, player.holder, player) : await records.get();
      reply(200, { best: current.score, holder: current.holder,
        leaders: current.leaders.map(({ holder, score }) => ({ holder, score })) });
    } catch { reply(503, { error: 'record_unavailable' }); }
  };
}
