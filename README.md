# Plus One

One more member of your group. A self-hosted Telegram assistant with its own
personality, shared memory, player calls, media tools and configurable reactions.

Run it on your VPS or a computer with Docker. Connect your own Telegram bot and
AI connection (Codex or Claude), then configure it by talking to it. Each installation keeps its
credentials, profiles and conversations in its own private directory.

## Install

1. Create a Telegram bot with BotFather and keep its token private.
2. Get your numeric Telegram user ID. This identifies the only account allowed
   to configure the bot; a username alone does not establish ownership.
3. Follow [the installation guide](docs/runtime/PORTABLE.md) to build the
   container, connect your chosen AI and check both connections before starting.
4. Open the bot privately, press **Start**, and answer its questions in ordinary
   messages. Choose English, Russian or Ukrainian for setup.

```sh
git clone https://github.com/MojoTheApe/plus-one.git
cd plus-one
```

Your Telegram token, owner ID and a Codex login or Claude API key are required. The default is neutral;
there are no preconfigured personal characters or real player rosters.

## Profiles and groups

Say **create a new profile** or **show all available profiles** in your private
chat. A profile can include personality, language and feature settings. Prepare
profiles before adding the bot to groups. When it joins a group, it privately
asks you which profile to use there. Review and confirm your choice.

Use **/setup** to explore capabilities by category. Ask about a feature to learn
what can be configured. Game rosters belong to profiles and groups.

Each feature has a short description and a default, setup or connection label.
You can change the subject during setup: your draft is kept privately, including
after a restart. Say **continue setup** or use **/setup** to return to the pending
question. Settings change only after you review and explicitly confirm them.
New profiles enable supported public-link downloads after group assignment;
the downloader and Telegram administrator permissions are still required.

## Message rules

Say **create a rule**, choose a group or saved profile, and provide an exact
phrase. Choose an action: review a dispute, call players, send a GIF, or change
personality. Review the group, phrase, permissions, target and announcement before
confirming. **Show rules** lists them; **delete a rule** removes one.

Ordinary requests such as asking to settle a dispute still use semantic
recognition. Saved phrase rules match the whole message, ignoring punctuation,
case and whitespace. Forwarded messages, quotes and code do not activate them.
Personality rules are always owner-only. They change the character and language
while retaining group settings and memory. A full profile assignment replaces
the group's managed feature settings and clears a separate character selection.

Profiles and rule settings are private to the owner. Group members retain only
the permissions of each feature. Replayed messages do not attempt the same rule
again; after an uncertain external failure, send a new message to retry it.

## Included capabilities

- Conversation, web research and discussion judging.
- Scoped history and long-term memory.
- Voice transcription, requested media analysis and supported link downloads.
- Configurable player calls, phrase reactions and sticker-pack operations.
- Optional Telegram Mini Apps, using your own HTTPS services and registration.

Mini Apps are separate services. They need your bot identity and public URLs;
they contain no bot token. Set `DUEL_BOT_USERNAME` on the Duel service for valid
Telegram invitations. Memory integrations require an explicit private scope;
none is connected to another installation by default.

The current Claude connection supports conversation, personalities and setup.
Web search, image input and the scoped history tool are not connected to it yet.
Game calls, downloads and other non-AI actions retain their own prerequisites.

## Data and updates

The installation guide explains isolated instances, backups and updates. SQLite
stores profiles, group settings, rules and drafts under the instance's private
state. Memory, media and conversations stay in their dedicated private paths.
The AI provider processes the prompts and context sent to it through your own
account.

Back up your instance before updating. Keep one polling process per token.
Never commit its environment file, auth, private profiles or state. For development,
use Node 24.20 or newer and `npm ci --ignore-scripts && npm test`; the ordinary
tests use temporary data and mocked external services.
