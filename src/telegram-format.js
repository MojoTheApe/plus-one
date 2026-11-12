import { publicLinks } from './request-policy.js';

const escape = text => String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const plain = text => String(text).replace(/<[^>]*>/g, '').replace(/[*_`]/g, '');
const decode = text => String(text).replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');

// User-supplied fields embedded in authored Markdown must remain literal.
export const escapeTelegramMarkdown = value => String(value ?? '').replace(/[\u0001\u0002]/g, '').replace(/[\\`*_<>\[\]()]/g, '\\$&');

// One renderer owns both model Markdown and transport-generated HTML. Only
// known inline markup survives; link targets are always public HTTP(S) URLs.
export function renderTelegramHtml(text) {
  const fragments = [];
  const hold = html => { const key = `\u0001${fragments.length}\u0002`; fragments.push(html); return key; };
  const link = (label, target) => {
    const url = publicLinks(decode(target))[0];
    if (!url) return escape(plain(decode(label)));
    const host = new URL(url).hostname.replace(/^www\./, '');
    const title = plain(decode(label)).trim();
    const visible = title.includes(host) ? title : `${title || host}${title ? ` (${host})` : ''}`;
    return hold(`<a href="${escape(url).replace(/"/g, '&quot;')}">${escape(visible)}</a>`);
  };
  let prepared = String(text).replace(/[\u0001\u0002]/g, '');
  prepared = prepared.replace(/\\([\\`*_<>\[\]()])/g, (_m, char) => hold(escape(char)));
  prepared = prepared.replace(/<(code|pre)>([\s\S]*?)<\/\1>/gi, (_m, tag, content) => hold(`<${tag.toLowerCase()}>${escape(decode(content))}</${tag.toLowerCase()}>`));
  prepared = prepared.replace(/`([^`\n]+)`/g, (_m, content) => hold(`<code>${escape(content)}</code>`));
  prepared = prepared.replace(/<a\s+href=["']([^"']+)["']\s*>([\s\S]*?)<\/a>/gi, (_m, url, label) => link(label, url));
  prepared = prepared.replace(/\[([^\]\n]+)\]\s*\((https?:\/\/[^)\s]+)\)/g, (_m, label, url) => link(label, url));
  prepared = prepared.replace(/<(b|i)>([\s\S]*?)<\/\1>/gi, (_m, tag, content) => hold(`<${tag.toLowerCase()}>${escape(decode(content).replace(/<[^>]*>/g,''))}</${tag.toLowerCase()}>`));
  for (const [pattern, tag] of [[/\*\*([\s\S]*?)\*\*/g, 'b'], [/__([\s\S]*?)__/g, 'b']]) {
    prepared = prepared.replace(pattern, (_m, content) => hold(`<${tag}>${escape(plain(content))}</${tag}>`));
  }
  let html = escape(prepared.replace(/【[^】]*】/g, '').replace(/[ \t]+\n/g, '\n').trim());
  // Expand in reverse order so an outer formatting fragment can contain links.
  for (let index = fragments.length - 1; index >= 0; index--) html = html.replaceAll(`\u0001${index}\u0002`, fragments[index]);
  return html;
}
