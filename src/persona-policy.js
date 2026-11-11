import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

export function loadPersonaProfile(file, selected) {
  if (!file) {
    if (selected) throw new Error("BOT_PROFILE requires BOT_PROFILE_FILE");
    return null;
  }
  const catalog = loadPersonaCatalog(file);
  return catalog.get(selected || catalog.defaultProfile);
}

// Catalog records stay private configuration. Resolve files lazily so an unused
// preset never causes another profile to load its instructions or tools.
export function loadPersonaCatalog(file) {
  let catalog;
  try { catalog = JSON.parse(fs.readFileSync(file, "utf8")); }
  catch { throw new Error("BOT_PROFILE_FILE must be a readable JSON profile catalog"); }
  if (catalog?.version !== 1 || !catalog.profiles ||
      typeof catalog.profiles !== "object" || Array.isArray(catalog.profiles) ||
      (catalog.defaultProfile !== undefined && (typeof catalog.defaultProfile !== "string" || !Object.hasOwn(catalog.profiles, catalog.defaultProfile)))) {
    throw new Error("Unknown bot profile or invalid profile catalog");
  }
  const loaded = new Map();
  return {
    defaultProfile: catalog.defaultProfile,
    records: catalog.profiles,
    get(id) {
      if (!Object.hasOwn(catalog.profiles, id)) throw new Error("Unknown bot profile");
      if (!loaded.has(id)) loaded.set(id, createPersonaProfile(id, catalog.profiles[id], path.dirname(file)));
      return loaded.get(id);
    },
  };
}

export function createPersonaProfile(id, record, directory) {
  const { displayName, aliases, language, persona } = record || {};
  if (typeof displayName !== "string" || !displayName.trim() || displayName.length > 80 ||
      (aliases !== undefined && (!Array.isArray(aliases) || aliases.length > 20 ||
        aliases.some(alias => typeof alias !== "string" || !alias.trim() || alias.length > 80)))) {
    throw new Error("Invalid bot profile name or aliases");
  }
  if (!["all", "preserve-existing"].includes(language?.accept) || typeof language.reply !== "string" ||
      (language.fallback !== undefined && typeof language.fallback !== "string") ||
      (language.accept === "preserve-existing" && language.reply !== "uk")) {
    throw new Error("Invalid bot profile language policy");
  }
  const languageNames = new Intl.DisplayNames(["en"], { type: "language", fallback: "none" });
  let languageName;
  try {
    const code = language.reply === "match-request" ? (language.fallback || "en") : language.reply;
    languageName = languageNames.of(code);
  } catch {}
  if (!languageName) throw new Error("Invalid bot profile reply language");

  let instructions, privateInstructions;
  if (persona?.kind === "inline" && typeof persona.instruction === "string" && persona.instruction.trim()) {
    instructions = `Your display name is ${JSON.stringify(displayName)}. ${persona.instruction.trim()}`;
  } else if (persona?.kind === "private-existing" && typeof persona.effective === "string" && persona.effective.trim()) {
    if (!directory) throw new Error("Private persona files require a profile catalog");
    const instructionsFile = path.resolve(directory, persona.effective);
    try { privateInstructions = fs.readFileSync(instructionsFile, "utf8"); }
    catch { throw new Error("The selected bot profile requires a readable private persona file"); }
    if (!privateInstructions.trim()) throw new Error("The selected private persona file is empty");
  } else {
    throw new Error("Invalid bot profile persona");
  }
  const fingerprint = createHash("sha256").update(JSON.stringify([id, displayName, aliases, language, instructions ?? privateInstructions])).digest("hex");
  return { displayName, aliases, language, languageName, instructions, privateInstructions, fingerprint };
}

export function profileReplyLanguage(profile) {
  if (!profile) return "Answer in Ukrainian.";
  if (profile.language.reply === "match-request") {
    return `Reply in the language of the current author's own request. Ignore names and quoted context when determining it. If no language is clear, reply in ${profile.languageName}.`;
  }
  if (profile.language.accept === "preserve-existing") return `Reply in ${profile.languageName}.`;
  return `Write the entire reply in ${profile.languageName}, even if the request uses a different language. The request's language never changes this profile's reply language. Check the language of the final text before sending it.`;
}
