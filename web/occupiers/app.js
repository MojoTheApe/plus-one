import { TerritoryView } from './territories.js';
import { AbsorptionView } from './absorption.js';
import { FloatingControls, GameZoomGuard } from './controls.js';
import { drawToy } from './art.js';

const $ = id => document.getElementById(id);
const phases = ['loading', 'error', 'dev-login', 'lobby', 'join', 'match', 'results'];
const zoomGuard = new GameZoomGuard(document);
const reasons = { full: 'Усі місця зайняті. Поки що можна спостерігати й повторити спробу пізніше.',
  no_spawn: 'Зараз немає безпечного місця. Залишайся глядачем або повтори спробу.',
  eliminated: 'Ти вже вибув із цього матчу. Повернутися можна в наступному раунді.',
  host_only: 'Це обирає організатор.', not_ready: 'Потрібні готовність учасників і достатня кількість гравців.',
  mode_unknown: 'Цей режим недоступний.', match_running: 'Змінити режим можна в лобі після матчу.',
  cannot_split: 'Потрібна маса від 20 в одній частині й менше 16 частин.',
  character_unknown: 'Цей персонаж недоступний. Вибери іншого.', character_locked: 'Персонажа не можна змінити під час гри.',
  color_taken: 'Цей колір уже зайнятий. Вибери інший.', color_locked: 'Колір не можна змінити під час гри.',
  match_ended: 'Матч уже завершено. Повертаємося до лобі.', start_failed: 'Не вдалося почати матч. Повтори спробу.',
  not_in_lobby: 'Ця дія доступна в лобі.', unknown_action: 'Дія не підтримується.' };
const deaths = { boundary: 'Ти вийшов за межі арени.', head: 'Ти зіткнувся з іншим гравцем.',
  self_trail: 'Ти перетнув власний слід.', trail_cut: 'Суперник перерізав твій слід.',
  no_land: 'Ти втратив усю територію.', absorbed: 'Тебе поглинув більший суперник.', disconnected: 'Зв’язку не було понад 10 секунд.' };
let state, myId, ticket, socket, dev = false, connected = false, stopped = false;
let observing = false, joinError = '', eventSeq = 0, reconnectTimer, disconnectedAt = null, noticeTimer;
let currentPhase = 'loading', requestId = 0, lastFrame = 0;
let roomToken = '', dismissedResult = null, rosterKey = '';
function readSession(key) { try { return sessionStorage.getItem(key); } catch { return null; } }
function saveSession(key, value) { try { sessionStorage.setItem(key, value); } catch { /* Storage is optional for Telegram identity. */ } }
let view = new TerritoryView($('arena'), $('joystick'), $('stick'), angle => command('input', { angle }), $('minimap'));
const views = { territories: view };
const absorption = () => state?.mode === 'absorption';
function selectView(mode) {
  const next = views[mode] ||= new AbsorptionView($('arena'), $('joystick'), $('stick'), target => command('input', { target }), $('minimap'));
  if (view === next) return;
  clearNotice(); resetControls();
  view.enabled = false; view.stop(); view.update(null, myId); view = next;
}
let controlLife = '', boostPointer = null, boostTimer = null, boosting = false;
const controls = new FloatingControls($('arena'), $('joystick'), $('stick'), {
  enabled: () => currentPhase === 'match' && view.enabled && !!view.me()?.alive,
  move: target => absorption() ? view.input(target) : Math.hypot(target.x, target.y) && view.input(Math.atan2(target.y / .82, target.x)),
  release: cancelled => {
    if (absorption()) { if (view.enabled) { view.input({ x: 0, y: 0 }); view.flushInput(); } else view.cancelPendingInput(); }
    else if (cancelled) view.cancelPendingInput(); else view.flushInput();
  },
  split: (x, y) => {
    if (!absorption()) return;
    const rect = $('arena').getBoundingClientRect(), origin = view.screenPoint(view.me().visual || view.me().point);
    const dx = x - rect.left - origin[0], dy = y - rect.top - origin[1], length = Math.hypot(dx, dy);
    if (length >= 8) command('split', { aim: { x: dx / length, y: dy / length } });
  },
});
function setBoost(active) {
  if (active && (!absorption() || !view.enabled || !view.me()?.alive || currentPhase !== 'match')) return;
  if (boosting === active) return;
  boosting = active;
  $('boost-game').setAttribute('aria-pressed', String(active));
  view.boosting = active;
  command('boost', { active });
  clearInterval(boostTimer); boostTimer = null;
  if (active) boostTimer = setInterval(() => command('boost', { active: true }), 100);
}
function resetControls() { controls.reset(); boostPointer = null; setBoost(false); }
window.addEventListener('blur', resetControls);
let controlWidth = window.innerWidth;
window.addEventListener('resize', () => {
  // Telegram's toolbars and keyboard can resize height during an owned drag.
  // Only an orientation/width change cancels that pointer; a new viewport origin
  // just moves its ring while preserving the input and capture.
  if (Math.abs(window.innerWidth - controlWidth) > 40) resetControls();
  else controls.position();
  controlWidth = window.innerWidth;
});
window.addEventListener('orientationchange', resetControls);
document.addEventListener('visibilitychange', () => { if (document.hidden) resetControls(); });
function element(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}
function dot(color) { const node = element('i', undefined, 'dot'); node.style.backgroundColor = color; return node; }
function paintAvatar(canvas, character, color) {
  const ctx = canvas.getContext('2d'); ctx.clearRect(0, 0, canvas.width, canvas.height);
  drawToy(ctx, canvas.width / 2, canvas.height * .74, canvas.width * .64, 1, character || 'car', color);
}
function avatar(color, character) {
  const node = element('canvas', undefined, 'avatar'); node.width = node.height = 80;
  node.setAttribute('aria-hidden', 'true'); paintAvatar(node, character, color); return node;
}
function characters(container) {
  const member = me(); if (!member || !state.characters) return;
  let picker = container.querySelector('.characters');
  if (!picker) {
    picker = element('details', undefined, 'characters');
    const summary = element('summary'), preview = element('canvas', undefined, 'character-preview');
    preview.width = preview.height = 128; preview.setAttribute('aria-hidden', 'true');
    const title = element('span'); title.append(element('small', 'Твій персонаж'), element('strong'));
    summary.append(preview, title, element('span', 'Змінити', 'change'));
    picker.append(summary, element('div', undefined, 'character-grid')); container.prepend(picker);
    picker.addEventListener('toggle', () => { summary.querySelector('.change').textContent = picker.open ? 'Згорнути' : 'Змінити'; });
  }
  const grid = picker.querySelector('.character-grid'), key = member.character + ':' + member.color;
  state.characters.forEach((choice, i) => {
    let button = grid.children[i];
    if (!button) {
      button = element('button', undefined, 'character'); button.dataset.character = choice.id;
      const preview = element('canvas'); preview.width = preview.height = 128; preview.setAttribute('aria-hidden', 'true');
      button.append(preview, element('span', choice.name));
      button.addEventListener('click', () => command('character', { character: choice.id })); grid.append(button);
    }
    button.setAttribute('aria-pressed', String(member.character === choice.id)); button.disabled = !connected;
    if (picker.dataset.preview !== key) paintAvatar(button.querySelector('canvas'), choice.id, member.color || '#ffbb00');
  });
  if (picker.dataset.preview !== key) {
    paintAvatar(picker.querySelector('.character-preview'), member.character, member.color || '#ffbb00');
    picker.querySelector('summary strong').textContent = state.characters.find(c => c.id === member.character)?.name || 'Автівка';
    picker.dataset.preview = key;
  }
}

const mass = value => value.toLocaleString('uk-UA', { maximumFractionDigits: 1 });
const percent = p => absorption() ? mass(p.score) : view.percent(p).toLocaleString('uk-UA', { minimumFractionDigits: 1, maximumFractionDigits: 1 }) + '%';
const me = () => state?.members.find(m => m.id === myId);
const rank = p => absorption() ? view.rank(p) : view.alive().filter(other => other.score > p.score + .0001).length + 1;
function show(phase) {
  if (phase !== currentPhase) clearNotice();
  if (currentPhase === 'match' && phase !== 'match') resetControls();
  currentPhase = phase;
  zoomGuard.setActive(phase === 'match');
  $('app').dataset.phase = phase;
  for (const id of phases) $(id).hidden = id !== phase;
  if (phase === 'match') view.start(); else view.stop();
}
function clearNotice() {
  clearTimeout(noticeTimer); noticeTimer = null;
  $('notice').hidden = true; $('notice').textContent = '';
}
function toast(text) {
  $('notice').textContent = text; $('notice').hidden = false;
  clearTimeout(noticeTimer); noticeTimer = setTimeout(() => { $('notice').hidden = true; }, 4000);
}
function command(action, fields = {}) {
  if (!connected || socket?.readyState !== WebSocket.OPEN) return;
  socket.send(JSON.stringify({ action, ...fields, request: ++requestId }));
}
function colors(container) {
  const member = me(); if (!member) return;
  characters(container);
  const occupied = new Set(state.phase === 'running' ? view.alive().filter(p => p.id !== myId).map(p => p.color)
    : state.members.filter(m => m.id !== myId && m.role === 'player' && m.connected).map(m => m.color));
  let palette = container.querySelector('.palette');
  if (!palette) {
    palette = element('div', undefined, 'palette');
    container.append(element('h2', 'Твій колір'), palette,
      element('p', 'Перекреслені кольори зайняті. Зміна кольору або персонажа скидає готовність.', 'hint'));
  }
  container.querySelector('.hint').textContent = state.practice ? 'Вибирай будь-який колір. Зміна кольору або персонажа скидає готовність.' : 'Перекреслені кольори зайняті. Зміна кольору або персонажа скидає готовність.';
  state.colors.forEach((color, i) => {
    // Keep the actual button through server frames, including a held touch.
    let button = palette.children[i];
    if (!button) {
      button = element('button', undefined, 'color'); button.style.backgroundColor = color;
      button.addEventListener('click', () => command('color', { color })); palette.append(button);
    }
    button.setAttribute('aria-label', `Колір ${i + 1}${occupied.has(color) ? ', зайнятий' : ''}`);
    button.setAttribute('aria-pressed', String(member.color === color));
    button.disabled = occupied.has(color) || !connected;
  });
}
function roster() {
  const key = JSON.stringify([state.hostId, myId, state.members]);
  if (key === rosterKey) return;
  rosterKey = key;
  const list = $('roster'); list.replaceChildren();
  for (const member of state.members) {
    const row = element('li', undefined, 'row'); row.append(avatar(member.color || '#8a9b91', member.character));
    const name = element('div', member.name, 'name'), details = [];
    if (member.id === state.hostId) details.push('Організатор');
    if (member.id === myId) details.push('ти');
    if (details.length) name.append(element('small', details.join(' · ')));
    row.append(name, element('span', member.role === 'spectator' ? 'Спостерігає' : member.ready ? 'Готовий' : 'Не готовий',
      'status' + (!member.ready ? ' wait' : ''))); list.append(row);
  }
}
function leaders(container, interactive = false) {
  container.parentElement.dataset.interactive = String(interactive);
  const previous = new Map([...container.children].map(row => [row.dataset.player, row]));
  for (const [i, p] of view.alive().slice(0, 5).entries()) {
    let row = previous.get(p.id);
    if (!row) {
      row = element(container.id === 'leaders' ? 'button' : 'li', undefined, container.id === 'leaders' ? 'leader' : 'row');
      row.dataset.player = p.id;
      row.append(dot(p.color), element('span'), element('b'));
      row.addEventListener('click', () => { view.followId = p.id; });
    }
    if (row.tagName === 'BUTTON') row.disabled = !interactive;
    row.children[0].style.backgroundColor = p.color;
    if (container.id === 'leaders') {
      row.children[0].textContent = rank(p) + ':';
      // Lighten only tiny text over the dark ranking panel, not game colours.
      row.children[1].style.color = '#' + [1, 3, 5].map(k => Math.round(parseInt(p.color.slice(k, k + 2), 16) * .35 + 255 * .65).toString(16).padStart(2, '0')).join('');
    }
    row.children[1].textContent = p.id === myId ? 'ТИ' : p.name;
    row.setAttribute('aria-label', `${i + 1}. ${p.name}: ${percent(p)}`);
    row.children[2].textContent = percent(p);
    if (container.children[i] !== row) container.insertBefore(row, container.children[i] || null);
    previous.delete(p.id);
  }
  for (const row of previous.values()) row.remove();
}
function renderResults() {
  const result = state.results, winners = result?.rows.filter(r => result.winners.includes(r.id)) || [];
  const cells = result?.mode === 'absorption';
  $('result-title').textContent = state.practice ? 'Тренування завершено.' : winners.length > 1 ? 'Нічия.' : winners.length ? 'Переможець — ' + winners[0].name + '!' : 'Матч без переможця.';
  const ownResult = result?.rows.find(row => row.id === myId);
  $('result-note').hidden = state.practice && !cells;
  $('result-metric').textContent = cells ? 'Маса' : 'Земля';
  $('result-note').textContent = cells ? 'Сумарна маса твоїх частин на кінець матчу. Після повного поглинання — 0.' : 'У тих, хто вибув, — земля на момент вибуття. Вони нижче тих, хто вижив: спочатку ті, хто вибув пізніше.';
  $('result-subtitle').textContent = state.practice ? (deaths[ownResult?.reason] || 'Час тренування вичерпано.') + ' Можна спробувати ще раз.'
    : cells ? winners.length ? 'Найбільша сумарна маса наприкінці матчу.' : 'На кінець матчу всі мають нульову масу.'
      : winners.length ? 'Переможця визначає площа серед тих, хто вижив.' : 'Усі гравці вибули.';
  $('results').querySelector('.actions .hint').textContent = state.practice ? 'Та сама приватна кімната. Колір збережеться, готовність скинеться.'
    : 'Та сама кімната, новий матч. Кольори збережуться, готовність скинеться.';
  const body = $('result-rows'); body.replaceChildren();
  for (const entry of result?.rows || []) {
    const row = element('tr'); if (entry.id === myId) row.classList.add('me'); if (entry.status === 'winner') row.classList.add('winner');
    row.append(element('td', entry.rank));
    const name = element('td'); name.append(dot(entry.color), document.createTextNode(' ' + entry.name + (entry.id === myId ? ' · ти' : '')));
    const status = entry.status === 'winner' && state.practice ? 'Завершив' : { winner: 'Переможець', survived: cells ? 'У грі' : 'Вижив', eliminated: cells ? 'Без маси' : 'Вибув' }[entry.status];
    name.dataset.status = status;
    row.append(name, element('td', cells ? mass(entry.mass) : entry.percent.toLocaleString('uk-UA', { maximumFractionDigits: 1 }) + '%'), element('td', status)); body.append(row);
  }
}
function render() {
  if (!state || !myId) return;
  const member = me(); if (!member) return;
  view.enabled = connected && currentPhase === 'match' && !!view.me()?.alive;
  if (!connected) view.cancelPendingInput();
  else if (!view.me()?.alive) view.clearInput();
  $('room-title').textContent = state.practice ? 'Приватне тренування' : 'Кімната твоєї групи';
  $('room-meta').textContent = `${dev ? 'Локальний тест · ' : ''}${Math.round(state.durationMs / 60_000)} хвилин · ${state.practice ? 'один гравець' : `до ${state.maxPlayers} гравців`}`;
  // A new late entrant may already have moved the shared room back to the next
  // lobby. Every participant still sees their completed result before readying.
  if (state.results?.matchId !== dismissedResult && state.results?.rows.some(row => row.id === myId)) {
    show('results'); renderResults(); return;
  }
  if (state.phase === 'lobby') {
    observing = false; joinError = '';
    show('lobby'); roster(); colors($('lobby-colors'));
    for (const button of document.querySelectorAll('[data-mode]')) {
      button.setAttribute('aria-pressed', String(button.dataset.mode === state.mode));
      button.disabled = !connected || state.hostId !== myId;
    }
    $('mode-note').textContent = state.hostId === myId ? 'Обирає організатор. Зміна скидає готовність.' : 'Режим обирає організатор.';
    $('lobby-headline').innerHTML = absorption() ? 'Збирай. Рости.<br>Поглинай!' : 'Малюй. Замикай.<br>Захоплюй!';
    $('lobby-tagline').textContent = state.practice ? 'Освой повороти та замикання контуру. Ця арена лише твоя.' : 'Повертайся на свою землю, поки твій слід не перерізали.';
    $('lobby-rules').textContent = state.practice ? 'Вийди зі своєї землі та повернися, замкнувши контур. Власний слід і межа арени небезпечні. Після вибуття почни новий раунд.' : 'Вийди зі своєї землі та повернися, замкнувши контур. Переріж чужий слід, щоб усунути суперника. Власний слід, зіткнення та межа арени небезпечні. Після вибуття — наступний раунд.';
    $('lobby-message').textContent = state.practice ? 'Ця кімната доступна лише тобі. Тренування триває до 5 хвилин або до вибуття.' : '';
    if (absorption()) {
      $('lobby-tagline').textContent = 'Почни маленьким. Збери більше маси за 5 хвилин.';
      $('lobby-rules').textContent = 'Збирай їжу та поглинай менших. Двічі торкнися поля, щоб розділитися в той бік. Утримуй «Скинути масу»: їжа летить назад, ти прискорюєшся вперед. На комп’ютері: пробіл — розділення, W — прискорення. Злиття — від 15 секунд. Після поглинання можна відродитися. Виграє сумарна маса наприкінці матчу.';
      $('lobby-message').textContent = state.practice ? 'Приватна арена на 5 хвилин. Збирай їжу та тренуй розділення. Ця кімната доступна лише тобі.' : 'Після поглинання можна повернутися маленьким.';
    }
    const count = state.members.filter(m => m.role === 'player' && m.connected).length;
    $('population').textContent = `${count} / ${state.maxPlayers}`;
    $('ready').textContent = member.role === 'spectator' ? 'Хочу грати' : member.ready ? 'Скасувати готовність' : 'Готовий';
    $('ready').disabled = !connected;
    $('spectate-lobby').hidden = state.practice || member.role === 'spectator';
    $('start').hidden = state.hostId !== myId;
    $('start').textContent = state.practice ? 'Почати тренування' : 'Почати матч';
    $('start').disabled = !state.canStart || !connected;
    $('ready-hint').textContent = count < state.minPlayers ? `Для старту потрібно гравців: щонайменше ${state.minPlayers}.` : state.canStart
      ? state.hostId === myId ? 'Усі готові. Можна починати.' : 'Усі готові. Чекаємо на організатора.'
      : state.practice ? 'Натисни «Готовий», потім почни тренування. Ти граєш сам.' : 'Починаємо, коли всі учасники готові.';
  } else if (state.phase === 'results') {
    show('results'); renderResults();
  } else {
    const player = view.me();
    if (player && !player.alive) observing = true;
    if (!player && !observing) {
      show('join'); colors($('join-colors')); leaders($('join-leaders'));
      const alive = view.alive();
      $('join-count').textContent = `У грі ${alive.length} із ${state.maxPlayers} гравців.`;
      $('join-leader').textContent = alive[0] ? `Лідер: ${alive[0].name} · ${percent(alive[0])}` : '';
      $('join-info').textContent = joinError ? reasons[joinError] || 'Спробуй увійти знову.'
        : alive.length >= state.maxPlayers ? reasons.full : 'Безпечна стартова земля та захист на 3 секунди, доки ти не вийдеш за її межі.';
      $('join-info').classList.toggle('error', !!joinError);
      if (absorption() && !joinError && alive.length < state.maxPlayers) $('join-info').textContent = 'Почнеш маленьким у безпечному місці із захистом на 2 секунди. Після поглинання можна відродитися.';
      $('join-game').textContent = joinError ? 'Повторити спробу' : 'Приєднатися';
      $('join-game').disabled = !connected || alive.length >= state.maxPlayers;
    } else {
      show('match');
      const active = !!player?.alive;
      view.enabled = active && connected;
      leaders($('leaders'), !active);
      $('score-label').textContent = active ? absorption() ? 'Твоя маса' : 'Твоя земля' : 'На арені';
      $('score').textContent = active ? percent(player) : String(view.alive().length);
      $('score').style.fontSize = absorption() && active && player.score >= 1000 ? player.score >= 10000 ? '12px' : '14px' : '';
      $('rank-wrap').hidden = !active;
      $('rank').textContent = active ? `${rank(player)} / ${view.alive().length}` : '—';
      $('stick').style.backgroundColor = player?.color || '#ffbb00';
      const life = `${state.game.id}:${player?.life || 0}:${active && connected}`;
      if (controlLife !== life) { resetControls(); controlLife = life; }
      $('boost-game').hidden = !absorption() || !active;
      $('boost-game').disabled = !connected || !active;
      $('observe-panel').hidden = active;
      $('observe-title').textContent = player ? 'Ти вибув' : 'Ти спостерігаєш';
      $('observe-text').textContent = player ? (deaths[player.deathReason] || 'Матч для тебе завершено.') + ' Наступний шанс — у новому матчі.'
        : 'Натисни ім’я лідера, щоб стежити за ним. Можна спробувати увійти.';
      $('open-join').hidden = !!player;
      if (absorption()) {
        $('observe-title').textContent = player ? player.deathReason === 'absorbed' ? 'Тебе поглинули' : 'Ти вибув' : 'Ти спостерігаєш';
        if (player) $('observe-text').textContent = 'Твоя маса — 0. Повернися маленьким і спробуй ще. Матч триває.';
        $('open-join').hidden = false;
      }
      $('open-join').textContent = absorption() && player ? 'Відродитися' : 'Приєднатися';
      $('open-join').disabled = !connected;
      $('leaders-box').hidden = !connected;
    }
  }
  updateClock();
}
function updateClock() {
  const now = Date.now() + (view.clockOffset || 0), remaining = Math.max(0, (state?.game?.endsAt || now) - now);
  const seconds = Math.ceil(remaining / 1000), time = `${Math.floor(seconds / 60).toString().padStart(2, '0')}:${(seconds % 60).toString().padStart(2, '0')}`;
  $('time').textContent = time; $('join-time').textContent = time;
  const protection = Math.max(0, (view.me()?.protectedUntil || 0) - now);
  $('protection').hidden = !protection || currentPhase !== 'match';
  if (protection) $('protection').textContent = `Захист · ${(protection / 1000).toFixed(1)} с.` + (absorption() ? '' : ' Вихід зі своєї землі зніме захист.');
  if (disconnectedAt !== null) {
    const left = Math.max(0, 10 - Math.floor((Date.now() - disconnectedAt) / 1000));
    $('connection').textContent = left ? `Зв’язок втрачено · ${left} с на повернення. Персонаж продовжує рух.` : 'Відновлюємо зв’язок. Без зв’язку понад 10 секунд гравець вибуває.';
  }
}
function connect() {
  if (stopped) return;
  clearTimeout(reconnectTimer);
  socket = new WebSocket(`${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/occupiers/socket`);
  const current = socket;
  socket.onopen = () => current.send(JSON.stringify({ type: 'hello', token: ticket }));
  socket.onmessage = event => {
    if (socket !== current) return;
    let data; try { data = JSON.parse(event.data); } catch { return; }
    if (data.type === 'welcome') { myId = data.id; dev = data.dev; return; }
    if (data.type === 'state') {
      connected = true; disconnectedAt = null; lastFrame = Date.now(); $('connection').hidden = true;
      if (state?.game?.id && data.game?.id !== state.game.id) { observing = false; joinError = ''; }
      const initial = !state;
      selectView(data.mode); state = data; view.clockOffset = data.time - Date.now(); view.update(data.game, myId);
      if (initial) eventSeq = Math.max(0, ...(data.events || []).map(e => e.seq));
      for (const item of data.events || []) {
        if (item.seq <= eventSeq) continue;
        eventSeq = item.seq;
        if (item.type === 'joined') toast(item.name + ' приєднався до гри');
        if (item.type === 'respawned' && item.id === myId) { observing = false; joinError = ''; }
        if (item.type === 'color_changed' && item.id === myId) toast('Вибраний колір зайняли. Тобі призначено інший вільний колір.');
        if (item.type === 'capture_failed' && item.id === myId) toast('Не вдалося обробити цей контур. Території збережено.');
      }
      render();
    } else if (data.type === 'ack' && !data.ok) {
      joinError = data.reason; toast(reasons[data.reason] || 'Дію не виконано.'); render();
    }
  };
  socket.onerror = () => {};
  socket.onclose = async event => {
    if (socket !== current || stopped) return;
    connected = false; disconnectedAt ??= Date.now(); $('connection').hidden = false; render();
    if (event.code === 4001) { stopped = true; fail('Гру відкрито в іншому вікні. Щоб повернути керування, натисни «Повторити вхід».'); return; }
    if (event.code === 4003) { await login(); return; }
    reconnectTimer = setTimeout(connect, 1000);
  };
}
function initData() {
  return window.Telegram?.WebApp?.initData || new URLSearchParams(location.hash.slice(1)).get('tgWebAppData') || '';
}
function fail(message) { $('error-text').textContent = message; show('error'); }
async function login(localName) {
  show('loading'); stopped = false;
  try {
    const raw = initData();
    let devId = readSession('occupiers-dev-id');
    if (!devId) { devId = crypto.randomUUID(); saveSession('occupiers-dev-id', devId); }
    const response = await fetch('/occupiers/api/session', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ initData: raw, devId, name: localName || readSession('occupiers-dev-name') || 'Гравець' }) });
    if (!response.ok) { fail(response.status === 429 ? 'Забагато спроб входу. Зачекай хвилину.'
      : response.status === 401 ? 'Відкрий Occupiers кнопкою з Telegram. Дані запуску не підтверджено або ця приватна кімната належить іншому користувачу.' : 'Сервер тимчасово недоступний. Повтори вхід.'); return; }
    const data = await response.json();
    ticket = data.token; dev = data.dev;
    roomToken = data.room;
    dismissedResult = readSession('occupiers-result:' + roomToken);
    if (dev && !localName && !readSession('occupiers-dev-name')) { show('dev-login'); return; }
    if (localName) saveSession('occupiers-dev-name', localName);
    connect();
  } catch { fail('Немає зв’язку із сервером. Повтори вхід.'); }
}
function setupTelegram() {
  const tg = window.Telegram?.WebApp;
  if (!tg) return;
  const safe = () => {
    const top = Math.max(0, tg.safeAreaInset?.top || 0, tg.contentSafeAreaInset?.top || 0);
    const bottom = Math.max(0, tg.safeAreaInset?.bottom || 0, tg.contentSafeAreaInset?.bottom || 0);
    document.documentElement.style.setProperty('--safe-top', top + 'px');
    document.documentElement.style.setProperty('--safe-bottom', bottom + 'px');
  };
  for (const method of ['ready', 'expand', 'disableVerticalSwipes', 'enableClosingConfirmation']) {
    try { tg[method]?.(); } catch { /* Optional on older Telegram clients. */ }
  }
  tg.onEvent?.('safeAreaChanged', safe); tg.onEvent?.('contentSafeAreaChanged', safe); tg.onEvent?.('viewportChanged', safe); safe();
}
$('ready').addEventListener('click', () => me()?.role === 'spectator' ? command('join') : command('ready', { ready: !me()?.ready }));
$('start').addEventListener('click', () => command('start'));
$('spectate-lobby').addEventListener('click', () => command('spectate'));
$('watch').addEventListener('click', () => { observing = true; render(); });
$('open-join').addEventListener('click', () => {
  if (absorption() && view.me() && !view.me().alive) { joinError = ''; command('join'); }
  else { observing = false; render(); }
});
$('boost-game').addEventListener('pointerdown', event => {
  if (boostPointer !== null || event.button !== 0) return;
  event.preventDefault(); boostPointer = event.pointerId;
  event.currentTarget.setPointerCapture(event.pointerId); setBoost(true);
});
for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) $('boost-game').addEventListener(type, event => {
  if (event.pointerId !== boostPointer) return;
  event.preventDefault(); boostPointer = null; setBoost(false);
});
$('boost-game').addEventListener('keydown', event => {
  if (event.code === 'Space' || event.code === 'Enter') { event.preventDefault(); setBoost(true); }
});
$('boost-game').addEventListener('keyup', event => {
  if (event.code === 'Space' || event.code === 'Enter') { event.preventDefault(); setBoost(false); }
});
$('boost-game').addEventListener('blur', () => setBoost(false));
for (const button of document.querySelectorAll('[data-mode]')) button.addEventListener('click', () => command('mode', { mode: button.dataset.mode }));
window.addEventListener('keydown', event => {
  if (event.code === 'Space' && !event.repeat && absorption() && currentPhase === 'match' && view.enabled && !event.target.closest('button,input,summary')) {
    event.preventDefault(); command('split');
  }
});
window.addEventListener('keydown', e => { if (e.code === 'KeyW' && !e.repeat && !e.target.closest('input,textarea,button')) { e.preventDefault(); setBoost(true); } });
window.addEventListener('keyup', e => { if (e.code === 'KeyW') setBoost(false); });
$('join-game').addEventListener('click', () => command('join'));
$('back-lobby').addEventListener('click', () => {
  dismissedResult = state?.results?.matchId || null;
  if (dismissedResult) saveSession('occupiers-result:' + roomToken, dismissedResult);
  if (state?.phase === 'results') command('lobby'); else render();
});
$('retry-login').addEventListener('click', () => { stopped = true; socket?.close(); state = null; myId = null; login(); });
$('dev-enter').addEventListener('click', () => login($('dev-name').value.trim() || 'Гравець'));
$('dev-name').addEventListener('keydown', e => { if (e.key === 'Enter') $('dev-enter').click(); });
setInterval(updateClock, 100);
setInterval(() => {
  if (connected && state?.phase === 'running' && Date.now() - lastFrame > 4000) socket?.close();
}, 1000);
window.addEventListener('online', () => { if (!connected && ticket && !stopped) connect(); });
window.addEventListener('pagehide', () => { view.stop(); view.clearInput(); view.enabled = false; stopped = true; socket?.close(); });
window.addEventListener('pageshow', event => { if (event.persisted) { stopped = false; ticket ? connect() : login(); } });
setupTelegram(); login();
