# Plus One

A self-hosted Telegram assistant with reusable personalities, independent group
settings, scoped context, voice transcription and media tools.

## Install

Give your installation agent this repository and follow
[the installation guide](docs/runtime/PORTABLE.md). The mandatory order is:

1. Choose where/how to run: local Docker, VPS Docker, or the documented native path.
2. Install, choose Codex CLI or Anthropic API, authenticate privately and verify AI.
3. Prepare the local speech model and media tools.
4. Create your Telegram bot, enable group joining and disable Group Privacy.
5. Set its private token and the owner's numeric Telegram ID; verify before starting.
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

Create a profile with name, character and language. Accept or skip the short
introduction and ask questions about any feature. One personality can be used in
several groups. Add the bot to a group and make it an administrator. It privately
asks which profile to use, then offers the group's settings.

Profiles contain personality only. Each group owns its functions, players, rules,
pack, history and memory. Switching personality preserves those settings. Editing
a shared profile previews affected groups and updates their linked personality.
Feature edits require a joined group, assigned profile and required rights.

Use `/setup` for My groups, Profiles, feature sections and cards. Choose with
buttons or natural requests; supply custom lists/text/files in messages. Complex
changes have a preview and confirmation. Drafts survive side conversation and
restart. Disabling retains parameters; expired buttons cannot save old previews.

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

Game calls need group-specific players; phrase rules need their exact phrase,
action and access settings. Link an existing pack belonging to your bot for
administrator sticker edits. Moderation needs group-specific permitted operators
and restriction rights. Mini Apps start off and require
[separate game connections](docs/runtime/MINI_APPS.md). A working AI connection or
an enabled setting alone is not proof that every external service works.

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
