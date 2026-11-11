# Install your own Plus One

## 1. Choose the environment, then install

The installation agent must first ask **where** (this computer or your VPS) and
**how** (Docker, or the native path below). Docker Desktop is the standard local
option; a Linux VPS needs Git, Docker Engine and the Compose plugin. A VPS is a
location, not an alternative to Docker. Run commands from the repository root.
Do not start the bot or ask for its Telegram token yet.

Choose a unique project name and private directory for each installation. These
examples use `nightbot`:

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

Leave Telegram token and owner ID empty for now. Never overwrite an existing
private environment file while preparing or updating an instance.

## 2. Choose AI and verify it before Telegram

The agent now asks: **Codex CLI or Anthropic API?** Connect only the selected
method, using the user's own account. Verify AI independently so authentication
problems are resolved before Telegram is introduced.

### Codex CLI

Complete device login privately in your own browser. `AI_MODELS=default` uses the
CLI default; alternatively select models available to your account.

```sh
docker compose -p nightbot -f deploy/compose.portable.yaml run --rm --entrypoint codex bot login --device-auth
docker compose -p nightbot -f deploy/compose.portable.yaml run --rm bot node scripts/check-portable.mjs --ai-only
```

### Anthropic API

The supported API-key connection uses the existing Claude Code CLI adapter.
Set your `ANTHROPIC_API_KEY` privately in `bot.env`. Optionally select available
`CLAUDE_MODEL` and `CLAUDE_CLASSIFY_MODEL` values. Add the Claude overlay to **every**
Compose operation for this instance, including checks, start, stop and updates:

```sh
docker compose -p nightbot -f deploy/compose.portable.yaml -f deploy/compose.claude.yaml run --rm bot node scripts/check-portable.mjs --ai-only
```

This adapter supports text conversation, profiles and intent classification.
Images, live web search and the scoped history tool are not connected to it yet.
Voice transcription and link downloads use their separate installed tools.

### Prepare speech and media tools

After AI passes, load the local speech model and check the downloader/FFmpeg:

```sh
docker compose -p nightbot -f deploy/compose.portable.yaml run --rm bot node scripts/check-portable.mjs --media-only
```

Include the Claude overlay when selected. The first speech-model download needs
network access and a writable instance cache; it may take several minutes. This
check verifies model loading and executables, not a physical Telegram interaction.
It neither polls nor sends Telegram messages. Correct the reported problem before
continuing. No Telegram token or owner is needed for AI/media-only checks.

## 3. Create the Telegram bot and configure group reception

Only after AI works, open the official BotFather and create your own bot with
`/newbot`. Keep its token private. Configure these settings immediately:

- `/setjoingroups`: Enable, so the bot can be added to groups.
- `/setprivacy`: Disable, so it can receive ordinary participants' group messages.

The same settings are available through `/mybots`. See
[Telegram's settings reference](https://core.telegram.org/bots/features#edit-settings).
If changing privacy for a bot already in a group, follow BotFather's instructions
about re-adding it. Later make it an administrator in each target group. Give
restriction permission only when configuring moderation; other optional actions
must have their actual required rights.

## 4. Identify the owner, verify, then start

The agent asks **who owns this installation**. Get that human account's numeric
Telegram user ID through a trusted client or verified update. A username is not
an ownership credential. Set `TELEGRAM_BOT_TOKEN` and `BOT_OWNER_ID` in private
`bot.env`. Keep `BOT_PROFILE=neutral` for a new installation.
Portable Compose refuses to start without a numeric owner ID. Keep
`BOT_REQUIRE_OWNER=true` from the portable example for native installations too.

```sh
docker compose -p nightbot -f deploy/compose.portable.yaml run --rm bot node scripts/check-portable.mjs --telegram-only
docker compose -p nightbot -f deploy/compose.portable.yaml run --rm bot node scripts/check-portable.mjs
docker compose -p nightbot -f deploy/compose.portable.yaml up -d
docker compose -p nightbot -f deploy/compose.portable.yaml ps
```

Use the Claude overlay on these commands when selected. The full check verifies
AI, local media readiness, Telegram identity/group settings and owner/runtime
configuration without polling. Never start two processes with one token.

The installer finishes by giving the bot link. Open it **as the configured owner**
and press **Start**. A missing/incorrect owner notice is an installation problem:
correct the numeric ID and restart that instance, rather than assigning ownership
to the first person who writes.

## 5. Continue in Telegram

Create the first personality: name, character, language, preview, save. Accept or
skip the short introduction. Profiles are reusable personalities; features belong
to specific groups. You can ask about features before joining any groups, but
cannot configure them in a saved profile.

Add the bot to a group and make it an administrator. It privately asks the owner
which profile to use. Select it, confirm the named group and choose Configure or
Later. Several joining notifications retain their own group. Failed notification
delivery does not erase a discovery; use My groups in `/setup`.

New groups enable conversation/search/judging, seven-day received history,
explicit-command long-term memory, requested photo/video analysis, automatic
public-link downloads and all received eligible voice transcription. Ordinary
voices are context, not automatic replies. Commands/rules and addressed requests
retain their permissions. Existing saved disables survive updates and personality
changes. Transcripts are not automatically permanent memory facts.

Buttons choose sections, modes and switches; messages provide custom data.
Complex settings have preview/save, Back, Cancel and optional Skip. Open menus do
not intercept ordinary voice/chat. Unrelated conversation pauses rather than
silently saves an old draft. Return with `/setup` or “continue setup”. Disabling
retains parameters. `/status` reports dependencies but does not prove physical-client
success. See [the product guide](../../src/bot-guide.md) and
[Mini App connection instructions](MINI_APPS.md).

## Native installation (explicit alternative)

Use only if the user explicitly selects it and the agent prepares the equivalent
isolated runtime. Install Node 24.20+, Git, Python 3 with venv, FFmpeg/FFprobe and
the selected Codex CLI or Claude CLI. Run `npm ci --ignore-scripts`; install
`requirements.txt` and `yt-dlp` in a private Python venv. Set `WHISPER_PYTHON` and
`SOCIAL_VIDEO_DOWNLOADER` to its executables.

Use absolute private `CODEX_HOME` (Codex), `AI_AGENT_DIR`, `AI_SESSION_MAP`,
`BOT_LOCK_FILE`, `BOT_STATUS_FILE`, `BOT_SETUP_FILE`, `CONVERSATION_HISTORY_DIR`,
`MEMORY_DIR`, `XDG_CACHE_HOME` and `HF_HOME` paths equivalent to the portable Compose
file. Create writable directories first. Set `ANSWER_BACKEND=codex` or `claude`;
use the selected account's private CLI authentication.

Read private environment values with Node's `--env-file` option, for example
`node --env-file=/absolute/private/bot.env scripts/check-portable.mjs --ai-only`.
Follow the same AI → media → Telegram/owner → full-check order. Only after checks
pass, run `node --env-file=/absolute/private/bot.env src/bot.js` under the user's
chosen process manager. No second poller, private root `.env`, or credentials from
another bot may be introduced.

## Updates, backup and another bot

Use a distinct instance directory, project name and token for another bot.
Always use its matching `BOT_INSTANCE_DIR`, project name and selected overlay.
Stop with `docker compose -p nightbot -f deploy/compose.portable.yaml stop` (plus
overlay if needed). Stop the selected instance before copying its private directory
into protected backup storage; then restart it. Backups include profiles, drafts,
group state, history, memory, auth and game data. Restore to a stopped instance
with matching identity and ownership. For source updates, pin the revision, back
up private state, rebuild, run the non-polling full check, then recreate only that
instance. Source merge is not an installed runtime upgrade.
