/**
 * main.js — PhonkChess app orchestration
 * Uses chess.js 0.13.4 API (game_over, in_check, in_checkmate, etc.)
 */

'use strict';

/* ---- App state ---- */
let chess = null;
let aiWorker = null;
let aiDepth = 3;           // default: MEDIUM
let isAIThinking = false;
let gameActive = false;
let moveCount = 0;
let musicMuted = false;

/* ---- DOM refs ---- */
const elStatusText    = document.getElementById('game-status-text');
const elThinking      = document.getElementById('thinking-indicator');
const elOverlay       = document.getElementById('game-overlay');
const elOverlayTitle  = document.getElementById('overlay-title');
const elOverlaySub    = document.getElementById('overlay-subtitle');
const elOverlayIcon   = document.getElementById('overlay-icon');
const elMoveHistory   = document.getElementById('move-history');
const elCardWhite     = document.getElementById('card-white');
const elCardBlack     = document.getElementById('card-black');
const elCapByWhite    = document.getElementById('captured-by-white');
const elCapByBlack    = document.getElementById('captured-by-black');

/* ---- Audio stubs (user replaces files) ---- */
const SOUNDS = {
  move:     _makeAudio('assets/sounds/move.mp3'),
  capture:  _makeAudio('assets/sounds/capture.mp3'),
  check:    _makeAudio('assets/sounds/check.mp3'),
  gameover: _makeAudio('assets/sounds/gameover.mp3'),
};

function _makeAudio(src) {
  const a = new Audio();
  a.src = src;
  a.volume = 0.5;
  return a;
}

function _playSound(name) {
  try {
    const snd = SOUNDS[name];
    if (snd) { snd.currentTime = 0; snd.play().catch(() => {}); }
  } catch (_) {}
}

/* ---- Worker init ---- */
function _initWorker() {
  if (aiWorker) { aiWorker.terminate(); aiWorker = null; }
  try {
    aiWorker = new Worker('js/ai-worker.js');
    aiWorker.onmessage = _onWorkerMessage;
    aiWorker.onerror = (e) => {
      console.warn('AI Worker error, using fallback:', e.message);
      aiWorker = null;
    };
  } catch (e) {
    console.warn('Web Worker unavailable, using main-thread fallback.');
    aiWorker = null;
  }
}

/* ---- Game init ---- */
function init() {
  chess = new Chess();
  moveCount = 0;
  gameActive = true;

  Board.init({
    getChess: () => chess,
    onMove: _onPlayerMove,
  });

  _initWorker();
  _setupUI();
  _updateStatus();
  _updateTurnIndicators();
  _clearHistory();
  _updateCaptured();
}

/* ---- UI event setup ---- */
function _setupUI() {
  document.querySelectorAll('.diff-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.diff-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      aiDepth = parseInt(btn.dataset.depth, 10);
    });
  });

  document.getElementById('btn-new-game').addEventListener('click', _newGame);
  document.getElementById('btn-flip').addEventListener('click', () => Board.flip());
  document.getElementById('btn-undo').addEventListener('click', _undoMove);
  document.getElementById('btn-overlay-new').addEventListener('click', _newGame);
  document.getElementById('btn-music').addEventListener('click', _toggleMusic);

  // Start music on first user interaction (browser autoplay policy)
  _startMusic();
}

/* ---- Background music ---- */
const _bgMusic = document.getElementById('bg-music');
_bgMusic.volume = 0.35;

function _startMusic() {
  // Browsers block autoplay until a user gesture; we attempt play and
  // fall back to a one-time gesture listener if it fails.
  const attempt = () => {
    if (!musicMuted) {
      _bgMusic.play().catch(() => {
        // Autoplay blocked — play on first click anywhere
        document.addEventListener('click', () => {
          if (!musicMuted) _bgMusic.play().catch(() => {});
        }, { once: true });
      });
    }
  };
  attempt();
}

function _toggleMusic() {
  musicMuted = !musicMuted;
  const btn = document.getElementById('btn-music');
  if (musicMuted) {
    _bgMusic.pause();
    btn.textContent = '♪ MUSIC: OFF';
    btn.classList.add('muted');
  } else {
    _bgMusic.play().catch(() => {});
    btn.textContent = '♪ MUSIC: ON';
    btn.classList.remove('muted');
  }
}

/* ---- New game ---- */
function _newGame() {
  chess = new Chess();
  moveCount = 0;
  gameActive = true;

  _hideOverlay();
  Board.reset();
  _clearHistory();
  _updateStatus();
  _updateTurnIndicators();
  _updateCaptured();
  Board.setCheck(false);

  isAIThinking = false;
  _setThinking(false);

  if (!aiWorker) _initWorker();
}

/* ---- Player move handler ---- */
function _onPlayerMove(from, to, promotion) {
  if (!gameActive || isAIThinking) return;

  const moveResult = chess.move({ from, to, promotion: promotion || 'q' });
  if (!moveResult) return;

  if (moveResult.captured) {
    Board.flashCapture(to);
    _playSound('capture');
  } else {
    _playSound('move');
  }

  Board.setLastMove(from, to);
  Board.render();
  _addHistoryMove(moveResult, chess.history().length);
  _updateCaptured();

  if (_checkGameOver()) return;

  if (chess.in_check()) {
    Board.setCheck(true);
    _playSound('check');
  } else {
    Board.setCheck(false);
  }

  _updateStatus();
  _updateTurnIndicators();
  _requestAIMove();
}

/* ---- AI move request ---- */
function _requestAIMove() {
  if (!gameActive) return;
  isAIThinking = true;
  _setThinking(true);

  const fen = chess.fen();
  const depth = aiDepth;

  if (aiWorker) {
    aiWorker.postMessage({ fen, depth });
  } else {
    _runAIFallback(fen, depth);
  }
}

/* ---- Fallback AI (main thread, no Worker) ---- */
function _runAIFallback(fen, depth) {
  setTimeout(() => {
    try {
      const move = _mainThreadAI(fen, depth);
      _onWorkerMessage({ data: { move } });
    } catch (e) {
      console.error('AI fallback error:', e);
      _setThinking(false);
      isAIThinking = false;
    }
  }, 30);
}

function _mainThreadAI(fen, depth) {
  const c = new Chess(fen);
  if (c.game_over()) return null;

  const PVALS = { p:100, n:320, b:330, r:500, q:900, k:20000 };

  function evalBoard(pos) {
    if (pos.in_checkmate()) return pos.turn() === 'w' ? -30000 : 30000;
    if (pos.in_draw() || pos.in_stalemate()) return 0;
    let s = 0;
    pos.board().forEach(row => row.forEach(p => {
      if (!p) return;
      s += (p.color === 'w' ? 1 : -1) * (PVALS[p.type] || 0);
    }));
    return s;
  }

  function order(moves) {
    return moves.sort((a,b) => (b.captured?1:0) - (a.captured?1:0));
  }

  function negamax(pos, d, alpha, beta) {
    if (d === 0 || pos.game_over()) {
      const s = evalBoard(pos);
      return pos.turn() === 'w' ? s : -s;
    }
    const moves = order(pos.moves({ verbose: true }));
    let best = -Infinity;
    for (const m of moves) {
      pos.move(m);
      const score = -negamax(pos, d-1, -beta, -alpha);
      pos.undo();
      if (score > best) best = score;
      if (score > alpha) alpha = score;
      if (alpha >= beta) break;
    }
    return best;
  }

  const moves = order(c.moves({ verbose: true }));
  let bestMove = null, bestScore = -Infinity;
  for (const m of moves) {
    c.move(m);
    const score = -negamax(c, depth-1, -Infinity, Infinity);
    c.undo();
    if (score > bestScore) { bestScore = score; bestMove = m; }
  }
  return bestMove ? bestMove.from + bestMove.to + (bestMove.promotion || '') : null;
}

/* ---- Worker response handler ---- */
function _onWorkerMessage(e) {
  const { move, error } = e.data;

  _setThinking(false);
  isAIThinking = false;

  if (!gameActive) return;
  if (error) { console.error('AI error:', error); return; }
  if (!move) return;

  const from = move.slice(0, 2);
  const to   = move.slice(2, 4);
  const promo = move.length > 4 ? move[4] : 'q';

  const moveResult = chess.move({ from, to, promotion: promo });
  if (!moveResult) { console.error('AI returned invalid move:', move); return; }

  if (moveResult.captured) {
    Board.flashCapture(to);
    _playSound('capture');
  } else {
    _playSound('move');
  }

  Board.setLastMove(from, to);
  Board.render();
  _addHistoryMove(moveResult, chess.history().length);
  _updateCaptured();

  if (_checkGameOver()) return;

  if (chess.in_check()) {
    Board.setCheck(true);
    _playSound('check');
  } else {
    Board.setCheck(false);
  }

  _updateStatus();
  _updateTurnIndicators();
}

/* ---- Game over detection ---- */
function _checkGameOver() {
  if (!chess.game_over()) return false;

  gameActive = false;
  Board.setCheck(false);
  _playSound('gameover');

  if (chess.in_checkmate()) {
    const winner = chess.turn() === 'w' ? 'Black' : 'White';
    _showOverlay('CHECKMATE', `${winner} wins!`, '♛');
  } else if (chess.in_stalemate()) {
    _showOverlay('STALEMATE', "It's a draw!", '½');
  } else if (chess.insufficient_material()) {
    _showOverlay('DRAW', 'Insufficient material', '=');
  } else if (chess.in_threefold_repetition()) {
    _showOverlay('DRAW', 'Threefold repetition', '=');
  } else if (chess.in_draw()) {
    _showOverlay('DRAW', "It's a draw!", '=');
  }

  return true;
}

/* ---- Undo two half-moves (player + AI) ---- */
function _undoMove() {
  if (isAIThinking) return;

  const m1 = chess.undo();
  const m2 = chess.undo();

  if (!m1 && !m2) return;

  gameActive = true;
  Board.setCheck(false);
  Board.clearSelection();

  const hist = chess.history({ verbose: true });
  if (hist.length > 0) {
    const last = hist[hist.length - 1];
    Board.setLastMove(last.from, last.to);
  } else {
    Board.setLastMove(null, null);
  }

  Board.render();
  _rebuildHistory();
  _updateCaptured();
  _updateStatus();
  _updateTurnIndicators();

  if (chess.in_check()) Board.setCheck(true);
}

/* ---- Status display ---- */
function _updateStatus() {
  if (!gameActive) return;
  const turn = chess.turn() === 'w' ? 'WHITE' : 'BLACK';
  if (chess.in_check()) {
    elStatusText.textContent = `${turn} IN CHECK`;
    elStatusText.style.color = 'var(--danger-red)';
    elStatusText.style.borderColor = 'rgba(255,0,64,0.4)';
    elStatusText.style.boxShadow = '0 0 10px rgba(255,0,64,0.3)';
  } else {
    elStatusText.textContent = `${turn} TO MOVE`;
    elStatusText.style.color = '';
    elStatusText.style.borderColor = '';
    elStatusText.style.boxShadow = '';
  }
}

/* ---- Turn indicators ---- */
function _updateTurnIndicators() {
  const isWhiteTurn = chess.turn() === 'w';
  elCardWhite.classList.toggle('active', isWhiteTurn && !isAIThinking);
  elCardBlack.classList.toggle('active', !isWhiteTurn || isAIThinking);
}

/* ---- Thinking spinner ---- */
function _setThinking(show) {
  elThinking.classList.toggle('visible', show);
  elCardBlack.classList.toggle('active', show);
  elCardWhite.classList.toggle('active', !show);
}

/* ---- Move history ---- */
function _clearHistory() {
  elMoveHistory.innerHTML = '<div class="history-empty">No moves yet</div>';
  moveCount = 0;
}

function _addHistoryMove(moveResult, totalHalfMoves) {
  const empty = elMoveHistory.querySelector('.history-empty');
  if (empty) empty.remove();

  elMoveHistory.querySelectorAll('.history-row').forEach(r => r.classList.remove('latest'));

  const san = moveResult.san;
  const isWhite = moveResult.color === 'w';

  if (isWhite) {
    moveCount++;
    const row = document.createElement('div');
    row.className = 'history-row latest';
    row.id = 'hist-row-' + moveCount;

    const num = document.createElement('span');
    num.className = 'history-num';
    num.textContent = moveCount + '.';

    const wMove = document.createElement('span');
    wMove.className = 'history-move-w';
    wMove.textContent = san;

    const bMove = document.createElement('span');
    bMove.className = 'history-move-b';
    bMove.textContent = '';
    bMove.id = 'hist-black-' + moveCount;

    row.appendChild(num);
    row.appendChild(wMove);
    row.appendChild(bMove);
    elMoveHistory.appendChild(row);
  } else {
    const bEl = document.getElementById('hist-black-' + moveCount);
    if (bEl) {
      bEl.textContent = san;
      const row = document.getElementById('hist-row-' + moveCount);
      if (row) row.classList.add('latest');
    }
  }

  elMoveHistory.scrollTop = elMoveHistory.scrollHeight;
}

function _rebuildHistory() {
  elMoveHistory.innerHTML = '';
  moveCount = 0;
  const history = chess.history({ verbose: true });

  if (history.length === 0) {
    elMoveHistory.innerHTML = '<div class="history-empty">No moves yet</div>';
    return;
  }

  history.forEach(m => _addHistoryMove(m, 0));
}

/* ---- Captured pieces ---- */
function _updateCaptured() {
  const history = chess.history({ verbose: true });
  const capturedByWhite = [];
  const capturedByBlack = [];

  history.forEach(m => {
    if (m.captured) {
      const key = (m.color === 'w' ? 'b' : 'w') + m.captured.toUpperCase();
      if (m.color === 'w') capturedByWhite.push(key);
      else capturedByBlack.push(key);
    }
  });

  _renderCaptured(elCapByWhite, capturedByWhite);
  _renderCaptured(elCapByBlack, capturedByBlack);
}

function _renderCaptured(container, pieces) {
  container.innerHTML = '';
  pieces.forEach(key => {
    const img = document.createElement('img');
    img.src = 'assets/pieces/' + key + '.svg';
    img.alt = key;
    container.appendChild(img);
  });
}

/* ---- Overlay ---- */
function _showOverlay(title, subtitle, icon) {
  elOverlayTitle.textContent = title;
  elOverlaySub.textContent = subtitle;
  elOverlayIcon.textContent = icon;
  elOverlay.classList.add('visible');
  elOverlay.setAttribute('aria-hidden', 'false');
}

function _hideOverlay() {
  elOverlay.classList.remove('visible');
  elOverlay.setAttribute('aria-hidden', 'true');
}

/* ---- Bootstrap ---- */
document.addEventListener('DOMContentLoaded', init);
