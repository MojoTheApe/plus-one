import { randomUUID } from 'node:crypto';
import { CHARACTERS, hasCharacter } from './characters.js';
import { TerritoriesMatch, territoryConfig } from './territories.js';
import { AbsorptionMatch } from './absorption.js';

export const MODES = Object.freeze([{ id: 'territories', name: 'Території' }, { id: 'absorption', name: 'Поглинання' }]);

export const COLORS = ['#ffbb00', '#00cfe8', '#f71957', '#38e625', '#9b23ed', '#2165f5',
  '#ff861b', '#f12c22', '#a9df22', '#d82bad', '#008ba8', '#ac6826'];

// Shared Telegram room/lobby. A match owns its own objects, admission, clock,
// elimination/respawn semantics and result rules. The two concrete modes reuse
// this room without sharing either game's map or eligibility rules.
export class OccupiersRoom {
  constructor(token, { config = {}, random = Math.random, clock = Date.now, practice = false } = {}) {
    this.token = token;
    this.config = territoryConfig(config);
    this.practice = practice === true;
    this.minimumPlayers = this.practice ? 1 : TerritoriesMatch.minimumPlayers;
    this.random = random;
    this.clock = clock;
    this.phase = 'lobby';
    this.mode = 'territories';
    this.members = new Map();
    this.hostId = null;
    this.match = null;
    this.lastResults = null;
    this.order = 0;
    this.events = [];
    this.eventId = 0;
    this.baseline = new Map();
    this.lastUsed = clock();
  }

  event(value) {
    this.events.push({ ...value, seq: ++this.eventId });
    this.events = this.events.slice(-12);
  }

  connected() { return [...this.members.values()].filter(m => m.socket); }
  player(id) { return this.match?.participant(id); }

  heldColors(exceptId) {
    if (this.phase === 'running') return new Set(this.match.active().filter(p => p.id !== exceptId).map(p => p.color));
    return new Set(this.connected().filter(m => m.id !== exceptId && m.role === 'player').map(m => m.color));
  }

  assignColor(member, preferred = member.color) {
    const occupied = this.heldColors(member.id);
    const color = COLORS.includes(preferred) && !occupied.has(preferred) ? preferred : COLORS.find(c => !occupied.has(c));
    if (!color) return false;
    if (preferred && preferred !== color) this.event({ type: 'color_changed', id: member.id });
    member.color = color;
    return true;
  }

  chooseHost() {
    if (this.connected().some(m => m.id === this.hostId)) return;
    this.hostId = this.connected().sort((a, b) => a.order - b.order)[0]?.id || null;
  }

  attach(user, socket, now = this.clock()) {
    this.tick(now); // Expire an old connection before permitting control to return.
    let member = this.members.get(String(user.id));
    if (!member) {
      if (this.connected().length >= 128) throw new Error('room_full');
      member = { id: randomUUID(), userKey: String(user.id), name: user.holder, color: null, character: 'car',
        order: this.order++, role: this.phase === 'lobby' ? 'player' : 'spectator', intent: 'player',
        ready: false, socket: null, leftAt: null };
      this.members.set(member.userKey, member);
    }
    const previous = member.socket;
    member.name = user.holder;
    member.socket = socket;
    member.leftAt = null;
    if (previous && previous !== socket) previous.close(4001, 'another_connection');
    const player = this.player(member.id);
    if (player) { player.name = member.name; this.match.connect(member.id); }
    if (this.phase === 'lobby' && member.role === 'player') {
      const others = this.connected().filter(m => m.id !== member.id && m.role === 'player').length;
      if (others >= this.config.maxPlayers || !this.assignColor(member)) member.role = 'spectator';
    } else if (!player?.alive) this.assignColor(member);
    this.chooseHost();
    this.lastUsed = now;
    return member;
  }

  detach(member, socket, now = this.clock()) {
    if (member.socket !== socket) return;
    member.socket = null;
    member.leftAt = now;
    member.ready = false;
    this.match?.disconnect(member.id, now);
    this.chooseHost();
    this.lastUsed = now;
  }

  resetLobby() {
    this.lastResults = this.match?.results || this.lastResults;
    this.match = null; // No map, trails, participation ban or objects survive a new round/mode.
    this.phase = 'lobby';
    this.baseline.clear();
    for (const member of this.members.values()) { member.ready = false; member.role = 'spectator'; }
    for (const member of this.connected().sort((a, b) => a.order - b.order)) {
      if (member.intent === 'player' && this.connected().filter(m => m.role === 'player').length < this.config.maxPlayers) {
        member.role = 'player';
        if (!this.assignColor(member)) member.role = 'spectator';
      }
    }
    for (const [key, member] of this.members) if (!member.socket) this.members.delete(key);
  }

  command(member, message, now = this.clock()) {
    this.tick(now);
    this.lastUsed = now;
    const action = message?.action;
    if (action === 'input') return { ok: this.phase === 'running' && this.match.input(member.id,
      this.mode === 'absorption' ? message.target : message.angle) };
    if (action === 'split') {
      const ok = this.phase === 'running' && this.mode === 'absorption' && this.match.split(member.id, now, message.aim ?? null);
      return ok ? { ok: true } : { ok: false, reason: 'cannot_split' };
    }
    if (action === 'boost') return { ok: this.phase === 'running' && this.mode === 'absorption' && this.match.boost(member.id, message.active, now) };
    if (action === 'mode') {
      if (member.id !== this.hostId) return { ok: false, reason: 'host_only' };
      if (this.phase !== 'lobby') return { ok: false, reason: 'match_running' };
      if (!MODES.some(mode => mode.id === message.mode)) return { ok: false, reason: 'mode_unknown' };
      if (this.mode !== message.mode) {
        this.mode = message.mode; this.match = null; this.lastResults = null; this.baseline.clear();
        for (const m of this.members.values()) m.ready = false;
      }
      return { ok: true };
    }
    if (action === 'character') {
      if (!hasCharacter(message.character)) return { ok: false, reason: 'character_unknown' };
      if (this.phase === 'running' && this.player(member.id)?.alive) return { ok: false, reason: 'character_locked' };
      if (member.character !== message.character) { member.character = message.character; member.ready = false; }
      return { ok: true };
    }
    if (action === 'color') {
      if ((this.phase === 'running' && this.player(member.id)?.alive) || !COLORS.includes(message.color)) return { ok: false, reason: 'color_locked' };
      if (this.heldColors(member.id).has(message.color)) return { ok: false, reason: 'color_taken' };
      member.color = message.color;
      member.ready = false;
      return { ok: true };
    }
    if (action === 'lobby') {
      if (this.phase === 'running') return { ok: false, reason: 'match_running' };
      if (this.phase === 'results') this.resetLobby();
      return { ok: true };
    }
    if (action === 'spectate') {
      // Observation in a running match never removes a live character, resets
      // protection or changes this mode's eligibility to join again.
      if (this.phase === 'lobby') { member.role = 'spectator'; member.intent = 'spectator'; member.ready = false; }
      return { ok: true };
    }
    if (action === 'join') {
      if (this.phase === 'results') this.resetLobby();
      if (this.phase === 'running') {
        const previous = this.player(member.id);
        if (previous && !previous.alive && !this.match.constructor.respawns) return this.match.join(member, now);
        if (!previous?.alive && !this.assignColor(member)) return { ok: false, reason: 'full' };
        const result = this.match.join(member, now);
        if (result.ok) { member.role = 'player'; member.intent = 'player'; }
        return result;
      }
      if (this.connected().filter(m => m.id !== member.id && m.role === 'player').length >= this.config.maxPlayers) return { ok: false, reason: 'full' };
      member.role = 'player';
      member.intent = 'player';
      this.assignColor(member);
      member.ready = false;
      return { ok: true };
    }
    if (action === 'ready') {
      if (this.phase !== 'lobby' || member.role !== 'player' || typeof message.ready !== 'boolean') return { ok: false, reason: 'not_in_lobby' };
      member.ready = message.ready;
      return { ok: true };
    }
    if (action === 'start') {
      const playing = this.connected().filter(m => m.role === 'player');
      if (member.id !== this.hostId) return { ok: false, reason: 'host_only' };
      if (this.phase !== 'lobby' || playing.length < this.minimumPlayers || playing.some(m => !m.ready)) return { ok: false, reason: 'not_ready' };
      try {
        // Only shared room settings cross into Absorption. Territories' speed,
        // protection and simulation rate must never become its physics defaults.
        const shared = Object.fromEntries(['width', 'height', 'maxPlayers', 'durationMs', 'reconnectMs'].map(k => [k, this.config[k]]));
        const Match = this.mode === 'absorption' ? AbsorptionMatch : TerritoriesMatch;
        const match = new Match(playing, { now, config: this.mode === 'absorption' ? shared : this.config, random: this.random, practice: this.practice,
          onEvent: event => this.event(event) });
        this.match = match;
        this.phase = 'running';
        this.lastResults = null;
        this.baseline.clear();
        for (const m of this.members.values()) m.ready = false;
        return { ok: true };
      } catch (error) { return { ok: false, reason: error.message === 'no_spawn' ? 'no_spawn' : 'start_failed' }; }
    }
    return { ok: false, reason: 'unknown_action' };
  }

  tick(now = this.clock()) {
    if (this.phase === 'running') {
      this.match.advance(now);
      if (this.match.finished) {
        this.phase = 'results';
        this.lastResults = this.match.results;
        for (const m of this.members.values()) m.ready = false;
      }
    }
    for (const [key, member] of this.members) {
      if (!member.socket && member.leftAt !== null && now - member.leftAt > this.config.reconnectMs
        && !this.player(member.id)) this.members.delete(key);
    }
  }

  snapshot(full = true, now = this.clock()) {
    const playing = this.connected().filter(m => m.role === 'player');
    return { type: 'state', full, time: now, phase: this.phase, mode: this.mode, modes: MODES, hostId: this.hostId,
      practice: this.practice, colors: COLORS, characters: CHARACTERS, maxPlayers: this.practice ? 1 : this.config.maxPlayers, durationMs: this.config.durationMs,
      minPlayers: this.minimumPlayers,
      canStart: this.phase === 'lobby' && playing.length >= this.minimumPlayers && playing.every(m => m.ready),
      members: [...this.members.values()].filter(m => m.socket || this.player(m.id)?.alive)
        .map(m => ({ id: m.id, name: m.name, color: m.color, character: m.character, role: m.role, ready: m.ready, connected: !!m.socket })),
      game: this.match?.snapshot(full, this.baseline) || null, results: this.lastResults, events: this.events };
  }
}
