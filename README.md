# Plus One

A self-hosted Telegram assistant with reusable personalities, independent group
settings, scoped context, voice transcription and media tools.

## Install

Give your installation agent this repository and follow
[the installation guide](docs/runtime/PORTABLE.md). The mandatory order is:

1. Choose where/how to run: local Docker, VPS Docker, or the documented native path.
2. Install, choose Codex CLI or Anthropic API, authenticate privately and verify AI.
3. Prepare the local speech model and media tools.
4. Follow one complete Telegram checklist: create the bot, enable group joining,
   disable Group Privacy and obtain your own numeric user ID.
5. Supply token/owner ID together and confirm once; verify and start.
6. Open the bot as the owner and press Start. Continue setup in Telegram.

```sh
git clone https://github.com/MojoTheApe/plus-one.git
cd plus-one
```

Each instance uses its own account, bot and private state directory. No private
characters, rosters, credentials or another installation's services are supplied.
The current Claude connection supports text/profile/classification; its image,
live-search and scoped-history-tool connections are not implemented yet.

## Profiles and groups

The first wake-up asks what to call you and the bot, then language and character.
Preview, Save profile or Edit one field without repeating the others. Your preferred
name stays private; the bot's name is its profile title. A short introduction offers
Add to group or a separate feature catalogue. Ask questions about any feature. One personality can be used in
several groups. Add the bot to a group and make it an administrator. It privately
asks which profile to use, then shows every group function's actual active/inactive
state and any missing setup/connection. Choose a function directly or return later.

Profiles contain personality only. Each group owns its functions, players, rules,
pack, history and memory. Switching personality preserves those settings. Editing
a shared profile previews affected groups and updates their linked personality.
Feature edits require a joined group, assigned profile and required rights.

Use `/setup` for My groups, Profiles and a flat list of group functions. Choose a
function, then describe what you want in your own words; several details can be
sent together, with files separately. The bot explains the feature and asks only
what is missing. Simple switches apply immediately; complex changes have a
private preview and Save. Ask questions without losing your draft, then continue
or correct the same saved item. All features guards unsaved changes. Drafts
survive side conversation and restart. Disabling retains parameters; expired
buttons cannot save old previews. Duplicate group names get private menu labels.

## Included capabilities

New configured groups enable addressed conversation, web research, dispute review,
seven-day received history, explicit-command long-term notes, requested media
analysis and automatic supported public-link downloads.

All received eligible voices are transcribed into their group's history for
context. Ordinary speech gets no reply; addressed requests, bot replies and valid
commands/rules follow normal permissions. Voice history is not automatically
permanent memory. Media analysis uses selected video frames and recognized speech.
Downloads support public Instagram, Threads and TikTok links subject to provider,
file and quota limits. Previously saved disables remain off.

Create gatherings for any games your group plays: name the game, players,
optional GIF/caption and command. For example, a Minecraft command called Crew
can be launched with `/assemble Crew` or from the group's game picker. Optional
launch phrases reference that same command; casual game discussion stays quiet.
Phrase actions can also review disputes, send a prepared message/GIF or change
profile, with explicit matching and actor permissions. Profile changes are
owner-only. GIF files and eligible short MP4s are prepared as animations; failure
retains the other draft values.

Create a new sticker pack from a title, first image and emoji, or connect a pack
editable by your bot. Administrators retain individual sticker controls.
Moderation needs group-specific permitted operators and restriction rights.
Mini Apps start off and need separate hosted services/public HTTPS addresses.
Their card explains the steps and prepares a request for your installation agent;
[technical game instructions](docs/runtime/MINI_APPS.md) are supplementary.
Local diagnostics and an enabled setting do not establish actual AI login, speech
model availability or a successful Telegram game launch. Each function has a
concrete manual test for its current group and saved configuration.

See [how the bot works](src/bot-guide.md) for capabilities, boundaries and setup
logic. `/ping` checks availability and owner-only `/status` reports diagnostics.

## Data and development

The [installation guide](docs/runtime/PORTABLE.md) covers isolated instances,
backup and updates. Preserve private environment/auth, SQLite settings/drafts,
history, memory, caches and game state outside Git. The selected AI account
processes context sent to it. Keep one polling process per token.

Use Node 24.20+ and `npm ci --ignore-scripts && npm test`. Offline tests use
synthetic data and mocked external services. They do not establish installed,
real-provider or physical Telegram-client behavior.
