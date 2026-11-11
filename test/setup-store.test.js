import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { openSetupStore } from "../src/setup-store.js";

test("two setup databases keep distinct bots, profiles, and in-progress drafts", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "bot-setup-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const alphaFile = path.join(root, "alpha", "setup.sqlite");
  const betaFile = path.join(root, "beta", "setup.sqlite");
  const alpha = await openSetupStore("101", alphaFile);
  const beta = await openSetupStore("102", betaFile);
  try {
    alpha.bind(501);
    beta.bind(502);
    alpha.change(state => {
      state.profiles.saved = { name: "Alpha", personality: "Calm", language: "uk", locale: "uk" };
      state.defaultProfile = "saved";
      state.session = { kind: "persona", name: "Draft", locale: "en" };
      state.groups[-700] = { title: "Fixture Group", modes: { memory: "off" } };
    });
    assert.equal(alpha.profile(-700).displayName, "Alpha");
    assert.equal(beta.profile(-700), null);
    assert.equal(beta.group(-700), undefined);
    assert.equal(beta.state.session, null);
    assert.throws(() => alpha.bind(502), /different Telegram bot/);
    assert.equal((await fs.stat(alphaFile)).mode & 0o777, 0o600);
  } finally {
    alpha.close();
    beta.close();
  }

  const reopened = await openSetupStore("101", alphaFile);
  try {
    reopened.bind(501);
    assert.equal(reopened.state.session.name, "Draft");
    assert.equal(reopened.group(-700).modes.memory, "off");
    assert.equal(reopened.profile(-700).language.reply, "uk");
  } finally {
    reopened.close();
  }
});
