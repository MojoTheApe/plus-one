import { randomUUID, createHash } from "node:crypto";

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

  reserve(chatId, url) {
    const now = this.now(), key = String(chatId);
    this.prune(now);
    let state = this.chats.get(key);
    if (!state) {
      if (this.chats.size >= this.maxChats) return denied("CAPACITY", 5);
      state = { successes: [], failures: [], urls: new Map(), blockedUntil: 0, updatedAt: now };
      this.chats.set(key, state);
    }
    state.updatedAt = now;
    const active = [...this.reservations.values()].filter(item => item.chatId === key);
    if (this.hourlyLimit > 0 && state.successes.length >= this.hourlyLimit) {
      return denied("SUCCESS_QUOTA", (state.successes[0] + this.windowMs - now) / 1000);
    }
    if (state.blockedUntil > now) return denied("FAILURE_COOLDOWN", (state.blockedUntil - now) / 1000);
    const urlKey = mediaUrlKey(url), urlState = state.urls.get(urlKey);
    if (urlState?.blockedUntil > now) return denied("URL_BACKOFF", (urlState.blockedUntil - now) / 1000);
    if (active.length) return denied("IN_PROGRESS", 5);
    const reservation = { id: randomUUID(), chatId: key, urlKey, createdAt: now };
    this.reservations.set(reservation.id, reservation);
    return { allowed: true, retryAfterSeconds: 0, reason: null, reservation: { ...reservation } };
  }

  complete(reservation, { success } = {}) {
    const saved = reservation && this.reservations.get(reservation.id);
    if (!saved) return false;
    this.reservations.delete(saved.id);
    this.finish(saved, success === true, this.now());
    return true;
  }

  finish(reservation, success, now) {
    const state = this.chats.get(reservation.chatId);
    if (!state) return;
    state.updatedAt = now;
    if (success) {
      state.successes.push(now);
      state.urls.delete(reservation.urlKey);
    } else {
      state.failures = state.failures.filter(time => time > now - this.failureWindowMs);
      state.failures.push(now);
      if (state.failures.length >= this.maxFailures) state.blockedUntil = now + this.failureCooldownMs;
      const failures = Math.min(20, (state.urls.get(reservation.urlKey)?.failures || 0) + 1);
      state.urls.set(reservation.urlKey, { failures, updatedAt: now,
        blockedUntil: now + Math.min(this.maxUrlBackoffMs, this.urlBackoffMs * 2 ** (failures - 1)) });
    }
  }

  prune(now) {
    for (const reservation of this.reservations.values()) {
      if (now - reservation.createdAt >= this.reservationTtlMs) {
        this.reservations.delete(reservation.id);
        this.finish(reservation, false, now);
      }
    }
    for (const [key, state] of this.chats) {
      state.successes = state.successes.filter(time => time > now - this.windowMs);
      state.failures = state.failures.filter(time => time > now - this.failureWindowMs);
      for (const [url, entry] of state.urls) {
        if (entry.blockedUntil <= now && now - entry.updatedAt >= this.failureWindowMs) state.urls.delete(url);
      }
      if (!state.successes.length && !state.failures.length && !state.urls.size && state.blockedUntil <= now
        && ![...this.reservations.values()].some(item => item.chatId === key)) this.chats.delete(key);
    }
  }
}

function denied(reason, seconds) {
  return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil(seconds)), reason, reservation: null };
}

function mediaUrlKey(value) {
  let normalized = String(value || "").trim();
  try { const url = new URL(normalized); url.hash = ""; normalized = url.href; } catch { /* Keep opaque identifiers stable. */ }
  return createHash("sha256").update(normalized).digest("hex");
}
