/* ═══════════════════════════════════════════════════════
   ChessLens — Frontend Application
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
  // currentVariation = null  → on main line
  // currentVariation = { branchIdx, varIdx }  → inside a variation
  currentVariation: null,
};

let useLocalWasm = false;

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

// ── DOM shortcuts ──────────────────────────────────────
const $ = id => document.getElementById(id);

// ══════════════════════════════════════════════════════
// HOME VIEW
// ══════════════════════════════════════════════════════

async function checkStockfish() {
  const badge = $("sf-status");
  badge.classList.remove("hidden");
  try {
    const res = await fetch("/api/check");
    const data = await res.json();
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
    if (!useLocalWasm) {
      const res = await fetch(`/api/games/${encodeURIComponent(username)}`);
      const data = await res.json();
      if (!res.ok || data.error) {
        throw new Error(data.error || "Failed to load games");
      }
      gamesList = data.games;
    } else {
      // Fetch directly from Chess.com public API in browser
      gamesList = await fetchGamesDirect(username, 20);
    }

    state.username = username;
    state.games = gamesList;

    $("header-username").textContent = `♟ ${username}`;
    $("header-username").classList.remove("hidden");

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
        <span class="game-row-opp-name">${opponent}</span>
        <span class="game-row-opp-rating">Rating: ${opponentRating}</span>
      </div>
      <div class="game-row-opening">${g.opening}</div>
      <div class="game-row-mode">
        <span>${timeIcon}</span>
        <span>${g.time_class}</span>
      </div>
      <div class="game-row-date">${g.date}</div>
      <div>
        <div class="game-row-action-btn">Analyse</div>
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
  $(`name-${pos}`).textContent = name;
  $(`rating-${pos}`).textContent = rating ? `${rating}` : "";
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
  const move = state.chess.move({ from: source, to: target, promotion: 'q' });
  return move ? undefined : 'snapback';
}

// Returns the currently active move array (main line or current variation)
function getActiveMoves() {
  if (!state.currentVariation || !state.result) return state.result?.moves || [];
  const { branchIdx, varIdx } = state.currentVariation;
  return state.result.moves[branchIdx].variations[varIdx];
}

// Enter a variation: switch active line to it and go to a specific move within it
function enterVariation(branchIdx, varIdx, moveIdx) {
  state.currentVariation = { branchIdx, varIdx };
  $("btn-main-line").classList.remove("hidden");
  goToMove(moveIdx);
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

  // Check if the next main-line move is the same — if so, just navigate there (no new variation)
  const nextMainMove = activeMoves[branchIdx + 1];
  if (nextMainMove && nextMainMove.uci === newMove.uci) {
    goToMove(branchIdx + 1);
    triggerLiveEvaluation(state.chess.fen());
    return;
  }

  if (state.currentVariation) {
    // Already in a variation — append to it
    activeMoves.push(newMove);
    state.moveIndex = activeMoves.length - 1;
  } else {
    // On the main line — attach variation to the branch point move
    const branchMove = state.result.moves[branchIdx];
    if (!branchMove.variations) branchMove.variations = [];

    // Check if a variation starting with this move already exists
    const existingVarIdx = branchMove.variations.findIndex(v => v[0]?.uci === newMove.uci);
    if (existingVarIdx !== -1) {
      // Enter the existing variation
      state.currentVariation = { branchIdx, varIdx: existingVarIdx };
      state.moveIndex = 0;
    } else {
      // Create new variation
      branchMove.variations.push([newMove]);
      const varIdx = branchMove.variations.length - 1;
      state.currentVariation = { branchIdx, varIdx };
      state.moveIndex = 0;
    }
    $("btn-main-line").classList.remove("hidden");
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

  // Update active move in list — match by both line context and index
  const cv = state.currentVariation;
  document.querySelectorAll(".move-cell").forEach(el => {
    const elIdx  = parseInt(el.dataset.idx);
    const elBranch = el.dataset.branch !== undefined ? parseInt(el.dataset.branch) : null;
    const elVar    = el.dataset.var    !== undefined ? parseInt(el.dataset.var)    : null;

    let isActive = false;
    if (cv === null && elBranch === null) {
      isActive = elIdx === state.moveIndex;
    } else if (cv !== null && elBranch === cv.branchIdx && elVar === cv.varIdx) {
      isActive = elIdx === state.moveIndex;
    }
    el.classList.toggle("active", isActive);
  });

  scrollToActive();
  triggerLiveEvaluation(fen);
}

function highlightSquares(uci, cls) {
  // Clear any existing highlight classes
  const classesToRemove = [
    "hl-best-from", "hl-best-to",
    "hl-excellent-from", "hl-excellent-to",
    "hl-good-from", "hl-good-to",
    "hl-inaccuracy-from", "hl-inaccuracy-to",
    "hl-mistake-from", "hl-mistake-to",
    "hl-blunder-from", "hl-blunder-to"
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

    // Draw arrows if setting is enabled
    if ($("chk-show-arrows").checked) {
      drawEngineArrows(data.lines);
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

function drawEngineArrows(moves) {
  const oldSvg = document.getElementById("board-arrows-svg");
  if (oldSvg) oldSvg.remove();

  if (!moves || !moves.length) return;

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
  
  const colors = [
    { name: "best",      color: "rgba(74, 222, 128, 0.65)" }, // green
    { name: "excellent", color: "rgba(59, 130, 246, 0.6)" },  // blue
    { name: "good",      color: "rgba(245, 158, 11, 0.55)" }  // orange
  ];

  colors.forEach(cfg => {
    const marker = document.createElementNS("http://www.w3.org/2000/svg", "marker");
    marker.setAttribute("id", `arrowhead-${cfg.name}`);
    marker.setAttribute("markerWidth", "6");
    marker.setAttribute("markerHeight", "6");
    marker.setAttribute("refX", "4");
    marker.setAttribute("refY", "3");
    marker.setAttribute("orient", "auto");
    
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", "M 0 0 L 6 3 L 0 6 z");
    path.setAttribute("fill", cfg.color);
    
    marker.appendChild(path);
    defs.appendChild(marker);
  });
  svg.appendChild(defs);

  moves.forEach((m, idx) => {
    const uci = m.uci;
    const from = uci.slice(0, 2);
    const to = uci.slice(2, 4);
    
    const pStart = getSquareCoordinates(from);
    const pEnd = getSquareCoordinates(to);
    
    const dx = pEnd.x - pStart.x;
    const dy = pEnd.y - pStart.y;
    const len = Math.sqrt(dx * dx + dy * dy);
    if (len < 1) return;

    // Shift arrow end back slightly so the arrowhead sits on the center of the target square
    const offset = width / 16; // half a square size
    const endX = pEnd.x - (dx / len) * offset;
    const endY = pEnd.y - (dy / len) * offset;

    const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
    line.setAttribute("x1", pStart.x);
    line.setAttribute("y1", pStart.y);
    line.setAttribute("x2", endX);
    line.setAttribute("y2", endY);
    
    const cfg = colors[idx] || colors[2];
    line.setAttribute("stroke", cfg.color);
    line.setAttribute("stroke-width", idx === 0 ? "7" : idx === 1 ? "5.5" : "4");
    line.setAttribute("marker-end", `url(#arrowhead-${cfg.name})`);
    
    svg.appendChild(line);
  });

  boardEl.appendChild(svg);
}

// ── Move list ──────────────────────────────────────────

function renderMoveList(moves) {
  const list = $("moves-list");
  list.innerHTML = "";

  let i = 0;
  while (i < moves.length) {
    const white = moves[i];
    const black = moves[i + 1];

    // Move number
    const numCell = document.createElement("div");
    numCell.className = "move-num";
    numCell.textContent = white.move_num + ".";
    list.appendChild(numCell);

    // White move
    list.appendChild(makeMoveCell(white, i, null, null));

    // Black move (or empty placeholder)
    if (black) {
      list.appendChild(makeMoveCell(black, i + 1, null, null));
    } else {
      const empty = document.createElement("div");
      empty.className = "move-cell empty";
      list.appendChild(empty);
    }

    // Variations branching from white move
    const whiteVars = white.variations || [];
    whiteVars.forEach((varMoves, varIdx) => {
      if (varMoves.length) {
        list.appendChild(makeVariationBlock(varMoves, i, varIdx, white.move_num, 'white'));
      }
    });

    // Variations branching from black move
    if (black) {
      const blackVars = black.variations || [];
      blackVars.forEach((varMoves, varIdx) => {
        if (varMoves.length) {
          list.appendChild(makeVariationBlock(varMoves, i + 1, varIdx, black.move_num, 'black'));
        }
      });
    }

    i += 2;
  }
}

// Build an inline variation block: (N. move move ...)
function makeVariationBlock(varMoves, branchIdx, varIdx, startMoveNum, branchColor) {
  const wrap = document.createElement("div");
  wrap.className = "variation-block";
  // span all 3 columns (num + white + black)
  wrap.style.gridColumn = "1 / -1";

  const inner = document.createElement("div");
  inner.className = "variation-inner";
  wrap.appendChild(inner);

  inner.appendChild(makeVarToken("(", "var-bracket"));

  let moveNum = startMoveNum;
  let color = branchColor === 'white' ? 'black' : 'white'; // first var move is the alternative
  // If branching from white, the variation starts with white's alternative
  color = branchColor === 'white' ? 'white' : 'black';

  varMoves.forEach((move, idx) => {
    // Move number label — show for white moves, or for the first black move in var
    if (move.color === 'white') {
      inner.appendChild(makeVarToken(move.move_num + ".", "var-num"));
    } else if (idx === 0) {
      inner.appendChild(makeVarToken(move.move_num + "…", "var-num"));
    }
    inner.appendChild(makeMoveCell(move, idx, branchIdx, varIdx));
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

// branchIdx/varIdx are null for main-line moves, set for variation moves
function makeMoveCell(move, idx, branchIdx, varIdx) {
  const cell = document.createElement("div");
  const isVar = branchIdx !== null;
  cell.className = `move-cell cls-${move.cls}${isVar ? ' var-move' : ''}`;
  cell.dataset.idx = idx;
  if (isVar) {
    cell.dataset.branch = branchIdx;
    cell.dataset.var    = varIdx;
  }

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
  san.textContent = move.san;
  cell.appendChild(san);

  if (isVar) {
    cell.addEventListener("click", () => enterVariation(branchIdx, varIdx, idx));
  } else {
    cell.addEventListener("click", () => {
      // Clicking a main-line move while in a variation returns to main line first
      if (state.currentVariation) {
        state.currentVariation = null;
        $("btn-main-line").classList.add("hidden");
      }
      goToMove(idx);
    });
  }

  cell.addEventListener("mouseenter", e => showTooltip(e, move));
  cell.addEventListener("mouseleave", hideTooltip);

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
  $("move-tooltip").classList.add("hidden");
}

// ── Win probability chart ──────────────────────────────

function renderChart(moves) {
  if (state.chart) state.chart.destroy();

  const labels = moves.map((m, i) => i + 1);
  const data   = moves.map(m => m.win_prob);

  const ctx = document.getElementById("win-chart").getContext("2d");

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
  if (!state.currentVariation) return;
  const branchIdx = state.currentVariation.branchIdx;
  state.currentVariation = null;
  $("btn-main-line").classList.add("hidden");
  renderMoveList(state.result.moves);
  goToMove(branchIdx);
});
$("btn-first").addEventListener("click", () => goToMove(-1));
$("btn-prev").addEventListener("click",  () => goToMove(state.moveIndex - 1));
$("btn-next").addEventListener("click",  () => goToMove(state.moveIndex + 1));
$("btn-last").addEventListener("click",  () => goToMove((state.result?.moves.length || 0) - 1));
$("btn-flip").addEventListener("click",  () => {
  state.flipped = !state.flipped;
  state.board?.flip();
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
  if (e.target.checked) {
    drawEngineArrows(state.liveEvalLines);
  } else {
    const oldSvg = document.getElementById("board-arrows-svg");
    if (oldSvg) oldSvg.remove();
  }
});

// ── Init ───────────────────────────────────────────────
const DEFAULT_USERNAME = "twelfth_doctor";
$("username-input").value = DEFAULT_USERNAME;
checkStockfish();
loadGames(); // Auto-load games on startup


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
  const archivesRes = await fetch(`https://api.chess.com/pub/player/${username.toLowerCase()}/games/archives`);
  if (!archivesRes.ok) throw new Error("User not found on Chess.com");
  const archivesData = await archivesRes.json();
  const archives = archivesData.archives || [];
  if (!archives.length) throw new Error("No games found for this user");

  // Fetch last 2 archives
  const allGames = [];
  const monthsToFetch = Math.min(2, archives.length);
  for (let i = archives.length - monthsToFetch; i < archives.length; i++) {
    const r = await fetch(archives[i]);
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

  if ($("chk-show-arrows").checked) {
    drawEngineArrows(lines);
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
