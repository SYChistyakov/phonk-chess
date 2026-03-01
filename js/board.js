/**
 * board.js — PhonkChess board rendering and interaction
 * Handles: DOM grid, piece placement, click/touch events, highlights
 */

'use strict';

const Board = (() => {
  /* ---- State ---- */
  let _flipped = false;           // true = black at bottom
  let _selectedSquare = null;     // currently selected square (e.g. 'e2')
  let _validMoves = [];           // array of move objects for selected piece
  let _lastMove = null;           // {from, to} of most recent move
  let _onMove = null;             // callback(from, to, promotion)
  let _getChess = null;           // function() => Chess instance

  /* ---- DOM refs ---- */
  let _grid = null;
  let _rankLabels = null;
  let _fileLabels = null;
  let _wrapper = null;

  const FILES = ['a','b','c','d','e','f','g','h'];
  const RANKS = ['1','2','3','4','5','6','7','8'];

  /* ---- Piece image map ---- */
  const PIECE_IMG = {
    wP: 'assets/pieces/wP.svg',
    wN: 'assets/pieces/wN.svg',
    wB: 'assets/pieces/wB.svg',
    wR: 'assets/pieces/wR.svg',
    wQ: 'assets/pieces/wQ.svg',
    wK: 'assets/pieces/wK.svg',
    bP: 'assets/pieces/bP.svg',
    bN: 'assets/pieces/bN.svg',
    bB: 'assets/pieces/bB.svg',
    bR: 'assets/pieces/bR.svg',
    bQ: 'assets/pieces/bQ.svg',
    bK: 'assets/pieces/bK.svg',
  };

  /* ---- Init ---- */
  function init({ onMove, getChess }) {
    _onMove = onMove;
    _getChess = getChess;

    _grid       = document.getElementById('board-grid');
    _rankLabels = document.getElementById('rank-labels');
    _fileLabels = document.getElementById('file-labels');
    _wrapper    = document.getElementById('board-wrapper');

    _buildGrid();
    _buildCoords();
    render();
  }

  /* ---- Build 8×8 DOM grid ---- */
  function _buildGrid() {
    _grid.innerHTML = '';
    const rows = _flipped ? RANKS : [...RANKS].reverse();
    const cols = _flipped ? [...FILES].reverse() : FILES;

    rows.forEach((rank, ri) => {
      cols.forEach((file, fi) => {
        const sq = document.createElement('div');
        const square = file + rank;
        sq.className = 'sq ' + ((ri + fi) % 2 === 0 ? 'light' : 'dark');
        sq.id = 'sq-' + square;
        sq.dataset.square = square;


        sq.addEventListener('click', () => _handleClick(square));
        sq.addEventListener('touchend', (e) => { e.preventDefault(); _handleClick(square); });

        _grid.appendChild(sq);
      });
    });
  }

  /* ---- Coordinate labels (outside grid) ---- */
  function _buildCoords() {
    _rankLabels.innerHTML = '';
    _fileLabels.innerHTML = '';

    const ranks = _flipped ? RANKS : [...RANKS].reverse();
    const files = _flipped ? [...FILES].reverse() : FILES;

    ranks.forEach(r => {
      const el = document.createElement('div');
      el.className = 'rank-label';
      el.textContent = r;
      _rankLabels.appendChild(el);
    });

    files.forEach(f => {
      const el = document.createElement('div');
      el.className = 'coord-label';
      el.textContent = f;
      _fileLabels.appendChild(el);
    });
  }

  /* ---- Render pieces from chess.js board ---- */
  function render() {
    const chess = _getChess();
    const board = chess.board(); // 8×8 array [rank8→rank1][a→h]

    const rows = _flipped ? RANKS : [...RANKS].reverse();
    const cols = _flipped ? [...FILES].reverse() : FILES;

    rows.forEach((rank, ri) => {
      cols.forEach((file, fi) => {
        const square = file + rank;
        const el = document.getElementById('sq-' + square);
        if (!el) return;

        // Remove existing piece img
        const existing = el.querySelector('.piece');
        if (existing) el.removeChild(existing);

        // Get piece from chess.js board
        const rankIdx = 8 - parseInt(rank);
        const fileIdx = file.charCodeAt(0) - 97;
        const piece = board[rankIdx][fileIdx];

        if (piece) {
          const key = (piece.color === 'w' ? 'w' : 'b') + piece.type.toUpperCase();
          const img = document.createElement('img');
          img.src = PIECE_IMG[key] || '';
          img.alt = key;
          img.className = 'piece ' + (piece.color === 'w' ? 'white' : 'black');
          img.draggable = false;
          el.appendChild(img);
        }
      });
    });

    _applyHighlights();
  }

  /* ---- Apply highlight classes ---- */
  function _applyHighlights() {
    // Clear all highlight classes first
    document.querySelectorAll('.sq').forEach(el => {
      el.classList.remove('selected', 'valid-move', 'capture-move', 'last-move');
    });

    // Last move
    if (_lastMove) {
      _sqEl(_lastMove.from)?.classList.add('last-move');
      _sqEl(_lastMove.to)?.classList.add('last-move');
    }

    // Selected square
    if (_selectedSquare) {
      _sqEl(_selectedSquare)?.classList.add('selected');

      // Valid moves
      const chess = _getChess();
      _validMoves.forEach(move => {
        const el = _sqEl(move.to);
        if (!el) return;
        // Capture: enemy piece on target OR en passant
        const piece = chess.get(move.to);
        const isCapture = piece || (move.flags && move.flags.includes('e'));
        if (isCapture) {
          el.classList.add('capture-move');
        } else {
          el.classList.add('valid-move');
        }
      });
    }
  }

  /* ---- Handle square click ---- */
  function _handleClick(square) {
    const chess = _getChess();

    // If game is over, ignore
    if (chess.game_over()) return;

    // Not player's turn
    if (chess.turn() !== 'w') return;

    const piece = chess.get(square);

    if (_selectedSquare) {
      // Try to move
      const isValidTarget = _validMoves.some(m => m.to === square);

      if (isValidTarget) {
        // Check if promotion
        const move = _validMoves.find(m => m.to === square);
        const promotion = _isPromotion(move) ? 'q' : undefined;
        _onMove(_selectedSquare, square, promotion);
        _selectedSquare = null;
        _validMoves = [];
        return;
      }

      // Clicked same square: deselect
      if (square === _selectedSquare) {
        _selectedSquare = null;
        _validMoves = [];
        _applyHighlights();
        return;
      }

      // Clicked own piece: switch selection
      if (piece && piece.color === chess.turn()) {
        _selectSquare(square, chess);
        return;
      }

      // Clicked empty/enemy without valid move: deselect
      _selectedSquare = null;
      _validMoves = [];
      _applyHighlights();
      return;
    }

    // Nothing selected: try to select
    if (piece && piece.color === chess.turn()) {
      _selectSquare(square, chess);
    }
  }

  function _selectSquare(square, chess) {
    _selectedSquare = square;
    _validMoves = chess.moves({ square, verbose: true });
    _applyHighlights();
  }

  function _isPromotion(move) {
    return move.flags && (move.flags.includes('p'));
  }

  /* ---- Public: clear selection ---- */
  function clearSelection() {
    _selectedSquare = null;
    _validMoves = [];
    _applyHighlights();
  }

  /* ---- Public: set last move ---- */
  function setLastMove(from, to) {
    _lastMove = (from && to) ? { from, to } : null;
  }

  /* ---- Public: flip board ---- */
  function flip() {
    _flipped = !_flipped;
    _buildGrid();
    _buildCoords();
    render();
  }

  /* ---- Public: set check state ---- */
  function setCheck(inCheck) {
    if (inCheck) {
      _wrapper.classList.add('in-check');
    } else {
      _wrapper.classList.remove('in-check');
    }
  }

  /* ---- Public: animate capture flash ---- */
  function flashCapture(square) {
    const el = _sqEl(square);
    if (!el) return;
    el.classList.add('capture-flash');
    setTimeout(() => el.classList.remove('capture-flash'), 350);
  }

  /* ---- Public: full re-render (e.g. after new game) ---- */
  function reset() {
    _selectedSquare = null;
    _validMoves = [];
    _lastMove = null;
    render();
    setCheck(false);
  }

  /* ---- Helper: get square DOM element ---- */
  function _sqEl(square) {
    return document.getElementById('sq-' + square);
  }

  return { init, render, clearSelection, setLastMove, flip, setCheck, flashCapture, reset };
})();
