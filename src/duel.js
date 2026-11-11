import { parseBotCommandText, say } from './helpers.js';
import { actionableAssembleText } from './assemble.js';

export function duelReply(message, bot, gameUrl, locale = 'uk') {
  if (message.forward_origin || message.forward_date || message.forward_from || message.via_bot || message._voiceTranscriptionError) return null;
  const text = actionableAssembleText(message, message._voiceTranscript).normalize('NFKC').trim();
  const command = parseBotCommandText(text, bot.username);
  if (!(command?.name === 'duel' && !command.args) && !/^duel[.!?]?$/i.test(text)) return null;
  let url;
  try {
    url = new URL(gameUrl);
    if (url.protocol !== 'https:' || url.username || url.password) throw new Error('Not configured');
  } catch { return { text: say(locale, 'Duel is not connected. Ask your installation agent to connect the game; /setup explains the requirements.', 'Duel не подключена. Попроси агента установки подключить игру; условия есть в /setup.', 'Duel ще не підключено. Попроси агента встановлення підключити гру; умови є в /setup.') }; }
  const play = say(locale, 'Play Duel', 'Играть в Duel', 'Грати в Duel');
  const button = message.chat.type === 'private'
    ? { text: play, web_app: { url: url.href } }
    : { text: play, url: `https://t.me/${bot.username}?startapp=duel` };
  return { text: say(locale, 'Duel — create a room and invite an opponent, or join by code. Bot practice is also available.', 'Duel — создай комнату и пригласи соперника или присоединись по коду. Есть тренировка с ботом.', 'Duel — створи кімнату та поклич суперника або приєднайся за кодом. Є тренування з ботом.'),
    reply_markup: { inline_keyboard: [[button]] } };
}
