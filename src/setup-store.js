import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { initialProfileSettings } from "./setup-profiles.js";
import { createPersonaProfile } from "./persona-policy.js";

export async function openSetupStore(owner, file, importedGroups, catalog, importedDefault = catalog?.defaultProfile) {
  if (!owner) return null;
  if (!/^[1-9]\d*$/.test(owner) || !Number.isSafeInteger(Number(owner))) {
    throw new Error("BOT_OWNER_ID must be a positive Telegram user ID");
  }
  const { DatabaseSync } = await import("node:sqlite");
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.closeSync(fs.openSync(file, "a", 0o600));
  fs.chmodSync(file, 0o600);
  const database = new DatabaseSync(file);
  database.exec("CREATE TABLE IF NOT EXISTS setup (id INTEGER PRIMARY KEY CHECK (id = 1), document TEXT NOT NULL)");
  const row = database.prepare("SELECT document FROM setup WHERE id = 1").get();
  const write = database.prepare("INSERT INTO setup VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET document = excluded.document");
  let state = row ? JSON.parse(row.document) : {
    version: 1, botId: null, defaultProfile: null, profiles: {}, groups: {}, session: null, locale: "en",
  };
  if (state.version !== 1) throw new Error("Unsupported bot setup database version");

  function change(edit) {
    const next = structuredClone(state);
    edit(next);
    write.run(JSON.stringify(next));
    state = next;
  }

  if (!row) change(next => {
    for (const [id, settings] of importedGroups?.chats ?? []) {
      next.groups[id] = {
        configured: true,
        assemble: settings.assemble,
        reaction: settings.insultReply,
        sticker: importedGroups.stickerBindings[id],
        modes: settings.modes,
        rules: settings.rules,
        legacyMemory: settings.legacyMemory,
        title: settings.title,
      };
    }
    for (const [id, sticker] of Object.entries(importedGroups?.stickerBindings ?? {})) {
      next.groups[id] ??= { sticker, configured: true };
    }
  });

  if (catalog) change(next => {
    for (const [id, item] of Object.entries(catalog.records)) {
      const key = "catalog:" + id;
      next.profiles[key] ??= {
        name: item.displayName, label: item.displayName, catalogKey: id,
        language: item.language.reply, locale: ["en", "ru", "uk"].includes(item.language.reply) ? item.language.reply : "en",
        settings: initialProfileSettings(), revision: catalog.get(id).fingerprint,
      };
    }
    if (!next.defaultProfile) {
      if (!next.profiles["catalog:" + importedDefault]) throw new Error("Unknown imported default profile");
      next.defaultProfile = "catalog:" + importedDefault;
      next.locale = next.profiles[next.defaultProfile].locale;
    }
  });

  for (const record of [...Object.values(state.profiles), ...Object.values(state.groups).flatMap(group => [group.persona, group.character?.persona])]) {
    if (record?.catalogKey) {
      if (!catalog) throw new Error("A stored private profile requires its configured catalog");
      catalog.get(record.catalogKey);
    }
  }

  if (Object.values(state.groups).some(group => group.configured === undefined) ||
      Object.values(state.profiles).some(profile => !profile.settings) ||
      Object.values(state.groups).some(group => group.profile && !group.persona)) {
    change(next => {
      for (const group of Object.values(next.groups)) {
        group.configured ??= Boolean(group.profile || group.assemble || group.reaction || group.sticker || group.modes);
        if (group.profile && !group.persona && next.profiles[group.profile]) {
          const { settings: ignored, ...persona } = next.profiles[group.profile];
          group.persona = persona;
        }
      }
      for (const profile of Object.values(next.profiles)) profile.settings ??= initialProfileSettings();
    });
  }

  return {
    ownerId: Number(owner),
    get state() { return state; },
    change,
    close() { database.close(); },
    bind(botId) {
      if (state.botId === botId) return;
      if (state.botId !== null) throw new Error("Setup database belongs to a different Telegram bot");
      change(next => { next.botId = botId; });
    },
    group(id) { return state.groups[id]; },
    resolveProfile(key, record = state.profiles[key], revision) {
      if (!record) return null;
      if (record.catalogKey) {
        if (!catalog) throw new Error("A stored private profile requires its configured catalog");
        const profile = catalog.get(record.catalogKey);
        return { ...profile, fingerprint: createHash("sha256").update(JSON.stringify([profile.fingerprint, key, revision])).digest("hex") };
      }
      return createPersonaProfile(JSON.stringify([key, revision, record.revision]), {
        displayName: record.name,
        language: { accept: "all", reply: record.language, fallback: record.locale },
        persona: { kind: "inline", instruction: record.personality },
      });
    },
    profile(id) {
      const key = state.groups[id]?.profile ?? state.defaultProfile;
      const character = state.groups[id]?.character;
      const record = character?.persona ?? state.groups[id]?.persona ?? state.profiles[key];
      if (!record) return null;
      const revision = character?.revision ?? state.groups[id]?.profileRevision ?? state.defaultRevision;
      return this.resolveProfile(character?.profile ?? key, record, revision);
    },
  };
}
