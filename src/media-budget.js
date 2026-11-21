import { randomUUID, createHash } from "node:crypto";
import { mediaPublicationKey, mediaReference } from "./media-source.js";

// Success quota and protection against repeated upstream failures are independent.
// Synchronous reservations also prevent two simultaneous requests overspending it.
export class MediaBudget {
  constructor({ hourlyLimit = 6, now = Date.now, windowMs = 3600000,
    failureWindowMs = 600000, maxFailures = 3, failureCooldownMs = 120000,
    urlBackoffMs = 30000, maxUrlBackoffMs = 600000, reservationTtlMs = 600000,
    maxChats = 1000 } = {}) {
    Object.assign(this, { hourlyLimit, now, windowMs, failureWindowMs, maxFailures,
      failureCooldownMs, urlBackoffMs, maxUrlBackoffMs, reservationTtlMs, maxChats });
    this.chats = new Map();
    this.reservations = new Map();
  }

  reserve(chatId, url, { source = true } = {}) {
    const now = this.now(), key = String(chatId);
    this.prune(now);
    let state = this.chats.get(key);
    if (!state) {
      if (this.chats.size >= this.maxChats) return denied("CAPACITY", 5);
      state = { successes: [], providers: new Map(), urls: new Map() };
      this.chats.set(key, state);
    }
    const active = [...this.reservations.values()].filter(item => item.chatId === key);
    if (active.length) return denied("IN_PROGRESS", 5);
    const reservation = { id: randomUUID(), chatId: key, provider: mediaReference(url)?.platform || "other",
      urlKey: mediaUrlKey(url), createdAt: now, sourceReserved: false, sourceSettled: false, legacy: source };
    this.reservations.set(reservation.id, reservation);
    if (source) {
      const result = this.reserveSource(reservation);
      if (!result.allowed) { this.reservations.delete(reservation.id); return result; }
    }
    return { allowed: true, retryAfterSeconds: 0, reason: null, reservation: { ...reservation } };
  }

  reserveSource(reservation) {
    const saved = reservation && this.reservations.get(reservation.id);
    if (!saved) return denied("IN_PROGRESS", 5);
    const now = this.now(), state = this.chats.get(saved.chatId);
    state.successes = state.successes.filter(time => time > now - this.windowMs);
    if (this.hourlyLimit > 0 && state.successes.length >= this.hourlyLimit) {
      return denied("SUCCESS_QUOTA", (state.successes[0] + this.windowMs - now) / 1000);
    }
    const pause = state.providers.get(saved.provider);
    if (pause?.blockedUntil > now) return denied("FAILURE_COOLDOWN", (pause.blockedUntil - now) / 1000);
    const urlState = state.urls.get(saved.urlKey);
    if (urlState?.blockedUntil > now) return denied("URL_BACKOFF", (urlState.blockedUntil - now) / 1000);
    saved.sourceReserved = true;
    saved.sourceSettled = false;
    return { allowed: true, retryAfterSeconds: 0, reason: null };
  }

  completeSource(reservation, { success, providerFailure = true } = {}) {
    const saved = reservation && this.reservations.get(reservation.id);
    if (!saved?.sourceReserved || saved.sourceSettled) return false;
    this.finish(saved, success === true, this.now(), providerFailure);
    saved.sourceSettled = true;
    return true;
  }

  complete(reservation, { success, providerFailure } = {}) {
    const saved = reservation && this.reservations.get(reservation.id);
    if (!saved) return false;
    if (saved.legacy && !saved.sourceSettled) this.completeSource(saved, { success, providerFailure });
    this.reservations.delete(saved.id);
    return true;
  }

  finish(reservation, success, now, providerFailure = true) {
    const state = this.chats.get(reservation.chatId);
    if (!state) return;
    if (success) {
      if (this.hourlyLimit > 0) state.successes.push(now);
      state.urls.delete(reservation.urlKey);
    } else {
      if (providerFailure) {
        const pause = state.providers.get(reservation.provider) || { failures: [], blockedUntil: 0 };
        pause.failures = pause.failures.filter(time => time > now - this.failureWindowMs);
        pause.failures.push(now);
        if (pause.failures.length >= this.maxFailures) pause.blockedUntil = now + this.failureCooldownMs;
        state.providers.set(reservation.provider, pause);
      }
      const failures = Math.min(20, (state.urls.get(reservation.urlKey)?.failures || 0) + 1);
      state.urls.set(reservation.urlKey, { failures, updatedAt: now,
        blockedUntil: now + Math.min(this.maxUrlBackoffMs, this.urlBackoffMs * 2 ** (failures - 1)) });
    }
  }

  prune(now) {
    for (const reservation of this.reservations.values()) {
      if (now - reservation.createdAt >= this.reservationTtlMs) {
        this.reservations.delete(reservation.id);
        if (reservation.sourceReserved && !reservation.sourceSettled) this.finish(reservation, false, now);
      }
    }
    for (const [key, state] of this.chats) {
      state.successes = state.successes.filter(time => time > now - this.windowMs);
      for (const [provider, pause] of state.providers) {
        pause.failures = pause.failures.filter(time => time > now - this.failureWindowMs);
        if (!pause.failures.length && pause.blockedUntil <= now) state.providers.delete(provider);
      }
      for (const [url, entry] of state.urls) {
        if (entry.blockedUntil <= now && now - entry.updatedAt >= this.failureWindowMs) state.urls.delete(url);
      }
      if (!state.successes.length && !state.providers.size && !state.urls.size
        && ![...this.reservations.values()].some(item => item.chatId === key)) this.chats.delete(key);
    }
  }
}

function denied(reason, seconds) {
  return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil(seconds)), reason, reservation: null };
}

function mediaUrlKey(value) {
  let normalized = mediaPublicationKey(value).trim();
  try { const url = new URL(normalized); url.hash = ""; normalized = url.href; } catch { /* Keep opaque identifiers stable. */ }
  return createHash("sha256").update(normalized).digest("hex");
}
