import fs from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

export const validRoomToken = value => typeof value === 'string' && /^occupiers_[a-f0-9]{32}$/.test(value);

// Keep personal test rooms in another file so older releases can still read the
// unchanged group registry after rollback.
export const practiceRegistryFile = filename => path.join(path.dirname(filename), 'practice-' + path.basename(filename));

export async function readRooms(filename, practice = false) {
  let text;
  try { text = await fs.readFile(filename, 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return { version: 1, rooms: {} }; throw error; }
  if (Buffer.byteLength(text) > 2_000_000) throw new Error('Room registry too large');
  const data = JSON.parse(text);
  const ownerKey = practice ? 'userId' : 'chatId';
  if (data.version !== 1 || !data.rooms || Array.isArray(data.rooms) || typeof data.rooms !== 'object'
    || Object.keys(data.rooms).length > 10_000
    || Object.entries(data.rooms).some(([token, value]) => !validRoomToken(token)
      || !Number.isSafeInteger(value?.[ownerKey]) || (practice ? value[ownerKey] <= 0 : value[ownerKey] >= 0))
    || new Set(Object.values(data.rooms).map(r => r[ownerKey])).size !== Object.keys(data.rooms).length) {
    throw new Error('Invalid Occupiers registry');
  }
  return data;
}

// The one existing bot is the sole registry writer. The game service reads only
// this dedicated file, never bot-private state. Forum topics share a group room.
export class RoomRegistry {
  constructor(filename) { this.filename = filename; this.pending = Promise.resolve(); }

  forGroup(chatId) {
    if (!Number.isSafeInteger(chatId) || chatId >= 0) return Promise.reject(new Error('group_required'));
    return this.forOwner(chatId, false);
  }

  forPractice(userId) {
    if (!Number.isSafeInteger(userId) || userId <= 0) return Promise.reject(new Error('user_required'));
    return this.forOwner(userId, true);
  }

  forOwner(ownerId, practice) {
    const filename = practice ? practiceRegistryFile(this.filename) : this.filename;
    const ownerKey = practice ? 'userId' : 'chatId';
    const result = this.pending.catch(() => {}).then(async () => {
      const data = await readRooms(filename, practice);
      const existing = Object.keys(data.rooms).find(token => data.rooms[token][ownerKey] === ownerId);
      if (existing) return existing;
      if (Object.keys(data.rooms).length >= 10_000) throw new Error('room_limit');
      const token = 'occupiers_' + randomBytes(16).toString('hex');
      data.rooms[token] = { [ownerKey]: ownerId };
      await fs.mkdir(path.dirname(filename), { recursive: true, mode: 0o700 });
      const temporary = filename + '.tmp';
      await fs.writeFile(temporary, JSON.stringify(data), { mode: 0o600 });
      await fs.rename(temporary, filename);
      return token;
    });
    this.pending = result;
    return result;
  }
}
