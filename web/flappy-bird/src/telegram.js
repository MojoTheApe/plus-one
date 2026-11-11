// Optional native Telegram bridge. Ordinary browsers keep working without it.
(function () {
  "use strict";
  const app = window.Telegram?.WebApp;
  const active = Boolean(app?.initData);
  const root = document.documentElement;
  const hint = document.getElementById("controls");
  const supported = (version) => active && app.isVersionAtLeast(version);
  const pause = () => window.dispatchEvent(new Event("flappy:pause"));

  function fit() {
    const mobile = matchMedia("(pointer: coarse)").matches || window.innerWidth <= 600;
    document.body.classList.toggle("mobile-layout", mobile);
    document.body.classList.toggle("telegram-app", active);
    const safe = active ? app.safeAreaInset || {} : {};
    const content = active ? app.contentSafeAreaInset || {} : {};
    const inset = (side) => Math.max(0, Number(safe[side]) || 0) + Math.max(0, Number(content[side]) || 0);
    for (const side of ["top", "bottom", "left", "right"]) root.style.setProperty("--game-safe-" + side, inset(side) + "px");
    hint.textContent = mobile ? "Дотик — помах · Пауза — праворуч угорі" : "Клацання / Пробіл — помах · P — пауза";
    const height = active && app.viewportStableHeight > 0 ? app.viewportStableHeight : window.innerHeight;
    const footerHeight = document.querySelector("footer").getBoundingClientRect().height;
    root.style.setProperty("--game-available-height", Math.max(64, height - inset("top") - footerHeight - 16) + "px");
  }

  window.FlappyTelegram = {
    active,
    toggleFullscreen() {
      if (!supported("8.0")) { if (active) app.expand(); return; }
      if (app.isFullscreen) app.exitFullscreen(); else app.requestFullscreen();
    },
  };
  fit();
  // This listener runs before the engine's resize listener, so it sees fresh bounds.
  window.addEventListener("resize", fit);
  if (!active) return;
  if (supported("6.1")) {
    // Older clients accept theme keywords; arbitrary header colors require 6.9.
    app.setHeaderColor(supported("6.9") ? "#211d20" : "bg_color");
    app.setBackgroundColor("#211d20");
  }
  if (supported("7.10")) app.setBottomBarColor("#211d20");
  app.expand();
  const refit = () => { fit(); window.dispatchEvent(new Event("resize")); };
  app.onEvent("viewportChanged", refit);
  if (supported("8.0")) {
    app.onEvent("safeAreaChanged", refit);
    app.onEvent("contentSafeAreaChanged", refit);
    app.onEvent("fullscreenChanged", refit);
    app.onEvent("deactivated", pause);
  }
  if (document.readyState === "complete") app.ready();
  else window.addEventListener("load", () => app.ready(), { once: true });
})();
