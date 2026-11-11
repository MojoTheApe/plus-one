import { actionableAssembleText } from "./assemble.js";
import { parseBotCommandText } from "./helpers.js";

const escape = (value) => String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const launch = /^(?:запусти|запустити|запустить|відкрий|відкрити|открой|открыть|open|launch|start|play)\s+(?:(?:мені|мне|me)\s+)?(?:(?:гру|игру|the game)\s+)?(?:flappy[\s-]*bird|фл[еэа]п[піи]+[\s,-]*б[еёіи]рд)[.!?\s]*$/iu;

export function isFlappyRequest(message, bot, aliasPrefix) {
  if (message.forward_origin || message.forward_date || message.forward_from || message.via_bot || message._voiceTranscriptionError) return false;
  const text = actionableAssembleText(message, message._voiceTranscript).normalize("NFKC").trim();
  if (!text || text.length > 512) return false;
  const command = parseBotCommandText(text, bot.username);
  if (command) return (command.name === "flappy" && !command.args) || (command.name === "start" && command.args === "flappy");
  if (text.startsWith("/")) return false;
  const mention = new RegExp(`@${escape(bot.username)}\\b`, "iu");
  const named = aliasPrefix || /^(?:бот|bot)[,:\s]+/iu;
  if (message.chat.type !== "private" && !mention.test(text) && !named.test(text) && message.reply_to_message?.from?.id !== bot.id) return false;
  const request = text.replace(new RegExp(`@${escape(bot.username)}\\b`, "giu"), "")
    .replace(named, "").replace(/^[\s,:]+/u, "")
    .replace(/^(?:будь ласка|пожалуйста|please)[,:\s]+/iu, "")
    .replace(/^(?:можеш|можешь|can you|could you)[,:\s]+/iu, "")
    .replace(/[,\s]+(?:будь ласка|пожалуйста|please)[.!?\s]*$/iu, "").trim();
  return launch.test(request);
}

export function flappyReply(message, bot, gameUrl, aliasPrefix) {
  if (!isFlappyRequest(message, bot, aliasPrefix)) return null;
  let url;
  try {
    url = new URL(gameUrl);
    if (url.protocol !== "https:" || url.username || url.password) throw new Error("Invalid game URL");
  } catch {
    return { text: "Flappy Bird ще не підключено. Спробуй пізніше." };
  }
  const privateChat = message.chat.type === "private";
  const button = privateChat ? { text: "Грати", web_app: { url: url.href } }
    : { text: "Грати у Flappy Bird", url: `https://t.me/${bot.username}?startapp=flappy` };
  return {
    text: privateChat ? "Flappy Bird — натисни «Грати»." : "Flappy Bird — грайте тут. Рекорд спільний для всіх гравців.",
    reply_markup: { inline_keyboard: [[button]] },
  };
}
