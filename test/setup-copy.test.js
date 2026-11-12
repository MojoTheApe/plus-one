import test from "node:test";
import assert from "node:assert/strict";
import { catalogue, featureDetail, featureName, matchFeature } from "../src/setup-copy.js";

test("catalogue gives each feature a description and an actionable setup status in all three languages", () => {
  const ids = ["chat", "judge", "search", "history", "memory", "voice", "analysis", "download", "assemble", "minigames", "reaction", "sticker", "moderation", "status"];
  for (const locale of ["en", "ru", "uk"]) {
    const text = catalogue(locale);
    assert.ok(text.length < 3900, "whole catalogue fits a single Telegram message");
    for (const id of ids) {
      const name = featureName(id, locale);
      assert.ok(text.includes("**" + name + ".** "), name);
      assert.ok(text.slice(text.indexOf("**" + name + ".** ")).split("\n")[0]?.length > name.length + 20, name + " needs its short description");
      assert.ok(featureDetail(id, locale).split("\n\n")[2]?.length > 50, name + " needs its detailed explanation");
      assert.equal(matchFeature(name)?.id, id, "the displayed name must open its own help");
    }
    assert.doesNotMatch(text, /Fortnite|Helldivers|Rocket League|@[A-Za-z_]+/);
  }
  const text = catalogue("ru", id => id === "voice" ? "unavailable" : id === "download" ? "off" : undefined);
  assert.match(text, /Голосовые[^\n]*нужно подключить/);
  assert.doesNotMatch(text, /Профиль задаёт/);
  assert.match(text, /Сборы игроков[^\n]*Зову настроенных игроков/);
  assert.match(featureDetail("download", "ru"), /администратора.*подключённое скачивание/);
  assert.match(featureDetail("assemble", "ru"), /Telegram-имена/);
  assert.match(featureDetail("minigames", "ru"), /BotFather/);
});
