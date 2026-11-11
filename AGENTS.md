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
3. Only after AI passes, guide creation in BotFather: allow groups (Group Joining),
   disable Group Privacy, obtain the new bot token. Explain that the owner later
   needs to make the bot an administrator in each group.
4. Ask who owns this installation and obtain their numeric Telegram user ID.
   A username alone cannot establish ownership. Keep token/keys/login private,
   outside Git; never print them or reuse another installation's credentials.
5. Run the Telegram/full non-polling check. Start only after Telegram, AI and owner
   are configured. Give the private bot link and instruct the owner to press Start.
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
