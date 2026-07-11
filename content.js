/**
 * checkSource.ai — content script
 * NEVER mutates image parents (prevents blank images).
 * Instant hover card + background AI update. Text selection support.
 */

(() => {
  "use strict";

  const MIN_SIZE = 64;
  const HOVER_MS = 350;
  const CACHE = new Map();
  const PENDING = new Set();

  let autoDetect = true;
  let hoverTimer = null;
  let activeSrc = null;
  let hoverToken = 0;
  let lastMove = 0;
  let pinned = false; // user pinned the card open

  chrome.storage.sync.get({ autoDetect: true }, (cfg) => {
    autoDetect = cfg.autoDetect !== false;
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "sync" && changes.autoDetect) {
      autoDetect = changes.autoDetect.newValue !== false;
    }
  });

  /* ---------------- host UI (isolated from page layout) ---------------- */

  function getHost() {
    let host = document.getElementById("checksource-host");
    if (host) return host;
    host = document.createElement("div");
    host.id = "checksource-host";
    host.setAttribute("data-checksource-root", "host");
    host.innerHTML = `
      <div class="cs-badge" id="cs-badge" hidden></div>
      <div class="cs-card" id="cs-card" hidden>
        <button type="button" class="cs-card-close" id="cs-card-close" aria-label="Close">×</button>
        <div class="cs-card-body" id="cs-card-body"></div>
      </div>
      <button type="button" class="cs-sel-btn" id="cs-sel-btn" hidden>Check text</button>
    `;
    document.documentElement.appendChild(host);

    host.querySelector("#cs-card-close").addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      pinned = false;
      hideCard();
    });

    host.querySelector("#cs-sel-btn").addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      analyzeSelection();
    });

    host.querySelector("#cs-badge").addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      pinned = true;
      const src = activeSrc;
      if (src && CACHE.has(src)) showCard(CACHE.get(src), null);
    });

    return host;
  }

  function getImageSrc(img) {
    let src =
      img.currentSrc ||
      img.src ||
      img.getAttribute("data-src") ||
      img.getAttribute("data-original") ||
      img.getAttribute("data-lazy-src") ||
      largestFromSrcset(img.getAttribute("srcset")) ||
      "";
    if (src.startsWith("//")) src = location.protocol + src;
    else if (src.startsWith("/") && !src.startsWith("//")) src = location.origin + src;
    return src;
  }

  function largestFromSrcset(srcset) {
    if (!srcset) return "";
    let best = "";
    let bestW = 0;
    for (const part of srcset.split(",")) {
      const bits = part.trim().split(/\s+/);
      const url = bits[0];
      const w = parseInt(bits[1], 10) || 0;
      if (url && w >= bestW) {
        bestW = w;
        best = url;
      } else if (url && !best) best = url;
    }
    return best;
  }

  function isEligibleImage(img) {
    if (!img || img.tagName !== "IMG") return false;
    if (img.closest?.("#checksource-host")) return false;
    const r = img.getBoundingClientRect();
    if (r.width < MIN_SIZE || r.height < MIN_SIZE) return false;
    const nw = img.naturalWidth || 0;
    const nh = img.naturalHeight || 0;
    if (nw > 0 && nh > 0 && (nw < 40 || nh < 40)) return false;
    const src = getImageSrc(img);
    if (!src || src.startsWith("data:image/svg") || src.startsWith("chrome-extension://")) return false;
    return true;
  }

  function imageFromPoint(x, y) {
    let stack;
    try {
      stack = document.elementsFromPoint(x, y);
    } catch {
      return null;
    }
    for (const el of stack) {
      if (!el || el.closest?.("#checksource-host")) continue;
      if (el.tagName === "IMG" && isEligibleImage(el)) return el;
      if (el.tagName === "PICTURE") {
        const img = el.querySelector("img");
        if (img && isEligibleImage(img)) return img;
      }
    }
    const top = stack[0];
    const wrap = top?.closest?.("figure, picture, a, [class*='image'], [class*='media']");
    const img = wrap?.querySelector?.("img");
    if (img && isEligibleImage(img)) return img;
    return null;
  }

  /* ---------------- card / badge (fixed, non-destructive) ---------------- */

  function placeNearRect(el, rect, prefer = "right") {
    const margin = 10;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    el.hidden = false;
    // measure after unhide
    const w = el.offsetWidth || 320;
    const h = el.offsetHeight || 200;

    let left = prefer === "right" ? rect.right + margin : rect.left;
    let top = rect.top;

    if (left + w > vw - 8) left = rect.left - w - margin;
    if (left < 8) left = 8;
    if (top + h > vh - 8) top = Math.max(8, vh - h - 8);
    if (top < 8) top = 8;

    el.style.position = "fixed";
    el.style.left = `${Math.round(left)}px`;
    el.style.top = `${Math.round(top)}px`;
    el.style.zIndex = "2147483647";
  }

  function showBadge(text, rect, tone) {
    getHost();
    const badge = document.getElementById("cs-badge");
    badge.textContent = text;
    badge.className = `cs-badge ${tone || ""}`;
    badge.hidden = false;
    badge.style.position = "fixed";
    badge.style.left = `${Math.round(rect.right - 72)}px`;
    badge.style.top = `${Math.round(rect.top + 8)}px`;
    badge.style.zIndex = "2147483646";
    if (parseFloat(badge.style.left) < 8) badge.style.left = "8px";
  }

  function hideBadge() {
    const badge = document.getElementById("cs-badge");
    if (badge) badge.hidden = true;
  }

  function showCard(report, anchorRect) {
    getHost();
    const card = document.getElementById("cs-card");
    const body = document.getElementById("cs-card-body");
    body.innerHTML = renderReportHTML(report, { compact: false });
    card.hidden = false;

    if (anchorRect) placeNearRect(card, anchorRect, "right");
    else {
      card.style.position = "fixed";
      card.style.right = "16px";
      card.style.top = "16px";
      card.style.left = "auto";
      card.style.zIndex = "2147483647";
    }
  }

  function hideCard() {
    if (pinned) return;
    const card = document.getElementById("cs-card");
    if (card) card.hidden = true;
  }

  function updateBadgeFromReport(report, rect) {
    if (!rect) return;
    if (report?.error) {
      showBadge("N/A", rect, "is-error");
      return;
    }
    if (report?.pending || report?.aiProbability == null) {
      showBadge("…", rect, "is-loading");
      return;
    }
    const pct = report.aiProbability;
    if (report.uncertain) showBadge(`? ${pct}%`, rect, "is-uncertain");
    else if (report.isAI) showBadge(`AI ${pct}%`, rect, "is-ai");
    else showBadge(`Real ${Math.max(0, 100 - pct)}%`, rect, "is-real");
  }

  /* ---------------- analysis ---------------- */

  async function requestAnalysis(src) {
    if (CACHE.has(src) && !CACHE.get(src).error && !CACHE.get(src).pending) {
      return CACHE.get(src);
    }
    if (PENDING.has(src)) {
      for (let i = 0; i < 60; i++) {
        await sleep(200);
        if (CACHE.has(src) && !CACHE.get(src).pending) return CACHE.get(src);
        if (!PENDING.has(src) && CACHE.has(src)) return CACHE.get(src);
      }
    }

    PENDING.add(src);
    try {
      const result = await chrome.runtime.sendMessage({
        type: "ANALYZE_IMAGE",
        src,
        pageUrl: location.href,
        pageHints: collectPageHints(),
      });
      if (!result) throw new Error("No response from extension — reload it");
      CACHE.set(src, result);
      return result;
    } finally {
      PENDING.delete(src);
    }
  }

  function collectPageHints() {
    const text = `${document.title} ${document.body?.innerText?.slice(0, 5000) || ""}`;
    const mentionsAIFake =
      /AI[- ]generated|artificially generated|deepfake|synthetic image|fake image|not (a )?real (photo|image)|Full Fact|fact[- ]?check|went viral|manipulated (image|photo)|generated with AI|Midjourney|DALL·E|DALL-E|Stable Diffusion/i.test(
        text
      );
    const hasWireCredit =
      /\b(AP|Reuters|AFP|Getty Images|Associated Press)\b/i.test(text) ||
      /Vahid Salemi\/AP|\/AP\b/i.test(text);
    return { mentionsAIFake, hasWireCredit };
  }

  async function scanImage(img, token) {
    const src = getImageSrc(img);
    if (!src) return;
    activeSrc = src;
    const rect = img.getBoundingClientRect();

    // Instant UI from cache
    if (CACHE.has(src) && !CACHE.get(src).pending && !CACHE.get(src).error) {
      const cached = CACHE.get(src);
      updateBadgeFromReport(cached, rect);
      showCard(cached, rect);
      return;
    }

    // Instant local preview (no wait)
    const quick = buildQuickReport(src, location.href);
    CACHE.set(src, quick);
    updateBadgeFromReport(quick, rect);
    showCard(quick, rect);

    try {
      const full = await requestAnalysis(src);
      if (token !== hoverToken && activeSrc !== src) return; // user moved on
      CACHE.set(src, full);
      // Re-measure — page may have scrolled; find img again
      const live = findImgBySrc(src) || img;
      const r2 = live.getBoundingClientRect();
      updateBadgeFromReport(full, r2);
      if (activeSrc === src || pinned) showCard(full, r2);
    } catch (err) {
      const fail = { error: err.message || "Analysis failed", kind: "image" };
      CACHE.set(src, fail);
      if (activeSrc === src) {
        showCard(fail, img.getBoundingClientRect());
        showBadge("N/A", img.getBoundingClientRect(), "is-error");
      }
    }
  }

  function findImgBySrc(src) {
    for (const img of document.querySelectorAll("img")) {
      if (getImageSrc(img) === src) return img;
    }
    return null;
  }

  function scheduleScan(img) {
    const src = getImageSrc(img);
    if (!src) return;

    // Switching images: allow new scan immediately
    if (activeSrc && activeSrc !== src) {
      clearTimeout(hoverTimer);
      pinned = false;
    }

    const rect = img.getBoundingClientRect();

    // Cached = instant
    if (CACHE.has(src) && !CACHE.get(src).pending && !CACHE.get(src).error) {
      activeSrc = src;
      updateBadgeFromReport(CACHE.get(src), rect);
      showCard(CACHE.get(src), rect);
      return;
    }

    clearTimeout(hoverTimer);
    hoverTimer = setTimeout(() => {
      const token = ++hoverToken;
      scanImage(img, token);
    }, HOVER_MS);
  }

  function onPointerMove(e) {
    if (pinned) return;
    const now = Date.now();
    if (now - lastMove < 60) return;
    lastMove = now;

    if (e.target?.closest?.("#checksource-host")) return;

    const img = imageFromPoint(e.clientX, e.clientY);
    if (!img) {
      clearTimeout(hoverTimer);
      if (!pinned) {
        // only hide if we left images
        hideBadge();
        hideCard();
        activeSrc = null;
      }
      return;
    }

    if (!autoDetect) {
      // still show cached badge if any
      const src = getImageSrc(img);
      const rect = img.getBoundingClientRect();
      if (CACHE.has(src)) updateBadgeFromReport(CACHE.get(src), rect);
      return;
    }

    scheduleScan(img);
  }

  /* ---------------- text selection ---------------- */

  function onSelectionChange() {
    const sel = window.getSelection();
    const text = sel?.toString()?.trim() || "";
    getHost();
    const btn = document.getElementById("cs-sel-btn");

    if (text.length < 12) {
      btn.hidden = true;
      return;
    }

    try {
      const range = sel.getRangeAt(0);
      const rect = range.getBoundingClientRect();
      if (!rect || (rect.width === 0 && rect.height === 0)) {
        btn.hidden = true;
        return;
      }
      btn.hidden = false;
      btn.style.position = "fixed";
      btn.style.left = `${Math.min(window.innerWidth - 120, Math.max(8, rect.right + 6))}px`;
      btn.style.top = `${Math.max(8, rect.top - 36)}px`;
      btn.style.zIndex = "2147483647";
    } catch {
      btn.hidden = true;
    }
  }

  async function analyzeSelection() {
    const text = window.getSelection()?.toString()?.trim() || "";
    if (text.length < 8) return;
    pinned = true;
    document.getElementById("cs-sel-btn").hidden = true;

    const result =
      (await chrome.runtime.sendMessage({
        type: "ANALYZE_TEXT",
        text,
        pageUrl: location.href,
      })) || buildTextReport(text, location.href);

    showCard(result, null);
  }

  /* ---------------- messaging ---------------- */

  chrome.runtime.onMessage.addListener((msg, _s, sendResponse) => {
    if (msg?.type === "SHOW_RESULT") {
      if (msg.src) CACHE.set(msg.src, msg.result);
      pinned = true;
      const img = findImgBySrc(msg.src);
      const rect = img?.getBoundingClientRect();
      if (rect) updateBadgeFromReport(msg.result, rect);
      showCard(msg.result, rect || null);
      sendResponse({ ok: true });
      return true;
    }
    if (msg?.type === "SHOW_TEXT_RESULT") {
      pinned = true;
      showCard(msg.result, null);
      sendResponse({ ok: true });
      return true;
    }
    return false;
  });

  function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  // Reposition open UI on scroll without touching page images
  window.addEventListener(
    "scroll",
    () => {
      if (!activeSrc) return;
      const img = findImgBySrc(activeSrc);
      if (!img) return;
      const rect = img.getBoundingClientRect();
      const report = CACHE.get(activeSrc);
      if (report) updateBadgeFromReport(report, rect);
      const card = document.getElementById("cs-card");
      if (card && !card.hidden) placeNearRect(card, rect, "right");
    },
    { passive: true, capture: true }
  );

  document.addEventListener("pointermove", onPointerMove, { passive: true, capture: true });
  document.addEventListener("selectionchange", onSelectionChange);
  document.addEventListener("mouseup", onSelectionChange);
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      pinned = false;
      hideCard();
      hideBadge();
      const btn = document.getElementById("cs-sel-btn");
      if (btn) btn.hidden = true;
    }
  });

  // Click outside card unpins
  document.addEventListener(
    "pointerdown",
    (e) => {
      if (e.target?.closest?.("#checksource-host")) return;
      if (pinned) {
        pinned = false;
        hideCard();
      }
    },
    true
  );

  getHost();
  console.info("[checkSource.ai] ready — non-destructive overlays");
})();
