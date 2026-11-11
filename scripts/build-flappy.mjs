import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../web/flappy-bird/', import.meta.url));
const read = (name) => fs.readFile(path.join(root, name), 'utf8');
const [shell, css, assets, game, bridge, records, license, icon, pixelFont, fontLicense, boardCss, boardJs, tinyFont, tinyLicense] = await Promise.all([
  read('src/shell.html'), read('vendor/effects.css'), read('vendor/assets.js'),
  read('src/game.js'), read('src/telegram.js'), read('src/group-record.js'), read('vendor/LICENSE'), read('vendor/icon.svg'),
  fs.readFile(path.join(root, 'vendor/pixelify-sans.ttf')), read('vendor/PIXELIFY-OFL.txt'),
  read('src/leaderboard.css'), read('src/leaderboard.js'), fs.readFile(path.join(root, 'vendor/tiny5.ttf')), read('vendor/TINY5-OFL.txt'),
]);
const parts = { UPSTREAM_CSS: css, ASSETS_JS: assets, GAME_JS: game, TELEGRAM_JS: bridge, GROUP_JS: records,
  GAME_ROUTER_JS: await read('src/game-router.js'),
  LICENSE: license, ICON: 'data:image/svg+xml;base64,' + Buffer.from(icon).toString('base64'),
  PIXEL_FONT: 'data:font/ttf;base64,' + pixelFont.toString('base64'), FONT_LICENSE: fontLicense,
  LEADERBOARD_CSS: boardCss, LEADERBOARD_JS: boardJs,
  TINY_FONT: 'data:font/ttf;base64,' + tinyFont.toString('base64'), TINY_LICENSE: tinyLicense };
const html = shell.replace(/\{\{([A-Z_]+)\}\}/g, (_, key) => {
  if (!(key in parts)) throw new Error('Unknown HTML placeholder: ' + key);
  return parts[key];
});
await fs.mkdir(path.join(root, 'dist'), { recursive: true });
await fs.writeFile(path.join(root, 'dist/index.html'), html);
console.log('Built Flappy Bird (' + Buffer.byteLength(html) + ' bytes)');
