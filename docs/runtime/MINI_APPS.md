# Connect optional Telegram Mini Apps

Mini Apps start **off** in every new group. They run in separate services; the bot
only creates launch links and, where required, owns group-room/record notification
state. Connecting AI does not host a game. A page reachable only on the installer's
laptop is not a public Telegram Mini App.

## Shared preparation

1. Choose a machine for the game services and a domain with valid public HTTPS.
   The commands below assume services and the bot share the same instance's state
   on one machine. Remote games need an explicitly supported state arrangement;
   do not expose the bot's private state or credentials over the web.
2. Keep `BOT_INSTANCE_DIR` from [the bot installation](PORTABLE.md). Create only the
   two dedicated game directories, writable by UID/GID 1000:

```sh
sudo install -d -o 1000 -g 1000 -m 700 \
  "$BOT_INSTANCE_DIR/state/games/flappy" \
  "$BOT_INSTANCE_DIR/state/games/occupiers"
```

3. In a separate `games.env` outside Git set the **public**, non-secret values:

```dotenv
GAME_BOT_ID=123456789
GAME_BOT_USERNAME=YourGroupBot
GAME_ORIGIN=https://games.example.com
```

`GAME_BOT_ID` is the bot's numeric ID, not the human owner ID.
`GAME_BOT_USERNAME` has no @. Do not copy the bot's credential file into a game.
4. Host these paths on the same HTTPS origin: `/flappy-bird/` → mini-entry port
   18080, `/duel/` → Duel port 18091, `/occupiers/` → Occupiers port 18090.
   The entry page dispatches signed start parameters to the other games. Keep
   `/flappy-bird/` available as the entry even when only another game is selected.
5. In BotFather configure this bot's **Main Mini App** URL to your HTTPS
   `/flappy-bird/` entry. For group launches, registration is required in addition
   to a running web service. Use your own bot identity, not another installation's.

For a reverse proxy on the same host, the route shape is:

```nginx
location /flappy-bird/ { proxy_pass http://127.0.0.1:18080; }
location /duel/ { proxy_pass http://127.0.0.1:18091; }
location /occupiers/ {
    proxy_pass http://127.0.0.1:18090;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
}
```

Install it inside your existing HTTPS server configuration; these route fragments
do not provision a certificate or replace another site's server. Occupiers needs
WebSocket forwarding. If using separate machines/proxy containers, adjust the
upstream addresses and protected networking deliberately.

## Flappy Bird

Build/start the shared entry and Flappy service:

```sh
docker compose -p nightbot-games --env-file "$BOT_INSTANCE_DIR/games.env" -f deploy/compose.games.yaml up -d --build mini-entry
```

In the bot's private `bot.env` set:

```dotenv
FLAPPY_BIRD_URL=https://games.example.com/flappy-bird/
FLAPPY_RECORD_FILE=/state/games/flappy/shared-record-v4.json
```

The game writes its dedicated record file; the bot reads it for verified record
notifications. Back up the whole Flappy directory and bot runtime checkpoints.
The game receives a public bot ID for signature checks, never the token.

## Duel

Start the shared entry plus Duel:

```sh
docker compose -p nightbot-games --env-file "$BOT_INSTANCE_DIR/games.env" -f deploy/compose.games.yaml --profile duel up -d --build
```

Set `DUEL_URL=https://games.example.com/duel/` in private `bot.env`. The game service
uses `GAME_BOT_USERNAME` for correct invitations. Duel has peer rooms and practice;
it does not need the Occupiers room registry or shared Flappy score file.

## Occupiers

Start the shared entry plus Occupiers:

```sh
docker compose -p nightbot-games --env-file "$BOT_INSTANCE_DIR/games.env" -f deploy/compose.games.yaml --profile occupiers up -d --build
```

Set in private `bot.env`:

```dotenv
OCCUPIERS_URL=https://games.example.com/occupiers/
OCCUPIERS_ROOMS_FILE=/state/games/occupiers/rooms.json
```

`GAME_ORIGIN` must match the public HTTPS origin exactly. The bot is the only room
registry writer; Occupiers mounts only its dedicated directory read-only. Preserve
both `rooms.json` and `practice-rooms.json` in backups. Live matches are in-memory;
restarting that service interrupts them. Do not mount all bot state into a game.

## Verify and enable for a group

1. Open each chosen HTTPS route from outside the server/laptop; inspect service
   status with the corresponding games Compose project. A route that works only
   on localhost is insufficient.
2. Recreate only the selected bot instance with its original portable Compose
   file and Claude overlay if selected, so it loads the new URLs/state paths.
   Keep one poller per token. This is an owner-controlled installation operation,
   not something an ordinary group member may trigger.
3. In private `/setup`, choose the actual group → Games → Telegram Mini Apps.
   Read the selected-game instructions and run the connection check. The check
   confirms configured services are reachable; it does not prove BotFather
   registration or physical-client behavior.
4. Enable Mini Apps for that group. Launch `/flappy`, `/duel` or `/occupiers` there
   using the configured bot. Confirm the intended game opens in Telegram. Test
   Duel invitations with the intended participants and Occupiers room isolation.
5. Record actual Telegram acceptance separately from source/offline tests.
   An already opened web game uses its own service; disabling bot launch does not
   shut down active services or erase scores/rooms.

For more than one game add both profiles on the same games project, for example
`--profile duel --profile occupiers`. A build/start command is not a data backup;
use the installation's stop/backup/update procedure and preserve existing state.
