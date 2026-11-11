# Install your own Telegram bot

Use a Linux VPS with Git, Docker Engine and the Docker Compose plugin, or a local
computer with Git and Docker Desktop. The commands below use a Unix shell. The
repository builds the image. Each bot uses a unique Compose project and a private
directory outside the checkout. The instructions below use the example project
name `nightbot`. Run them from the repository root.

## Prepare the instance

Create a Telegram bot with BotFather and keep its token on the server. Get the
owner's numeric Telegram user ID from a trusted Telegram client or a Telegram
update from the owner. The ID identifies the human account that can run setup.

```sh
export BOT_INSTANCE_DIR="$HOME/.local/share/tg-bot/nightbot"
install -d -m 700 "$BOT_INSTANCE_DIR"
test -e "$BOT_INSTANCE_DIR/bot.env" || install -m 600 deploy/portable.env.example "$BOT_INSTANCE_DIR/bot.env"
sudo install -d -o 1000 -g 1000 -m 700 \
  "$BOT_INSTANCE_DIR/state" "$BOT_INSTANCE_DIR/state/home" \
  "$BOT_INSTANCE_DIR/state/codex" "$BOT_INSTANCE_DIR/state/agent" \
  "$BOT_INSTANCE_DIR/state/runtime"

docker compose -p nightbot -f deploy/compose.portable.yaml build
```

In the private `bot.env` set `TELEGRAM_BOT_TOKEN` and `BOT_OWNER_ID`. Keep
`BOT_PROFILE=neutral` for a new installation. `AI_MODELS=default` lets the Codex CLI select its default. You can also
list models available to your account. The instance directory contains
credentials and private state, so preserve its restricted permissions.

## Connect Codex and verify

```sh
docker compose -p nightbot -f deploy/compose.portable.yaml run --rm --entrypoint codex bot login --device-auth
docker compose -p nightbot -f deploy/compose.portable.yaml run --rm bot node scripts/check-portable.mjs
```

Complete the login in your own browser. The check looks up the bot's Telegram
identity and asks Codex for a test answer. It does not start polling or send any
messages. If the check reports a problem, correct the named connection before
starting the service.

```sh
docker compose -p nightbot -f deploy/compose.portable.yaml up -d
docker compose -p nightbot -f deploy/compose.portable.yaml ps
```

Open the bot link from the check using the configured owner's Telegram account.
Press **Start** in its private chat. Answer in ordinary messages and confirm the
profile when it looks right. You can write “create a new profile” or “show all
available profiles” at any time. A profile can have its own label and can be
prepared before the bot joins any group. For example, “configure game calls in
profile Gaming” edits that saved profile's feature settings.

The first private Start should ask what to call the bot. If it reports that the
owner is missing or incorrect, verify the numeric `BOT_OWNER_ID` in this instance's
private environment file and restart that instance. Use the matching Telegram
account; the bot never assigns ownership to the first person who writes.

AI must be connected for conversational setup. You can discuss another topic
without losing the draft, then say “continue setup” or use `/setup` to return.
A plain yes during side conversation cannot save an older preview. If the AI
turn check fails, the bot keeps the draft and reports the connection problem.
The catalogue shows descriptions and whether a feature needs setup or connection;
asking about one opens its detailed requirements and supported configuration steps.
Supported public-link downloads default on in new profiles after group assignment.
The bot still needs administrator rights and the downloader enabled. Updates
preserve previously saved off modes; private/restricted posts may be unavailable.

When the bot joins a group, it privately asks the owner which profile to use.
Reply to that message to select the group, review the preview and confirm.
The owner can also ask “use profile Gaming” inside a group. The confirmation is
sent privately. Profile lists and internal configuration are private to the owner.
Applying a profile copies its personality and feature settings to the group.
Editing a saved profile prepares its next application. Reapply it to the selected
group when you want those changes there. Group history and game results are
separate from configuration. Use `/setup` for the catalogue and group settings.

Say “create a rule” to connect a whole phrase to judging, player calls, an
animation or a personality change. Choose the group/saved profile and confirm
the complete private preview. “Show rules” and “delete a rule” manage rules.
Personality rules are owner-only and preserve feature settings/memory. Full
profile assignments clear a separate character selection. Quoted/forwarded
messages cannot trigger rules. A replay does not repeat the attempt; send a new
message to retry after an uncertain external failure.


Check Telegram bot privacy and group permissions if the group does not appear.
The owner can send a message that the bot receives in that group as a fallback
for discovery. If private notification delivery fails, setup still lists the group.

## Use Claude instead of Codex

The existing Claude connection uses Claude Code CLI with your own API key.
Set `ANTHROPIC_API_KEY` in the instance's private `bot.env`. Optionally set
`CLAUDE_MODEL` and `CLAUDE_CLASSIFY_MODEL` to models available to your account.
It does not use the Codex login. Keep the instance directories and owner setup
above, and add the Claude overlay to **every** Compose operation for that instance,
including checking, starting, stopping, backups and updates:

```sh
docker compose -p nightbot -f deploy/compose.portable.yaml -f deploy/compose.claude.yaml build
docker compose -p nightbot -f deploy/compose.portable.yaml -f deploy/compose.claude.yaml run --rm bot node scripts/check-portable.mjs
docker compose -p nightbot -f deploy/compose.portable.yaml -f deploy/compose.claude.yaml up -d
```

The current Claude adapter supports conversation, profiles and intent classification,
including interrupted setup. Its image input, web search and scoped history tool
are not connected yet; the catalogue marks search and image analysis accordingly.
This is not full capability parity with Codex. Non-AI functions such as game calls
and public-link downloads keep their existing Telegram/server requirements.

## Add another bot

Repeat the steps with a distinct instance directory, Compose project name and
Telegram token. Both projects can use the same checkout. Use the corresponding
project name and `BOT_INSTANCE_DIR` for every operation. Stop a project with
`docker compose -p nightbot -f deploy/compose.portable.yaml stop`. Its saved
profile, group settings and history remain in the private directory.

For a backup, stop that project's bot, copy its private directory into protected
backup storage, then start the project again. Restore it to a stopped project
with the same token and file ownership. For source updates, pin the selected
revision, back up the private directory, build and run the check against that
revision, then recreate that project's bot. The portable project uses its own
state and credentials. Additional Mini Apps require separate HTTPS services and
BotFather registration for that account.
