/**
 * ChessNow Analyzer — local review math (Lichess-style win% → accuracy → labels).
 * Loaded before app.js. Pure functions; no DOM.
 *
 * References:
 * - https://lichess.org/page/accuracy
 * - open-game-review / Wazir-style Brilliant / Great / Miss heuristics
 */
(function (global) {
  "use strict";

  const WIN_K = 0.00368208;
  /** Bump when review math / POV / depth / label / accuracy policy changes. */
  const REVIEW_CACHE_PREFIX = "review_v7_";
  const MATE_SCORE = 10000;

  function clamp(n, lo, hi) {
    return Math.max(lo, Math.min(hi, n));
  }

  /**
   * Normalize a Stockfish side-to-move score to centipawns.
   * Mate scores become large synthetic CP (same idea as server get_cp).
   */
  function stmToCp(cp, mate) {
    if (mate != null) {
      const m = mate | 0;
      // mate 0 = side to move is already checkmated
      if (m === 0) return -MATE_SCORE;
      return (MATE_SCORE - Math.abs(m) * 10) * (m > 0 ? 1 : -1);
    }
    return cp == null ? 0 : cp | 0;
  }

  /** Side-to-move CP → White POV. whiteToMove = true if White is STM for this score. */
  function stmCpToWhite(stmCp, whiteToMove) {
    return whiteToMove ? stmCp : -stmCp;
  }

  /**
   * CPL from mover's seat.
   * beforeStm = eval before move (STM = mover), afterStm = eval after move (STM = opponent).
   */
  function cplFromStm(beforeStm, afterStm) {
    const afterMover = -afterStm;
    return clamp(beforeStm - afterMover, 0, 1000);
  }

  /** White-perspective centipawns → win percent 0–100. */
  function cpToWinPercent(cp) {
    const x = clamp(cp == null ? 0 : cp, -1500, 1500);
    return 50 + 50 * (2 / (1 + Math.exp(-WIN_K * x)) - 1);
  }

  /** Win% from the side about to move / that just moved. */
  function winPercentForSide(cpWhite, isWhite) {
    const wpWhite = cpToWinPercent(cpWhite);
    return isWhite ? wpWhite : 100 - wpWhite;
  }

  /**
   * Per-move accuracy from mover's win% before → after the move.
   * Lichess: Accuracy% = 103.1668 * exp(-0.04354 * drop) - 3.1669
   */
  function moveAccuracyFromWinPercents(beforeWP, afterWP) {
    if (afterWP >= beforeWP) return 100;
    const winDiff = beforeWP - afterWP;
    const raw = 103.1668100711649 * Math.exp(-0.04354415386753951 * winDiff) - 3.166924740191411;
    return clamp(raw, 0, 100);
  }

  /** Simple game accuracy: mean of move accuracies (1 decimal). */
  function gameAccuracyFromMoveAccuracies(accs) {
    if (!accs || !accs.length) return 100;
    const avg = accs.reduce((a, b) => a + b, 0) / accs.length;
    return Math.round(clamp(avg, 0, 100) * 10) / 10;
  }

  /**
   * Weighted game accuracy (Lichess-inspired).
   * Volatile / imbalanced seats weigh more; early opening plies weigh less.
   * @param {Array<{acc:number, beforeWP?:number, plyIndex?:number}>} entries
   */
  function gameAccuracyWeighted(entries) {
    if (!entries || !entries.length) return 100;
    let num = 0;
    let den = 0;
    for (let i = 0; i < entries.length; i++) {
      const e = entries[i];
      const acc = e.acc == null ? e : e.acc; // allow bare number arrays
      if (typeof acc !== "number") continue;
      const beforeWP = e.beforeWP == null ? 50 : e.beforeWP;
      const plyIndex = e.plyIndex == null ? i : e.plyIndex;
      const vol = Math.abs(beforeWP - 50);
      // Equal quiet seats ~0.4 weight; ±50 win% seats ~1.0
      let w = clamp(0.4 + 0.6 * (vol / 50), 0.35, 1.15);
      if (plyIndex < 12) w *= 0.65; // opening soft-discount
      num += acc * w;
      den += w;
    }
    if (!den) return 100;
    return Math.round(clamp(num / den, 0, 100) * 10) / 10;
  }

  /** Piece values for sacrifice detection (pawn=1 … queen=9; king ignored). */
  const PIECE_VAL = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 0 };

  function materialPoints(chess) {
    let w = 0;
    let b = 0;
    const board = chess.board();
    for (let r = 0; r < 8; r++) {
      for (let c = 0; c < 8; c++) {
        const sq = board[r][c];
        if (!sq) continue;
        const v = PIECE_VAL[sq.type] || 0;
        if (sq.color === "w") w += v;
        else b += v;
      }
    }
    return { w, b };
  }

  /** True if mover lost ≥2 points of material on this ply (capture net / sacrifice). */
  function isMaterialSacrifice(chessBefore, chessAfter, isWhite) {
    const before = materialPoints(chessBefore);
    const after = materialPoints(chessAfter);
    const myBefore = isWhite ? before.w : before.b;
    const myAfter = isWhite ? after.w : after.b;
    const oppBefore = isWhite ? before.b : before.w;
    const oppAfter = isWhite ? after.b : after.w;
    const myLoss = myBefore - myAfter;
    const oppLoss = oppBefore - oppAfter;
    return myLoss >= 2 && myLoss > oppLoss;
  }

  /**
   * Classify a move.
   * @param {object} opts
   * @param {number} opts.beforeWP mover win% before
   * @param {number} opts.afterWP mover win% after
   * @param {boolean} opts.isBest played engine #1
   * @param {number} [opts.onlyMoveGap] PV1 win% − PV2 win% at the pre-move position
   * @param {boolean} [opts.sacrificed] material sacrifice heuristic
   * @param {boolean} [opts.opponentJustBlundered]
   * @param {number}  [opts.plyIndex] 0-based ply index
   * @param {boolean} [opts.missedMate] had a forced mate and did not play it
   * @param {boolean} [opts.allowedMate] walked into a forced mate against us
   */
  function classifyMove(opts) {
    const beforeWP = opts.beforeWP;
    const afterWP = opts.afterWP;
    const drop = beforeWP - afterWP;
    const isBest = !!opts.isBest;
    const onlyMoveGap = opts.onlyMoveGap == null ? 0 : opts.onlyMoveGap;
    const sacrificed = !!opts.sacrificed;
    const opponentJustBlundered = !!opts.opponentJustBlundered;
    const plyIndex = opts.plyIndex == null ? 999 : opts.plyIndex;
    const missedMate = !!opts.missedMate;
    const allowedMate = !!opts.allowedMate;

    // Mate outcomes dominate soft win% bands
    if (allowedMate && !isBest) return "blunder";
    if (missedMate && !isBest) {
      // Failed to finish when mate was available
      return opponentJustBlundered ? "miss" : "blunder";
    }

    // Miss: failed to punish a blunder (left ≥4% win on the table)
    if (opponentJustBlundered && !isBest && drop >= 4) {
      return "miss";
    }

    // Brilliant: best + real sacrifice + eval holds in a non-losing seat
    if (isBest && sacrificed && drop <= 2 && afterWP >= 45 && onlyMoveGap >= 2) {
      return "brilliant";
    }

    // Great: essentially the only good move and they found it
    if (isBest && onlyMoveGap >= 12 && drop <= 1.5) {
      return "great";
    }

    // Book: early phase, quiet, top-tier choice (theory proxy without a masters DB)
    if (plyIndex < 16 && drop <= 1.5 && (isBest || drop <= 0.8) && afterWP >= 40 && afterWP <= 60) {
      return "book";
    }

    if (isBest || drop <= 0.5) return "best";
    if (drop <= 2) return "excellent";
    if (drop <= 5) return "good";
    if (drop <= 10) return "inaccuracy";
    if (drop <= 20) return "mistake";
    return "blunder";
  }

  /** Legacy CPL bands (kept for server parity / fallback). */
  function classifyCpl(cpl, isBest) {
    if (isBest || cpl <= 5) return "best";
    if (cpl <= 20) return "excellent";
    if (cpl <= 50) return "good";
    if (cpl <= 100) return "inaccuracy";
    if (cpl <= 200) return "mistake";
    return "blunder";
  }

  function calculateAccuracyFromCpls(cpls) {
    if (!cpls.length) return 100;
    const avg = cpls.reduce((a, b) => a + b, 0) / cpls.length;
    return Math.round(clamp(100 * Math.exp(-avg / 400), 0, 100) * 10) / 10;
  }

  /** Drop keys from older review cache generations. */
  function purgeStaleReviewCaches(storage) {
    if (!storage) return;
    const keep = REVIEW_CACHE_PREFIX;
    const toRemove = [];
    for (let i = 0; i < storage.length; i++) {
      const k = storage.key(i);
      if (!k) continue;
      if (k.startsWith("review_") && !k.startsWith(keep)) toRemove.push(k);
    }
    toRemove.forEach((k) => storage.removeItem(k));
  }

  global.ReviewMath = {
    REVIEW_CACHE_PREFIX,
    stmToCp,
    stmCpToWhite,
    cplFromStm,
    cpToWinPercent,
    winPercentForSide,
    moveAccuracyFromWinPercents,
    gameAccuracyFromMoveAccuracies,
    gameAccuracyWeighted,
    isMaterialSacrifice,
    classifyMove,
    classifyCpl,
    calculateAccuracyFromCpls,
    purgeStaleReviewCaches,
  };
})(typeof window !== "undefined" ? window : globalThis);
