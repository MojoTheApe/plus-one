# Plus One: product knowledge

This is application knowledge, not Telegram conversation content. Explain it in
the active profile's language. Actual runtime capabilities and permissions take
precedence over a general description. Never claim an external action succeeded
without its actual result.

## Installation

The installation agent first asks where and how to run the bot (local Docker,
VPS Docker, or a documented native setup). It installs dependencies, then asks
for Codex CLI or the existing Anthropic API-key/Claude CLI connection. Verify AI
before requesting Telegram credentials. Next guide BotFather: create the bot,
allow groups, disable Group Privacy, store its token and the human owner's numeric
Telegram ID privately. A username alone never grants ownership. Verify connections
before starting one poller per token. End with the bot's private Start link.

## Personalities and groups

A profile defines name, personality and language. Create several and reuse one in
several groups. Features are configured for a specific joined group, never in a
saved personality. Changing personality preserves feature settings, players,
rules, pack, history and memory. Editing a shared profile updates linked
personalities after an explicit preview of affected groups. A deliberate
owner-only character rule may override the assigned personality. Do not claim
multiple simultaneously active personalities per group.

The owner creates the first profile via private /start, then may read an optional
introduction. Questions/help are available before adding a group. Feature editing
requires a selected joined group, assigned profile and bot administrator rights.
After joining, privately notify the owner with the actual group name and profile
choices. After assignment offer feature configuration or Later. Failure to deliver
a notification does not erase the discovered group. /setup reopens settings.
Only the configured installation owner may view or edit private configuration;
being a Telegram group administrator does not grant installation ownership.

## Defaults and voice

New configured groups enable addressed conversation, research, judging and history;
long-term notes are saved only on explicit /remember, /memory or /forget requests.
Received history is retained for seven days with group/topic boundaries. It is not
an automatic import of older Telegram messages or another group's memory.

All received eligible group voices are transcribed and recorded in group history
for context. Ordinary voices get no response. Answer only a valid addressed
request, permitted command/rule or reply to this bot. Apply the same actor,
forward, quote and replay checks as text. There is no reply-to-all voice setting.
History transcripts are not automatically permanent facts. File, processing and
configured duration limits and failed transcription can make some audio
unavailable: disclose that rather than pretending to know its contents.

Photo/video analysis is enabled but performed only on request. Video analysis
uses sampled frames and recognized speech, not a complete audiovisual viewing.
Automatic public-link downloads are enabled for new configured groups: supported
Instagram, Threads and TikTok URLs, bot administrator rights and installed tools
are required. Private posts, login requirements, site blocks, quotas and file
limits can prevent downloading. Previously saved disabled settings stay disabled.

## Additional setup

Game calls: choose a supported game, list its @usernames, optionally attach a GIF,
review and save. Players are group-specific. Edit players/GIF separately. Calling
everyone needs a complete verified member roster; the bot cannot enumerate all
unseen existing members. A configuration preview must not summon anyone.

Phrase rules: exact whole phrase, bounded action (judge, call, GIF, personality),
parameters, permitted actor and optional announcement, then preview/save.
Personality actions are owner-only. Quotes, forwards and code cannot trigger rules.

Sticker packs: link an existing regular pack belonging to this bot; one active
group per pack. Group administrators may add/remove individual stickers. No
arbitrary pack creation or whole-pack deletion is promised.

Moderation: select permitted group administrators, review, then enable. The bot
also needs permission to restrict members. Use /kick by reply or a known recent
username. Do not remove group owners/administrators. Owner identity, group-admin
status and action authorization are separate checks.

Mini Apps (Duel, Flappy Bird, Occupiers) are off initially and require their own
services, reachable public HTTPS addresses, BotFather registration and the chosen
game's public IDs/room or record state. See docs/runtime/MINI_APPS.md for concrete
per-game setup. A local page alone is insufficient for Telegram users. Never put
the bot token in a game client. Connecting a game does not automatically enable
it in every group.

## Controls and limits

Use buttons for navigation, switches and choices, and messages for user-supplied
data/files. Scope every operation to its named group. Disabling retains saved
parameters. Drafts support back/cancel and skipping optional inputs. Open menus
do not consume unrelated conversation. Stale buttons must not save old previews
or act on a newly selected group. /ping checks availability; owner-only /status
reports dependencies. An enabled preference is not a successful external test.

Codex provides the maintained independent connection. The current Claude adapter
supports text conversation, profiles and classification; image input, live web
search and the scoped history tool are not wired to it. Do not promise parity.
Never invent unknown settings, connections, secrets or successful delivery.
