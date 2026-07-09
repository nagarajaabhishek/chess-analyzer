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
  showBestArrow: false,
};

let useLocalWasm = false;
let hasBackend = false;

// Classification display config
const CLS = {
  best:       { label: "Best",       color: "#22c55e", symbol: "✓" },
  excellent:  { label: "Excellent",  color: "#4ade80", symbol: "✓" },
  good:       { label: "Good",       color: "#a3e635", symbol: "·" },
  inaccuracy: { label: "Inaccuracy", color: "#fbbf24", symbol: "?!" },
  mistake:    { label: "Mistake",    color: "#f97316", symbol: "?" },
  blunder:    { label: "Blunder",    color: "#ef4444", symbol: "??" },
};

// ── View helpers ───────────────────────────────────────
function showView(id) {
  document.querySelectorAll(".view").forEach(v => {
    v.classList.toggle("hidden", v.id !== id);
    v.classList.toggle("active", v.id === id);
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
  const hashRoutes = {
    "#faq": "/faq",
    "#accessibility": "/accessibility",
    "#blindfold-chess": "/guides/blindfold-chess",
    "#voice-commands": "/guides/voice-commands"
  };

  // Update active state visual indicators on header links
  document.querySelectorAll(".nav-link").forEach(link => {
    const href = link.getAttribute("href");
    link.classList.toggle("active-link", href === hash || (hash === "" && href === "#home") || (hash === "#home" && href === "#home"));
  });

  if (hashRoutes[hash]) {
    loadDynamicContent(hashRoutes[hash]);
  } else if (hash === "#about") {
    showView("view-about");
    window.scrollTo({ top: 0, behavior: "smooth" });
  } else if (hash === "#play") {
    showView("view-play");
    window.scrollTo({ top: 0, behavior: "smooth" });
  } else if (hash === "#analysis") {
    showView("view-analysis");
    window.scrollTo({ top: 0, behavior: "smooth" });
  } else if (hash === "#games") {
    showView("view-games");
    window.scrollTo({ top: 0, behavior: "smooth" });
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
  badge.classList.remove("hidden");
  try {
    const res = await fetch("/api/check");
    const data = await res.json();
    hasBackend = true;
    if (data.ok) {
      useLocalWasm = false;
      badge.className = "sf-badge ok";
      badge.textContent = "✅  Stockfish ready (Local C++)";
    } else {
      useLocalWasm = true;
      badge.className = "sf-badge ok";
      badge.textContent = "✅  Stockfish ready (Local WebAssembly)";
    }
  } catch (_) {
    hasBackend = false;
    useLocalWasm = true;
    badge.className = "sf-badge ok";
    badge.textContent = "✅  Stockfish ready (Local WebAssembly)";
  }
}

async function loadGames() {
  const username = $("username-input").value.trim();
  if (!username) return;

  const btn = $("load-btn");
  const refreshBtn = $("games-refresh");
  const errEl = $("home-error");
  
  errEl.classList.add("hidden");
  btn.disabled = true;
  btn.querySelector(".btn-text").textContent = "Loading…";
  
  if (refreshBtn) {
    refreshBtn.disabled = true;
    refreshBtn.textContent = "⟳ Loading…";
  }

  try {
    let gamesList = [];
    if (hasBackend) {
      const res = await fetch(`/api/games/${encodeURIComponent(username)}`);
      const data = await res.json();
      if (!res.ok || data.error) {
        throw new Error(data.error || "Failed to load games");
      }
      gamesList = data.games;
    } else {
      // Fetch directly from Chess.com public API in browser/Capacitor
      gamesList = await fetchGamesDirect(username, 20);
    }

    state.username = username;
    state.games = gamesList;

    $("header-username").textContent = `♟ ${username}`;
    $("header-username").classList.remove("hidden");

    // Populate new profile button/tag on Games Listing page
    const profileTag = $("games-profile-tag");
    if (profileTag) {
      profileTag.classList.remove("hidden");
      $("games-profile-avatar").textContent = username[0]?.toUpperCase() || "?";
      $("games-profile-name").textContent = username;
    }

    renderGames(gamesList, username);
    showView("view-games");
  } catch (err) {
    errEl.textContent = err.message;
    errEl.classList.remove("hidden");
  } finally {
    btn.disabled = false;
    btn.querySelector(".btn-text").textContent = "Load Games";
    if (refreshBtn) {
      refreshBtn.disabled = false;
      refreshBtn.textContent = "⟳ Refresh";
    }
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

async function startAnalysis(game) {
  state.currentGame = game;
  state.result = null;
  state.moveIndex = -1;
  state.currentVariation = null;

  showView("view-analysis");
  $("btn-main-line").classList.add("hidden");
  $("analysis-loading").classList.remove("hidden");
  $("analysis-result").classList.add("hidden");
  $("meta-opening").textContent = game.opening;
  $("progress-bar").style.width = "0%";
  $("loading-progress").textContent = "Starting…";

  if (useLocalWasm) {
    try {
      await runLocalWasmAnalysis(game);
    } catch (err) {
      alert("Local WebAssembly Analysis failed: " + err.message);
      showView("view-games");
    }
    return;
  }

  try {
    const res = await fetch("/api/analyze", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        pgn:      game.pgn,
        username: state.username,
        mode:     state.analysisMode,
        url:      game.url,
      })
    });
    const { task_id, error } = await res.json();
    if (error) throw new Error(error);
    pollAnalysis(task_id);
  } catch (err) {
    alert("Error starting analysis: " + err.message);
  }
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

  const g = state.currentGame;
  const isWhite = g.player_color === "White";

  // Calculate move durations
  calculateMoveDurations(result.moves, g.time_control);

  // Fetch player country flags
  if (!state.playerFlags || state.playerFlags.whiteName !== result.white_player || state.playerFlags.blackName !== result.black_player) {
    state.playerFlags = { white: "", black: "", whiteName: result.white_player, blackName: result.black_player };
    fetchPlayerFlags(result.white_player, result.black_player);
  }

  // Populate desktop moves classification summary pills
  const counts = isWhite ? result.white_counts : result.black_counts;
  updateSummaryPills(counts);

  // ── Player bars ──────────────────────────────────────
  // Top = opponent, Bottom = player (board default orientation)
  const topColor   = isWhite ? "black" : "white";
  const topName    = isWhite ? result.black_player : result.white_player;
  const topAcc     = isWhite ? result.black_accuracy : result.white_accuracy;
  const topRating  = isWhite ? g.black_rating : g.white_rating;
  const botName    = isWhite ? result.white_player : result.black_player;
  const botAcc     = isWhite ? result.white_accuracy : result.black_accuracy;
  const botRating  = isWhite ? g.white_rating : g.black_rating;

  setupPlayerBar("top",    topColor, topName, topRating, topAcc);
  setupPlayerBar("bottom", isWhite ? "white" : "black", botName, botRating, botAcc);

  // Default to moves tab
  const movesTab = document.querySelector('.sidebar-tab[data-tab="moves"]');
  if (movesTab) movesTab.click();

  // ── Accuracy cards ────────────────────────────────────
  $("acc-white-big").textContent  = result.white_accuracy + "%";
  $("acc-black-big").textContent  = result.black_accuracy + "%";
  $("acc-white-name").textContent = result.white_player;
  $("acc-black-name").textContent = result.black_player;
  renderClsBreakdown("cls-white", result.white_counts);
  renderClsBreakdown("cls-black", result.black_counts);

  // Populate mobile game review metadata
  if ($("mob-info-opening")) $("mob-info-opening").textContent = result.opening || g.opening || "Unknown Opening";
  if ($("mob-info-result")) $("mob-info-result").textContent = g.result || "Draw";
  if ($("mob-info-moves")) $("mob-info-moves").textContent = result.moves.length;

  const grid = $("mob-cls-grid");
  if (grid) {
    const bW = result.white_counts.blunder || 0;
    const bB = result.black_counts.blunder || 0;
    const mW = result.white_counts.mistake || 0;
    const mB = result.black_counts.mistake || 0;
    const iW = result.white_counts.inaccuracy || 0;
    const iB = result.black_counts.inaccuracy || 0;

    grid.innerHTML = `
      <div class="mob-cls-item">
        <div class="mob-cls-num-row">
          <div class="mob-cls-dot" style="background:#ef4444"></div>
          <span>${bW} <span style="font-weight:400;color:var(--text-3)">vs</span> ${bB}</span>
        </div>
        <span class="mob-cls-label">Blunders</span>
      </div>
      <div class="mob-cls-item">
        <div class="mob-cls-num-row">
          <div class="mob-cls-dot" style="background:#f97316"></div>
          <span>${mW} <span style="font-weight:400;color:var(--text-3)">vs</span> ${mB}</span>
        </div>
        <span class="mob-cls-label">Mistakes</span>
      </div>
      <div class="mob-cls-item">
        <div class="mob-cls-num-row">
          <div class="mob-cls-dot" style="background:#fbbf24"></div>
          <span>${iW} <span style="font-weight:400;color:var(--text-3)">vs</span> ${iB}</span>
        </div>
        <span class="mob-cls-label">Inaccuracies</span>
      </div>
    `;
  }

  // ── Board ─────────────────────────────────────────────
  initBoard(isWhite);

  // ── Move list ─────────────────────────────────────────
  renderMoveList(result.moves);

  // ── Chart ─────────────────────────────────────────────
  renderChart(result.moves);

  // ── Set to start position ────────────────────────────
  goToMove(-1);
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

function renderClsBreakdown(elId, counts) {
  const el = $(elId);
  el.innerHTML = Object.entries(counts)
    .filter(([, n]) => n > 0)
    .map(([cls, n]) => `
      <div class="cls-pip">
        <div class="cls-dot" style="background:${CLS[cls]?.color}"></div>
        <span>${n} ${CLS[cls]?.label || cls}</span>
      </div>`)
    .join("");
}

// ── Board ──────────────────────────────────────────────

// Returns optimal board pixel size based on available window width and height to fit screen
function getBoardSize() {
  const isMobile = window.innerWidth <= 900;
  if (isMobile) {
    // Subtract safe margin padding (16px * 2) and eval bar width (22px + gap 8px)
    const availableWidth = window.innerWidth - 32 - 30;
    return Math.max(260, Math.min(availableWidth, 480));
  } else {
    const availableWidth = window.innerWidth - 380 - 20 - 48 - 32;
    // Subtract vertical spacing: header (56px), topbar/padding (~40px), player names and controls (~180px)
    const availableHeight = window.innerHeight - 56 - 40 - 180;
    return Math.max(300, Math.min(availableWidth, availableHeight, 660));
  }
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
  if (state.board && state.result) {
    const size = getBoardSize();
    document.getElementById("board").style.width = size + "px";
    state.board.resize();
    const evalWrap = document.querySelector('.eval-bar-wrap');
    if (evalWrap) evalWrap.style.height = size + 'px';
  }
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
  const active = document.querySelector(".move-cell.active");
  if (container && active) {
    container.scrollTo({
      top: active.offsetTop - container.clientHeight / 2 + active.clientHeight / 2,
      behavior: "smooth"
    });
  }
}

function updateCoachBubble() {
  const panel = $("coach-panel");
  if (!panel) return;

  if (state.moveIndex === -1) {
    panel.classList.remove("hidden");
    $("coach-move-badge").className = "coach-badge";
    $("coach-move-badge").style.background = "#fff";
    $("coach-move-badge").style.color = "#110c07";
    $("coach-move-badge").textContent = "🏁";
    $("coach-move-title").textContent = "Starting Position";
    $("coach-text").textContent = "Analyze this game. Swipe or tap Next to walk through key moments.";
    return;
  }

  const moves = getActiveMoves();
  const move = moves[state.moveIndex];
  if (!move) {
    panel.classList.add("hidden");
    return;
  }

  panel.classList.remove("hidden");
  
  // Set classification details
  const clsInfo = CLS[move.cls];
  const badge = $("coach-move-badge");
  badge.className = `coach-badge`;
  badge.style.background = clsInfo?.color || "var(--text-3)";
  badge.style.color = "#110c07";
  badge.textContent = clsInfo?.badge || "·";
  
  $("coach-move-title").textContent = `${clsInfo?.label || "Move"} · ${move.eval_str || "0.0"}`;
  
  // Generate dynamic coach comments
  let comment = "";
  const sanText = `<b>${move.san}</b>`;
  switch (move.cls) {
    case "book":
      comment = `${sanText} is standard book opening theory. You're following established lines.`;
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
    case "blunder":
      comment = `${sanText} is a blunder!` + (move.best_san ? ` The best move was <b>${move.best_san}</b>.` : "");
      break;
    default:
      comment = `You played ${sanText}. Stockfish evaluates this position at ${move.eval_str}.`;
  }
  
  $("coach-text").innerHTML = comment;
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
    $('move-counter').textContent = `Move ${move.move_num}${move.color === 'black' ? '…' : '.'}`;
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
  triggerLiveEvaluation(fen);
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
  const classesToRemove = [
    "hl-best-from", "hl-best-to",
    "hl-excellent-from", "hl-excellent-to",
    "hl-good-from", "hl-good-to",
    "hl-inaccuracy-from", "hl-inaccuracy-to",
    "hl-mistake-from", "hl-mistake-to",
    "hl-blunder-from", "hl-blunder-to",
    "hl-king-win", "hl-king-lose", "hl-king-draw"
  ];
  document.querySelectorAll("[class*='hl-']").forEach(el => {
    classesToRemove.forEach(c => el.classList.remove(c));
  });

  if (!uci || !cls || uci.length < 4) return;
  const from = uci.slice(0, 2);
  const to   = uci.slice(2, 4);
  const fromEl = document.getElementsByClassName(`square-${from}`)[0];
  const toEl   = document.getElementsByClassName(`square-${to}`)[0];
  if (fromEl) fromEl.classList.add(`hl-${cls}-from`);
  if (toEl)   toEl.classList.add(`hl-${cls}-to`);
}

function updateEvalBar(cpWhite, label) {
  // Map cp to percentage (50% = equal)
  const capped = Math.max(-600, Math.min(600, cpWhite));
  const pct = 50 + (capped / 600) * 45;   // 5%-95% range
  $("eval-bar-fill").style.height = `${pct}%`;
  $("eval-bar-label").textContent = label || "0.0";
}

// ── Live Evaluation (Stockfish 18 MultiPV=3) ────────────────

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
      <span class="line-rank line-rank-${idx + 1}">#${idx + 1}</span>
      <span class="line-move">${m.san}</span>
      <span class="line-eval">${m.score}</span>
    </div>`;
  }).join("");
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
    { name: "blunder",    color: "rgba(239, 68, 68, 0.75)" },   // Red
    { name: "mistake",    color: "rgba(249, 115, 22, 0.7)" },    // Orange
    { name: "inaccuracy", color: "rgba(251, 191, 36, 0.7)" },    // Yellow
    { name: "best",       color: "rgba(34, 197, 94, 0.7)" },     // Green
    { name: "excellent",  color: "rgba(59, 130, 246, 0.7)" },    // Blue
    { name: "book",       color: "rgba(163, 230, 53, 0.7)" },    // Lime
    { name: "good",       color: "rgba(245, 158, 11, 0.55)" },   // Orange/Good
    { name: "best_arrow", color: "rgba(34, 197, 94, 0.8)" }      // Green recommendation
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
      const isBadMove = ["inaccuracy", "mistake", "blunder"].includes(currentMove.cls);
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
  blunder:    "rgba(239, 68, 68, 0.75)",  // Red
  mistake:    "rgba(249, 115, 22, 0.7)",   // Orange
  inaccuracy: "rgba(251, 191, 36, 0.7)",   // Yellow
  best:       "rgba(34, 197, 94, 0.7)",    // Green
  excellent:  "rgba(59, 130, 246, 0.7)",   // Blue
  book:       "rgba(163, 230, 53, 0.7)",   // Light Green/Lime
  good:       "rgba(163, 230, 53, 0.55)",  // Good
  best_arrow: "rgba(34, 197, 94, 0.8)"     // Solid Green for recommended best
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
  const isBadMove = ["inaccuracy", "mistake", "blunder"].includes(move.cls);
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
    { name: "mistake",    color: REVIEW_COLORS.mistake },
    { name: "inaccuracy", color: REVIEW_COLORS.inaccuracy },
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

    // 1. White move (Column 1)
    container.appendChild(makeMoveCell(white, i, path));

    // 2. Move number (Column 2)
    const numCell = document.createElement("div");
    numCell.className = "move-num";
    numCell.textContent = white.move_num + ".";
    container.appendChild(numCell);

    // 3. Black move or empty placeholder (Column 3)
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

    const dot = document.createElement("div");
    dot.className = "mobile-move-dot";
    dot.style.background = CLS[move.cls]?.color || "transparent";
    item.appendChild(dot);

    const sanSpan = document.createElement("span");
    sanSpan.innerHTML = formatSanWithSymbol(move.san);
    item.appendChild(sanSpan);

    item.addEventListener("click", () => goToMove(idx));
    list.appendChild(item);
  });
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
    const dot = document.createElement("div");
    dot.className = "move-cls-dot";
    cell.appendChild(dot);
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
  $("tooltip-cls").textContent = CLS[move.cls]?.label || move.cls;
  $("tooltip-cls").style.color = CLS[move.cls]?.color || "#fff";
  $("tooltip-cpl").textContent = move.is_best
    ? "Engine's best move"
    : `Centipawn loss: ${move.cpl}`;

  const bestEl = $("tooltip-best");
  if (move.best_uci && !move.is_best) {
    bestEl.textContent = `Best: ${move.best_uci}`;
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

  state.chart = new Chart(ctx, {
    type: "line",
    data: {
      labels,
      datasets: [{
        data,
        borderColor: "#4fffb0",
        backgroundColor: (ctx) => {
          const g = ctx.chart.ctx.createLinearGradient(0, 0, 0, 120);
          g.addColorStop(0,   "rgba(79,255,176,0.3)");
          g.addColorStop(0.5, "rgba(79,255,176,0.05)");
          g.addColorStop(1,   "rgba(239,68,68,0.05)");
          return g;
        },
        borderWidth: 1.5,
        pointRadius: 0,
        tension: 0.4,
        fill: true,
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: "nearest", axis: "x" },
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            title: items => `Move ${items[0].label}`,
            label: item => `White win prob: ${item.raw.toFixed(1)}%`,
          },
          backgroundColor: "#1a2235",
          borderColor: "rgba(255,255,255,0.1)",
          borderWidth: 1,
        },
      },
      scales: {
        x: { display: false },
        y: {
          min: 0, max: 100,
          grid: { color: "rgba(255,255,255,0.04)" },
          ticks: {
            color: "#505a72",
            font: { size: 10 },
            callback: v => v === 50 ? "Equal" : v === 100 ? "White" : v === 0 ? "Black" : "",
          },
          border: { display: false },
        },
      },
      onClick: (e, elements) => {
        if (elements.length > 0) {
          goToMove(elements[0].index);
        }
      },
    }
  });

  // Add 50% guide line (equality)
  const plugin = {
    id: "equalityLine",
    beforeDraw(chart) {
      const { ctx, scales: { y } } = chart;
      const y50 = y.getPixelForValue(50);
      ctx.save();
      ctx.strokeStyle = "rgba(255,255,255,0.08)";
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 4]);
      ctx.beginPath();
      ctx.moveTo(chart.chartArea.left, y50);
      ctx.lineTo(chart.chartArea.right, y50);
      ctx.stroke();
      ctx.restore();
    }
  };
  state.chart.options.plugins.equalityLine = {};
  Chart.register(plugin);
  state.chart.update();
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
$("games-back").addEventListener("click", () => showView("view-home"));
$("games-refresh").addEventListener("click", loadGames);
$("games-profile-tag").addEventListener("click", () => {
  if (state.username) {
    window.open(`https://www.chess.com/member/${state.username}`, "_blank");
  }
});
document.querySelectorAll(".mode-btn").forEach(btn => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".mode-btn").forEach(b => b.classList.remove("active"));
    btn.classList.add("active");
    state.analysisMode = btn.dataset.mode;
  });
});

// Analysis
$("analysis-back").addEventListener("click", () => showView("view-games"));
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
});

// Mobile navigation buttons
$("btn-mobile-prev").addEventListener("click", () => goToMove(state.moveIndex - 1));
$("btn-mobile-next").addEventListener("click", () => goToMove(state.moveIndex + 1));

// Mobile bottom action bar buttons
$("btn-mobile-flip").addEventListener("click", () => {
  state.flipped = !state.flipped;
  state.board?.flip();
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
$("btn-mobile-next-key").addEventListener("click", () => {
  const moves = getActiveMoves();
  if (!moves.length) return;

  // Scan forward for next blunder, mistake, or inaccuracy (key moment of interest)
  let nextKeyIdx = -1;
  for (let i = state.moveIndex + 1; i < moves.length; i++) {
    if (["blunder", "mistake", "inaccuracy"].includes(moves[i].cls)) {
      nextKeyIdx = i;
      break;
    }
  }

  // If found, navigate to it; otherwise go to the next move (or loop back to start)
  if (nextKeyIdx !== -1) {
    goToMove(nextKeyIdx);
  } else {
    if (state.moveIndex < moves.length - 1) {
      goToMove(state.moveIndex + 1);
    } else {
      goToMove(-1);
    }
  }
});

// Sidebar Tabs switching
document.querySelectorAll(".sidebar-tab").forEach(tab => {
  tab.addEventListener("click", () => {
    const targetTab = tab.dataset.tab;
    document.querySelectorAll(".sidebar-tab").forEach(t => t.classList.toggle("active", t === tab));
    
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

// "Game Review" button trigger
$("btn-trigger-review").addEventListener("click", () => {
  const reviewTab = document.querySelector('.sidebar-tab[data-tab="review"]');
  if (reviewTab) reviewTab.click();
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

async function loadLiveGames() {
  const container = $("live-games-container");
  if (!container) return;
  
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

function initLandingPageListeners() {
  const dialPhoneBtn = $("btn-dial-phone");
  if (dialPhoneBtn) {
    dialPhoneBtn.addEventListener("click", () => {
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

// ── Init ───────────────────────────────────────────────
const DEFAULT_USERNAME = "twelfth_doctor";
$("username-input").value = DEFAULT_USERNAME;
initPhoneAuth();
initVoiceCall();
initLandingPageListeners();

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

async function getStockfishWorker() {
  // Static worker file — stockfish.js auto-locates stockfish.wasm from the same directory.
  // Blob URL workers are unreliable in iOS WKWebView so we avoid them entirely.
  // Use stockfish.js directly as the worker — it has built-in worker detection
  // and derives the WASM path from its own URL (/js/stockfish.wasm). Using a
  // wrapper file breaks this because self.location would point to the wrapper.
  const worker = new Worker("/js/stockfish.js");

  // Stockfish posts a banner message when its WASM finishes loading.
  // Only after that banner arrives is it safe to send "uci" and wait for "uciok".
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Stockfish init timeout")), 20000);
    let uciSent = false;
    const h = e => {
      if (typeof e.data !== "string") return;
      if (!uciSent) {
        uciSent = true;
        worker.postMessage("uci");
      } else if (e.data.includes("uciok")) {
        clearTimeout(timeout);
        worker.removeEventListener("message", h);
        resolve();
      }
    };
    worker.addEventListener("message", h);
    worker.onerror = e => { clearTimeout(timeout); reject(e); };
  });

  return worker;
}

async function fetchGamesDirect(username, count = 20) {
  const archivesRes = await customFetch(`https://api.chess.com/pub/player/${username.toLowerCase()}/games/archives`);
  if (!archivesRes.ok) throw new Error("User not found on Chess.com");
  const archivesData = await archivesRes.json();
  const archives = archivesData.archives || [];
  if (!archives.length) throw new Error("No games found for this user");

  // Fetch last 2 archives
  const allGames = [];
  const monthsToFetch = Math.min(2, archives.length);
  for (let i = archives.length - monthsToFetch; i < archives.length; i++) {
    const r = await customFetch(archives[i]);
    if (r.ok) {
      const d = await r.json();
      allGames.push(...(d.games || []));
    }
  }

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
    const isWhite = white.username?.toLowerCase() === username.toLowerCase();
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

  return formatted;
}

async function runLocalWasmAnalysis(game) {
  const cacheKey = `review_${game.url}_${state.analysisMode}`;
  const cached = localStorage.getItem(cacheKey);
  if (cached) {
    state.result = JSON.parse(cached);
    renderAnalysis(state.result);
    return;
  }

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
  $("progress-bar").style.width = "0%";
  $("loading-progress").textContent = `0 / ${totalMoves} moves`;

  // Start Stockfish Web Worker via same-origin Blob URL
  const worker = await getStockfishWorker();
  
  const depthLimit = state.analysisMode === "quick" ? 8 : state.analysisMode === "deep" ? 14 : 11;
  const timeLimit = state.analysisMode === "quick" ? 50 : state.analysisMode === "deep" ? 300 : 120;

  const movesData = [];
  const whiteCpls = [];
  const blackCpls = [];
  
  const board = new Chess();
  
  let lastEval = await evaluateFen(worker, board.fen(), timeLimit);
  
  for (let i = 0; i < totalMoves; i++) {
    const m = moves[i];
    const isWhite = m.color === 'w';
    const san = m.san;
    const uci = m.from + m.to + (m.promotion || "");
    
    // Calculate best move SAN before changing the main board state
    let bestSan = null;
    if (lastEval && lastEval.bestMove) {
      const from = lastEval.bestMove.slice(0, 2);
      const to = lastEval.bestMove.slice(2, 4);
      const promo = lastEval.bestMove[4] || undefined;
      const tempChess = new Chess(board.fen());
      const tempMove = tempChess.move({ from, to, promotion: promo });
      if (tempMove) bestSan = tempMove.san;
    }
    
    board.move(m);
    const postFen = board.fen();
    
    const evalData = await evaluateFen(worker, postFen, timeLimit);
    
    const moverColor = isWhite ? 1 : -1;
    const scoreBeforeRel = lastEval.score * moverColor;
    const scoreAfterRel = evalData.score * moverColor;
    
    let cpl = scoreBeforeRel - scoreAfterRel;
    if (lastEval.mate !== null || evalData.mate !== null) {
      cpl = (lastEval.mate !== null && evalData.mate === null) ? 200 : 0;
    }
    cpl = Math.max(0, Math.min(cpl, 1000));
    
    if (isWhite) whiteCpls.push(Math.min(cpl, 300));
    else blackCpls.push(Math.min(cpl, 300));
    
    const isBest = uci.slice(0, 4) === lastEval.bestMove.slice(0, 4);
    const cls = classifyCpl(cpl, isBest);
    const wp = winProb(evalData.score);
    
    movesData.push({
      idx:         i + 1,
      move_num:    Math.floor(i / 2) + 1,
      san:         san,
      uci:         uci,
      color:       isWhite ? "white" : "black",
      fen:         postFen,
      eval_cp:     evalData.score,
      eval_str:    formatScore(evalData.score, evalData.mate),
      cpl:         Math.round(cpl),
      cls:         cls,
      win_prob:    wp,
      is_best:     isBest,
      best_uci:    !isBest ? lastEval.bestMove : null,
      best_san:    !isBest ? bestSan : null,
      clk:         clkMatches[i] || null,
      variations:  [],
    });

    lastEval = evalData;
    
    const pct = Math.round(((i + 1) / totalMoves) * 100);
    $("progress-bar").style.width = `${pct}%`;
    $("loading-progress").textContent = `${i + 1} / ${totalMoves} moves`;
  }
  
  worker.terminate();

  const getCounts = (color) => {
    const c = { best: 0, excellent: 0, good: 0, inaccuracy: 0, mistake: 0, blunder: 0 };
    movesData.forEach(m => {
      if (m.color === color && m.cls in c) c[m.cls]++;
    });
    return c;
  };

  const reviewResult = {
    white_player:   game.white,
    black_player:   game.black,
    opening:        game.opening,
    white_accuracy: calculateAccuracy(whiteCpls),
    black_accuracy: calculateAccuracy(blackCpls),
    white_counts:   getCounts("white"),
    black_counts:   getCounts("black"),
    moves:          movesData,
    start_fen:      "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1",
    result:         game.result || "*",
  };

  localStorage.setItem(cacheKey, JSON.stringify(reviewResult));

  state.result = reviewResult;
  renderAnalysis(reviewResult);
}

function evaluateFen(worker, fen, timeLimit) {
  return new Promise(resolve => {
    let bestMove = "";
    let score = 0;
    let mate = null;
    
    const onMsg = (e) => {
      const line = e.data;
      if (line.startsWith("info depth")) {
        const cpMatch = line.match(/score cp (-?\d+)/);
        if (cpMatch) score = parseInt(cpMatch[1]);
        
        const mateMatch = line.match(/score mate (-?\d+)/);
        if (mateMatch) mate = parseInt(mateMatch[1]);
        
        const pvMatch = line.match(/ pv ([a-h][1-8][a-h][1-8][qrbn]?)/);
        if (pvMatch) bestMove = pvMatch[1];
      } else if (line.startsWith("bestmove")) {
        worker.removeEventListener("message", onMsg);
        resolve({ score, mate, bestMove: bestMove || line.split(" ")[1] });
      }
    };
    
    worker.addEventListener("message", onMsg);
    worker.postMessage("position fen " + fen);
    worker.postMessage("go movetime " + timeLimit);
  });
}

function classifyCpl(cpl, isBest) {
  if (isBest) return "best";
  if (cpl <= 15) return "excellent";
  if (cpl <= 35) return "good";
  if (cpl <= 60) return "inaccuracy";
  if (cpl <= 120) return "mistake";
  return "blunder";
}

function winProb(cp) {
  return 50 + 50 * (2 / (1 + Math.exp(-0.00368 * cp)) - 1);
}

function calculateAccuracy(cpls) {
  if (!cpls.length) return 100;
  const avg = cpls.reduce((a, b) => a + b, 0) / cpls.length;
  const acc = 100 * Math.exp(-avg / 400);
  return Math.round(Math.max(0, Math.min(100, acc)) * 10) / 10;
}

function formatScore(cp, mate) {
  if (mate !== null) return `M${mate}`;
  return (cp / 100 >= 0 ? "+" : "") + (cp / 100).toFixed(1);
}

let liveWasmWorker = null;
async function runLocalWasmLiveEval(fen) {
  const linesList = $("engine-lines-list");
  linesList.innerHTML = `<div class="engine-line-item empty">Engine thinking…</div>`;

  if (liveWasmWorker) liveWasmWorker.terminate();
  liveWasmWorker = await getStockfishWorker();

  const lines = await evaluateMultiPV(liveWasmWorker, fen, 11, 120);
  liveWasmWorker.terminate();
  liveWasmWorker = null;

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

function evaluateMultiPV(worker, fen, depth, timeLimit) {
  return new Promise(resolve => {
    let pvs = [];
    
    const onMsg = (e) => {
      const line = e.data;
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
          
          const pvMatch = line.match(/ pv ([a-h][1-8][a-h][1-8][qrbn]?)/);
          const bestMove = pvMatch ? pvMatch[1] : "";
          
          if (bestMove) {
            const parts = fen.split(" ");
            const turn = parts[1] || "w";
            
            let score_str = "";
            if (mate !== null) {
              score_str = `M${Math.abs(mate)}`;
            } else {
              const score_val = (score / 100.0);
              score_str = score_val > 0 ? `+${score_val.toFixed(2)}` : score_val.toFixed(2);
            }

            pvs[rank] = {
              uci: bestMove,
              san: bestMove,
              score: score_str,
              cp: score
            };
          }
        }
      } else if (line.startsWith("bestmove")) {
        worker.removeEventListener("message", onMsg);
        const sorted = pvs.filter(x => x !== undefined).slice(0, 3);
        resolve(sorted);
      }
    };

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
    
    // Re-render to show the country flags next to names
    if (state.result) {
      renderAnalysis(state.result);
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

function updateSummaryPills(counts) {
  const container = $("desktop-summary-pills");
  if (!container) return;
  container.innerHTML = "";
  
  if (!counts) {
    container.classList.add("hidden");
    return;
  }
  
  container.classList.remove("hidden");
  
  const pillConfigs = [
    { key: "best",       icon: "★", class: "pill-best",       label: "Best" },
    { key: "excellent",  icon: "👍", class: "pill-excellent",  label: "Excellent" },
    { key: "good",       icon: "✔", class: "pill-good",       label: "Good" },
    { key: "inaccuracy", icon: "☡", class: "pill-inaccuracy", label: "Inaccuracy" },
    { key: "mistake",    icon: "❓", class: "pill-mistake",    label: "Mistake" },
    { key: "blunder",    icon: "❌", class: "pill-blunder",    label: "Blunder" }
  ];
  
  pillConfigs.forEach(cfg => {
    const val = counts[cfg.key] || 0;
    if (val > 0) {
      const pill = document.createElement("span");
      pill.className = `summary-pill ${cfg.class}`;
      pill.innerHTML = `${cfg.icon} ${val}`;
      pill.title = `${val} ${cfg.label} Move${val > 1 ? 's' : ''}`;
      container.appendChild(pill);
    }
  });
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
    // Convert relative engine score (POV of side to move) to White POV for the eval bar
    const isWhiteTurn = state.chess ? state.chess.turn() === 'w' : true;
    let cpWhite = topLine.cp;
    let evalStrWhite = evalStr;
    if (!isWhiteTurn) {
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

    const panel = $("coach-panel");
    if (panel) {
      panel.classList.remove("hidden");
      const badge = $("coach-move-badge");
      if (badge) {
        badge.className = "coach-badge";
        badge.style.background = "#d4a055";
        badge.style.color = "#110c07";
        badge.textContent = "🔍";
      }
      const title = $("coach-move-title");
      if (title) {
        title.textContent = `Analysis · ${evalStr}`;
      }
      const txt = $("coach-text");
      if (txt) {
        if (move) {
          txt.innerHTML = `You played <b>${move.san}</b>. Stockfish evaluates this position at <b>${evalStr}</b>. The best move is <b>${bestMove}</b>.`;
        } else {
          txt.innerHTML = `Stockfish evaluates this position at <b>${evalStr}</b>. The best move is <b>${bestMove}</b>.`;
        }
      }
    }
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
  $("btn-trigger-review").classList.add("loading");
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
    $("btn-trigger-review").classList.remove("loading");
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

