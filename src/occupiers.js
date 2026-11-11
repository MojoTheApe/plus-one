import { parseBotCommandText } from './helpers.js';
import { actionableAssembleText } from './assemble.js';

export function isOccupiersRequest(message, bot) {
  if (message.forward_origin || message.forward_date || message.forward_from || message.via_bot
    || message._voiceTranscriptionError) return false;
  const text = actionableAssembleText(message, message._voiceTranscript).normalize('NFKC').trim();
  const command = parseBotCommandText(text, bot.username);
  return !!command && command.name === 'occupiers' && !command.args;
}

export async function occupiersReply(message, bot, { gameUrl, registry }) {
  if (!isOccupiersRequest(message, bot)) return null;
  const practice = message.chat.type === 'private' && message.from?.id === message.chat.id;
  if (!practice && !['group', 'supergroup'].includes(message.chat.type)) return { text: 'Виклич /occupiers у групі для спільної гри або в особистому чаті зі мною для приватного тренування.' };
  try {
    const url = new URL(gameUrl);
    if (url.protocol !== 'https:' || url.username || url.password || !registry) throw new Error('Not configured');
  } catch { return { text: 'Occupiers ще не підключено. Спробуй пізніше.' }; }
  const token = practice ? await registry.forPractice(message.from.id) : await registry.forGroup(message.chat.id);
  return { text: practice ? 'Приватне тренування Occupiers: керуй джойстиком і захоплюй землю сам. Доступ лише для тебе; повідомлень у групах не буде.'
    : 'Occupiers — захоплюйте території разом. Оберіть колір і підтвердьте готовність у кімнаті.',
    reply_markup: { inline_keyboard: [[{ text: practice ? 'Тренуватись' : 'Грати', url: `https://t.me/${bot.username}?startapp=${token}` }]] } };
}
