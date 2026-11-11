import { parseBotCommandText } from './helpers.js';
import { actionableAssembleText } from './assemble.js';

export function duelReply(message, bot, gameUrl) {
  if (message.forward_origin || message.forward_date || message.forward_from || message.via_bot || message._voiceTranscriptionError) return null;
  const text = actionableAssembleText(message, message._voiceTranscript).normalize('NFKC').trim();
  const command = parseBotCommandText(text, bot.username);
  if (!(command?.name === 'duel' && !command.args) && !/^duel[.!?]?$/i.test(text)) return null;
  let url;
  try {
    url = new URL(gameUrl);
    if (url.protocol !== 'https:' || url.username || url.password) throw new Error('Not configured');
  } catch { return { text: 'Duel ще не підключено. Спробуй пізніше.' }; }
  const button = message.chat.type === 'private'
    ? { text: 'Грати в Duel', web_app: { url: url.href } }
    : { text: 'Грати в Duel', url: `https://t.me/${bot.username}?startapp=duel` };
  return { text: 'Duel — створи кімнату та поклич суперника або приєднайся за кодом. Є тренування з ботом.',
    reply_markup: { inline_keyboard: [[button]] } };
}
