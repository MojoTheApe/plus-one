import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { loadGroupSettings } from "../src/group-settings.js";

test("catalog validates group IDs, game settings and unique sticker pack ownership", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "group-settings-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const file = path.join(root, "groups.json");
  const games = JSON.parse(await fs.readFile(new URL("../test-support/assemble-games.json", import.meta.url), "utf8"));
  const load = async chats => {
    await fs.writeFile(file, JSON.stringify({ version: 1, chats }));
    return loadGroupSettings(file, games);
  };

  assert.equal(loadGroupSettings(undefined, games), null);
  const catalog = loadGroupSettings(new URL("../src/group-settings.example.json", import.meta.url).pathname, games);
  assert.equal(catalog.chats.size, 2);
  await assert.rejects(load({ "123": {} }), /chat ID/);
  await assert.rejects(load({ "-123": { assemble: { games: { minecraft: {} } } } }), /assemble.games/);
  await assert.rejects(load({ "-123": { assemble: { games: { fortnite: { players: [12345] } } } } }), /assemble players/);
  await assert.rejects(load({ "-123": { assemble: { globalAnimation: "missing.gif" } } }), /Missing group settings animation/);
  const reaction = (await load({ "-123": { insultReply: { animation: "fixture_gif", extraTerms: ["silly goose"] } } })).chats.get(-123).insultReply;
  assert.deepEqual(reaction.extraTerms, ["silly goose"]);
  assert.equal(reaction.terms, undefined, "extra terms retain the default insult dictionary");
  await assert.rejects(load({ "-123": { insultReply: { animation: "fixture_gif", extraTerms: [42] } } }), /Invalid group insult/);
  const stickerPack = { packName: "alpha_by_ExampleBot", ownerId: 101 };
  await assert.rejects(load({
    "-123": { stickerPack },
    "-456": { stickerPack: { ...stickerPack, packName: stickerPack.packName.toUpperCase(), ownerId: 102 } },
  }), /only be assigned to one group/);
});
