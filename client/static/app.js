/* ═══════════════════════════════════════════════════════
   ChessNow — Frontend Application
   Handles: view routing, Chess.com API calls,
            board rendering, analysis polling, charts
═══════════════════════════════════════════════════════ */

"use strict";

// ── State ─────────────────────────────────────────────
const state = {
  username:    "",
  games:       [],
  analysisMode:"normal",
  currentGame: null,
  result:      null,    // analysis result object
  moveIndex:   -1,      // -1 = start position
  board:       null,    // chessboard.js instance
  chess:       null,    // chess.js instance for move validation
  flipped:     false,
  chart:       null,
  pollTimer:   null,
  liveEvalAbortController: null,
  liveEvalLines: [],
  // Variation navigation
  currentVariationPath: [],
  lastRenderedPathStr: null,
  showBestArrow: true,  // show best-move arrow on mistakes by default
  fromCache: false,
  forceReanalyze: false,
};

let useLocalWasm = true;   // Analyzer-first: always prefer in-browser Stockfish WASM
let hasBackend = false;
let analysisAbort = { cancelled: false };
let analysisInProgress = false; // true while a full-game review owns the Stockfish worker
// Engine state is declared up here (not beside the functions that use it) because
// restoring a review after a page refresh runs live eval during the initial
// routing call, before declarations further down this file have been initialised.
let liveEvalSeq = 0;
let liveEvalToken = 0;                    // newest evaluateMultiPV request
let liveEvalChain = Promise.resolve();    // serialises live searches on the worker
/** Warm Stockfish worker reused across review + live eval (Hash stays hot). */
let sharedSfWorker = null;
let sharedSfReady = null;
const LAST_USERNAME_KEY = "chesscom_last_user";
const ACTIVE_REVIEW_KEY = "chessnow_active_review";

function persistActiveReview() {
  if (!state.currentGame) return;
  const payload = {
    game: state.currentGame,
    username: state.username,
    analysisMode: state.analysisMode,
    fromCache: !!state.fromCache,
    moveIndex: state.moveIndex,
    result: state.result,
  };
  try {
    sessionStorage.setItem(ACTIVE_REVIEW_KEY, JSON.stringify(payload));
  } catch (_) {
    // Result payloads can exceed quota — keep enough to re-open via analysis cache.
    try {
      delete payload.result;
      sessionStorage.setItem(ACTIVE_REVIEW_KEY, JSON.stringify(payload));
    } catch (_) {}
  }
}

function restoreActiveReview() {
  let data = null;
  try {
    data = JSON.parse(sessionStorage.getItem(ACTIVE_REVIEW_KEY) || "null");
  } catch (_) {
    return false;
  }
  if (!data?.game) return false;

  state.currentGame = data.game;
  if (data.username) state.username = data.username;
  if (data.analysisMode) state.analysisMode = data.analysisMode;
  state.fromCache = !!data.fromCache;

  if (data.result) {
    state.result = data.result;
    renderAnalysis(data.result);
    if (typeof data.moveIndex === "number" && data.moveIndex >= -1) {
      requestAnimationFrame(() => goToMove(data.moveIndex));
    }
    return true;
  }

  // No saved result — restart analysis (hits local review cache when available).
  startAnalysis(data.game);
  return true;
}

// Classification display config (win%-based labels + Chess.com-style extras)
const CLS = {
  brilliant:  { label: "Brilliant",  color: "#22d3ee", symbol: "!!", badge: "!!", emoji: "💎" },
  great:      { label: "Great",      color: "#38bdf8", symbol: "!",  badge: "!",  emoji: "🔥" },
  best:       { label: "Best",       color: "#22c55e", symbol: "✓",  badge: "★",  emoji: "⭐" },
  excellent:  { label: "Excellent",  color: "#4ade80", symbol: "✓",  badge: "✓",  emoji: "👍" },
  good:       { label: "Good",       color: "#a3e635", symbol: "·",  badge: "·",  emoji: "✅" },
  book:       { label: "Book",       color: "#a3e635", symbol: "📖", badge: "📖", emoji: "📖" },
  inaccuracy: { label: "Inaccuracy", color: "#fbbf24", symbol: "?!", badge: "?!", emoji: "⚠️" },
  mistake:    { label: "Mistake",    color: "#f97316", symbol: "?",  badge: "?",  emoji: "❓" },
  miss:       { label: "Miss",       color: "#e879f9", symbol: "✖",  badge: "✖",  emoji: "❌" },
  blunder:    { label: "Blunder",    color: "#ef4444", symbol: "??", badge: "??", emoji: "💥" },
};
// Display order for the review summary table (best → worst)
const CLS_ORDER = ["brilliant", "great", "best", "excellent", "good", "book", "inaccuracy", "mistake", "miss", "blunder"];
// Moves the "Next mistake" button stops on
const ERROR_CLS = new Set(["inaccuracy", "mistake", "miss", "blunder"]);
// Routine moves — their emoji is dimmed in move lists so key moments stand out
const QUIET_CLS = new Set(["best", "excellent", "good", "book"]);
const LOADING_LABEL = "Analysing your game…";

// ── View helpers ───────────────────────────────────────
function showView(id) {
  document.querySelectorAll(".view").forEach(v => {
    v.classList.toggle("hidden", v.id !== id);
    v.classList.toggle("active", v.id === id);
  });
  if (id !== "view-analysis") setReviewing(false);
}

function setReviewing(on) {
  document.getElementById("view-analysis")?.classList.toggle("is-reviewing", !!on);
  document.body.classList.toggle("is-reviewing", !!on);
  if (!on) closeNavDrawer();
}

function openNavDrawer() {
  const drawer = $("nav-drawer");
  const backdrop = $("nav-drawer-backdrop");
  const btn = $("nav-sandwich");
  if (!drawer) return;
  drawer.hidden = false;
  if (backdrop) backdrop.hidden = false;
  // Double rAF so the slide-in transition runs after display flips on
  requestAnimationFrame(() => {
    requestAnimationFrame(() => document.body.classList.add("nav-drawer-open"));
  });
  if (btn) btn.setAttribute("aria-expanded", "true");
}

function closeNavDrawer() {
  const drawer = $("nav-drawer");
  const backdrop = $("nav-drawer-backdrop");
  const btn = $("nav-sandwich");
  document.body.classList.remove("nav-drawer-open");
  if (btn) btn.setAttribute("aria-expanded", "false");
  // Wait for slide-out, then hide
  window.setTimeout(() => {
    if (document.body.classList.contains("nav-drawer-open")) return;
    if (drawer) drawer.hidden = true;
    if (backdrop) backdrop.hidden = true;
  }, 280);
}

function toggleNavDrawer() {
  if (document.body.classList.contains("nav-drawer-open")) closeNavDrawer();
  else openNavDrawer();
}

function initNavDrawer() {
  $("nav-sandwich")?.addEventListener("click", toggleNavDrawer);
  $("nav-drawer-close")?.addEventListener("click", closeNavDrawer);
  $("nav-drawer-backdrop")?.addEventListener("click", closeNavDrawer);
  document.querySelectorAll(".nav-drawer-link").forEach(link => {
    link.addEventListener("click", () => closeNavDrawer());
  });
  document.addEventListener("keydown", e => {
    if (e.key === "Escape" && document.body.classList.contains("nav-drawer-open")) {
      closeNavDrawer();
    }
  });
}

// Function to load dynamic content without page reloads
async function loadDynamicContent(path) {
  const titleMap = {
    "/faq": "Frequently Asked Questions",
    "/accessibility": "Accessibility Statement",
    "/guides/blindfold-chess": "Progressive Blindfold Guide",
    "/guides/voice-commands": "Voice Commands Reference"
  };
  const fileMap = {
    "/faq": "pages/faq.html",
    "/accessibility": "pages/accessibility.html",
    "/guides/blindfold-chess": "pages/blindfold-chess.html",
    "/guides/voice-commands": "pages/voice-commands.html"
  };

  const normalizedPath = path.replace(/\/$/, "");
  const filename = fileMap[normalizedPath];
  const title = titleMap[normalizedPath] || "ChessNow Guide";

  const contentTitle = $("content-title");
  const contentBody = $("content-body");

  if (!contentTitle || !contentBody) return;

  contentTitle.textContent = title;
  contentBody.innerHTML = `<div style="text-align: center; padding: 40px; color: var(--text-2); font-family: var(--font-sans);">Loading content...</div>`;
  showView("view-content");
  window.scrollTo({ top: 0, behavior: "smooth" });

  try {
    const response = await fetch("/" + filename);
    if (!response.ok) throw new Error("Failed to load page");
    const htmlText = await response.text();
    
    // Parse HTML and extract content inside <main>
    const parser = new DOMParser();
    const doc = parser.parseFromString(htmlText, "text/html");
    const mainContent = doc.querySelector("main");
    
    if (mainContent) {
      // Remove H1 and description paragraph from injected content
      const h1 = mainContent.querySelector("h1");
      if (h1) h1.remove();
      const p = mainContent.querySelector("main > p");
      if (p) p.remove();
      
      // Update all brand text to ChessNow inside the parsed HTML
      let contentHtml = mainContent.innerHTML;
      contentHtml = contentHtml.replace(/ChessLens/g, "ChessNow");
      contentBody.innerHTML = contentHtml;
      
      // Update links inside the dynamically loaded content to also intercept them!
      contentBody.querySelectorAll("a[href]").forEach(link => {
        const href = link.getAttribute("href");
        if (href.startsWith("/faq") || href.startsWith("/accessibility") || href.startsWith("/guides/")) {
          link.addEventListener("click", (e) => {
            e.preventDefault();
            const hash = href.replace("/guides/", "").replace("/", "");
            window.location.hash = hash;
          });
        }
      });
    } else {
      contentBody.innerHTML = `<div style="color: var(--inaccuracy); padding: 20px;">Could not locate main content block.</div>`;
    }
  } catch (error) {
    console.error("Error loading dynamic content:", error);
    contentBody.innerHTML = `<div style="color: var(--blunder); padding: 20px;">Error loading content. Please check your connection and try again.</div>`;
  }
}

// Global hash routing controller
function handleHashRouting() {
  const hash = window.location.hash;
  // Leaving the review while Stockfish is still running: stop it so it can't
  // finish later and pop review chrome over whatever view the user moved to.
  if (hash !== "#review" && analysisInProgress) cancelRunningAnalysis();
  const hashRoutes = {
    "#faq": "/faq",
    "#accessibility": "/accessibility",
    "#blindfold-chess": "/guides/blindfold-chess",
    "#voice-commands": "/guides/voice-commands"
  };

  // Update active state visual indicators on header + drawer links
  document.querySelectorAll(".nav-link, .nav-drawer-link").forEach(link => {
    const href = link.getAttribute("href");
    // Keep Analyze highlighted across the whole Analyzer flow
    const analyzeActive = href === "#analysis" && (
      hash === "#analysis" ||
      hash === "#section-analysis" ||
      hash === "#games" ||
      hash === "#review"
    );
    link.classList.toggle(
      "active-link",
      analyzeActive ||
      href === hash ||
      (hash === "" && href === "#home") ||
      (hash === "#home" && href === "#home")
    );
  });

  if (hashRoutes[hash]) {
    loadDynamicContent(hashRoutes[hash]);
  } else if (hash === "#about") {
    showView("view-about");
    window.scrollTo({ top: 0, behavior: "smooth" });
  } else if (hash === "#play") {
    showView("view-play");
    window.scrollTo({ top: 0, behavior: "smooth" });
  } else if (hash === "#analysis" || hash === "#section-analysis") {
    // Nav "Analyze" → Local Game Analyzer (username → game list), not the empty board view
    showView("view-home");
    requestAnimationFrame(() => {
      const target = $("section-analysis");
      if (target) {
        target.scrollIntoView({ behavior: "smooth", block: "start" });
      }
      const input = $("username-input");
      if (input) {
        setTimeout(() => input.focus({ preventScroll: true }), 350);
      }
    });
  } else if (hash === "#games") {
    if (state.games && state.games.length) {
      showView("view-games");
      window.scrollTo({ top: 0, behavior: "smooth" });
    } else {
      // No list in memory (refresh / deep link) → Local Game Analyzer
      window.location.hash = "analysis";
    }
  } else if (hash === "#review") {
    // Restore from memory, or from sessionStorage after a hard refresh
    if (state.currentGame || state.result || restoreActiveReview()) {
      showView("view-analysis");
      setReviewing(true);
      window.scrollTo({ top: 0, behavior: "smooth" });
    } else if (state.games && state.games.length) {
      window.location.hash = "games";
    } else {
      window.location.hash = "analysis";
    }
  } else if (hash === "#home" || !hash) {
    showView("view-home");
    window.scrollTo({ top: 0, behavior: "smooth" });
  }
}

// ── DOM shortcuts ──────────────────────────────────────
const $ = id => document.getElementById(id);

// Escapes text before it's interpolated into an innerHTML template — values like
// player names ultimately come from user-uploaded PGN headers, so they can't be trusted raw.
const escapeHtml = str => String(str ?? "").replace(/[&<>"']/g, c => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
}[c]));

async function customFetch(url) {
  if (window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.CapacitorHttp) {
    try {
      const response = await window.Capacitor.Plugins.CapacitorHttp.get({
        url: url,
        headers: {
          "User-Agent": "ChessNow/1.0.0 (contact: support@chessnow.app)"
        }
      });
      return {
        ok: response.status >= 200 && response.status < 300,
        json: async () => response.data,
        text: async () => typeof response.data === 'string' ? response.data : JSON.stringify(response.data)
      };
    } catch (e) {
      console.error("CapacitorHttp native fetch failed, falling back to standard fetch", e);
    }
  }
  return fetch(url);
}

// ══════════════════════════════════════════════════════
// HOME VIEW
// ══════════════════════════════════════════════════════

async function checkStockfish() {
  const badge = $("sf-status");
  if (badge) badge.classList.remove("hidden");
  // Analyzer always uses WASM so web / iOS / Flask-dev all share one review path.
  useLocalWasm = true;
  try {
    const res = await fetch("/api/check");
    hasBackend = res.ok;
  } catch (_) {
    hasBackend = false;
  }
  if (badge) {
    badge.className = "sf-badge ok";
    badge.textContent = "✅  Stockfish 19 ready (Local WebAssembly)";
  }
}

function showHomeError(msg) {
  const errEl = $("home-error");
  if (!errEl) return;
  if (!msg) {
    errEl.classList.add("hidden");
    errEl.textContent = "";
    return;
  }
  errEl.textContent = msg;
  errEl.classList.remove("hidden");
}

function openSidebarTab(tabName) {
  const tab = document.querySelector(`.sidebar-tab[data-tab="${tabName}"]`);
  if (tab) tab.click();
}

function setAnalysisLoadingMeta(modeLabel) {
  const meta = $("loading-meta");
  if (meta) meta.textContent = modeLabel || "";
}

async function loadGames() {
  const username = $("username-input").value.trim();
  if (!username) {
    showHomeError("Enter a Chess.com username to load games.");
    return;
  }

  const btn = $("load-btn");

  showHomeError("");
  btn.disabled = true;
  btn.querySelector(".btn-text").textContent = "Loading…";

  try {
    // Always hit Chess.com from the browser for Analyzer (consistent offline-capable path)
    const gamesList = await fetchGamesDirect(username, 20);

    if (!gamesList.length) {
      throw new Error("No recent games found for this user.");
    }

    state.username = username;
    state.games = gamesList;

    try {
      localStorage.setItem(LAST_USERNAME_KEY, username);
    } catch (_) {}

    // Push #games so browser Back from a review can return here
    if (window.location.hash !== "#games") {
      window.location.hash = "games";
    }

    $("header-username").textContent = `♟ ${username}`;
    $("header-username").classList.remove("hidden");

    renderGames(gamesList, username);
    showView("view-games");
  } catch (err) {
    showHomeError(err.message || "Could not load games.");
  } finally {
    btn.disabled = false;
    btn.querySelector(".btn-text").textContent = "Load Games";
  }
}

// ══════════════════════════════════════════════════════
// GAMES LIST VIEW
// ══════════════════════════════════════════════════════

function renderGames(games, username) {
  const container = $("games-list");
  $("games-title").textContent = `Recent Games`;
  $("games-sub").textContent = `${username} · ${games.length} games`;

  if (!games.length) {
    container.innerHTML = `<div class="inline-error">No games found.</div>`;
    // Reset KPIs
    $("kpi-record").textContent = "—";
    $("kpi-opp-rating").textContent = "—";
    $("kpi-streak").textContent = "—";
    return;
  }

  // ── Calculate KPIs ──────────────────────────────────
  let wins = 0, losses = 0, draws = 0;
  let totalOppRating = 0, countOppRating = 0;
  
  games.forEach(g => {
    // Record
    if (g.result === "Win") wins++;
    else if (g.result === "Loss") losses++;
    else if (g.result === "Draw") draws++;

    // Opponent rating
    const r = parseInt(g.opponent_rating);
    if (!isNaN(r)) {
      totalOppRating += r;
      countOppRating++;
    }
  });

  const winRate = games.length ? ((wins / games.length) * 100).toFixed(1) : 0;
  const avgOpp = countOppRating ? Math.round(totalOppRating / countOppRating) : "—";

  // Streak (games are returned newest-first)
  let streak = 0;
  let streakType = null;
  for (let i = 0; i < games.length; i++) {
    const res = games[i].result;
    if (i === 0) {
      streakType = res;
      streak = 1;
    } else if (res === streakType) {
      streak++;
    } else {
      break;
    }
  }

  // Populate KPIs
  $("kpi-record").textContent = `${wins}W - ${losses}L - ${draws}D (${winRate}%)`;
  $("kpi-opp-rating").textContent = `${avgOpp}`;
  
  const streakEl = $("kpi-streak");
  streakEl.className = "kpi-value"; // reset
  if (streakType === "Win") {
    streakEl.textContent = `${streak} Win${streak > 1 ? "s" : ""}`;
    streakEl.classList.add("win");
  } else if (streakType === "Loss") {
    streakEl.textContent = `${streak} Loss${streak > 1 ? "es" : ""}`;
    streakEl.classList.add("loss");
  } else {
    streakEl.textContent = `${streak} Draw${streak > 1 ? "s" : ""}`;
  }

  // ── Render Rows ─────────────────────────────────────
  container.innerHTML = games.map((g, i) => {
    const isWhite = g.player_color === "White";
    const opponent = isWhite ? g.black : g.white;
    const opponentRating = isWhite ? g.black_rating : g.white_rating;
    const timeIcon = { bullet: "⚡", blitz: "🔥", rapid: "⏱", daily: "📅" }[g.time_class] || "♟";

    return `
    <div class="game-row result-${g.result}" data-idx="${i}">
      <div>
        <span class="game-result-badge badge-${g.result}">${g.result}</span>
      </div>
      <div class="game-row-opp">
        <span class="game-row-opp-name">${escapeHtml(opponent)}</span>
        <div style="display: flex; gap: 6px; font-size: 11.5px; color: var(--text-3); align-items: center; margin-top: 1px;">
          <span>Rating: ${opponentRating}</span>
          <span style="opacity: 0.5;">•</span>
          <span>${escapeHtml(g.date)}</span>
        </div>
      </div>
      <div class="game-row-opening">${escapeHtml(g.opening)}</div>
      <div class="game-row-mode">
        <span>${timeIcon}</span>
        <span>${g.time_class}</span>
      </div>
      <div class="game-row-date">${escapeHtml(g.date)}</div>
      <div>
        <div class="game-row-action-btn">Review</div>
      </div>
    </div>`;
  }).join("");

  container.querySelectorAll(".game-row").forEach(row => {
    row.addEventListener("click", () => {
      const idx = parseInt(row.dataset.idx);
      startAnalysis(state.games[idx]);
    });
  });
}

// ══════════════════════════════════════════════════════
// ANALYSIS VIEW — initiation & polling
// ══════════════════════════════════════════════════════

async function startAnalysis(game, opts = {}) {
  state.currentGame = game;
  persistActiveReview();
  state.result = null;
  state.moveIndex = -1;
  state.currentVariation = null;
  analysisAbort = { cancelled: false };
  state.fromCache = false;
  state.forceReanalyze = !!opts.forceReanalyze;

  // Push #review on top of #games so browser Back returns to the games list
  if (window.location.hash !== "#review") {
    window.location.hash = "review";
  }
  showView("view-analysis");
  setReviewing(false);
  $("btn-main-line")?.classList.add("hidden");
  $("analysis-loading").classList.remove("hidden");
  $("analysis-result").classList.add("hidden");
  $("cache-banner")?.classList.add("hidden");
  const openingLabel = game.opening || "Game review";
  $("meta-opening").textContent = openingLabel;
  const openingSidebar = $("meta-opening-sidebar");
  if (openingSidebar) openingSidebar.textContent = openingLabel;

  // Say which game is being analysed — the wait is long enough to wonder
  const loadLabel = document.querySelector("#analysis-loading .loading-label");
  if (loadLabel) loadLabel.textContent = LOADING_LABEL;
  const loadingGame = $("loading-game");
  if (loadingGame) {
    const players = game.white && game.black ? `${game.white} vs ${game.black}` : "";
    loadingGame.textContent = [players, game.opening].filter(Boolean).join(" · ");
  }
  $("analysis-load-error")?.classList.add("hidden");
  $("btn-analysis-error-back")?.classList.add("hidden");
  setLoadingProgress(0, 0);
  $("loading-progress").textContent = "Starting…";
  const depthNote = { quick: "quick pass", deep: "deep pass" }[state.analysisMode] || "";
  setAnalysisLoadingMeta(["Stockfish 19", depthNote, "runs in your browser"].filter(Boolean).join(" · "));
  const cancelBtn = $("btn-cancel-analysis");
  if (cancelBtn) cancelBtn.classList.remove("hidden");

  try {
    await runLocalWasmAnalysis(game);
  } catch (err) {
    destroyLoadingBoard();
    if (analysisAbort.cancelled || err?.message === "cancelled") {
      // Only steer back to the list if the user is still on the review route —
      // if they already navigated elsewhere, leave them where they went.
      if (window.location.hash === "#review") {
        window.location.hash = state.games?.length ? "games" : "analysis";
      }
      return;
    }
    showAnalysisFatalError(err.message || "Analysis failed");
  }
}

/**
 * Update the loading panel. `done`/`total` are plies; the text talks in full
 * moves and adds a time estimate once there is enough signal to make one.
 */
function setLoadingProgress(done, total, startedAt) {
  const pct = total ? Math.round((done / total) * 100) : 0;
  $("progress-bar").style.width = `${pct}%`;

  let text = "Starting…";
  if (total) {
    text = `Move ${Math.max(1, Math.ceil(done / 2))} of ${Math.ceil(total / 2)}`;
    if (startedAt && done >= 4 && done < total) {
      const secsLeft = ((performance.now() - startedAt) / done) * (total - done) / 1000;
      text += secsLeft < 5 ? " · almost done" : ` · about ${Math.ceil(secsLeft / 5) * 5}s left`;
    }
  }
  $("loading-progress").textContent = text;

  const wrap = $("progress-bar-wrap");
  if (wrap) {
    wrap.setAttribute("aria-valuenow", String(pct));
    wrap.setAttribute("aria-valuetext", text);
  }
}

// Small board on the loading panel that plays the game through as it is analysed
function initLoadingBoard(game) {
  destroyLoadingBoard();
  const el = $("loading-board");
  if (!el || !el.offsetWidth) return; // hidden on very short viewports
  state.loadingBoard = Chessboard("loading-board", {
    position: "start",
    orientation: (game.player_color || "White") === "Black" ? "black" : "white",
    pieceTheme: piece => "/pieces/" + piece + ".svg",
    showNotation: false,
    draggable: false,
    moveSpeed: 120,
  });
}

function destroyLoadingBoard() {
  if (!state.loadingBoard) return;
  try { state.loadingBoard.destroy(); } catch (_) {}
  state.loadingBoard = null;
}

function showAnalysisFatalError(message) {
  $("analysis-loading").classList.remove("hidden");
  $("analysis-result").classList.add("hidden");
  $("loading-progress").textContent = "";
  setAnalysisLoadingMeta("");
  const label = document.querySelector("#analysis-loading .loading-label");
  if (label) label.textContent = "Analysis failed";
  const errBox = $("analysis-load-error");
  if (errBox) {
    errBox.textContent = message;
    errBox.classList.remove("hidden");
  }
  $("btn-cancel-analysis")?.classList.add("hidden");
  $("btn-analysis-error-back")?.classList.remove("hidden");
}

function cancelRunningAnalysis() {
  analysisAbort.cancelled = true;
  try {
    // Best-effort stop if a shared worker is mid-search
    if (window.__sfSharedWorker) window.__sfSharedWorker.postMessage("stop");
  } catch (_) {}
}

function pollAnalysis(taskId) {
  if (state.pollTimer) clearInterval(state.pollTimer);

  state.pollTimer = setInterval(async () => {
    try {
      const res = await fetch(`/api/status/${taskId}`);
      const data = await res.json();

      // Update progress bar
      const pct = data.progress || 0;
      $("progress-bar").style.width = `${pct}%`;
      $("loading-progress").textContent =
        data.total ? `${Math.round(data.total * pct / 100)} / ${data.total} moves` : "Analysing…";

      if (data.status === "done") {
        clearInterval(state.pollTimer);
        renderAnalysis(data.result);
      } else if (data.status === "error") {
        clearInterval(state.pollTimer);
        alert("Analysis error: " + data.error);
      }
    } catch (err) {
      clearInterval(state.pollTimer);
    }
  }, 800);
}

// ══════════════════════════════════════════════════════
// ANALYSIS VIEW — rendering
// ══════════════════════════════════════════════════════

function renderAnalysis(result) {
  state.result = result;

  $("analysis-loading").classList.add("hidden");
  $("analysis-result").classList.remove("hidden");
  $("analysis-load-error")?.classList.add("hidden");
  $("btn-cancel-analysis")?.classList.add("hidden");
  $("btn-analysis-error-back")?.classList.add("hidden");
  setReviewing(true);
  destroyLoadingBoard();
  const loadLabel = document.querySelector("#analysis-loading .loading-label");
  if (loadLabel) loadLabel.textContent = LOADING_LABEL;

  // Reviews cached before the checkmate-label fix stored the final eval as "-M0"
  result.moves.forEach(m => {
    if (/^-?M0$/.test(m.eval_str || "")) m.eval_str = m.eval_cp >= 0 ? "1-0" : "0-1";
  });

  // Opening name: sidebar header on desktop, top bar on phones. Set both here so
  // a review restored after a refresh (which skips startAnalysis) still shows it.
  const openingLabel = result.opening || state.currentGame?.opening || $("meta-opening")?.textContent || "";
  const openingSidebar = $("meta-opening-sidebar");
  if (openingSidebar) openingSidebar.textContent = openingLabel;
  if ($("meta-opening")) $("meta-opening").textContent = openingLabel;

  const g = state.currentGame || {};
  const isWhite = (g.player_color || "White") === "White";

  // Calculate move durations
  calculateMoveDurations(result.moves, g.time_control);

  // Fetch player country flags
  if (!state.playerFlags || state.playerFlags.whiteName !== result.white_player || state.playerFlags.blackName !== result.black_player) {
    state.playerFlags = { white: "", black: "", whiteName: result.white_player, blackName: result.black_player };
    fetchPlayerFlags(result.white_player, result.black_player);
  }

  renderPlayerBars(result);

  // Land on Review summary first; Moves tab is for replay
  openSidebarTab("review");

  // Cached-review banner in sidebar (dismissible — not sticky above the board)
  const banner = $("cache-banner");
  if (banner) {
    const dismissed = sessionStorage.getItem("chessnow_cache_banner_dismissed") === "1";
    banner.classList.toggle("hidden", !state.fromCache || dismissed);
  }

  // ── Review summary: one White | class | Black table (desktop tab + mobile card)
  renderReviewTable("review-table", result);
  renderReviewTable("mob-review-table", result);

  // Populate mobile game review metadata
  if ($("mob-info-opening")) $("mob-info-opening").textContent = result.opening || g.opening || "Unknown Opening";
  if ($("mob-info-result")) $("mob-info-result").textContent = g.result || "Draw";
  if ($("mob-info-moves")) $("mob-info-moves").textContent = Math.ceil(result.moves.length / 2);

  // ── Board ─────────────────────────────────────────────
  initBoard(isWhite);

  // ── Move list ─────────────────────────────────────────
  renderMoveList(result.moves);

  // ── Chart ─────────────────────────────────────────────
  renderChart(result.moves);

  // ── Set to start position ────────────────────────────
  goToMove(-1);

  // Coach/player chrome affects height — refit board after paint so nothing clips.
  requestAnimationFrame(() => {
    resizeAnalysisBoard();
    requestAnimationFrame(resizeAnalysisBoard);
  });

  persistActiveReview();
}

// Player bars: top = opponent, bottom = player (board default orientation).
// Separate from renderAnalysis so late-arriving country flags can refresh the
// names without re-rendering (and resetting) the whole review.
function renderPlayerBars(result) {
  const g = state.currentGame || {};
  const isWhite = (g.player_color || "White") === "White";
  const topColor   = isWhite ? "black" : "white";
  const topName    = isWhite ? result.black_player : result.white_player;
  const topAcc     = isWhite ? result.black_accuracy : result.white_accuracy;
  const topRating  = isWhite ? g.black_rating : g.white_rating;
  const botName    = isWhite ? result.white_player : result.black_player;
  const botAcc     = isWhite ? result.white_accuracy : result.black_accuracy;
  const botRating  = isWhite ? g.white_rating : g.black_rating;

  setupPlayerBar("top",    topColor, topName, topRating, topAcc);
  setupPlayerBar("bottom", isWhite ? "white" : "black", botName, botRating, botAcc);
}

function setupPlayerBar(pos, color, name, rating, acc) {
  const av = $(`avatar-${pos}`);
  av.textContent = name[0]?.toUpperCase() || "?";
  av.className = `player-avatar ${color === "white" ? "white-av" : "black-av"}`;
  
  const isWhite = color === "white";
  const flag = state.playerFlags ? (isWhite ? state.playerFlags.white : state.playerFlags.black) : "";
  
  $(`name-${pos}`).innerHTML = `${flag ? flag + " " : ""}${escapeHtml(name)}`;
  $(`rating-${pos}`).textContent = rating ? `(${rating})` : "";
  $(`acc-${pos}-val`).textContent = acc + "%";
}

/**
 * Review summary table: accuracy on top, then one row per move class with
 * White's count on the left and Black's on the right. Non-zero counts are
 * buttons that jump to that player's next move of that class.
 */
function renderReviewTable(elId, result) {
  const el = $(elId);
  if (!el) return;
  const w = result.white_counts || {};
  const b = result.black_counts || {};

  const countCell = (n, cls, color) => n > 0
    ? `<button type="button" class="rt-count" data-cls="${cls}" data-color="${color}"
         aria-label="${n} ${CLS[cls].label} by ${color === "white" ? "White" : "Black"} — jump to the next one">${n}</button>`
    : `<span class="rt-count rt-zero">0</span>`;

  const rows = CLS_ORDER
    .filter(cls => (w[cls] || 0) + (b[cls] || 0) > 0)
    .map(cls => `
      <div class="rt-row">
        ${countCell(w[cls] || 0, cls, "white")}
        <span class="rt-cls"><span class="cls-emoji" aria-hidden="true">${CLS[cls].emoji}</span>${CLS[cls].label}</span>
        ${countCell(b[cls] || 0, cls, "black")}
      </div>`)
    .join("");

  el.innerHTML = `
    <div class="rt-head">
      <div class="rt-player">
        <span class="acc-color-dot white-dot" aria-hidden="true"></span>
        <span class="rt-name">${escapeHtml(result.white_player)}</span>
      </div>
      <div class="rt-player rt-player-right">
        <span class="rt-name">${escapeHtml(result.black_player)}</span>
        <span class="acc-color-dot black-dot" aria-hidden="true"></span>
      </div>
    </div>
    <div class="rt-row rt-acc">
      <span class="rt-acc-val">${result.white_accuracy}%</span>
      <span class="rt-cls rt-acc-label">Accuracy</span>
      <span class="rt-acc-val">${result.black_accuracy}%</span>
    </div>
    ${rows}`;
}

// One-line recap shown in the coach bubble at the start position
function reviewSummaryHtml() {
  const r = state.result;
  if (!r) return "Step through the moves to see how the game went.";
  // Kept to two lines on a phone so the board doesn't shift when you leave the
  // start position; accuracy already sits beside each player's name.
  const errors = r.moves.filter(m => ERROR_CLS.has(m.cls)).length;
  return errors
    ? `<b>${errors} move${errors === 1 ? "" : "s"}</b> worth a second look. Step through, or jump to the next mistake.`
    : "A clean game — nothing flagged. Step through the moves to see why.";
}

// ── Board ──────────────────────────────────────────────

// Returns optimal board pixel size based on available window width and height to fit screen
function getBoardColChrome() {
  const boardCol = document.querySelector(".board-col");
  if (!boardCol) return 96;
  let chrome = 0;
  for (const child of boardCol.children) {
    if (child.classList.contains("board-eval-wrap")) continue;
    if (child.classList.contains("hidden")) continue;
    if (child.classList.contains("coach-panel--mobile")) continue;
    if (child.classList.contains("mobile-navigation-row")) continue;
    if (child.classList.contains("mobile-bottom-bar")) continue;
    if (child.classList.contains("mobile-review-card")) continue;
    if (getComputedStyle(child).display === "none") continue;
    chrome += child.getBoundingClientRect().height;
  }
  // Desktop board chrome is essentially the two player bars
  return Math.max(chrome + 8, 88);
}

function getBoardSize() {
  // Measure the real layout instead of mirroring CSS numbers here — a mismatch
  // between the two is what used to push the sidebar underneath the board.
  const px = v => parseFloat(v) || 0;
  const layout = document.querySelector(".analysis-layout");
  const layoutStyle = layout ? getComputedStyle(layout) : null;
  const layoutInner = layout && layout.clientWidth
    ? layout.clientWidth - px(layoutStyle.paddingLeft) - px(layoutStyle.paddingRight)
    : window.innerWidth - 40;

  const evalWrap = document.querySelector(".eval-bar-wrap");
  const boardRow = document.querySelector(".board-eval-wrap");
  const evalWidth = evalWrap ? evalWrap.getBoundingClientRect().width : 0;
  const evalBar = evalWidth
    ? evalWidth + px(getComputedStyle(boardRow).columnGap) // eval bar + gap to the board
    : 52;

  const isMobile = window.innerWidth <= 900;
  if (isMobile) {
    const widthFit = Math.max(240, Math.min(Math.floor(layoutInner - evalBar), 480));

    // Short phones: trim the board so the move strip still clears the docked
    // action bar — but never below 280px, where the page scrolls instead.
    const navRow = document.getElementById("mobile-nav-row");
    const actionBar = document.getElementById("mobile-action-bar");
    if (!boardRow || !navRow || !actionBar || !actionBar.offsetHeight) return widthFit;
    const boardRect = boardRow.getBoundingClientRect();
    const aboveBoard = boardRect.top + window.scrollY;                       // top bar, player, coach
    const belowBoard = navRow.getBoundingClientRect().bottom - boardRect.bottom; // player + move strip
    const dock = window.innerHeight - actionBar.getBoundingClientRect().top + 8; // docked bar + breathing room
    const heightFit = Math.floor(window.innerHeight - aboveBoard - belowBoard - dock);
    return Math.max(Math.min(widthFit, 280), Math.min(widthFit, heightFit));
  }

  // Desktop: board + sidebar share one row — grow to fill height/width like Chess.com.
  const rightCol = document.querySelector(".right-col");
  const sidebarFallback = Math.min(480, Math.max(380, Math.floor(window.innerWidth * 0.28)));
  const sidebar = (rightCol && rightCol.getBoundingClientRect().width) || sidebarFallback;
  const gap = layoutStyle ? px(layoutStyle.columnGap) : 16;
  const availableWidth = Math.floor(layoutInner - gap - sidebar - evalBar);

  // Prefer nearly full viewport height (review mode hides the top header).
  const view = document.getElementById("view-analysis");
  let availableHeight;
  if (view) {
    const padTop = parseFloat(getComputedStyle(view).paddingTop) || 8;
    availableHeight = view.clientHeight - padTop - getBoardColChrome() - 12;
  } else {
    availableHeight = window.innerHeight - getBoardColChrome() - 16;
  }
  // Soft ceiling only for ultrawide/tall monitors; otherwise use all available space.
  return Math.max(320, Math.min(availableWidth, availableHeight, 960));
}

function resizeAnalysisBoard() {
  if (!state.board) return;
  const boardEl = document.getElementById("board");
  if (!boardEl) return;
  const size = getBoardSize();
  boardEl.style.width = size + "px";
  state.board.resize();
  const evalWrap = document.querySelector(".eval-bar-wrap");
  if (evalWrap) evalWrap.style.height = size + "px";

  // Lock sidebar to board-column height so only the moves subsection scrolls
  const isMobile = window.innerWidth <= 900;
  const rightCol = document.querySelector(".right-col");
  const boardCol = document.querySelector(".board-col");
  if (rightCol && boardCol) {
    if (isMobile) {
      rightCol.style.height = "";
      rightCol.style.maxHeight = "";
    } else {
      const h = Math.round(boardCol.getBoundingClientRect().height);
      if (h > 0) {
        rightCol.style.height = h + "px";
        rightCol.style.maxHeight = h + "px";
      }
    }
  }

  refreshBoardMarks();
}

function initBoard(playerIsWhite) {
  state.flipped = !playerIsWhite;
  const size = getBoardSize();

  // Set container element width explicitly for chessboard.js
  document.getElementById("board").style.width = size + "px";

  // chess.js tracks position for move validation during exploration
  state.chess = new Chess();

  if (state.board) state.board.destroy();
  state.board = Chessboard("board", {
    position:    "start",
    orientation: playerIsWhite ? "white" : "black",
    pieceTheme:  function(piece) {
      return '/pieces/' + piece + '.svg';
    },
    draggable:   true,
    onDragStart: handleDragStart,
    onDrop:      handleDrop,
    onSnapEnd:   handleSnapEnd,
  });

  const evalWrap = document.querySelector('.eval-bar-wrap');
  if (evalWrap) evalWrap.style.height = size + 'px';

  // Enable touch dragging on mobile devices
  enableMobilePieceDragging();
}

function enableMobilePieceDragging() {
  const boardEl = document.getElementById("board");
  if (!boardEl) return;

  const touchHandler = (e) => {
    // Avoid interfering with standard multi-touch gestures (like pinching)
    if (e.touches.length > 1) return;

    const touch = e.changedTouches[0];
    let mouseEvent = "";
    
    switch (e.type) {
      case "touchstart": mouseEvent = "mousedown"; break;
      case "touchmove":  mouseEvent = "mousemove"; break;
      case "touchend":   mouseEvent = "mouseup";   break;
      default: return;
    }
    
    // Create simulated mouse event mapping the touch coordinates
    const simulatedEvent = new MouseEvent(mouseEvent, {
      bubbles: true,
      cancelable: true,
      view: window,
      clientX: touch.clientX,
      clientY: touch.clientY,
      screenX: touch.screenX,
      screenY: touch.screenY
    });
    
    touch.target.dispatchEvent(simulatedEvent);
    e.preventDefault();
  };

  boardEl.addEventListener("touchstart", touchHandler, { passive: false });
  boardEl.addEventListener("touchmove",  touchHandler, { passive: false });
  boardEl.addEventListener("touchend",   touchHandler, { passive: false });
}

// Keep board size updated on window resize
window.addEventListener("resize", () => {
  if (state.board && state.result) resizeAnalysisBoard();
});

// Only allow the side-to-move's pieces to be dragged
function handleDragStart(source, piece) {
  if (!state.chess) return false;
  if (state.chess.turn() === 'w' && piece.startsWith('b')) return false;
  if (state.chess.turn() === 'b' && piece.startsWith('w')) return false;
  return true;
}

// Validate drop — snap back if illegal
function handleDrop(source, target) {
  if (!state.chess) return 'snapback';

  // Detect promotion before committing so the user can pick the piece instead of
  // always auto-queening — underpromotions are rare but real (e.g. stalemate tricks).
  const candidateMoves = state.chess.moves({ square: source, verbose: true });
  const isPromotion = candidateMoves.some(m => m.to === target && m.flags.includes('p'));

  let promotion = 'q';
  if (isPromotion) {
    const choice = (window.prompt("Promote to: Q, R, B, or N?", "Q") || "Q").trim().toLowerCase();
    promotion = ['q', 'r', 'b', 'n'].includes(choice) ? choice : 'q';
  }

  const move = state.chess.move({ from: source, to: target, promotion });
  return move ? undefined : 'snapback';
}

// Returns the currently active moves array walking down the variation path
function getActiveMoves() {
  let moves = state.result?.moves || [];
  if (!state.currentVariationPath || !state.currentVariationPath.length) {
    return moves;
  }
  for (const branch of state.currentVariationPath) {
    if (moves[branch.moveIdx] && moves[branch.moveIdx].variations) {
      moves = moves[branch.moveIdx].variations[branch.varIdx];
    } else {
      break;
    }
  }
  return moves;
}

// After animation ends, attach the played move as a variation on the branch point
function handleSnapEnd() {
  if (!state.chess) return;
  state.board.position(state.chess.fen(), false);

  const history = state.chess.history({ verbose: true });
  const moveObj = history[history.length - 1];
  if (!moveObj || !state.result) { triggerLiveEvaluation(state.chess.fen()); return; }

  const activeMoves = getActiveMoves();
  const branchIdx = state.moveIndex; // index in the active line we're branching from

  // Determine move number and color for the new move
  const prevMove = activeMoves[branchIdx];
  let moveNum = 1, color = 'white';
  if (prevMove) {
    moveNum = prevMove.color === 'white' ? prevMove.move_num : prevMove.move_num + 1;
    color   = prevMove.color === 'white' ? 'black' : 'white';
  }

  const newMove = {
    move_num: moveNum,
    color,
    san:      moveObj.san,
    uci:      moveObj.from + moveObj.to + (moveObj.promotion || ''),
    fen:      state.chess.fen(),
    eval_cp:  0,
    eval_str: '0.0',
    cls:      'variation',
    variations: [],
  };

  // Check if the next move in active line is the same — if so, just navigate there
  const nextMove = activeMoves[branchIdx + 1];
  if (nextMove && nextMove.uci === newMove.uci) {
    goToMove(branchIdx + 1);
    triggerLiveEvaluation(state.chess.fen());
    return;
  }

  // Force branching if we're in the middle of activeMoves, OR if we're on the main read-only game line
  const isMainLine = !state.currentVariationPath || state.currentVariationPath.length === 0;
  if (branchIdx < activeMoves.length - 1 || isMainLine) {
    const branchMove = activeMoves[branchIdx];
    if (branchMove) {
      if (!branchMove.variations) branchMove.variations = [];

      // Check if a variation starting with this move already exists
      const existingVarIdx = branchMove.variations.findIndex(v => v[0]?.uci === newMove.uci);
      if (existingVarIdx !== -1) {
        // Enter the existing variation
        state.currentVariationPath = [...(state.currentVariationPath || []), { moveIdx: branchIdx, varIdx: existingVarIdx }];
        state.moveIndex = 0;
      } else {
        // Create new variation
        branchMove.variations.push([newMove]);
        const varIdx = branchMove.variations.length - 1;
        state.currentVariationPath = [...(state.currentVariationPath || []), { moveIdx: branchIdx, varIdx: varIdx }];
        state.moveIndex = 0;
      }
      $("btn-main-line").classList.remove("hidden");
    }
  } else {
    // Append move to the active variation line (extending the current exploration)
    activeMoves.push(newMove);
    state.moveIndex = activeMoves.length - 1;
  }

  renderMoveList(state.result.moves);
  scrollToActive();
  triggerLiveEvaluation(state.chess.fen());
}

function scrollToActive() {
  const container = document.querySelector(".moves-list-wrap");
  const active = document.querySelector("#moves-list .move-cell.active");
  if (!container || !active) return;

  // Use rects vs the scroll container — offsetTop is wrong under CSS grid / nested layout
  const cRect = container.getBoundingClientRect();
  const aRect = active.getBoundingClientRect();
  const pad = 12;
  const fullyVisible =
    aRect.top >= cRect.top + pad && aRect.bottom <= cRect.bottom - pad;
  if (fullyVisible) return;

  const delta =
    (aRect.top + aRect.bottom) / 2 - (cRect.top + cRect.bottom) / 2;
  container.scrollTo({
    top: Math.max(0, container.scrollTop + delta),
    behavior: "smooth",
  });
}

function setCoachContent({ hidden, badgeText, badgeBg, badgeColor, title, html, text }) {
  const targets = [
    {
      panel: $("coach-panel"),
      badge: $("coach-move-badge"),
      title: $("coach-move-title"),
      body: $("coach-text"),
    },
    {
      panel: $("coach-panel-sidebar"),
      badge: $("coach-move-badge-sidebar"),
      title: $("coach-move-title-sidebar"),
      body: $("coach-text-sidebar"),
    },
  ];

  for (const t of targets) {
    if (!t.panel) continue;
    t.panel.classList.toggle("hidden", !!hidden);
    if (hidden) continue;
    if (t.badge) {
      // Emoji badges carry their own colour; pass badgeBg only for plain-text badges
      t.badge.className = badgeBg ? "coach-badge" : "coach-badge coach-badge--emoji";
      t.badge.style.background = badgeBg || "transparent";
      t.badge.style.color = badgeColor || "#110c07";
      t.badge.textContent = badgeText || "·";
    }
    if (t.title) t.title.textContent = title || "Game Review";
    if (t.body) {
      if (html != null) t.body.innerHTML = html;
      else t.body.textContent = text || "";
    }
  }
}

function updateCoachBubble() {
  if (state.moveIndex === -1) {
    setCoachContent({
      hidden: false,
      badgeText: "🏁",
      title: "Game Review",
      html: reviewSummaryHtml(),
    });
    return;
  }

  const moves = getActiveMoves();
  const move = moves[state.moveIndex];
  if (!move) {
    setCoachContent({ hidden: true });
    return;
  }

  const clsInfo = CLS[move.cls];
  const sanText = `<b>${move.san}</b>`;
  let comment = "";
  switch (move.cls) {
    case "book":
      comment = `${sanText} is standard book opening theory. You're following established lines.`;
      break;
    case "brilliant":
      comment = `Brilliant! ${sanText} finds a striking idea — Stockfish loves it.`;
      break;
    case "great":
      comment = `Great find! ${sanText} was essentially the only good move.`;
      break;
    case "best":
      comment = `Excellent play! ${sanText} was the best move in this position.`;
      break;
    case "excellent":
      comment = `${sanText} is an excellent move! You're keeping a strong position.`;
      break;
    case "good":
      comment = `${sanText} is a solid move, keeping the game balanced.`;
      break;
    case "inaccuracy":
      comment = `${sanText} is an inaccuracy.` + (move.best_san ? ` The best move was <b>${move.best_san}</b>.` : "");
      break;
    case "mistake":
      comment = `${sanText} is a mistake.` + (move.best_san ? ` The best move was <b>${move.best_san}</b>.` : "");
      break;
    case "miss":
      comment = `Missed chance. ${sanText} lets the opponent off the hook.` + (move.best_san ? ` Punish with <b>${move.best_san}</b>.` : "");
      break;
    case "blunder":
      comment = `${sanText} is a blunder!` + (move.best_san ? ` The best move was <b>${move.best_san}</b>.` : "");
      break;
    default:
      comment = `You played ${sanText}. Stockfish evaluates this position at ${move.eval_str}.`;
  }

  setCoachContent({
    hidden: false,
    badgeText: clsInfo?.emoji || "·",
    badgeBg: clsInfo ? null : "var(--text-3)",
    badgeColor: "#110c07",
    title: `${clsInfo?.label || "Move"} · ${move.eval_str || "0.0"}`,
    html: comment,
  });
}

// ── "Next mistake" / Retry — shared by the mobile action bar and the desktop Review tab
function nextErrorIndex() {
  const moves = getActiveMoves();
  for (let i = state.moveIndex + 1; i < moves.length; i++) {
    if (ERROR_CLS.has(moves[i].cls)) return i;
  }
  return -1;
}

function advanceToNextKeyMove() {
  const moves = getActiveMoves();
  if (!moves.length) return;
  const next = nextErrorIndex();
  if (next !== -1) goToMove(next);
  else if (state.moveIndex < moves.length - 1) goToMove(state.moveIndex + 1);
  else goToMove(-1);
}

// Keep the button label honest about what a tap will do from the current move
function updateReviewActions() {
  const moves = getActiveMoves();
  const label = nextErrorIndex() !== -1 ? "Next mistake"
    : state.moveIndex < moves.length - 1 ? "Next move"
    : "Back to start";
  ["btn-mobile-next-key", "btn-next-key"].forEach(id => {
    const btn = $(id);
    if (btn) btn.textContent = label;
  });

  // Retry steps back so you can try a better move — only meaningful on an error
  // or on a move you just tried yourself.
  const current = moves[state.moveIndex];
  const retry = $("btn-mobile-retry");
  if (retry) retry.disabled = !(current && (ERROR_CLS.has(current.cls) || current.cls === "variation"));
}

// Jump to a move on the main game line, leaving any side variation first
function goToMainLineMove(idx) {
  if (state.currentVariationPath && state.currentVariationPath.length) {
    state.currentVariationPath = [];
    $("btn-main-line")?.classList.add("hidden");
    renderMoveList(state.result.moves);
  }
  goToMove(idx);
}

function goToMove(idx) {
  const moves = getActiveMoves();
  state.moveIndex = Math.max(-1, Math.min(idx, moves.length - 1));

  const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
  let fen = START_FEN;

  // Clear existing engine arrows before evaluating new position
  const oldSvg = document.getElementById("board-arrows-svg");
  if (oldSvg) oldSvg.remove();

  if (state.moveIndex === -1) {
    state.board.position('start', false);
    if (state.chess) state.chess.load(START_FEN);
    updateEvalBar(0, '0.0');
    $('move-counter').textContent = 'Start';
    highlightSquares(null);
  } else {
    const move = moves[state.moveIndex];
    state.board.position(move.fen, false);
    if (state.chess) state.chess.load(move.fen);
    updateEvalBar(move.eval_cp, move.eval_str);
    // Standard notation ("4. Nf3" / "4… Bxf3") — a bare "Move 4…" read as truncated text
    $('move-counter').textContent = `${move.move_num}${move.color === 'black' ? '…' : '.'} ${move.san}`;
    highlightSquares(move.uci, move.cls);
    fen = move.fen;
  }

  // Update active move in list — match by path equality
  const currentPathStr = JSON.stringify(state.currentVariationPath || []);
  document.querySelectorAll(".move-cell").forEach(el => {
    const elIdx = parseInt(el.dataset.idx);
    const elPathStr = el.dataset.path || "[]";
    const isActive = (elIdx === state.moveIndex && elPathStr === currentPathStr);
    el.classList.toggle("active", isActive);
  });

  // Update active move in mobile horizontal list
  document.querySelectorAll(".mobile-move-item").forEach(el => {
    el.classList.toggle("active", parseInt(el.dataset.idx) === state.moveIndex);
  });

  // Auto-scroll moves wrapper to keep the active item visible in the scroll container
  const mobList = $("mobile-moves-list");
  const mobActive = mobList ? mobList.querySelector(".mobile-move-item.active") : null;
  if (mobActive) {
    mobActive.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "smooth" });
  }

  // Update Coach Speech bubble
  updateCoachBubble();
  updateReviewActions();

  // Move the cursor on the win-probability chart
  if (state.chart) state.chart.update("none");

  // If path changed, rebuild the horizontal mobile moves bar (keeping it clean and preserving scroll on regular steps)
  if (state.lastRenderedPathStr !== currentPathStr) {
    state.lastRenderedPathStr = currentPathStr;
    renderMobileMoveList(getActiveMoves());
  }

  // Draw game review arrows (played move and/or dashed best recommendation)
  setTimeout(() => {
    drawReviewArrows();
  }, 50);

  // Update captured pieces & remaining time clocks dynamically
  updateCapturedPieces(fen);
  updateClocks(state.moveIndex);

  // Apply King endgame highlight overlays at the final position
  applyEndGameKingHighlights();

  scrollToActive();

  // Instantly show cached MultiPV from review (UI session can restyle; shape matches live eval)
  if (state.moveIndex >= 0 && moves[state.moveIndex]?.engine_lines?.length) {
    const cached = moves[state.moveIndex].engine_lines;
    state.liveEvalLines = cached;
    renderEngineLines(cached);
    $("engine-lines-list").dataset.fen = fen;
  }

  triggerLiveEvaluation(fen);

  // Keep refresh-restore position in sync (lightweight — only if a session already exists)
  try {
    const raw = sessionStorage.getItem(ACTIVE_REVIEW_KEY);
    if (raw) {
      const data = JSON.parse(raw);
      data.moveIndex = state.moveIndex;
      sessionStorage.setItem(ACTIVE_REVIEW_KEY, JSON.stringify(data));
    }
  } catch (_) {}
}

/** Convert Stockfish MultiPV (STM scores) into renderEngineLines()-compatible rows. */
function pvListToEngineLines(pvs, fen, whiteToMove) {
  if (!pvs || !pvs.length || !fen) return [];
  const lines = [];
  for (let i = 0; i < pvs.length; i++) {
    const pv = pvs[i];
    if (!pv || !pv.uci) continue;
    let san = pv.uci;
    try {
      const tmp = new Chess(fen);
      const mv = tmp.move({
        from: pv.uci.slice(0, 2),
        to: pv.uci.slice(2, 4),
        promotion: pv.uci[4] || undefined,
      });
      if (mv) san = mv.san;
    } catch (_) {}
    const stmCp = pv.score || 0;
    const whiteCp = ReviewMath.stmCpToWhite(stmCp, whiteToMove);
    const mateStm = pv.mate;
    const mateWhite = mateStm == null ? null : (whiteToMove ? mateStm : -mateStm);
    lines.push({
      san,
      uci: pv.uci,
      cp: whiteCp,
      score: formatScore(whiteCp, mateWhite),
      rank: i + 1,
    });
  }
  return lines;
}

function getKingSquares() {
  if (!state.chess) return { w: null, b: null };
  let w = null, b = null;
  const board = state.chess.board();
  for (let r = 0; r < 8; r++) {
    for (let c = 0; c < 8; c++) {
      const piece = board[r][c];
      if (piece && piece.type === 'k') {
        const square = String.fromCharCode(97 + c) + (8 - r);
        if (piece.color === 'w') w = square;
        else b = square;
      }
    }
  }
  return { w, b };
}

function applyEndGameKingHighlights() {
  const isMainLine = !state.currentVariationPath || state.currentVariationPath.length === 0;
  const moves = state.result?.moves || [];
  const isLastMove = state.moveIndex === moves.length - 1;
  
  if (isMainLine && isLastMove && moves.length > 0) {
    const kings = getKingSquares();
    if (!kings.w || !kings.b) return;
    
    // Parse result from result tag or headers
    const result = state.result.result || state.result.headers?.Result || "";
    
    const whiteEl = document.getElementsByClassName(`square-${kings.w}`)[0];
    const blackEl = document.getElementsByClassName(`square-${kings.b}`)[0];
    
    if (result === "1-0") {
      if (whiteEl) whiteEl.classList.add("hl-king-win");
      if (blackEl) blackEl.classList.add("hl-king-lose");
    } else if (result === "0-1") {
      if (blackEl) blackEl.classList.add("hl-king-win");
      if (whiteEl) whiteEl.classList.add("hl-king-lose");
    } else if (result === "1/2-1/2") {
      if (whiteEl) whiteEl.classList.add("hl-king-draw");
      if (blackEl) blackEl.classList.add("hl-king-draw");
    }
  }
}

function highlightSquares(uci, cls) {
  // Clear any existing highlight classes
  const classesToRemove = ["hl-king-win", "hl-king-lose", "hl-king-draw"];
  Object.keys(CLS).forEach(c => classesToRemove.push(`hl-${c}-from`, `hl-${c}-to`));
  document.querySelectorAll("[class*='hl-']").forEach(el => {
    classesToRemove.forEach(c => el.classList.remove(c));
  });
  document.querySelectorAll("#board .sq-badge").forEach(el => el.remove());

  if (!uci || !cls || uci.length < 4) return;
  const from = uci.slice(0, 2);
  const to   = uci.slice(2, 4);
  const fromEl = document.querySelector(`#board .square-${from}`);
  const toEl   = document.querySelector(`#board .square-${to}`);
  if (fromEl) fromEl.classList.add(`hl-${cls}-from`);
  if (toEl)   toEl.classList.add(`hl-${cls}-to`);

  // Classification emoji in the corner of the destination square
  if (toEl && CLS[cls]) {
    const badge = document.createElement("span");
    badge.className = "sq-badge";
    badge.textContent = CLS[cls].emoji;
    badge.setAttribute("aria-hidden", "true");
    badge.style.fontSize = Math.max(11, Math.round(toEl.offsetWidth * 0.22)) + "px";
    toEl.appendChild(badge);
  }
}

// chessboard.js rebuilds every square on flip / resize, which drops the
// highlight, the emoji badge and the arrows — put them back for the current move.
function refreshBoardMarks() {
  if (!state.result || !state.board) return;
  const move = getActiveMoves()[state.moveIndex];
  highlightSquares(move ? move.uci : null, move ? move.cls : null);
  applyEndGameKingHighlights();
  drawReviewArrows();
}

function updateEvalBar(cpWhite, label) {
  // Map cp to percentage (50% = equal)
  const capped = Math.max(-600, Math.min(600, cpWhite));
  const pct = 50 + (capped / 600) * 45;   // 5%-95% range
  $("eval-bar-fill").style.height = `${pct}%`;
  const el = $("eval-bar-label");
  el.textContent = label || "0.0";
  // Sit score in the larger color block so contrast stays readable
  const whiteAhead = pct >= 50;
  el.style.bottom = whiteAhead ? "10px" : "auto";
  el.style.top = whiteAhead ? "auto" : "10px";
  el.style.color = whiteAhead ? "#1a1208" : "#f0d9b5";
}

// ── Live Evaluation (Stockfish 19 MultiPV=3) ────────────────

async function triggerLiveEvaluation(fen) {
  if (useLocalWasm) {
    runLocalWasmLiveEval(fen);
    return;
  }

  const linesList = $("engine-lines-list");
  linesList.innerHTML = `<div class="engine-line-item empty">Engine thinking…</div>`;
  state.liveEvalLines = [];

  // Abort any active live evaluation requests
  if (state.liveEvalAbortController) {
    state.liveEvalAbortController.abort();
  }
  state.liveEvalAbortController = new AbortController();

  try {
    const res = await fetch("/api/live_eval", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ fen }),
      signal: state.liveEvalAbortController.signal
    });
    const data = await res.json();

    if (!res.ok || data.error) {
      throw new Error(data.error || "Evaluation failed");
    }

    state.liveEvalLines = data.lines;
    renderEngineLines(data.lines);
    updateCoachBubbleWithLiveEval(data.lines);

    // Draw live candidate arrows if setting is enabled and not in Game Review mode
    if ($("chk-show-arrows").checked && !state.result) {
      drawEngineArrows(data.lines);
    } else if (state.result) {
      // In game review, ensure review arrows are drawn
      drawReviewArrows();
    } else {
      const oldSvg = document.getElementById("board-arrows-svg");
      if (oldSvg) oldSvg.remove();
    }

  } catch (err) {
    if (err.name === "AbortError") return; // ignored
    linesList.innerHTML = `<div class="engine-line-item empty">Engine offline</div>`;
  }
}

function renderEngineLines(lines) {
  const container = $("engine-lines-list");
  if (!lines || !lines.length) {
    container.innerHTML = `<div class="engine-line-item empty">No candidate lines found.</div>`;
    return;
  }

  container.innerHTML = lines.map((m, idx) => {
    return `
    <div class="engine-line-item">
      <span class="line-rank line-rank-${idx + 1}">${idx + 1}</span>
      <span class="line-move">${escapeHtml(m.san)}</span>
      <span class="line-pv">${escapeHtml(m.line || "")}</span>
      <span class="line-eval">${escapeHtml(m.score)}</span>
    </div>`;
  }).join("");
}

/** "Checkmate" / "Stalemate" / "Draw" when the position has no moves to suggest. */
function gameOverLabel(fen) {
  try {
    const c = new Chess(fen);
    if (c.in_checkmate()) return "Checkmate — game over";
    if (c.in_stalemate()) return "Stalemate — game over";
    if (c.in_draw()) return "Drawn position";
  } catch (_) {}
  return "";
}

/**
 * Raw live MultiPV rows (UCI moves, side-to-move scores) → display rows that
 * match the cached review lines: SAN, White-POV score, plus a short continuation.
 */
function liveLinesForDisplay(rawLines, fen) {
  const whiteToMove = (fen.split(" ")[1] || "w") === "w";
  return rawLines.map((pv, i) => {
    const sans = [];
    try {
      const tmp = new Chess(fen);
      for (const uci of pv.pv.slice(0, 6)) {
        const mv = tmp.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] || undefined });
        if (!mv) break;
        sans.push(mv.san);
      }
    } catch (_) {}
    const whiteCp = ReviewMath.stmCpToWhite(ReviewMath.stmToCp(pv.score, pv.mate), whiteToMove);
    const mateWhite = pv.mate == null ? null : (whiteToMove ? pv.mate : -pv.mate);
    return {
      san: sans[0] || pv.uci,
      uci: pv.uci,
      cp: whiteCp,
      score: formatScore(whiteCp, mateWhite),
      line: sans.slice(1).join(" "),
      rank: i + 1,
      whitePov: true,
    };
  });
}

function getSquareCoordinates(square) {
  const col = square.charCodeAt(0) - 97; // 'a' -> 0, 'b' -> 1...
  const row = parseInt(square[1]) - 1;   // '1' -> 0, '2' -> 1...
  
  const boardEl = document.getElementById("board");
  const width = boardEl.offsetWidth;
  const sqSize = width / 8;

  let colIdx = col;
  let rowIdx = 7 - row;

  if (state.flipped) {
    colIdx = 7 - col;
    rowIdx = row;
  }

  const x = (colIdx + 0.5) * sqSize;
  const y = (rowIdx + 0.5) * sqSize;
  return { x, y };
}

function drawEngineArrows(engineLines) {
  const oldSvg = document.getElementById("board-arrows-svg");
  if (oldSvg) oldSvg.remove();

  const boardEl = document.getElementById("board");
  if (!boardEl) return;
  const width = boardEl.offsetWidth;

  // Create SVG overlay
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("id", "board-arrows-svg");
  svg.style.position = "absolute";
  svg.style.top = "0";
  svg.style.left = "0";
  svg.style.width = width + "px";
  svg.style.height = width + "px";
  svg.style.pointerEvents = "none";
  svg.style.zIndex = "10";

  const defs = document.createElementNS("http://www.w3.org/2000/svg", "defs");
  svg.appendChild(defs);

  // Define Arrow arrowhead markers for all categories
  const arrowConfigs = [
    { name: "blunder",    color: "rgba(239, 68, 68, 0.75)" },
    { name: "miss",       color: "rgba(232, 121, 249, 0.75)" },
    { name: "mistake",    color: "rgba(249, 115, 22, 0.7)" },
    { name: "inaccuracy", color: "rgba(251, 191, 36, 0.7)" },
    { name: "brilliant",  color: "rgba(34, 211, 238, 0.85)" },
    { name: "great",      color: "rgba(56, 189, 248, 0.8)" },
    { name: "best",       color: "rgba(34, 197, 94, 0.7)" },
    { name: "excellent",  color: "rgba(59, 130, 246, 0.7)" },
    { name: "book",       color: "rgba(163, 230, 53, 0.7)" },
    { name: "good",       color: "rgba(245, 158, 11, 0.55)" },
    { name: "best_arrow", color: "rgba(34, 197, 94, 0.8)" }
  ];

  arrowConfigs.forEach(cfg => {
    const marker = document.createElementNS("http://www.w3.org/2000/svg", "marker");
    marker.setAttribute("id", `arrowhead-${cfg.name}`);
    marker.setAttribute("markerWidth", "4.2");
    marker.setAttribute("markerHeight", "4.2");
    marker.setAttribute("refX", "3.1");
    marker.setAttribute("refY", "2.1");
    marker.setAttribute("orient", "auto");
    
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", "M 0 0 L 4.2 2.1 L 0 4.2 z");
    path.setAttribute("fill", cfg.color);
    
    marker.appendChild(path);
    defs.appendChild(marker);
  });

  const arrows = [];

  // 1. Gather live engine candidate moves
  if (engineLines && engineLines.length) {
    engineLines.forEach((m, idx) => {
      if (m.uci) {
        arrows.push({
          uci: m.uci,
          colorType: idx === 0 ? "best" : idx === 1 ? "excellent" : "good",
          strokeWidth: idx === 0 ? "4.8" : idx === 1 ? "3.8" : "2.8",
          isDashed: false
        });
      }
    });
  }

  // 2. Gather game review played moves (if in game review mode)
  if (state.result) {
    const activeMoves = getActiveMoves();
    const currentMove = activeMoves[state.moveIndex];
    if (currentMove) {
      if (currentMove.uci) {
        arrows.push({
          uci: currentMove.uci,
          colorType: currentMove.cls || "good",
          strokeWidth: "4.5",
          isDashed: false
        });
      }
      const isBadMove = ["inaccuracy", "mistake", "miss", "blunder"].includes(currentMove.cls);
      if ((isBadMove || state.showBestArrow) && currentMove.best_uci && !currentMove.is_best && currentMove.uci !== currentMove.best_uci) {
        arrows.push({
          uci: currentMove.best_uci,
          colorType: "best_arrow",
          strokeWidth: "4.5",
          isDashed: false
        });
      }
    }
  }

  // 3. Draw gathered arrows to the SVG
  arrows.forEach(arr => {
    const from = arr.uci.slice(0, 2);
    const to = arr.uci.slice(2, 4);
    
    const pStart = getSquareCoordinates(from);
    const pEnd = getSquareCoordinates(to);
    
    const dx = pEnd.x - pStart.x;
    const dy = pEnd.y - pStart.y;
    const len = Math.sqrt(dx * dx + dy * dy);
    if (len < 1) return;

    const offset = width / 16;
    const endX = pEnd.x - (dx / len) * offset;
    const endY = pEnd.y - (dy / len) * offset;

    const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
    line.setAttribute("x1", pStart.x);
    line.setAttribute("y1", pStart.y);
    line.setAttribute("x2", endX);
    line.setAttribute("y2", endY);
    
    const match = arrowConfigs.find(c => c.name === arr.colorType) || arrowConfigs[6];
    line.setAttribute("stroke", match.color);
    line.setAttribute("stroke-width", arr.strokeWidth);
    line.setAttribute("marker-end", `url(#arrowhead-${arr.colorType})`);

    if (arr.isDashed) {
      line.setAttribute("stroke-dasharray", "5,4");
    }
    
    svg.appendChild(line);
  });

  boardEl.appendChild(svg);
}

// ── Review Move Arrows (Chess.com Style) ───────────────
const REVIEW_COLORS = {
  blunder:    "rgba(239, 68, 68, 0.75)",
  miss:       "rgba(232, 121, 249, 0.75)",
  mistake:    "rgba(249, 115, 22, 0.7)",
  inaccuracy: "rgba(251, 191, 36, 0.7)",
  brilliant:  "rgba(34, 211, 238, 0.85)",
  great:      "rgba(56, 189, 248, 0.8)",
  best:       "rgba(34, 197, 94, 0.7)",
  excellent:  "rgba(59, 130, 246, 0.7)",
  book:       "rgba(163, 230, 53, 0.7)",
  good:       "rgba(163, 230, 53, 0.55)",
  best_arrow: "rgba(34, 197, 94, 0.8)"
};

function drawReviewArrows() {
  const oldSvg = document.getElementById("board-arrows-svg");
  if (oldSvg) oldSvg.remove();

  if (!state.result) return;
  const moves = getActiveMoves();
  const move = moves[state.moveIndex];
  if (!move) return;

  const arrows = [];

  // 1. Draw played move arrow
  if (move.uci) {
    arrows.push({
      uci: move.uci,
      type: move.cls || "good"
    });
  }

  // 2. Draw best move dashed arrow automatically for inaccuracies/mistakes/blunders, or if showBestArrow toggle is active
  const isBadMove = ["inaccuracy", "mistake", "miss", "blunder"].includes(move.cls);
  if ((isBadMove || state.showBestArrow) && move.best_uci && !move.is_best && move.uci !== move.best_uci) {
    arrows.push({
      uci: move.best_uci,
      type: "best_arrow"
    });
  }

  drawVisualReviewArrows(arrows);
}

function drawVisualReviewArrows(arrows) {
  if (!arrows || !arrows.length) return;

  const boardEl = document.getElementById("board");
  const width = boardEl.offsetWidth;
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("id", "board-arrows-svg");
  svg.style.position = "absolute";
  svg.style.top = "0";
  svg.style.left = "0";
  svg.style.width = width + "px";
  svg.style.height = width + "px";
  svg.style.pointerEvents = "none";
  svg.style.zIndex = "10";

  const defs = document.createElementNS("http://www.w3.org/2000/svg", "defs");

  // Define arrowhead markers for review classifications
  const configs = [
    { name: "blunder",    color: REVIEW_COLORS.blunder },
    { name: "miss",       color: REVIEW_COLORS.miss },
    { name: "mistake",    color: REVIEW_COLORS.mistake },
    { name: "inaccuracy", color: REVIEW_COLORS.inaccuracy },
    { name: "brilliant",  color: REVIEW_COLORS.brilliant },
    { name: "great",      color: REVIEW_COLORS.great },
    { name: "best",       color: REVIEW_COLORS.best },
    { name: "excellent",  color: REVIEW_COLORS.excellent },
    { name: "book",       color: REVIEW_COLORS.book },
    { name: "good",       color: REVIEW_COLORS.good },
    { name: "best_arrow", color: REVIEW_COLORS.best_arrow }
  ];

  configs.forEach(cfg => {
    const marker = document.createElementNS("http://www.w3.org/2000/svg", "marker");
    marker.setAttribute("id", `arrowhead-${cfg.name}`);
    marker.setAttribute("markerWidth", "4.2");
    marker.setAttribute("markerHeight", "4.2");
    marker.setAttribute("refX", "3.1");
    marker.setAttribute("refY", "2.1");
    marker.setAttribute("orient", "auto");
    
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", "M 0 0 L 4.2 2.1 L 0 4.2 z");
    path.setAttribute("fill", cfg.color);
    
    marker.appendChild(path);
    defs.appendChild(marker);
  });
  svg.appendChild(defs);

  arrows.forEach(arr => {
    const from = arr.uci.slice(0, 2);
    const to = arr.uci.slice(2, 4);
    
    const pStart = getSquareCoordinates(from);
    const pEnd = getSquareCoordinates(to);
    
    const dx = pEnd.x - pStart.x;
    const dy = pEnd.y - pStart.y;
    const len = Math.sqrt(dx * dx + dy * dy);
    if (len < 1) return;

    // Shift arrow end back slightly so the arrowhead sits on the center of the target square
    const offset = width / 16;
    const endX = pEnd.x - (dx / len) * offset;
    const endY = pEnd.y - (dy / len) * offset;

    const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
    line.setAttribute("x1", pStart.x);
    line.setAttribute("y1", pStart.y);
    line.setAttribute("x2", endX);
    line.setAttribute("y2", endY);
    
    const color = REVIEW_COLORS[arr.type] || "rgba(148, 163, 184, 0.7)";
    line.setAttribute("stroke", color);
    line.setAttribute("stroke-width", "4.5");
    line.setAttribute("marker-end", `url(#arrowhead-${arr.type})`);
    
    svg.appendChild(line);
  });

  boardEl.appendChild(svg);
}

// ── Move list ──────────────────────────────────────────

function renderMovesRange(moves, container, path) {
  let i = 0;
  while (i < moves.length) {
    const white = moves[i];
    const black = moves[i + 1];

    // Chess.com order: move number | white | black
    const numCell = document.createElement("div");
    numCell.className = "move-num";
    numCell.textContent = white.move_num + ".";
    container.appendChild(numCell);

    container.appendChild(makeMoveCell(white, i, path));

    if (black) {
      container.appendChild(makeMoveCell(black, i + 1, path));
    } else {
      const empty = document.createElement("div");
      empty.className = "move-cell empty";
      container.appendChild(empty);
    }

    // 4. White variations (spans 1 / -1 in its own row)
    const whiteVars = white.variations || [];
    whiteVars.forEach((varMoves, varIdx) => {
      if (varMoves.length) {
        const subPath = [...path, { moveIdx: i, varIdx: varIdx }];
        container.appendChild(makeVariationBlock(varMoves, subPath, white.move_num, 'white'));
      }
    });

    // 5. Black variations (spans 1 / -1 in its own row)
    if (black) {
      const blackVars = black.variations || [];
      blackVars.forEach((varMoves, varIdx) => {
        if (varMoves.length) {
          const subPath = [...path, { moveIdx: i + 1, varIdx: varIdx }];
          container.appendChild(makeVariationBlock(varMoves, subPath, black.move_num, 'black'));
        }
      });
    }

    i += 2;
  }
}

function renderMoveList(moves) {
  const list = $("moves-list");
  if (!list) return;
  list.innerHTML = "";

  // Render main line moves at root level (path is [])
  renderMovesRange(moves, list, []);

  // Render horizontal mobile moves navigation bar in sync
  renderMobileMoveList(getActiveMoves());
}

function renderMobileMoveList(moves) {
  const list = $("mobile-moves-list");
  if (!list) return;
  list.innerHTML = "";

  moves.forEach((move, idx) => {
    const item = document.createElement("div");
    item.className = "mobile-move-item";
    item.dataset.idx = idx;

    const numSpan = document.createElement("span");
    numSpan.className = "mobile-move-num";
    if (move.color === "white") {
      numSpan.textContent = move.move_num + ".";
    } else {
      numSpan.textContent = move.move_num + "...";
    }
    item.appendChild(numSpan);

    const sanSpan = document.createElement("span");
    sanSpan.innerHTML = formatSanWithSymbol(move.san);
    item.appendChild(sanSpan);

    // Emoji marker after the move (same set as the desktop list; routine ones dimmed)
    if (CLS[move.cls]) {
      const mark = makeClsMark(move.cls);
      if (QUIET_CLS.has(move.cls)) mark.classList.add("cls-mark--quiet");
      item.appendChild(mark);
    }

    item.addEventListener("click", () => goToMove(idx));
    list.appendChild(item);
  });
}

// Emoji marker for a move classification, labelled for screen readers
function makeClsMark(cls) {
  const mark = document.createElement("span");
  mark.className = "cls-mark";
  mark.textContent = CLS[cls].emoji;
  mark.setAttribute("role", "img");
  mark.setAttribute("aria-label", CLS[cls].label);
  return mark;
}

function formatSanWithSymbol(san) {
  if (!san) return "";
  const firstChar = san[0];
  const pieceSymbols = {
    'Q': '♛',
    'R': '♜',
    'B': '♝',
    'N': '♞',
    'K': '♚'
  };
  
  if (firstChar in pieceSymbols) {
    // Add vertical alignment and spacing style classes
    return `<span class="piece-sym">${pieceSymbols[firstChar]}</span>${san.slice(1)}`;
  }
  return san;
}

// Build an inline variation block: (N. move move ...)
function makeVariationBlock(varMoves, path, startMoveNum, branchColor) {
  const wrap = document.createElement("div");
  wrap.className = "variation-block";
  // span all 3 columns (num + white + black)
  wrap.style.gridColumn = "1 / -1";

  const inner = document.createElement("div");
  inner.className = "variation-inner";
  wrap.appendChild(inner);

  inner.appendChild(makeVarToken("(", "var-bracket"));

  varMoves.forEach((move, idx) => {
    // Move number label — show for white moves, or for the first black move in var
    if (move.color === 'white') {
      inner.appendChild(makeVarToken(move.move_num + ".", "var-num"));
    } else if (idx === 0) {
      inner.appendChild(makeVarToken(move.move_num + "…", "var-num"));
    }
    
    // Pass current path walking down this variation branch
    inner.appendChild(makeMoveCell(move, idx, path));

    // Recursively draw sub-variations inside the inline bracket
    const subVars = move.variations || [];
    subVars.forEach((subVarMoves, subVarIdx) => {
      if (subVarMoves.length) {
        const subPath = [...path, { moveIdx: idx, varIdx: subVarIdx }];
        inner.appendChild(makeVariationBlock(subVarMoves, subPath, move.move_num, move.color));
      }
    });
  });

  inner.appendChild(makeVarToken(")", "var-bracket"));
  return wrap;
}

function makeVarToken(text, cls) {
  const el = document.createElement("span");
  el.className = cls;
  el.textContent = text;
  return el;
}

// path is an array of branch descriptions, or empty for main-line moves
function makeMoveCell(move, idx, path) {
  const cell = document.createElement("div");
  const isVar = path && path.length > 0;
  cell.className = `move-cell cls-${move.cls}${isVar ? ' var-move' : ''}`;
  cell.dataset.idx = idx;
  cell.dataset.path = JSON.stringify(path || []);

  if (!isVar) {
    cell.title = move.cpl !== undefined
      ? `${CLS[move.cls]?.label || move.cls} · CPL: ${move.cpl}`
      : move.san;
  }

  if (!isVar) {
    // Emoji per classification (not colour alone); routine moves are dimmed via CSS
    const mark = CLS[move.cls]
      ? makeClsMark(move.cls)
      : Object.assign(document.createElement("span"), { className: "cls-mark" });
    if (QUIET_CLS.has(move.cls)) mark.classList.add("cls-mark--quiet");
    cell.appendChild(mark);
  }

  const san = document.createElement("span");
  san.innerHTML = formatSanWithSymbol(move.san);
  cell.appendChild(san);

  if (!isVar && move.duration !== undefined && move.duration !== null) {
    const timeSpan = document.createElement("span");
    timeSpan.className = "move-time";
    timeSpan.textContent = formatDuration(move.duration);
    cell.appendChild(timeSpan);
  }

  cell.addEventListener("click", () => {
    state.currentVariationPath = path || [];
    if (state.currentVariationPath.length > 0) {
      $("btn-main-line").classList.remove("hidden");
    } else {
      $("btn-main-line").classList.add("hidden");
    }
    goToMove(idx);
  });

  cell.addEventListener("mouseenter", e => showTooltip(e, move));
  cell.addEventListener("mouseleave", hideTooltip);
  // Mobile: tap once to show tooltip, tap again (or anywhere else) to dismiss
  cell.addEventListener("touchstart", e => {
    const tt = $("move-tooltip");
    const alreadyOpen = !tt.classList.contains("hidden") && tt._currentMove === move;
    if (alreadyOpen) {
      hideTooltip();
    } else {
      const touch = e.touches[0];
      showTooltip({ clientX: touch.clientX, clientY: touch.clientY }, move);
      tt._currentMove = move;
    }
  }, { passive: true });

  return cell;
}

function showTooltip(e, move) {
  const tt = $("move-tooltip");
  $("tooltip-cls").textContent = CLS[move.cls] ? `${CLS[move.cls].emoji} ${CLS[move.cls].label}` : move.cls;
  $("tooltip-cls").style.color = CLS[move.cls]?.color || "#fff";
  $("tooltip-cpl").textContent = move.is_best
    ? "Engine's best move"
    : `Centipawn loss: ${move.cpl}`;

  const bestEl = $("tooltip-best");
  const bestLabel = move.best_san || move.best_uci;
  if (bestLabel && !move.is_best) {
    bestEl.textContent = `Best: ${bestLabel}`;
    bestEl.classList.remove("hidden");
  } else {
    bestEl.classList.add("hidden");
  }

  tt.classList.remove("hidden");
  positionTooltip(e, tt);
}

function positionTooltip(e, tt) {
  const x = e.clientX + 12;
  const y = e.clientY - 10;
  tt.style.left = `${Math.min(x, window.innerWidth - 200)}px`;
  tt.style.top  = `${Math.min(y, window.innerHeight - 120)}px`;
}

function hideTooltip() {
  const tt = $("move-tooltip");
  tt.classList.add("hidden");
  tt._currentMove = null;
}

// Dismiss tooltip when tapping anywhere outside a move cell
document.addEventListener("touchstart", e => {
  if (!e.target.closest(".move-cell")) hideTooltip();
}, { passive: true });

// ── Win probability chart ──────────────────────────────

function renderChart(moves) {
  if (state.chart) state.chart.destroy();

  const labels = moves.map((m, i) => i + 1);
  const data   = moves.map(m => m.win_prob);

  const isMobile = window.innerWidth <= 900;
  const canvasId = isMobile ? "mob-win-chart" : "win-chart";
  const canvas = document.getElementById(canvasId);
  if (!canvas) return;
  const ctx = canvas.getContext("2d");

  // Dashed 50% line (equality) + a cursor on the move currently shown on the board
  const reviewChartPlugin = {
    id: "reviewChartMarks",
    beforeDraw(chart) {
      const { ctx, scales: { y } } = chart;
      const y50 = y.getPixelForValue(50);
      ctx.save();
      ctx.strokeStyle = "rgba(240,217,181,0.14)";
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 4]);
      ctx.beginPath();
      ctx.moveTo(chart.chartArea.left, y50);
      ctx.lineTo(chart.chartArea.right, y50);
      ctx.stroke();
      ctx.restore();
    },
    afterDatasetsDraw(chart) {
      const onMainLine = !(state.currentVariationPath && state.currentVariationPath.length);
      const point = onMainLine ? chart.getDatasetMeta(0).data[state.moveIndex] : null;
      if (!point) return;
      const { ctx, chartArea } = chart;
      ctx.save();
      ctx.strokeStyle = "rgba(240,217,181,0.75)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(point.x, chartArea.top);
      ctx.lineTo(point.x, chartArea.bottom);
      ctx.stroke();
      ctx.fillStyle = "#f0d9b5";
      ctx.beginPath();
      ctx.arc(point.x, point.y, 3.5, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    },
  };

  state.chart = new Chart(ctx, {
    type: "line",
    data: {
      labels,
      datasets: [{
        data,
        borderColor: "#d4a055",
        backgroundColor: (ctx) => {
          const g = ctx.chart.ctx.createLinearGradient(0, 0, 0, 120);
          g.addColorStop(0, "rgba(212,160,85,0.32)");
          g.addColorStop(1, "rgba(212,160,85,0.03)");
          return g;
        },
        borderWidth: 1.5,
        pointRadius: 0,
        tension: 0.4,
        fill: true,
      }]
    },
    plugins: [reviewChartPlugin],
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: "nearest", axis: "x", intersect: false },
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            // Labels are plies — show them the way the move list does ("12. Nf3" / "12… Nf6")
            title: items => {
              const m = moves[items[0].dataIndex];
              return m ? `${m.move_num}${m.color === "black" ? "…" : "."} ${m.san}` : "";
            },
            label: item => `White win chance: ${item.raw.toFixed(1)}%`,
          },
          backgroundColor: "#241a0f",
          titleColor: "#f0d9b5",
          bodyColor: "#c4a070",
          borderColor: "rgba(181,136,99,0.32)",
          borderWidth: 1,
          displayColors: false,
        },
      },
      scales: {
        x: { display: false },
        y: {
          min: 0, max: 100,
          grid: { color: "rgba(240,217,181,0.05)" },
          ticks: {
            color: "#a8875c",
            font: { size: 10 },
            callback: v => v === 50 ? "Equal" : v === 100 ? "White" : v === 0 ? "Black" : "",
          },
          border: { display: false },
        },
      },
      onClick: (e, elements) => {
        if (elements.length > 0) {
          goToMainLineMove(elements[0].index);
        }
      },
      onHover: (e, elements) => {
        const canvas = e.native?.target;
        if (canvas) canvas.style.cursor = elements.length ? "pointer" : "default";
      },
    }
  });
}

// ══════════════════════════════════════════════════════
// KEYBOARD NAVIGATION
// ══════════════════════════════════════════════════════

document.addEventListener("keydown", e => {
  if (!state.result) return;
  const total = state.result.moves.length;
  if (e.key === "ArrowLeft"  || e.key === "ArrowDown")  goToMove(state.moveIndex - 1);
  if (e.key === "ArrowRight" || e.key === "ArrowUp")    goToMove(state.moveIndex + 1);
  if (e.key === "Home") goToMove(-1);
  if (e.key === "End")  goToMove(total - 1);
});

// ══════════════════════════════════════════════════════
// SWIPE NAVIGATION (mobile)
// ══════════════════════════════════════════════════════

(function initSwipe() {
  let touchStartX = 0;
  let touchStartY = 0;
  const SWIPE_THRESHOLD = 40;   // min px horizontal travel
  const AXIS_LOCK = 1.5;        // horizontal must dominate by this ratio

  const boardArea = document.getElementById("view-analysis");

  boardArea.addEventListener("touchstart", e => {
    touchStartX = e.touches[0].clientX;
    touchStartY = e.touches[0].clientY;
  }, { passive: true });

  boardArea.addEventListener("touchend", e => {
    if (!state.result) return;
    const dx = e.changedTouches[0].clientX - touchStartX;
    const dy = e.changedTouches[0].clientY - touchStartY;
    // Only register if horizontal travel dominates and exceeds threshold
    if (Math.abs(dx) < SWIPE_THRESHOLD || Math.abs(dx) < Math.abs(dy) * AXIS_LOCK) return;
    if (dx < 0) {
      // swipe left → next move
      goToMove(state.moveIndex + 1);
    } else {
      // swipe right → prev move
      goToMove(state.moveIndex - 1);
    }
  }, { passive: true });
})();

// ══════════════════════════════════════════════════════
// EVENT LISTENERS
// ══════════════════════════════════════════════════════

// Home
$("load-btn").addEventListener("click", loadGames);
$("username-input").addEventListener("keydown", e => { if (e.key === "Enter") loadGames(); });
$("logo-btn").addEventListener("click", () => {
  showView("view-home");
  $("header-username").classList.add("hidden");
});

// Games
document.querySelectorAll(".mode-btn").forEach(btn => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".mode-btn").forEach(b => b.classList.remove("active"));
    btn.classList.add("active");
    state.analysisMode = btn.dataset.mode;
  });
});

// Analysis
function leaveAnalysisToGames() {
  if (analysisInProgress) cancelRunningAnalysis();
  setReviewing(false);
  // Prefer games list; fall back to Local Game Analyzer entry
  window.location.hash = state.games?.length ? "games" : "analysis";
}
$("analysis-back").addEventListener("click", leaveAnalysisToGames);
$("analysis-back-sidebar")?.addEventListener("click", leaveAnalysisToGames);
$("btn-main-line").addEventListener("click", () => {
  if (!state.currentVariationPath || !state.currentVariationPath.length) return;
  const firstBranch = state.currentVariationPath[0];
  state.currentVariationPath = [];
  $("btn-main-line").classList.add("hidden");
  renderMoveList(state.result.moves);
  goToMove(firstBranch.moveIdx);
});
$("btn-first").addEventListener("click", () => goToMove(-1));
$("btn-prev").addEventListener("click",  () => goToMove(state.moveIndex - 1));
$("btn-next").addEventListener("click",  () => goToMove(state.moveIndex + 1));
$("btn-last").addEventListener("click",  () => goToMove((state.result?.moves.length || 0) - 1));
$("btn-flip").addEventListener("click",  () => {
  state.flipped = !state.flipped;
  state.board?.flip();
  refreshBoardMarks();
});

// Mobile navigation buttons
$("btn-mobile-prev").addEventListener("click", () => goToMove(state.moveIndex - 1));
$("btn-mobile-next").addEventListener("click", () => goToMove(state.moveIndex + 1));

// Mobile bottom action bar buttons
$("btn-mobile-flip").addEventListener("click", () => {
  state.flipped = !state.flipped;
  state.board?.flip();
  refreshBoardMarks();
});
$("btn-mobile-show-best").addEventListener("click", () => {
  state.showBestArrow = !state.showBestArrow;
  $("btn-mobile-show-best").classList.toggle("active", state.showBestArrow);

  drawReviewArrows();
});
$("btn-mobile-retry").addEventListener("click", () => {
  // Go back one move so the user can retry dragging a different variation
  goToMove(state.moveIndex - 1);
});
// Next mistake (falls back to next move, then back to start) — label kept in sync by updateReviewActions()
$("btn-mobile-next-key").addEventListener("click", advanceToNextKeyMove);
$("btn-next-key")?.addEventListener("click", advanceToNextKeyMove);

// Review summary table: counts jump to that player's next move of that class
["review-table", "mob-review-table"].forEach(id => {
  $(id)?.addEventListener("click", e => {
    const btn = e.target.closest("button.rt-count");
    if (!btn) return;
    jumpToNextClass(btn.dataset.cls, btn.dataset.color);
    // The mobile summary sits below the board — bring the board back into view
    if (id === "mob-review-table") window.scrollTo({ top: 0, behavior: "smooth" });
  });
});

// Sidebar Tabs switching
document.querySelectorAll(".sidebar-tab").forEach(tab => {
  tab.addEventListener("click", () => {
    const targetTab = tab.dataset.tab;
    document.querySelectorAll(".sidebar-tab").forEach(t => {
      t.classList.toggle("active", t === tab);
      t.setAttribute("aria-selected", t === tab ? "true" : "false");
    });

    // Toggle active content divs
    $("tab-moves").classList.toggle("hidden", targetTab !== "moves");
    $("tab-review").classList.toggle("hidden", targetTab !== "review");

    // Force chart update on view tab to fit its container dimensions
    if (targetTab === "review" && state.chart) {
      setTimeout(() => {
        state.chart.resize();
        state.chart.update();
      }, 50);
    }
  });
});

// "Show Arrows" toggle change handler
$("chk-show-arrows").addEventListener("change", (e) => {
  if (e.target.checked && !state.result) {
    drawEngineArrows(state.liveEvalLines);
  } else if (state.result) {
    drawReviewArrows();
  } else {
    const oldSvg = document.getElementById("board-arrows-svg");
    if (oldSvg) oldSvg.remove();
  }
});

// ── Phone configuration helper ────────────────────────
function formatPhoneNumber(phoneNumberString) {
  const cleaned = ('' + phoneNumberString).replace(/\D/g, '');
  const match = cleaned.match(/^(1|)?(\d{3})(\d{3})(\d{4})$/);
  if (match) {
    const intlCode = match[1] ? '+1 ' : '';
    return [intlCode, '(', match[2], ') ', match[3], '-', match[4]].join('');
  }
  return phoneNumberString;
}

async function loadConfig() {
  try {
    const res = await fetch("/api/config");
    if (res.ok) {
      const data = await res.json();
      if (data.phone_number) {
        const rawPhone = data.phone_number;
        const formatted = formatPhoneNumber(rawPhone);
        
        // Update home screen displays
        const displayEl = $("phone-number-display");
        if (displayEl) displayEl.textContent = formatted;
        
        const dialLink = $("btn-dial-phone");
        if (dialLink) dialLink.href = `tel:${rawPhone}`;
      }
    }
  } catch (err) {
    console.error("Failed to load config:", err);
  }
}

async function loadPublicStats() {
  const el = $("public-stats");
  if (!el) return;
  try {
    const res = await fetch("/api/stats/public");
    if (!res.ok) return;
    const s = await res.json();
    if (s.voice_games_total > 0) {
      el.innerHTML = `♟ <strong>${Number(s.voice_games_total).toLocaleString()}</strong> games played by phone · ` +
                     `📞 <strong>${Number(s.calls_total).toLocaleString()}</strong> calls answered`;
      el.classList.remove("hidden");
    }
  } catch (_) { /* social proof is optional — never break the page */ }
}

async function loadLiveGames() {
  const container = $("live-games-container");
  if (!container) return;
  loadPublicStats();

  try {
    const res = await fetch("/api/games/live");
    if (!res.ok) throw new Error("Failed to fetch live games");
    const data = await res.json();
    const games = data.games || [];
    
    if (games.length === 0) {
      container.innerHTML = `
        <div class="live-game-placeholder-card">
          <p>No active voice games in progress. Dial <strong>+1-(4-CHESSNOW-3)</strong> to start playing!</p>
        </div>
      `;
      return;
    }
    
    let html = "";
    games.forEach(g => {
      const sourceLabel = g.source === "voice_bot" ? "vs AI Coach" : "PvP Challenge";
      const whiteName = escapeHtml(g.white_player || "White");
      const blackName = escapeHtml(g.black_player || "Black");
      
      html += `
        <div class="live-game-card">
          <div class="live-game-status">
            <span class="live-game-pulse"></span> Ongoing Match
          </div>
          <div class="live-game-players">
            👑 ${whiteName} vs ♟ ${blackName}
          </div>
          <div class="live-game-meta">
            <span class="live-game-source">${sourceLabel}</span>
            <span style="font-size: 11px; color: var(--text-3);">Live on Call</span>
          </div>
          <button class="btn-watch" onclick="loadGameById('${g.id}')">Spectate / Analyze</button>
        </div>
      `;
    });
    container.innerHTML = html;
  } catch (err) {
    console.error("Error loading live games:", err);
    container.innerHTML = `
      <div class="live-game-placeholder-card">
        <p style="color: var(--blunder);">⚠️ Error loading live games. Please try again later.</p>
      </div>
    `;
  }
}

function initSampleCall() {
  // "Hear a sample call" hero demo — browser TTS so the product can demo its
  // own medium. Swap in a recorded clip later by replacing speakLine's engine.
  const wrap = $("sample-call");
  const btn = $("btn-sample-call");
  const transcript = $("sample-transcript");
  if (!wrap || !btn || !transcript || !("speechSynthesis" in window)) return;

  wrap.classList.remove("hidden");
  const lines = Array.from(transcript.querySelectorAll("li"));
  let playing = false;

  function stop() {
    window.speechSynthesis.cancel();
    playing = false;
    lines.forEach(li => li.classList.remove("speaking"));
    btn.textContent = "▶  Hear a sample call";
  }

  function speakLine(i) {
    if (!playing || i >= lines.length) { stop(); return; }
    lines.forEach(li => li.classList.remove("speaking"));
    const li = lines[i];
    li.classList.add("speaking");
    const text = li.textContent.replace(/^(Thara|Caller)/, "");
    const u = new SpeechSynthesisUtterance(text);
    u.pitch = li.dataset.who === "thara" ? 1.15 : 0.9;
    u.rate = 1.0;
    u.onend = () => setTimeout(() => speakLine(i + 1), 300);
    u.onerror = stop;
    window.speechSynthesis.speak(u);
  }

  btn.addEventListener("click", () => {
    if (playing) { stop(); transcript.classList.add("hidden"); return; }
    playing = true;
    transcript.classList.remove("hidden");
    btn.textContent = "■  Stop";
    window.speechSynthesis.cancel();
    speakLine(0);
  });

  window.addEventListener("pagehide", stop);
}

function initLandingPageListeners() {
  initSampleCall();
  const dialPhoneBtn = $("btn-dial-phone");
  if (dialPhoneBtn) {
    dialPhoneBtn.addEventListener("click", () => {
      // Acquisition beacon: count web→phone dial intent (anonymous, best-effort)
      try {
        const payload = JSON.stringify({ event: "dial_click" });
        if (navigator.sendBeacon) {
          navigator.sendBeacon("/api/metrics/event", new Blob([payload], { type: "application/json" }));
        } else {
          fetch("/api/metrics/event", { method: "POST", headers: { "Content-Type": "application/json" }, body: payload, keepalive: true }).catch(() => {});
        }
      } catch (_) { /* never block the dial action */ }
      const displayEl = $("phone-number-display");
      if (displayEl) {
        const phoneNumber = displayEl.textContent.trim();
        navigator.clipboard.writeText(phoneNumber).then(() => {
          const tooltip = $("phone-copy-tooltip");
          if (tooltip) {
            tooltip.classList.add("visible");
            setTimeout(() => tooltip.classList.remove("visible"), 2000);
          }
        }).catch(err => {
          console.error("Failed to copy phone number:", err);
        });
      }
    });
  }

  const scrollBtn = $("btn-scroll-analysis");
  if (scrollBtn) {
    scrollBtn.addEventListener("click", () => {
      const target = $("section-analysis");
      if (target) {
        target.scrollIntoView({ behavior: "smooth" });
      }
    });
  }

  // Footer Navigation & About back button
  const homeLink = $("footer-link-home");
  if (homeLink) {
    homeLink.addEventListener("click", (e) => {
      e.preventDefault();
      showView("view-home");
      window.scrollTo({ top: 0, behavior: "smooth" });
    });
  }

  const howLink = $("footer-link-how");
  if (howLink) {
    howLink.addEventListener("click", (e) => {
      const target = $("section-how-it-works");
      if (target) {
        e.preventDefault();
        showView("view-home");
        target.scrollIntoView({ behavior: "smooth" });
      }
    });
  }

  const liveLink = $("footer-link-live");
  if (liveLink) {
    liveLink.addEventListener("click", (e) => {
      const target = $("section-live-games");
      if (target) {
        e.preventDefault();
        showView("view-home");
        target.scrollIntoView({ behavior: "smooth" });
      }
    });
  }

  const analysisLink = $("footer-link-analysis");
  if (analysisLink) {
    analysisLink.addEventListener("click", (e) => {
      const target = $("section-analysis");
      if (target) {
        e.preventDefault();
        showView("view-home");
        target.scrollIntoView({ behavior: "smooth" });
      }
    });
  }

  const aboutLink = $("footer-link-about");
  if (aboutLink) {
    aboutLink.addEventListener("click", (e) => {
      e.preventDefault();
      window.location.hash = "about";
    });
  }

  const aboutBackBtn = $("about-back");
  if (aboutBackBtn) {
    aboutBackBtn.addEventListener("click", () => {
      window.location.hash = "home";
    });
  }

  const contentBackBtn = $("content-back");
  if (contentBackBtn) {
    contentBackBtn.addEventListener("click", () => {
      window.location.hash = "home";
    });
  }

  // Intercept all links pointing to guides/FAQ
  document.querySelectorAll('a[href^="/faq"], a[href^="/accessibility"], a[href^="/guides/"]').forEach(link => {
    link.addEventListener("click", (e) => {
      e.preventDefault();
      const href = link.getAttribute("href");
      const hash = href.replace("/guides/", "").replace("/", "");
      window.location.hash = hash;
    });
  });
}

// ── Analyzer extras: PGN import, cancel, jump filters, cache re-run ──
function showPgnError(msg) {
  const el = $("pgn-error");
  if (!el) return;
  if (!msg) {
    el.classList.add("hidden");
    el.textContent = "";
    return;
  }
  el.textContent = msg;
  el.classList.remove("hidden");
}

function gameFromPgn(pgnText) {
  const chess = new Chess();
  if (!chess.load_pgn(pgnText)) {
    throw new Error("Could not parse that PGN. Check the text and try again.");
  }
  const headers = chess.header();
  const white = headers.White || "White";
  const black = headers.Black || "Black";
  const result = headers.Result || "*";
  let opening = headers.Opening || headers.ECO || "Custom PGN";
  if (headers.ECOUrl) {
    try {
      opening = headers.ECOUrl.split("/").pop().replace(/-/g, " ");
    } catch (_) {}
  }
  const history = chess.history({ verbose: true });
  if (!history.length) throw new Error("PGN has no moves to analyse.");

  // Prefer White as the "player" unless a known username matches Black
  const uname = (state.username || "").toLowerCase();
  const playerColor =
    uname && black.toLowerCase() === uname ? "Black" :
    uname && white.toLowerCase() === uname ? "White" : "White";

  const id = `pgn_${Date.now()}`;
  return {
    id,
    url: id,
    white,
    black,
    white_rating: headers.WhiteElo || "?",
    black_rating: headers.BlackElo || "?",
    opponent: playerColor === "White" ? black : white,
    opponent_rating: "?",
    player_color: playerColor,
    result: result === "1-0" ? (playerColor === "White" ? "Win" : "Loss")
          : result === "0-1" ? (playerColor === "Black" ? "Win" : "Loss")
          : result === "1/2-1/2" ? "Draw" : result,
    date: headers.Date || "",
    opening,
    time_class: "custom",
    time_control: headers.TimeControl || "",
    pgn: pgnText,
  };
}

// Jump to the next main-line move of a class (optionally one player's), wrapping
// around at the end. Stays on the current tab so repeated clicks cycle through.
function jumpToNextClass(cls, color) {
  if (!state.result?.moves?.length) return;
  const moves = state.result.moves;
  const onMainLine = !(state.currentVariationPath && state.currentVariationPath.length);
  const start = onMainLine ? state.moveIndex + 1 : 0;
  for (let i = 0; i < moves.length; i++) {
    const idx = (start + i) % moves.length;
    if (moves[idx].cls === cls && (!color || moves[idx].color === color)) {
      goToMainLineMove(idx);
      return;
    }
  }
}

function initAnalyzerExtras() {
  $("btn-cancel-analysis")?.addEventListener("click", () => {
    cancelRunningAnalysis();
    const label = document.querySelector("#analysis-loading .loading-label");
    if (label) label.textContent = "Cancelling…";
  });

  $("btn-analysis-error-back")?.addEventListener("click", () => {
    window.location.hash = state.games?.length ? "games" : "analysis";
  });

  $("btn-reanalyze")?.addEventListener("click", () => {
    if (!state.currentGame) return;
    sessionStorage.removeItem("chessnow_cache_banner_dismissed");
    startAnalysis(state.currentGame, { forceReanalyze: true });
  });

  $("btn-dismiss-cache")?.addEventListener("click", () => {
    sessionStorage.setItem("chessnow_cache_banner_dismissed", "1");
    $("cache-banner")?.classList.add("hidden");
  });

  $("pgn-analyze-btn")?.addEventListener("click", () => {
    showPgnError("");
    const text = ($("pgn-input")?.value || "").trim();
    if (!text) {
      showPgnError("Paste a PGN first.");
      return;
    }
    try {
      const game = gameFromPgn(text);
      state.games = state.games || [];
      startAnalysis(game);
    } catch (err) {
      showPgnError(err.message || "Invalid PGN");
    }
  });

  $("pgn-file")?.addEventListener("change", async (e) => {
    showPgnError("");
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    try {
      const text = await file.text();
      if ($("pgn-input")) $("pgn-input").value = text;
      const game = gameFromPgn(text);
      startAnalysis(game);
    } catch (err) {
      showPgnError(err.message || "Could not read that file.");
    } finally {
      e.target.value = "";
    }
  });
}

// ── Init ───────────────────────────────────────────────
// Prefill username: ?user=… query wins, else last successful Chess.com lookup
try {
  const params = new URLSearchParams(window.location.search);
  const queryUser = (params.get("user") || params.get("username") || "").trim();
  const savedUser = localStorage.getItem(LAST_USERNAME_KEY);
  const prefill = queryUser || savedUser;
  if (prefill && $("username-input")) {
    $("username-input").value = prefill;
  }
  // Deep-link: /?user=twelfth_doctor#analysis → load that player's games
  if (queryUser) {
    if (!window.location.hash || window.location.hash === "#home") {
      window.location.hash = "analysis";
    }
    setTimeout(() => loadGames(), 0);
  }
} catch (_) {}
initPhoneAuth();
initVoiceCall();
initLandingPageListeners();
initAnalyzerExtras();
initNavDrawer();
$("btn-mobile-show-best")?.classList.toggle("active", !!state.showBestArrow);
$("chk-show-arrows") && ($("chk-show-arrows").checked = true);

// Initialize dynamic SPA hash routing
window.addEventListener("hashchange", handleHashRouting);
handleHashRouting();

(async () => {
  // Load configuration
  await loadConfig();

  // Load live games immediately and poll every 10s
  loadLiveGames();
  setInterval(loadLiveGames, 10000);

  // Must resolve before any games/analysis fetch decides backend-vs-WASM, otherwise
  // useLocalWasm is still its initial `false` and a no-backend deployment (static
  // hosting, the iOS Capacitor app) always tries the backend path on first load.
  await checkStockfish();

  // A post-game SMS review link looks like "/?game=<id>" — load that specific game
  // directly instead of the normal username-based homepage flow.
  const sharedGameId = new URLSearchParams(window.location.search).get("game");
  if (sharedGameId) {
    loadGameById(sharedGameId);
  }
})();

// ══════════════════════════════════════════════════════
// STANDALONE OFFLINE / MOBILE FALLBACK ENGINE HELPERS
// ══════════════════════════════════════════════════════


function analysisLimitsForMode(mode) {
  // Depth is the quality target; movetime is a safety cap so mobile doesn't hang.
  if (mode === "quick") return { depth: 12, movetime: 250 };
  if (mode === "deep")  return { depth: 18, movetime: 1200 };
  return { depth: 15, movetime: 500 };
}

async function getStockfishWorker() {
  // Stockfish 19 lite-single: Worker entry is /js/stockfish.js; it resolves
  // sibling /js/stockfish.wasm from its own URL. Blob URL workers break iOS WKWebView.
  if (sharedSfWorker && sharedSfReady) {
    try {
      return await sharedSfReady;
    } catch (_) {
      sharedSfWorker = null;
      sharedSfReady = null;
    }
  }

  const worker = new Worker("/js/stockfish.js");
  sharedSfWorker = worker;

  // SF19 does not always emit a boot banner — send uci once the worker is alive
  // and wait for uciok. Retry once in case the first command arrived pre-ready.
  sharedSfReady = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Stockfish init timeout")), 30000);
    let resolved = false;
    const h = e => {
      if (typeof e.data !== "string") return;
      if (e.data.includes("uciok")) {
        if (resolved) return;
        resolved = true;
        clearTimeout(timeout);
        worker.removeEventListener("message", h);
        // Persist TT across positions in a game; lite-single is 1 thread.
        worker.postMessage("setoption name Hash value 128");
        worker.postMessage("setoption name Threads value 1");
        worker.postMessage("isready");
        resolve(worker);
      }
    };
    worker.addEventListener("message", h);
    worker.onerror = e => {
      clearTimeout(timeout);
      sharedSfWorker = null;
      sharedSfReady = null;
      reject(e);
    };
    worker.postMessage("uci");
    setTimeout(() => { if (!resolved) worker.postMessage("uci"); }, 250);
  });

  return sharedSfReady;
}

function resetSharedStockfishWorker() {
  if (sharedSfWorker) {
    try { sharedSfWorker.terminate(); } catch (_) {}
  }
  sharedSfWorker = null;
  sharedSfReady = null;
}

async function chessComFetchWithRetry(url, attempts = 3) {
  let lastErr = null;
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await customFetch(url);
      if (res.status === 429 || res.status === 503) {
        await new Promise(r => setTimeout(r, 400 * Math.pow(2, i)));
        lastErr = new Error(`Chess.com rate limited (${res.status})`);
        continue;
      }
      return res;
    } catch (e) {
      lastErr = e;
      await new Promise(r => setTimeout(r, 300 * Math.pow(2, i)));
    }
  }
  throw lastErr || new Error("Chess.com request failed");
}

async function fetchGamesDirect(username, count = 20) {
  const uname = username.toLowerCase().trim();
  const archivesRes = await chessComFetchWithRetry(`https://api.chess.com/pub/player/${encodeURIComponent(uname)}/games/archives`);
  if (archivesRes.status === 404) throw new Error("User not found on Chess.com");
  if (!archivesRes.ok) throw new Error(`Chess.com archives error (${archivesRes.status})`);
  const archivesData = await archivesRes.json();
  const archives = archivesData.archives || [];
  if (!archives.length) throw new Error("No games found for this user");

  // Walk newest → oldest archives until we have `count` games (serial + light pacing).
  const allGames = [];
  for (let i = archives.length - 1; i >= 0 && allGames.length < count; i--) {
    const r = await chessComFetchWithRetry(archives[i]);
    if (!r.ok) continue;
    const d = await r.json();
    const monthGames = d.games || [];
    allGames.push(...monthGames);
    if (i > 0 && allGames.length < count) {
      await new Promise(res => setTimeout(res, 120));
    }
  }

  if (!allGames.length) throw new Error("No games found for this user");

  const result_map = {
    "win": "Win", "checkmated": "Loss", "resigned": "Loss",
    "timeout": "Loss", "abandoned": "Loss",
    "agreed": "Draw", "repetition": "Draw", "stalemate": "Draw",
    "insufficient": "Draw", "timevsinsufficient": "Draw", "50move": "Draw",
  };

  const formatted = [];
  const gamesToFormat = allGames.slice(-count).reverse();

  for (const g of gamesToFormat) {
    const white = g.white || {};
    const black = g.black || {};
    const isWhite = white.username?.toLowerCase() === uname;
    const player = isWhite ? white : black;
    const opponent = isWhite ? black : white;
    const result = result_map[player.result] || "?";

    const end_ts = g.end_time || 0;
    let date = "";
    if (end_ts) {
      const d = new Date(end_ts * 1000);
      date = d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
    }

    const pgn_text = g.pgn || "";
    let opening = "Unknown Opening";
    const pgnLines = pgn_text.split("\n");
    for (const line of pgnLines) {
      if (line.startsWith("[ECOUrl") && line.includes('"')) {
        opening = line.split('"')[1].split("/").pop().replace(/-/g, " ").replace(/\b\w/g, c => c.toUpperCase());
        break;
      }
      if (line.startsWith("[Opening") && line.includes('"')) {
        opening = line.split('"')[1];
        break;
      }
    }

    formatted.push({
      white: white.username || "",
      black: black.username || "",
      white_rating: white.rating || "?",
      black_rating: black.rating || "?",
      opponent: opponent.username || "?",
      opponent_rating: opponent.rating || "?",
      player_color: isWhite ? "White" : "Black",
      result: result,
      date: date,
      opening: opening,
      time_class: g.time_class || "rapid",
      time_control: g.time_control || "",
      pgn: pgn_text,
      url: g.url || "",
    });
  }

  try {
    localStorage.setItem("chesscom_last_user", uname);
  } catch (_) {}

  return formatted;
}

async function runLocalWasmAnalysis(game) {
  if (!window.ReviewMath) throw new Error("ReviewMath failed to load.");
  ReviewMath.purgeStaleReviewCaches(localStorage);

  const cachePrefix = ReviewMath.REVIEW_CACHE_PREFIX;
  const cacheKey = `${cachePrefix}${game.url || game.id || "pgn"}_${state.analysisMode}`;
  if (!state.forceReanalyze) {
    const cached = localStorage.getItem(cacheKey);
    if (cached) {
      try {
        state.result = JSON.parse(cached);
        state.fromCache = true;
        renderAnalysis(state.result);
        return;
      } catch (_) {
        localStorage.removeItem(cacheKey);
      }
    }
  }
  state.fromCache = false;
  state.forceReanalyze = false;

  analysisInProgress = true;
  try {
    await runLocalWasmAnalysisUncached(game, cacheKey);
  } finally {
    analysisInProgress = false;
  }
  // Live eval is skipped while the review owns the worker, so the position the
  // review just opened on has no engine lines yet — fetch them now.
  if (state.result && state.chess) triggerLiveEvaluation(state.chess.fen());
}

async function runLocalWasmAnalysisUncached(game, cacheKey) {

  // Parse clock comments from PGN (e.g. [%clk 0:02:59])
  const clkMatches = [];
  const clkRegex = /\[%clk\s+([0-9:]+(?:\.[0-9]+)?)\]/g;
  let match;
  while ((match = clkRegex.exec(game.pgn)) !== null) {
    clkMatches.push(match[1]);
  }

  const chessInstance = new Chess();
  if (!chessInstance.load_pgn(game.pgn)) {
    throw new Error("Failed to parse PGN.");
  }
  const moves = chessInstance.history({ verbose: true });
  const totalMoves = moves.length;
  setLoadingProgress(0, totalMoves);
  initLoadingBoard(game);

  const worker = await getStockfishWorker();
  // Fresh TT for a new game; keep the same worker so Hash warms across plies.
  worker.postMessage("ucinewgame");
  worker.postMessage("setoption name MultiPV value 3");

  const { depth: depthLimit, movetime: timeLimit } = analysisLimitsForMode(state.analysisMode);
  const startedAt = performance.now();

  const movesData = [];
  const whiteAccEntries = [];
  const blackAccEntries = [];

  const board = new Chess();

  let lastEval = await evaluateFen(worker, board.fen(), timeLimit, 3, depthLimit);
  let prevCls = null;

  for (let i = 0; i < totalMoves; i++) {
    if (analysisAbort.cancelled) {
      throw new Error("cancelled");
    }
    const m = moves[i];
    const isWhite = m.color === "w";
    const san = m.san;
    const uci = m.from + m.to + (m.promotion || "");

    let bestSan = null;
    if (lastEval && lastEval.hasPv && lastEval.bestMove) {
      const from = lastEval.bestMove.slice(0, 2);
      const to = lastEval.bestMove.slice(2, 4);
      const promo = lastEval.bestMove[4] || undefined;
      const tempChess = new Chess(board.fen());
      const tempMove = tempChess.move({ from, to, promotion: promo });
      if (tempMove) bestSan = tempMove.san;
    }

    const fenBefore = board.fen();
    const beforeBoard = new Chess(fenBefore);
    board.move(m);
    const postFen = board.fen();
    const afterBoard = new Chess(postFen);

    const evalData = await evaluateFen(worker, postFen, timeLimit, 3, depthLimit);

    // score fields are STM-relative CP (mates already synthesized in evaluateFen).
    // Before move: STM = mover. After move: STM = opponent → negate for mover / White POV.
    const scoreBeforeWhite = ReviewMath.stmCpToWhite(lastEval.score, isWhite);
    const scoreAfterWhite = ReviewMath.stmCpToWhite(evalData.score, !isWhite);
    const cpl = Math.round(ReviewMath.cplFromStm(lastEval.score, evalData.score));

    const beforeWP = ReviewMath.winPercentForSide(scoreBeforeWhite, isWhite);
    const afterWP = ReviewMath.winPercentForSide(scoreAfterWhite, isWhite);
    const moveAcc = ReviewMath.moveAccuracyFromWinPercents(beforeWP, afterWP);

    // Only trust "Best" when we actually saw a PV (mirrors server has_pv guard).
    const isBest = !!(lastEval.hasPv && lastEval.bestMove && uci === lastEval.bestMove);

    // MultiPV gap at the pre-move position (both scores STM = mover)
    let onlyMoveGap = 0;
    if (lastEval.pvs && lastEval.pvs[1]) {
      const pv1WP = ReviewMath.cpToWinPercent(lastEval.pvs[0] ? lastEval.pvs[0].score : lastEval.score);
      const pv2WP = ReviewMath.cpToWinPercent(lastEval.pvs[1].score);
      onlyMoveGap = pv1WP - pv2WP;
    }

    const sacrificed = ReviewMath.isMaterialSacrifice(beforeBoard, afterBoard, isWhite);
    const opponentJustBlundered = prevCls === "blunder";
    // before: STM = mover → mate > 0 means we could force mate
    const missedMate = lastEval.mate != null && lastEval.mate > 0 && !isBest;
    // after: STM = opponent → mate > 0 means they can force mate now
    const allowedMate = evalData.mate != null && evalData.mate > 0 &&
      !(lastEval.mate != null && lastEval.mate < 0);

    const cls = ReviewMath.classifyMove({
      beforeWP,
      afterWP,
      isBest,
      onlyMoveGap,
      sacrificed,
      opponentJustBlundered,
      plyIndex: i,
      missedMate,
      allowedMate,
    });

    if (cls !== "book") {
    const accEntry = { acc: moveAcc, beforeWP, plyIndex: i };
    if (isWhite) whiteAccEntries.push(accEntry);
    else blackAccEntries.push(accEntry);
    }

    const wp = ReviewMath.cpToWinPercent(scoreAfterWhite);
    // Mate sign from White's seat: after White moves, STM mate is Black's → flip.
    const mateWhite = evalData.mate == null
      ? null
      : (isWhite ? -evalData.mate : evalData.mate);

    movesData.push({
      idx:           i + 1,
      move_num:      Math.floor(i / 2) + 1,
      san:           san,
      uci:           uci,
      color:         isWhite ? "white" : "black",
      fen:           postFen,
      eval_cp:       scoreAfterWhite,
      eval_str:      formatScore(scoreAfterWhite, mateWhite),
      cpl:           cpl,
      cls:           cls,
      win_prob:      Math.round(wp * 10) / 10,
      move_accuracy: Math.round(moveAcc * 10) / 10,
      is_best:       isBest,
      best_uci:      !isBest && lastEval.hasPv ? lastEval.bestMove : null,
      best_san:      !isBest ? bestSan : null,
      clk:           clkMatches[i] || null,
      depth:         evalData.depth || null,
      // Pre-move alternatives (what could have been played) — for coach / UI session
      candidates:    pvListToEngineLines(lastEval.pvs, fenBefore, isWhite),
      // Post-move MultiPV at the position the user lands on when scrubbing the move list
      engine_lines:  pvListToEngineLines(evalData.pvs, postFen, !isWhite),
      variations:    [],
    });

    prevCls = cls;
    lastEval = evalData;

    setLoadingProgress(i + 1, totalMoves, startedAt);
    if (state.loadingBoard) state.loadingBoard.position(postFen);
  }

  // Keep shared worker warm for the next review / live eval (do not terminate).

  const emptyCounts = () => ({
    brilliant: 0, great: 0, best: 0, excellent: 0, good: 0, book: 0,
    inaccuracy: 0, mistake: 0, miss: 0, blunder: 0,
  });
  const getCounts = (color) => {
    const c = emptyCounts();
    movesData.forEach(m => {
      if (m.color === color && m.cls in c) c[m.cls]++;
    });
    return c;
  };

  const reviewResult = {
    white_player:   game.white,
    black_player:   game.black,
    opening:        game.opening,
    white_accuracy: ReviewMath.gameAccuracyWeighted(whiteAccEntries),
    black_accuracy: ReviewMath.gameAccuracyWeighted(blackAccEntries),
    white_counts:   getCounts("white"),
    black_counts:   getCounts("black"),
    moves:          movesData,
    start_fen:      "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1",
    result:         game.result || "*",
    analysis_meta:  { depth: depthLimit, movetime: timeLimit, engine: "local-stockfish" },
  };

  try {
    localStorage.setItem(cacheKey, JSON.stringify(reviewResult));
  } catch (_) { /* quota */ }

  state.result = reviewResult;
  renderAnalysis(reviewResult);
}

/**
 * Evaluate a FEN. Returns side-to-move relative score (mates → synthetic CP),
 * mate ply if any, best move, hasPv flag, and optional MultiPV lines.
 */
function evaluateFen(worker, fen, timeLimit, multipv = 1, depth = 15) {
  return new Promise((resolve, reject) => {
    const pvs = [];
    let bestMove = "";
    let hasPv = false;
    let score = 0;
    let mate = null;
    let reachedDepth = 0;
    const hardTimeout = setTimeout(() => {
      try { worker.postMessage("stop"); } catch (_) {}
    }, Math.max(timeLimit * 3, 5000));

    const onMsg = (e) => {
      const line = e.data;
      if (typeof line !== "string") return;
      if (line.startsWith("info depth")) {
        const depthMatch = line.match(/\bdepth (\d+)/);
        if (depthMatch) reachedDepth = Math.max(reachedDepth, parseInt(depthMatch[1], 10));

        const multipvMatch = line.match(/multipv (\d+)/);
        const rank = multipvMatch ? parseInt(multipvMatch[1], 10) - 1 : 0;

        let lineScore = null;
        let lineMate = null;
        const mateMatch = line.match(/score mate (-?\d+)/);
        const cpMatch = line.match(/score cp (-?\d+)/);
        if (mateMatch) {
          lineMate = parseInt(mateMatch[1], 10);
          lineScore = ReviewMath.stmToCp(0, lineMate);
        } else if (cpMatch) {
          lineMate = null;
          lineScore = ReviewMath.stmToCp(parseInt(cpMatch[1], 10), null);
        }

        const pvMatch = line.match(/ pv ([a-h][1-8][a-h][1-8][qrbn]?)/);
        const pvUci = pvMatch ? pvMatch[1] : "";

        if (lineScore != null && (pvUci || multipvMatch)) {
          pvs[rank] = { uci: pvUci, score: lineScore, mate: lineMate, depth: reachedDepth };
        }

        if (rank === 0 && lineScore != null) {
          score = lineScore;
          mate = lineMate;
          if (pvUci) {
            bestMove = pvUci;
            hasPv = true;
          }
        }
      } else if (line.startsWith("bestmove")) {
        clearTimeout(hardTimeout);
        worker.removeEventListener("message", onMsg);
        const bm = line.split(" ")[1];
        const finalBest = bestMove || (bm && bm !== "(none)" ? bm : "");
        resolve({
          score,
          mate,
          bestMove: finalBest,
          hasPv,
          depth: reachedDepth,
          pvs: pvs.filter(Boolean),
        });
      }
    };

    worker.addEventListener("message", onMsg);
    try {
      if (multipv > 1) worker.postMessage("setoption name MultiPV value " + multipv);
      worker.postMessage("position fen " + fen);
      // Prefer reaching depth; movetime is only a cap.
      worker.postMessage("go depth " + depth + " movetime " + timeLimit);
    } catch (err) {
      clearTimeout(hardTimeout);
      worker.removeEventListener("message", onMsg);
      resetSharedStockfishWorker();
      reject(err);
    }
  });
}

function classifyCpl(cpl, isBest) {
  return ReviewMath.classifyCpl(cpl, isBest);
}

function winProb(cp) {
  return ReviewMath.cpToWinPercent(cp);
}

function calculateAccuracy(cpls) {
  return ReviewMath.calculateAccuracyFromCpls(cpls);
}

function formatScore(cp, mate) {
  if (mate != null) {
    // mate 0 = the side to move is already checkmated: show the result, not "-M0"
    if (mate === 0) return cp >= 0 ? "1-0" : "0-1";
    return mate > 0 ? `M${mate}` : `-M${Math.abs(mate)}`;
  }
  return (cp / 100 >= 0 ? "+" : "") + (cp / 100).toFixed(1);
}

async function runLocalWasmLiveEval(fen) {
  // Shared worker is owned by full-game review while analysisInProgress.
  if (analysisInProgress) return;

  const linesList = $("engine-lines-list");
  const seq = ++liveEvalSeq;

  // Nothing to search once the game is over — say so instead of "no lines found"
  const over = gameOverLabel(fen);
  if (over) {
    state.liveEvalLines = [];
    linesList.innerHTML = `<div class="engine-line-item empty">${over}</div>`;
    return;
  }

  // Lines cached from the review for this exact position stay on screen while the
  // live search runs; anything else is stale and gets the placeholder.
  if (linesList.dataset.fen !== fen) {
    linesList.innerHTML = `<div class="engine-line-item empty">Engine thinking…</div>`;
  }

  const worker = await getStockfishWorker();

  const { depth, movetime } = analysisLimitsForMode(state.analysisMode || "normal");
  // evaluateMultiPV stops any in-flight search and waits its turn
  const rawLines = await evaluateMultiPV(worker, fen, Math.min(depth, 14), Math.min(movetime, 400));
  if (seq !== liveEvalSeq) return; // superseded by a newer live eval
  const lines = liveLinesForDisplay(rawLines, fen);
  linesList.dataset.fen = fen;

  state.liveEvalLines = lines;
  renderEngineLines(lines);
  updateCoachBubbleWithLiveEval(lines);

  if ($("chk-show-arrows").checked && !state.result) {
    drawEngineArrows(lines);
  } else if (state.result) {
    drawReviewArrows();
  } else {
    const oldSvg = document.getElementById("board-arrows-svg");
    if (oldSvg) oldSvg.remove();
  }
}

/**
 * Live MultiPV search. Calls are serialised on one worker: "stop" makes
 * Stockfish answer with a bestmove for the *old* search, so a listener attached
 * before that arrives would report the previous position's lines as its own.
 * A request that has been superseded by the time its turn comes is skipped.
 */
function evaluateMultiPV(worker, fen, depth, timeLimit) {
  const token = ++liveEvalToken;
  try { worker.postMessage("stop"); } catch (_) {}
  const run = () => (token === liveEvalToken ? searchMultiPV(worker, fen, depth, timeLimit) : Promise.resolve([]));
  liveEvalChain = liveEvalChain.then(run, run);
  return liveEvalChain;
}

function searchMultiPV(worker, fen, depth, timeLimit) {
  return new Promise(resolve => {
    let pvs = [];
    
    const onMsg = (e) => {
      const line = e.data;
      if (typeof line !== "string") return;
      if (line.startsWith("info depth")) {
        const multipvMatch = line.match(/multipv (\d+)/);
        if (multipvMatch) {
          const rank = parseInt(multipvMatch[1]) - 1;
          
          let score = 0;
          let mate = null;
          const cpMatch = line.match(/score cp (-?\d+)/);
          if (cpMatch) score = parseInt(cpMatch[1]);
          const mateMatch = line.match(/score mate (-?\d+)/);
          if (mateMatch) mate = parseInt(mateMatch[1]);
          
          // Full principal variation, e.g. " pv e2e4 e7e5 g1f3"
          const pvMatch = line.match(/ pv ((?:[a-h][1-8][a-h][1-8][qrbn]?\s*)+)/);
          const pvMoves = pvMatch ? pvMatch[1].trim().split(/\s+/) : [];

          if (pvMoves.length) {
            // Raw side-to-move values; liveLinesForDisplay() turns these into SAN + White-POV scores
            pvs[rank] = { uci: pvMoves[0], pv: pvMoves, score, mate };
          }
        }
      } else if (line.startsWith("bestmove")) {
        worker.removeEventListener("message", onMsg);
        clearTimeout(bail);
        const sorted = pvs.filter(x => x !== undefined).slice(0, 3);
        resolve(sorted);
      }
    };

    // If the worker never answers, give up rather than block every later search
    const bail = setTimeout(() => {
      worker.removeEventListener("message", onMsg);
      resolve(pvs.filter(x => x !== undefined).slice(0, 3));
    }, Math.max(timeLimit * 3, 3000));

    worker.addEventListener("message", onMsg);
    worker.postMessage("setoption name MultiPV value 3");
    worker.postMessage("position fen " + fen);
    worker.postMessage("go depth " + depth + " movetime " + timeLimit);
  });
}

// ── Clocks, Captured Pieces, Flags, and Summary Pills Helpers ──

function timeStrToSeconds(str) {
  if (!str) return 0;
  const parts = str.split(":");
  let secs = 0;
  if (parts.length === 3) {
    secs += parseInt(parts[0]) * 3600 + parseInt(parts[1]) * 60 + parseFloat(parts[2]);
  } else if (parts.length === 2) {
    secs += parseInt(parts[0]) * 60 + parseFloat(parts[1]);
  } else {
    secs += parseFloat(parts[0]);
  }
  return secs;
}

function calculateMoveDurations(moves, timeControl) {
  const startingTime = parseInt(timeControl) || 600; // default 10 minutes
  let lastWhiteClk = startingTime;
  let lastBlackClk = startingTime;
  
  moves.forEach((move, i) => {
    if (!move.clk) {
      move.duration = null;
      return;
    }
    const currentClk = timeStrToSeconds(move.clk);
    if (move.color === "white") {
      move.duration = Math.max(0.1, lastWhiteClk - currentClk);
      lastWhiteClk = currentClk;
    } else {
      move.duration = Math.max(0.1, lastBlackClk - currentClk);
      lastBlackClk = currentClk;
    }
  });
}

function formatDuration(secs) {
  if (secs < 60) {
    return secs.toFixed(1) + "s";
  }
  const m = Math.floor(secs / 60);
  const s = Math.round(secs % 60);
  return `${m}m ${s}s`;
}

function getFlagEmoji(countryCode) {
  if (!countryCode) return "";
  const codePoints = countryCode
    .toUpperCase()
    .split('')
    .map(char => 127397 + char.charCodeAt(0));
  return String.fromCodePoint(...codePoints);
}

async function fetchPlayerFlags(whiteName, blackName) {
  try {
    const [whiteRes, blackRes] = await Promise.all([
      fetch(`https://api.chess.com/pub/player/${encodeURIComponent(whiteName)}`).then(r => r.json()).catch(() => null),
      fetch(`https://api.chess.com/pub/player/${encodeURIComponent(blackName)}`).then(r => r.json()).catch(() => null)
    ]);
    
    if (whiteRes && whiteRes.country) {
      const code = whiteRes.country.split("/").pop();
      state.playerFlags.white = getFlagEmoji(code);
    }
    if (blackRes && blackRes.country) {
      const code = blackRes.country.split("/").pop();
      state.playerFlags.black = getFlagEmoji(code);
    }
    
    // Show the country flags next to the names. Only the player bars are redrawn:
    // a full renderAnalysis() here used to snap the board back to the start and
    // reopen the Review tab a moment after the user had begun stepping through.
    if (state.result) {
      renderPlayerBars(state.result);
    }
  } catch (e) {
    console.warn("Error fetching Chess.com profiles:", e);
  }
}

function updateCapturedPieces(fen) {
  const piecePart = fen.split(" ")[0];
  const counts = {
    P: 0, N: 0, B: 0, R: 0, Q: 0,
    p: 0, n: 0, b: 0, r: 0, q: 0
  };
  for (let char of piecePart) {
    if (char in counts) counts[char]++;
  }

  const lostWhite = {
    Q: Math.max(0, 1 - counts.Q),
    R: Math.max(0, 2 - counts.R),
    B: Math.max(0, 2 - counts.B),
    N: Math.max(0, 2 - counts.N),
    P: Math.max(0, 8 - counts.P)
  };

  const lostBlack = {
    q: Math.max(0, 1 - counts.q),
    r: Math.max(0, 2 - counts.r),
    b: Math.max(0, 2 - counts.b),
    n: Math.max(0, 2 - counts.n),
    p: Math.max(0, 8 - counts.p)
  };

  let whiteVal = lostBlack.p*1 + lostBlack.n*3 + lostBlack.b*3 + lostBlack.r*5 + lostBlack.q*9;
  let blackVal = lostWhite.P*1 + lostWhite.N*3 + lostWhite.B*3 + lostWhite.R*5 + lostWhite.Q*9;

  const isWhite = state.currentGame.player_color === "White";
  const topColor = isWhite ? "black" : "white";
  
  const topLost = topColor === "black" ? lostWhite : lostBlack;
  const topSymbols = topColor === "black" ? { P: '♙', N: '♘', B: '♗', R: '♖', Q: '♕' } : { p: '♟', n: '♞', b: '♝', r: '♜', q: '♛' };
  const topAdv = topColor === "black" ? (blackVal - whiteVal) : (whiteVal - blackVal);
  renderCapturedBox("player-top-captured", topLost, topSymbols, topAdv);

  const botLost = topColor === "black" ? lostBlack : lostWhite;
  const botSymbols = topColor === "black" ? { p: '♟', n: '♞', b: '♝', r: '♜', q: '♛' } : { P: '♙', N: '♘', B: '♗', R: '♖', Q: '♕' };
  const botAdv = topColor === "black" ? (whiteVal - blackVal) : (blackVal - whiteVal);
  renderCapturedBox("player-bottom-captured", botLost, botSymbols, botAdv);
}

function renderCapturedBox(elId, lost, symbols, adv) {
  const el = $(elId);
  if (!el) return;
  el.innerHTML = "";

  const order = ['Q', 'R', 'B', 'N', 'P'];
  order.reverse().forEach(key => {
    const count = lost[key];
    const sym = symbols[key.toLowerCase()] || symbols[key.toUpperCase()];
    for (let i = 0; i < count; i++) {
      const span = document.createElement("span");
      span.className = "captured-piece";
      span.textContent = sym;
      el.appendChild(span);
    }
  });

  if (adv > 0) {
    const pill = document.createElement("span");
    pill.className = "material-adv-pill";
    pill.textContent = `+${adv}`;
    el.appendChild(pill);
  }
}

function updateClocks(idx) {
  const moves = getActiveMoves();
  const topClock = $("clock-top");
  const bottomClock = $("clock-bottom");
  if (!topClock || !bottomClock) return;

  if (idx === -1) {
    topClock.classList.add("hidden");
    bottomClock.classList.add("hidden");
    return;
  }

  let whiteClk = null;
  let blackClk = null;
  for (let i = 0; i <= idx; i++) {
    if (moves[i].clk) {
      if (moves[i].color === "white") whiteClk = moves[i].clk;
      else blackClk = moves[i].clk;
    }
  }

  if (!whiteClk && !blackClk) {
    topClock.classList.add("hidden");
    bottomClock.classList.add("hidden");
    return;
  }

  topClock.classList.remove("hidden");
  bottomClock.classList.remove("hidden");

  const isWhite = state.currentGame.player_color === "White";
  const topColor = isWhite ? "black" : "white";

  function formatClock(clkStr) {
    if (!clkStr) return "--:--";
    if (clkStr.startsWith("0:")) return clkStr.slice(2);
    return clkStr;
  }

  const topClkVal = topColor === "black" ? blackClk : whiteClk;
  const botClkVal = topColor === "black" ? whiteClk : blackClk;

  topClock.textContent = formatClock(topClkVal);
  bottomClock.textContent = formatClock(botClkVal);

  const currentMove = moves[idx];
  const nextTurn = currentMove.color === "white" ? "black" : "white";
  
  if (nextTurn === topColor) {
    topClock.classList.add("active");
    bottomClock.classList.remove("active");
  } else {
    bottomClock.classList.add("active");
    topClock.classList.remove("active");
  }
}

function updateCoachBubbleWithLiveEval(lines) {
  if (!lines || !lines.length) return;
  const moves = getActiveMoves();
  const move = moves[state.moveIndex];
  const isVar = state.currentVariationPath && state.currentVariationPath.length > 0;
  const hasNoCls = !move || !move.cls;
  
  if (isVar || hasNoCls) {
    const topLine = lines[0];
    const evalStr = topLine.score;
    const bestMove = topLine.san;
    
    // Update live evaluation bar (Rating Bar)
    // Local WASM lines are already White-POV; server lines are side-to-move and need flipping
    const isWhiteTurn = state.chess ? state.chess.turn() === 'w' : true;
    let cpWhite = topLine.cp;
    let evalStrWhite = evalStr;
    if (!isWhiteTurn && !topLine.whitePov) {
      cpWhite = -cpWhite;
      if (evalStrWhite.startsWith("+")) {
        evalStrWhite = "-" + evalStrWhite.slice(1);
      } else if (evalStrWhite.startsWith("-")) {
        evalStrWhite = "+" + evalStrWhite.slice(1);
      } else if (evalStrWhite.startsWith("#M")) {
        evalStrWhite = "-#M" + evalStrWhite.slice(3);
      } else if (evalStrWhite.startsWith("-#M")) {
        evalStrWhite = "#M" + evalStrWhite.slice(3);
      }
    }
    updateEvalBar(cpWhite, evalStrWhite);

    // At the start of the main line the coach shows the review summary — keep it
    if (!move && !isVar) return;

    setCoachContent({
      hidden: false,
      badgeText: "🔍",
      title: `Analysis · ${evalStr}`,
      html: move
        ? `You played <b>${escapeHtml(move.san)}</b>. Stockfish evaluates this position at <b>${escapeHtml(evalStr)}</b>. The best reply is <b>${escapeHtml(bestMove)}</b>.`
        : `Stockfish evaluates this position at <b>${escapeHtml(evalStr)}</b>. The best move is <b>${escapeHtml(bestMove)}</b>.`,
    });
  }
}

// ── Onboarding Authentication & Lobby Navigation ──
function enterPlayLobby() {
  const phone = localStorage.getItem("userPhone");
  if (!phone) return;

  const playProfileTag = $("play-profile-tag");
  if (playProfileTag) {
    playProfileTag.classList.remove("hidden");
    $("play-profile-avatar").textContent = phone[0]?.toUpperCase() || "?";
    $("play-profile-name").textContent = phone;
  }

  loadPendingChallenges();
  showView("view-play");
}

function initPhoneAuth() {
  const phone = localStorage.getItem("userPhone");
  if (phone) {
    loadUserSavedGames();
    loadPendingChallenges();
  }

  // Home Screen: "Play on Call" routing
  const homePlayBtn = $("btn-home-play");
  if (homePlayBtn) {
    homePlayBtn.addEventListener("click", () => {
      const activePhone = localStorage.getItem("userPhone");
      if (!activePhone) {
        window.authRedirectView = "view-play";
        resetAuthOverlay();
        $("auth-overlay").classList.remove("hidden");
      } else {
        enterPlayLobby();
      }
    });
  }

  // Play Lobby Lobby: Back to home
  const playBackBtn = $("play-back");
  if (playBackBtn) {
    playBackBtn.addEventListener("click", () => {
      showView("view-home");
    });
  }

  function resetAuthOverlay() {
    $("input-phone").value = "";
    const otpInput = $("input-otp");
    if (otpInput) otpInput.value = "";
    
    const phoneGroup = $("auth-phone-group");
    if (phoneGroup) phoneGroup.classList.remove("hidden");
    const otpGroup = $("auth-otp-group");
    if (otpGroup) otpGroup.classList.add("hidden");
    
    const submitBtn = $("btn-submit-auth");
    if (submitBtn) submitBtn.classList.remove("hidden");
    const verifyBtn = $("btn-verify-auth");
    if (verifyBtn) verifyBtn.classList.add("hidden");
    
    const instruction = $("auth-instruction");
    if (instruction) instruction.textContent = "Enter your phone number to automatically save, sync, and review your games across web & voice.";
  }

  // Auth Submit
  $("btn-submit-auth").addEventListener("click", async () => {
    const rawPhone = $("input-phone").value.trim();
    if (!rawPhone) return alert("Please enter your phone number.");

    try {
      const res = await fetch("/api/auth", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ phone: rawPhone })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Authentication failed");

      $("auth-phone-group").classList.add("hidden");
      $("auth-otp-group").classList.remove("hidden");
      $("btn-submit-auth").classList.add("hidden");
      $("btn-verify-auth").classList.remove("hidden");
      
      let msg = "We sent a 6-digit verification code to your number. Please enter it below.";
      if (data.mock) {
        msg += " (Mock Mode: check server console or use '123456')";
      }
      $("auth-instruction").textContent = msg;
    } catch (err) {
      alert("Error: " + err.message);
    }
  });

  // Verify Auth OTP
  $("btn-verify-auth").addEventListener("click", async () => {
    const rawPhone = $("input-phone").value.trim();
    const rawOtp = $("input-otp").value.trim();
    if (!rawPhone || !rawOtp) return alert("Please enter both phone number and verification code.");

    try {
      const res = await fetch("/api/auth/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ phone: rawPhone, code: rawOtp })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Verification failed");

      localStorage.setItem("userPhone", data.phone);
      localStorage.setItem("sessionToken", data.token);
      $("auth-overlay").classList.add("hidden");

      if (window.authRedirectView === "view-play") {
        window.authRedirectView = null;
        enterPlayLobby();
      } else if (window.authRedirectView === "voice-tab") {
        window.authRedirectView = null;
        loadUserSavedGames();
      } else {
        loadUserSavedGames();
        loadPendingChallenges();
      }
    } catch (err) {
      alert("Error: " + err.message);
    }
  });

  // Auth Cancel
  const cancelAuthBtn = $("btn-cancel-auth");
  if (cancelAuthBtn) {
    cancelAuthBtn.addEventListener("click", () => {
      window.authRedirectView = null;
      $("auth-overlay").classList.add("hidden");
    });
  }

  // Games view: category toggle tabs
  const gamesTabs = document.querySelectorAll(".games-tab");
  gamesTabs.forEach(tab => {
    tab.addEventListener("click", () => {
      gamesTabs.forEach(t => t.classList.remove("active"));
      tab.classList.add("active");

      const tabName = tab.dataset.gamestab;
      if (tabName === "chesscom") {
        $("group-chesscom-games").classList.remove("hidden");
        $("group-voice-games").classList.add("hidden");
      } else if (tabName === "voice") {
        $("group-chesscom-games").classList.add("hidden");
        $("group-voice-games").classList.remove("hidden");

        const activePhone = localStorage.getItem("userPhone");
        if (!activePhone) {
          window.authRedirectView = "voice-tab";
          resetAuthOverlay();
          $("auth-overlay").classList.remove("hidden");
        } else {
          loadUserSavedGames();
        }
      }
    });
  });

  initPvpChallengeUI();
  // Incoming challenges can arrive at any time, not just on this page load.
  setInterval(loadPendingChallenges, 45000);
}

// ── PvP Challenge UI ──
function initPvpChallengeUI() {
  const btn = $("btn-send-challenge");
  if (!btn) return;

  btn.addEventListener("click", async () => {
    const phone = localStorage.getItem("userPhone");
    const opponentInput = $("pvp-opponent-phone");
    const opponentPhone = opponentInput.value.trim();
    const statusEl = $("pvp-challenge-status");
    if (!phone) return alert("Please sign in with your phone number first.");
    if (!opponentPhone) return alert("Please enter an opponent phone number.");

    statusEl.classList.remove("hidden");
    statusEl.textContent = "Sending challenge…";

    try {
      const token = localStorage.getItem("sessionToken") || "";
      const res = await fetch("/api/voice/challenge", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${token}`
        },
        body: JSON.stringify({ phone, opponent_phone: opponentPhone })
      });
      const data = await res.json();
      if (!res.ok || data.error) throw new Error(data.error || "Failed to send challenge");

      statusEl.textContent = "Challenge sent! Call in as White to make your first move.";
      opponentInput.value = "";
    } catch (err) {
      statusEl.textContent = "Error: " + err.message;
    }
  });
}

async function loadPendingChallenges() {
  const phone = localStorage.getItem("userPhone");
  const container = $("pvp-pending-list");
  if (!phone || !container) return;

  try {
    const token = localStorage.getItem("sessionToken") || "";
    const res = await fetch(`/api/voice/pending_challenges?phone=${phone}`, {
      headers: {
        "Authorization": `Bearer ${token}`
      }
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Failed to load challenges");

    const challenges = data.challenges || [];
    if (!challenges.length) {
      container.innerHTML = `<div class="pvp-pending-item empty">No incoming challenges right now.</div>`;
      return;
    }

    container.innerHTML = challenges.map(c => `
      <div class="pvp-pending-item" data-game-id="${c.game_id}">
        <span>📞 ${c.from_phone} challenged you</span>
        <div class="pvp-pending-actions">
          <button class="pvp-accept" data-action="accept">Accept</button>
          <button data-action="decline">Decline</button>
        </div>
      </div>
    `).join("");

    container.querySelectorAll(".pvp-pending-item").forEach(item => {
      const gameId = item.dataset.gameId;
      item.querySelector('[data-action="accept"]').addEventListener("click", () => {
        // Accepting just means calling in as yourself — find_active_live_game resolves
        // the pending pvp game by phone automatically, no game_id needed on this path.
        startVoiceCall();
      });
      item.querySelector('[data-action="decline"]').addEventListener("click", async () => {
        try {
          const token = localStorage.getItem("sessionToken") || "";
          await fetch("/api/voice/decline_challenge", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "Authorization": `Bearer ${token}`
            },
            body: JSON.stringify({ game_id: gameId, phone })
          });
          loadPendingChallenges();
        } catch (err) {
          alert("Error declining challenge: " + err.message);
        }
      });
    });
  } catch (err) {
    container.innerHTML = `<div class="pvp-pending-item empty">Error loading challenges: ${err.message}</div>`;
  }
}

// ── Load Saved Games History ──
async function loadUserSavedGames() {
  const phone = localStorage.getItem("userPhone");
  if (!phone) return;

  const container = $("saved-games-list");
  if (!container) return;

  try {
    const token = localStorage.getItem("sessionToken") || "";
    const res = await fetch(`/api/games?phone=${phone}`, {
      headers: {
        "Authorization": `Bearer ${token}`
      }
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Failed to load games");

    const games = data.games || [];
    if (!games.length) {
      container.innerHTML = `<div class="game-history-item empty">No saved games found. Start a game or analysis to save one!</div>`;
      return;
    }

    container.innerHTML = games.map(g => {
      const date = new Date(g.created_at).toLocaleDateString();
      const result = g.result === "1-0" ? "White won" : g.result === "0-1" ? "Black won" : g.result === "1/2-1/2" ? "Draw" : "Ongoing";
      return `
        <div class="game-history-item" data-pgn="${encodeURIComponent(g.pgn)}" data-id="${g.id}">
          <div class="game-item-players">⚔️ ${escapeHtml(g.white_player)} vs ${escapeHtml(g.black_player)}</div>
          <div class="game-item-meta">
            <span>📅 ${date}</span>
            <span>🏁 ${result}</span>
          </div>
          <div class="game-item-accs">
            <span class="game-acc-val game-acc-white">W: ${Math.round(g.white_accuracy)}%</span>
            <span class="game-acc-val game-acc-black">B: ${Math.round(g.black_accuracy)}%</span>
          </div>
        </div>
      `;
    }).join("");

    // Add click listeners to load game
    container.querySelectorAll(".game-history-item").forEach(item => {
      item.addEventListener("click", () => {
        if (item.dataset.id) loadGameById(item.dataset.id);
      });
    });

  } catch (err) {
    container.innerHTML = `<div class="game-history-item empty">Error loading games: ${err.message}</div>`;
  }
}

// Loads any game by id (saved-games list, or a shared "?game=" review link) — sets
// state.currentGame first since renderAnalysis() reads g.player_color/time_control/
// opening off it immediately, and would throw on a null currentGame otherwise.
async function loadGameById(gameId) {
  try {
    const res = await fetch(`/api/game/${gameId}`);
    const data = await res.json();
    if (!res.ok || data.error) throw new Error(data.error || "Game not found");

    state.currentGame = {
      white_player: data.white_player,
      black_player: data.black_player,
      player_color: "White",
      result: data.result,
      time_control: "",
      opening: data.opening || "Unknown Opening",
    };
    showView("view-analysis");
    loadPgnGame(data.pgn, gameId);
  } catch (err) {
    alert("Error loading game: " + err.message);
  }
}

function loadPgnGame(pgn, gameId = null) {
  const phone = localStorage.getItem("userPhone") || "";
  const token = localStorage.getItem("sessionToken") || "";
  const bodyData = { pgn: pgn, mode: state.analysisMode, phone: phone, token: token };
  if (gameId) {
    bodyData.game_id = gameId;
  }
  fetch("/api/analyze", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(bodyData)
  })
  .then(res => res.json())
  .then(data => {
    if (data.error) throw new Error(data.error);
    pollAnalysis(data.task_id);
  })
  .catch(err => {
    alert("Error loading game: " + err.message);
  });
}

// ── Web Speech API microphone call flow ──
let speechRecognition = null;
let isCallMuted = false;
let isCallActive = false;
let currentCallPhone = "";
let currentBotElo = "1500";
let currentPersonality = "formal";

// Tracks where the NEXT input should be sent and whether a menu (promotion/disambiguation)
// is currently pending — a real Twilio call just waits on the <Gather> for this, but the
// browser simulation has to orchestrate it manually since there's no live call underneath.
let currentGatherAction = "/api/voice/process_move";
let pendingChoiceActive = false;

function applyTwimlState(xmlText) {
  const parser = new DOMParser();
  const xmlDoc = parser.parseFromString(xmlText, "application/xml");
  const gatherNode = xmlDoc.querySelector("Gather");
  currentGatherAction = gatherNode?.getAttribute("action") || "/api/voice/process_move";

  const sayText = xmlDoc.querySelector("Say")?.textContent || "";
  // The disambiguation prompt always starts with "Which <piece>?" (see process_voice_move);
  // promotion prompts route to their own dedicated action — either signals a pending menu.
  pendingChoiceActive = currentGatherAction.includes("process_promotion") || /^Which /i.test(sayText.trim());

  const actionRow = $("call-action-buttons");
  if (actionRow) {
    actionRow.querySelectorAll("button").forEach(b => b.disabled = pendingChoiceActive);
  }
  return sayText;
}

function initVoiceCall() {
  // btn-games-call lives on the games list page; the other two are on the analysis board.
  const callButtons = ["btn-desktop-call", "btn-mobile-call", "btn-games-call"];
  callButtons.forEach(id => {
    const btn = $(id);
    if (btn) {
      btn.addEventListener("click", () => {
        startVoiceCall();
      });
    }
  });

  const hangupBtn = $("btn-call-hangup");
  if (hangupBtn) {
    hangupBtn.addEventListener("click", () => {
      endVoiceCall();
    });
  }

  const muteBtn = $("btn-call-mute");
  if (muteBtn) {
    muteBtn.addEventListener("click", () => {
      toggleCallMute();
    });
  }

  // On-screen equivalents of the phone-keypad shortcuts, for callers with no keypad.
  const resignBtn = $("btn-call-resign");
  if (resignBtn) resignBtn.addEventListener("click", () => { if (!pendingChoiceActive) sendMoveToVoiceBackend("resign"); });
  const drawBtn = $("btn-call-draw");
  if (drawBtn) drawBtn.addEventListener("click", () => { if (!pendingChoiceActive) sendMoveToVoiceBackend("draw"); });
  const takebackBtn = $("btn-call-takeback");
  if (takebackBtn) takebackBtn.addEventListener("click", () => { if (!pendingChoiceActive) sendMoveToVoiceBackend("takeback"); });

  // Text-input fallback for browsers/devices without SpeechRecognition (e.g. iOS/Safari).
  const sendTextBtn = $("btn-call-text-send");
  const textInput = $("call-text-input");
  const submitTypedMove = () => {
    const value = textInput.value.trim();
    if (!value) return;
    sendMoveToVoiceBackend(value);
    textInput.value = "";
  };
  if (sendTextBtn) sendTextBtn.addEventListener("click", submitTypedMove);
  if (textInput) textInput.addEventListener("keydown", e => { if (e.key === "Enter") submitTypedMove(); });
}

function startVoiceCall() {
  if (isCallActive) return;
  isCallActive = true;
  isCallMuted = false;
  currentGatherAction = "/api/voice/process_move";
  pendingChoiceActive = false;

  const overlay = $("voice-call-overlay");
  overlay.classList.remove("hidden");
  
  const personalitySelect = $("personality-select");
  currentPersonality = personalitySelect ? personalitySelect.value : "formal";
  const botName = "Thara";
  const avatar = "👩🏼‍💼";
  
  $("call-avatar").textContent = avatar;
  $("call-status").textContent = `Calling ${botName}...`;
  $("call-feedback").textContent = '"Ringing..."';

  currentCallPhone = localStorage.getItem("userPhone") || "test_phone";

  speakVoice("dialing bot, connecting", () => {
    connectVoiceCall(botName, currentPersonality);
  });
}

function connectVoiceCall(botName, personality) {
  if (!isCallActive) return;
  $("call-status").textContent = `Connected to ${botName}`;
  $("call-feedback").textContent = '"Connecting to bot..."';

  const formData = new URLSearchParams();
  formData.append("From", currentCallPhone);
  formData.append("force_new", "1");
  formData.append("personality", personality);
  const difficultySelect = $("difficulty-select");
  if (difficultySelect && difficultySelect.value) {
    formData.append("elo", difficultySelect.value);
  }

  fetch("/api/voice", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: formData.toString()
  })
  .then(res => res.text())
  .then(xmlText => {
    if (!isCallActive) return;
    const sayText = applyTwimlState(xmlText) || `Connected to ${botName}`;
    speakVoice(sayText, () => {
      if (xmlText.includes("Hangup")) {
        endVoiceCall();
      } else {
        startSpeechListener();
      }
    });
  })
  .catch(err => {
    console.error("Error connecting to voice backend:", err);
    speakVoice("Error connecting to voice bot.", () => {
      endVoiceCall();
    });
  });
}

function startSpeechListener() {
  if (!isCallActive || isCallMuted) return;

  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechRecognition) {
    // Safari/WebKit (and therefore iOS, including the Capacitor app) has never implemented
    // SpeechRecognition — fall back to typed input instead of leaving the user stuck.
    $("call-feedback").textContent = '"Speech input isn\'t supported here — type your move below."';
    const fallback = $("call-text-fallback");
    if (fallback) {
      fallback.classList.remove("hidden");
      $("call-text-input")?.focus();
    }
    return;
  }

  if (speechRecognition) {
    try { speechRecognition.stop(); } catch(e) {}
  }

  speechRecognition = new SpeechRecognition();
  speechRecognition.continuous = false;
  speechRecognition.interimResults = false;
  speechRecognition.lang = "en-US";

  speechRecognition.onstart = () => {
    $("call-feedback").textContent = '"Listening for your move..."';
  };

  speechRecognition.onerror = (e) => {
    console.log("Speech recognition error:", e);
    if (isCallActive && !isCallMuted && e.error !== "no-speech") {
      setTimeout(startSpeechListener, 1000);
    }
  };

  speechRecognition.onresult = (event) => {
    const transcript = event.results[0][0].transcript;
    $("call-feedback").textContent = `You said: "${transcript}"`;
    sendMoveToVoiceBackend(transcript);
  };

  try {
    speechRecognition.start();
  } catch(e) {
    console.log("Failed to start speech recognition:", e);
  }
}

async function sendMoveToVoiceBackend(speechResult) {
  if (!isCallActive) return;
  $("call-feedback").textContent = '"Processing move..."';

  // Route to wherever the last response actually asked for (normal move entry, or a
  // pending promotion/disambiguation menu) — a real phone call's <Gather> does this
  // automatically; the browser simulation has to track it explicitly.
  const targetAction = currentGatherAction;

  try {
    const formData = new URLSearchParams();
    formData.append("From", currentCallPhone);
    formData.append("SpeechResult", speechResult);
    formData.append("elo", currentBotElo);

    const res = await fetch(targetAction, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: formData.toString()
    });

    const xmlText = await res.text();
    const sayText = applyTwimlState(xmlText) || "I made a move.";

    speakVoice(sayText, () => {
      if (xmlText.includes("Hangup")) {
        endVoiceCall();
      } else if (pendingChoiceActive) {
        // A promotion/disambiguation menu is now open — go straight back to listening
        // for the answer instead of asking the bot for its move, which would otherwise
        // silently clobber the menu prompt.
        startSpeechListener();
      } else {
        triggerStockfishVoiceResponse();
      }
    });

  } catch(e) {
    speakVoice("Error communicating with backend.", () => {
      startSpeechListener();
    });
  }
}

async function triggerStockfishVoiceResponse() {
  if (!isCallActive) return;

  try {
    const formData = new URLSearchParams();
    formData.append("From", currentCallPhone);
    formData.append("elo", currentBotElo);

    const res = await fetch("/api/voice", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: formData.toString()
    });
    const xmlText = await res.text();
    const sayText = applyTwimlState(xmlText);

    if (sayText) {
      speakVoice(sayText, () => {
        if (xmlText.includes("Hangup")) {
          endVoiceCall();
        } else {
          startSpeechListener();
        }
      });
    } else {
      startSpeechListener();
    }

  } catch(e) {
    startSpeechListener();
  }
}

function getSmoothFemaleVoice() {
  const voices = window.speechSynthesis.getVoices();
  const preferences = [
    /Google US English/i,
    /Microsoft Zira/i,
    /Samantha/i,
    /Karen/i,
    /Moira/i,
    /Tessa/i,
    /Susan/i,
    /female/i
  ];
  
  for (const pref of preferences) {
    const match = voices.find(v => pref.test(v.name) && v.lang.startsWith("en"));
    if (match) return match;
  }
  return voices.find(v => v.lang.startsWith("en"));
}

function speakVoice(text, callback) {
  if (!window.speechSynthesis) {
    if (callback) callback();
    return;
  }

  window.speechSynthesis.cancel();
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.lang = "en-US";
  utterance.rate = 1.0;
  
  // Apply a smooth female voice if available
  const femaleVoice = getSmoothFemaleVoice();
  if (femaleVoice) {
    utterance.voice = femaleVoice;
  }
  
  utterance.onend = () => {
    if (callback) callback();
  };
  utterance.onerror = () => {
    if (callback) callback();
  };
  window.speechSynthesis.speak(utterance);
}

function toggleCallMute() {
  isCallMuted = !isCallMuted;
  const muteBtn = $("btn-call-mute");
  if (muteBtn) {
    muteBtn.classList.toggle("muted", isCallMuted);
    muteBtn.textContent = isCallMuted ? "🔇" : "🎙️";
  }
  
  if (isCallMuted) {
    if (speechRecognition) {
      try { speechRecognition.stop(); } catch(e) {}
    }
    $("call-feedback").textContent = '"Muted"';
  } else {
    startSpeechListener();
  }
}

function endVoiceCall() {
  isCallActive = false;
  pendingChoiceActive = false;
  currentGatherAction = "/api/voice/process_move";
  if (speechRecognition) {
    try { speechRecognition.stop(); } catch(e) {}
  }
  if (window.speechSynthesis) {
    window.speechSynthesis.cancel();
  }
  $("voice-call-overlay").classList.add("hidden");
  $("call-text-fallback")?.classList.add("hidden");
  loadUserSavedGames();
}

