import { createOccupiersServer } from '../src/occupiers/server.js';

const dev = process.env.OCCUPIERS_DEV === '1';
const host = process.env.OCCUPIERS_HOST || (dev ? '127.0.0.1' : '0.0.0.0');
const options = {};
for (const [env, key] of Object.entries({ OCCUPIERS_DURATION_MS: 'durationMs', OCCUPIERS_MAX_PLAYERS: 'maxPlayers',
  OCCUPIERS_PROTECTION_MS: 'protectionMs', OCCUPIERS_SPAWN_RADIUS: 'spawnRadius', OCCUPIERS_SPAWN_DISTANCE: 'spawnDistance' })) {
  if (process.env[env] !== undefined) options[key] = Number(process.env[env]);
}
const app = createOccupiersServer({ dev, host, botId: process.env.OCCUPIERS_BOT_ID,
  registryFile: process.env.OCCUPIERS_ROOMS_FILE, origin: process.env.OCCUPIERS_ORIGIN, config: options });
const port = Number(process.env.OCCUPIERS_PORT || 8090);
app.server.listen(port, host, () => console.log('Occupiers listening on ' + host + ':' + port + (dev ? ' (local development)' : '')));
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => app.close().then(() => process.exit(0)));
