(function () {
  'use strict';
  const root = document.getElementById('flappy-ui');
  const board = document.getElementById('flappy-leaderboard');
  const openButton = document.getElementById('flappy-show-leaderboard');
  const back = document.getElementById('flappy-board-back');
  const ranking = document.getElementById('flappy-ranking');
  const status = document.getElementById('flappy-board-status');
  const retry = document.getElementById('flappy-board-retry');
  const nativeBack = window.Telegram?.WebApp?.BackButton;
  let renderedLeaders = null;

  function fitNames() {
    if (board.hidden) return;
    for (const name of ranking.querySelectorAll('.bird-player-name')) {
      name.textContent = window.FlappyRecord.displayName(name.dataset.holder);
      // CSS cannot break one unsupported joined-emoji grapheme. Only add finer
      // invisible breaks when it actually exceeds this column; preserve normal emoji.
      if (name.scrollWidth > name.clientWidth) name.textContent = window.FlappyRecord.displayName(name.dataset.holder, 2);
    }
  }

  root.querySelector('[data-play-image]').src = ASSETS.sprites.button_play;
  root.querySelector('[data-board-image]').src = ASSETS.sprites.button_score;
  root.querySelector('.bird-board-grass').style.backgroundImage = `url("${ASSETS.sprites.land}")`;
  const arrow = root.querySelector('.bird-board-arrow').getContext('2d');
  arrow.fillStyle = '#fff7df';
  ['...w...','..ww...','.wwwwww','wwwwwww','.wwwwww','..ww...','...w...'].forEach((row,y) => {
    Array.from(row).forEach((pixel,x) => { if (pixel === 'w') arrow.fillRect(x*2,y*2,2,2); });
  });

  function drawCrown(context, left, top) {
    const colors = { b:'#543847', y:'#ffcf35', o:'#e89b23' };
    ['.b...b...b.','.by.byb.yb.','.bybyyybyb.','.byyyyyyyb.','..byyyyyb..','..booooob..','..bbbbbbb..'].forEach((row,y) => {
      Array.from(row).forEach((pixel,x) => {
        if (colors[pixel]) { context.fillStyle = colors[pixel]; context.fillRect(left+x*2,top+y*2,2,2); }
      });
    });
  }
  function crown() {
    const canvas = document.createElement('canvas');
    canvas.width = 22; canvas.height = 14; canvas.className = 'bird-crown';
    canvas.setAttribute('aria-label', 'Рекордсмен'); canvas.setAttribute('role', 'img');
    drawCrown(canvas.getContext('2d'), 0, 0);
    return canvas;
  }

  function render() {
    const record = window.FlappyRecord;
    const leaders = record.leaders;
    if (leaders !== renderedLeaders) {
      renderedLeaders = leaders;
      ranking.replaceChildren();
      (leaders || []).forEach((player,index) => {
        const row = document.createElement('li'), rank = document.createElement('span');
        rank.textContent = `${index + 1}.`;
        const name = document.createElement('span'), points = document.createElement('span');
        name.className = 'bird-player-name'; name.dataset.holder = player.holder;
        name.textContent = record.displayName(player.holder);
        points.className = 'bird-points'; points.textContent = `– ${player.score}`;
        row.append(rank); if (index === 0) row.append(crown()); row.append(name, points); ranking.append(row);
      });
    }
    status.textContent = !record.active ? 'Спільний рейтинг доступний у Telegram. Відкрий гру через бота.'
      : record.error ? (leaders ? 'Не вдалося оновити рейтинг. Показано останні збережені дані.' : 'Не вдалося завантажити рейтинг.')
      : leaders === null ? 'Завантаження…' : !leaders.length ? 'Ще немає результатів. Зіграй першу спробу!' : '';
    status.hidden = !status.textContent;
    retry.hidden = !record.active || !record.error;
    fitNames();
  }
  function close() {
    if (board.hidden) return;
    board.hidden = true; nativeBack?.hide();
    document.getElementById('flappy-result-actions').hidden = false;
    openButton.focus({ preventScroll:true });
  }
  window.FlappyLeaderboard = { get isOpen() { return !board.hidden; }, close, drawCrown };
  openButton.addEventListener('click', () => {
    board.hidden = false; document.getElementById('flappy-result-actions').hidden = true;
    render(); nativeBack?.show(); back.focus({ preventScroll:true });
    window.FlappyRecord.refresh?.();
  });
  back.addEventListener('click', close);
  nativeBack?.onClick(close);
  retry.addEventListener('click', () => window.FlappyRecord.refresh?.());
  window.addEventListener('flappy:record', render);
  window.addEventListener('resize', () => requestAnimationFrame(fitNames));
  window.addEventListener('keydown', event => {
    if (!board.hidden && event.code === 'Escape') { event.preventDefault(); close(); }
  });
  document.getElementById('flappy-play-again').addEventListener('click', () => window.dispatchEvent(new Event('flappy:restart')));
})();
