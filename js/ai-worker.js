/**
 * ai-worker.js — PhonkChess AI Web Worker
 * Algorithm: Negamax with alpha-beta pruning
 * Uses chess.js 0.13.4 API
 * Receives: { fen, depth }
 * Responds: { move } (e.g. { move: 'e2e4' })
 */

'use strict';

// chess-umd.js is in the same js/ directory as this worker
importScripts('chess-umd.js');

/* ---- Piece values ---- */
const PIECE_VALUES = {
  p: 100,
  n: 320,
  b: 330,
  r: 500,
  q: 900,
  k: 20000,
};

/* ---- Piece-square tables (White's perspective, top-down rank8→rank1) ---- */
const PST = {
  p: [
     0,  0,  0,  0,  0,  0,  0,  0,
    50, 50, 50, 50, 50, 50, 50, 50,
    10, 10, 20, 30, 30, 20, 10, 10,
     5,  5, 10, 25, 25, 10,  5,  5,
     0,  0,  0, 20, 20,  0,  0,  0,
     5, -5,-10,  0,  0,-10, -5,  5,
     5, 10, 10,-20,-20, 10, 10,  5,
     0,  0,  0,  0,  0,  0,  0,  0,
  ],
  n: [
    -50,-40,-30,-30,-30,-30,-40,-50,
    -40,-20,  0,  0,  0,  0,-20,-40,
    -30,  0, 10, 15, 15, 10,  0,-30,
    -30,  5, 15, 20, 20, 15,  5,-30,
    -30,  0, 15, 20, 20, 15,  0,-30,
    -30,  5, 10, 15, 15, 10,  5,-30,
    -40,-20,  0,  5,  5,  0,-20,-40,
    -50,-40,-30,-30,-30,-30,-40,-50,
  ],
  b: [
    -20,-10,-10,-10,-10,-10,-10,-20,
    -10,  0,  0,  0,  0,  0,  0,-10,
    -10,  0,  5, 10, 10,  5,  0,-10,
    -10,  5,  5, 10, 10,  5,  5,-10,
    -10,  0, 10, 10, 10, 10,  0,-10,
    -10, 10, 10, 10, 10, 10, 10,-10,
    -10,  5,  0,  0,  0,  0,  5,-10,
    -20,-10,-10,-10,-10,-10,-10,-20,
  ],
  r: [
     0,  0,  0,  0,  0,  0,  0,  0,
     5, 10, 10, 10, 10, 10, 10,  5,
    -5,  0,  0,  0,  0,  0,  0, -5,
    -5,  0,  0,  0,  0,  0,  0, -5,
    -5,  0,  0,  0,  0,  0,  0, -5,
    -5,  0,  0,  0,  0,  0,  0, -5,
    -5,  0,  0,  0,  0,  0,  0, -5,
     0,  0,  0,  5,  5,  0,  0,  0,
  ],
  q: [
    -20,-10,-10, -5, -5,-10,-10,-20,
    -10,  0,  0,  0,  0,  0,  0,-10,
    -10,  0,  5,  5,  5,  5,  0,-10,
     -5,  0,  5,  5,  5,  5,  0, -5,
      0,  0,  5,  5,  5,  5,  0, -5,
    -10,  5,  5,  5,  5,  5,  0,-10,
    -10,  0,  5,  0,  0,  0,  0,-10,
    -20,-10,-10, -5, -5,-10,-10,-20,
  ],
  k_mid: [
    -30,-40,-40,-50,-50,-40,-40,-30,
    -30,-40,-40,-50,-50,-40,-40,-30,
    -30,-40,-40,-50,-50,-40,-40,-30,
    -30,-40,-40,-50,-50,-40,-40,-30,
    -20,-30,-30,-40,-40,-30,-30,-20,
    -10,-20,-20,-20,-20,-20,-20,-10,
     20, 20,  0,  0,  0,  0, 20, 20,
     20, 30, 10,  0,  0, 10, 30, 20,
  ],
  k_end: [
    -50,-40,-30,-20,-20,-30,-40,-50,
    -30,-20,-10,  0,  0,-10,-20,-30,
    -30,-10, 20, 30, 30, 20,-10,-30,
    -30,-10, 30, 40, 40, 30,-10,-30,
    -30,-10, 30, 40, 40, 30,-10,-30,
    -30,-10, 20, 30, 30, 20,-10,-30,
    -30,-30,  0,  0,  0,  0,-30,-30,
    -50,-30,-30,-30,-30,-30,-30,-50,
  ],
};

/* ---- PST index: board row/col → table index from perspective of color ---- */
// board[ri][fi]: ri=0 is rank 8, ri=7 is rank 1
// white PST: row 0 = rank 8, read top→bottom (ri=0→7 = rank8→rank1)
// black PST: mirrored (ri=0 = rank 1 from black's perspective)
function pstIndex(ri, fi, color) {
  if (color === 'w') {
    return ri * 8 + fi;
  } else {
    return (7 - ri) * 8 + fi;
  }
}

/* ---- Determine endgame ---- */
function isEndgame(board) {
  let queens = 0, minors = 0;
  board.forEach(row => row.forEach(p => {
    if (!p) return;
    if (p.type === 'q') queens++;
    if (p.type === 'r' || p.type === 'b' || p.type === 'n') minors++;
  }));
  return queens === 0 || (queens === 2 && minors <= 2);
}

/* ---- Static evaluation (chess.js 0.x API) ---- */
function evaluate(chess) {
  if (chess.in_checkmate()) {
    return chess.turn() === 'w' ? -30000 : 30000;
  }
  if (chess.in_draw() || chess.in_stalemate()) {
    return 0;
  }

  const board = chess.board();
  const endgame = isEndgame(board);
  let score = 0;

  board.forEach((row, ri) => {
    row.forEach((piece, fi) => {
      if (!piece) return;
      const val = PIECE_VALUES[piece.type] || 0;
      let table;
      if (piece.type === 'k') {
        table = endgame ? PST.k_end : PST.k_mid;
      } else {
        table = PST[piece.type] || null;
      }
      const idx = pstIndex(ri, fi, piece.color);
      const pst = table ? table[idx] : 0;
      const pieceScore = val + pst;
      score += piece.color === 'w' ? pieceScore : -pieceScore;
    });
  });

  return score;
}

/* ---- Move ordering: captures first ---- */
function orderMoves(moves) {
  return moves.sort((a, b) => (b.captured ? 1 : 0) - (a.captured ? 1 : 0));
}

/* ---- Negamax with alpha-beta ---- */
function negamax(chess, depth, alpha, beta) {
  if (depth === 0 || chess.game_over()) {
    const score = evaluate(chess);
    return chess.turn() === 'w' ? score : -score;
  }

  const moves = orderMoves(chess.moves({ verbose: true }));
  let best = -Infinity;

  for (const move of moves) {
    chess.move(move);
    const score = -negamax(chess, depth - 1, -beta, -alpha);
    chess.undo();

    if (score > best) best = score;
    if (score > alpha) alpha = score;
    if (alpha >= beta) break;
  }

  return best;
}

/* ---- Find best move ---- */
function getBestMove(fen, depth) {
  const chess = new Chess(fen);
  if (chess.game_over()) return null;

  const moves = orderMoves(chess.moves({ verbose: true }));
  let bestMove = null;
  let bestScore = -Infinity;

  for (const move of moves) {
    chess.move(move);
    const score = -negamax(chess, depth - 1, -Infinity, Infinity);
    chess.undo();

    if (score > bestScore) {
      bestScore = score;
      bestMove = move;
    }
  }

  if (!bestMove) return null;
  return bestMove.from + bestMove.to + (bestMove.promotion || '');
}

/* ---- Worker message handler ---- */
self.onmessage = function(e) {
  const { fen, depth } = e.data;
  try {
    const move = getBestMove(fen, depth);
    self.postMessage({ move });
  } catch (err) {
    self.postMessage({ move: null, error: err.message });
  }
};
