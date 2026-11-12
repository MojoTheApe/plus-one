# Plus One: installation and development guide

Read README.md, docs/runtime/PORTABLE.md and src/bot-guide.md first. Follow this
mandatory order for a fresh installation; do not request every credential upfront.

1. Ask where and how the user wants to install: this computer with Docker, a VPS
   with Docker, or the documented native path if they explicitly select it.
   Prepare that environment and its isolated private instance directory.
2. Ask which AI connection: Codex CLI or Anthropic API (the existing Claude CLI
   adapter). Explain that adapter's current search/image/history limitations.
   Help the user authenticate privately. Run --ai-only without Telegram credentials;
   resolve AI errors before proceeding. Run --media-only to load the speech model
   and check tools, without starting a poller.
3. Only after AI/media pass, send ONE complete Telegram instruction, in the
   user's language: open https://t.me/BotFather, /newbot, choose name and unique
   username ending in bot, copy the token; /setjoingroups -> select that bot ->
   Enable; /setprivacy -> select the same bot -> Disable. Explain that this lets
   it receive ordinary group messages/voices. From the future owner's account,
   open https://t.me/userinfobot, press Start and copy the numeric account ID.
   Explain that this is neither their @username nor the bot's ID. Ask for token,
   owner ID and Ready together, or one OK after the two private input fields.
   State the exact private input location for this installation. Do not split
   this checklist into questions waiting for a reply after every setting.
4. After that one confirmation, save token/owner ID privately and run the
   Telegram/full non-polling check. A numeric ID is ownership configuration,
   not proof of the human's identity. Correct only the reported failed item;
   retain completed steps. Keep token/keys/login outside Git/logs, never echo
   secrets or reuse another installation's credentials. Explain that the owner
   later makes the bot administrator in each selected group.
5. Start only after Telegram, AI and owner
   are configured. Give the private bot link and instruct the owner to press Start.
   Confirm actual startup, then send one final message: the bot is configured and
   running, open its personal link, press Start and create the first profile.
   The installation-agent stage ends here; personality/group setup happens in Telegram.

Use a distinct instance directory and Compose project per bot. Never start two
pollers with one token. Keep existing state and back it up before updating.
A group administrator is not automatically the installation owner.

Profiles define name, character and language only. Functions belong to groups.
Do not edit saved-profile feature templates: choose a joined group, assign its
profile and verify bot administrator rights. Personality changes preserve group
settings/players/rules/history. Help is available before a group exists.

For development read the shipped bot guide and use supported Node and lockfile
dependencies. Offline tests use synthetic state/mocked services. Separate source,
container, real-model, installed and physical-client evidence. Do not restart a
live instance, send live Telegram messages or call a paid AI account without
explicit authorization. Preserve owner checks, topic boundaries, private memory
scopes and one-poller ownership. Rules invoke bounded actions, never arbitrary code.
