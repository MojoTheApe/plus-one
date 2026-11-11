(function () {
  "use strict";
  const app = window.Telegram?.WebApp;
  const launch = new URLSearchParams(window.location?.hash?.slice(1) || "");
  const initData = app?.initData || launch.get("tgWebAppData") || "";
  // Shared BEST belongs to all bot players. Missing chat_type must never select a personal BEST.
  const active = Boolean(initData || launch.has("tgWebAppData") || launch.has("tgWebAppPlatform"));
  const record = window.FlappyRecord = { active, best: null, holder: null, leaders: null, error: false };
  const status = document.getElementById("group-record");
  const retry = document.getElementById("group-retry");
  let pendingScore = null, syncing = false;

  function show(text, failed = false) {
    if (status.textContent === text && retry.hidden === !failed) return;
    status.textContent = text;
    retry.hidden = !failed;
    status.hidden = !text;
    window.dispatchEvent(new Event("resize")); // Refit after the footer changes height.
  }

  function displayHolder(name, clusterLimit = 16) {
    // CSS cannot wrap inside one oversized, unsupported ZWJ grapheme. Keep the
    // stored identity intact and give only long clusters invisible break points.
    const segments = typeof Intl.Segmenter === 'function'
      ? [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(name)] : [{ segment: name }];
    return segments.map(({ segment }) => {
      const points = Array.from(segment);
      return points.length > clusterLimit ? points.map((point, index) => (index && index % clusterLimit === 0 ? '\u200b' : '') + point).join('') : segment;
    }).join('');
  }
  record.displayName = displayHolder;
  if (!active) {
    show("Особистий BEST на цьому пристрої · рейтинг доступний у Telegram");
    return;
  }

  async function sync() {
    if (syncing) return;
    syncing = true;
    let sending = null;
    record.error = false;
    show(pendingScore !== null ? "Зберігаємо результат…" : "");
    window.dispatchEvent(new Event("flappy:record"));
    try {
      do {
        sending = pendingScore;
        pendingScore = null;
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 8000);
        let result;
        try {
          const response = await fetch("/flappy-bird/api/record", {
            method: "POST", headers: { "Content-Type": "application/json" }, signal: controller.signal,
            body: JSON.stringify({ initData, ...(sending === null ? {} : { score: sending }) }),
          });
          if (!response.ok) throw new Error("Record unavailable");
          result = await response.json();
        } finally { clearTimeout(timer); }
        if (!Number.isSafeInteger(result.best) || result.best < 0 || result.best > 1_000_000
            || !(result.holder === null || (typeof result.holder === "string" && result.holder.trim() && Array.from(result.holder).length <= 64))
            || !Array.isArray(result.leaders) || result.leaders.length > 10
            || result.leaders.some((player,index) => !Number.isSafeInteger(player?.score) || player.score < 0 || player.score > result.best
              || typeof player.holder !== 'string' || !player.holder.trim() || Array.from(player.holder).length > 64
              || (index > 0 && player.score > result.leaders[index - 1].score))) throw new Error("Invalid record");
        if (result.best >= (record.best ?? 0)) {
          record.best = result.best; record.holder = result.holder; record.leaders = result.leaders;
        }
      } while (pendingScore !== null);
      show("");
    } catch {
      record.error = true;
      if (sending !== null) pendingScore = Math.max(pendingScore ?? 0, sending);
      show(record.best === null ? "Спільний рекорд недоступний. Відкрий гру знову через бота."
        : pendingScore !== null ? "Результат не збережено. Перевір зв’язок і натисни «Повторити»."
          : "Немає зв’язку. Показано останні збережені дані.", true);
    } finally { syncing = false; window.dispatchEvent(new Event("flappy:record")); }
  }

  record.refresh = sync;
  record.submit = score => {
    pendingScore = Math.max(pendingScore ?? 0, score);
    sync();
  };
  retry.addEventListener("click", sync);
  window.addEventListener("online", sync);
  window.addEventListener("focus", sync);
  document.addEventListener("visibilitychange", () => { if (!document.hidden) sync(); });
  let nativeActive = app?.isActive !== false;
  if (app?.isVersionAtLeast?.("8.0")) {
    app.onEvent("activated", () => { nativeActive = true; sync(); });
    app.onEvent("deactivated", () => { nativeActive = false; });
  }
  setInterval(() => { if (!document.hidden && nativeActive) sync(); }, 15000);
  sync();
})();
