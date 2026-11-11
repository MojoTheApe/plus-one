import { createHash, randomBytes } from "node:crypto";
import { groupConfiguration } from "./setup-profiles.js";
import { say } from "./helpers.js";

export const setupDigest = value => createHash("sha256").update(JSON.stringify(value ?? null)).digest("hex");

function groupDigest(group) {
  if (!group) return setupDigest(null);
  return setupDigest([groupConfiguration(group), group.settingsRevision]);
}

// Native message controls only. The existing setup handler still owns drafts,
// permissions and configuration writes. Persist actions so restart is safe.
export function createSetupControls({ store, telegram, now = Date.now }) {
  function markup(rows, { group, draft = false } = {}) {
    const token = randomBytes(8).toString("hex");
    const actions = [];
    const keyboard = rows.filter(row => row.length).map(row => row.map(button => {
      if (button.url) return { text: button.text, url: button.url };
      const index = actions.push(button.action) - 1;
      return { text: button.text.slice(0, 64), callback_data: `setup:${token}:${index}` };
    }));
    store.change(state => {
      state.setupPanels ??= {};
      for (const [id, panel] of Object.entries(state.setupPanels)) {
        if (now() - panel.at > 24 * 3600 * 1000) delete state.setupPanels[id];
      }
      const entries = Object.keys(state.setupPanels);
      for (const id of entries.slice(0, Math.max(0, entries.length - 99))) delete state.setupPanels[id];
      state.setupPanels[token] = { at: now(), group, groupDigest: group ? groupDigest(state.groups[group]) : null,
        draftDigest: draft ? setupDigest(state.session) : null, actions };
    });
    return { inline_keyboard: keyboard };
  }

  async function consume(query) {
    if (!query.data?.startsWith("setup:")) return null;
    const permitted = query.from?.id === store.ownerId && query.message?.chat?.type === "private" &&
      query.message.chat.id === store.ownerId;
    const match = /^setup:([a-f0-9]{16}):(\d{1,3})$/u.exec(query.data);
    const panel = match && store.state.setupPanels?.[match[1]];
    const action = panel?.actions[Number(match?.[2])];
    const valid = permitted && panel && action && now() - panel.at <= 24 * 3600 * 1000 &&
      (!panel.group || panel.groupDigest === groupDigest(store.group(panel.group))) &&
      (!panel.draftDigest || panel.draftDigest === setupDigest(store.state.session));
    await telegram("answerCallbackQuery", { callback_query_id: query.id,
      ...(valid ? {} : { text: say(store.state.locale, "This menu expired. Open /setup.", "Меню устарело. Открой /setup.", "Меню застаріло. Відкрий /setup.") }) }).catch(() => {});
    if (!valid) return { invalid: true };
    store.change(state => { delete state.setupPanels[match[1]]; });
    return { action, group: panel.group, messageId: query.message.message_id };
  }

  return { markup, consume };
}
