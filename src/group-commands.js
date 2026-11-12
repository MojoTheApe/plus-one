import { normalizeGamePlayers } from './assemble.js';
import { mentionChunks } from './assemble-members.js';

export const commandId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,24}$/u.test(value) && value !== 'global';
export const commandTitle = game => game.commandName || game.name;
export const commandNames = game => [game.id, game.name, game.commandName, ...(game.aliases ?? [])].filter(Boolean);
export const normalizedName = value => String(value ?? '').normalize('NFKC').trim().toLowerCase();

export function validateGroupCommand(game) {
  if (!commandId(game?.id) || typeof game.name !== 'string' || !game.name.trim() || game.name.length > 80 ||
      typeof game.commandName !== 'string' || !game.commandName.trim() || game.commandName.length > 80 ||
      !Array.isArray(game.aliases) || game.aliases.length > 16 || game.aliases.some(x => typeof x !== 'string' || !x.trim() || x.length > 80) ||
      typeof game.caption !== 'string' || game.caption.length > 2000 ||
      (game.animationReference != null && (typeof game.animationReference !== 'string' || !game.animationReference || game.animationReference.length > 512 || /^https?:/iu.test(game.animationReference)))) {
    throw new Error('Invalid group gathering');
  }
  return { ...game, name: game.name.trim(), commandName: game.commandName.trim(), aliases: [...new Set(game.aliases.map(x => x.trim()))], players: normalizeGamePlayers(game.players, game.id) };
}

export function gatheringChunks(game) {
  const title = [game.name, game.caption].filter(Boolean).join('\n');
  return mentionChunks(title, game.players.map(username => ({ username })));
}

export function availableRuleAction(group, rule, profiles) {
  if (!group || group.active === false || group.configured === false || group.disabled?.reaction || rule.enabled === false) return false;
  if (rule.action.type === 'judge') return group.modes?.judge !== 'off';
  if (rule.action.type === 'persona') return profiles===undefined || Boolean(profiles[rule.action.profile]);
  if (rule.action.type === 'assemble') {
    if (group.disabled?.assemble) return false;
    return rule.action.game === 'global' ? Boolean(group.assemble) : Boolean(group.assemble?.games?.some(game => game.id === rule.action.game && game.enabled !== false && game.players?.length));
  }
  return true;
}
