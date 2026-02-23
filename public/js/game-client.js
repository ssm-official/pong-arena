// ===========================================
// Game Client — Canvas rendering + input
// ===========================================
// Receives state from server, renders to canvas.
// Sends input to server via socket.

const GameClient = (() => {
  const CANVAS_W = 800;
  const CANVAS_H = 600;
  const PADDLE_W = 12;
  const PADDLE_H = 100;
  const BALL_SIZE = 10;

  let canvas = null;
  let ctx = null;
  let currentState = null;
  let myWallet = null;
  let amPlayer1 = false;
  let gameId = null;
  let animFrameId = null;
  let currentInput = 'stop';
  let skinConfig = { paddle: '#a855f7', ball: '#ffffff', background: '#0f0f2a' };

  function init(canvasElement, wallet) {
    canvas = canvasElement;
    ctx = canvas.getContext('2d');
    myWallet = wallet;
    setupInput();
  }

  function setGameInfo(gId, player1Wallet) {
    gameId = gId;
    amPlayer1 = (myWallet === player1Wallet);
  }

  function setSkins(config) {
    if (config.paddle) skinConfig.paddle = config.paddle;
    if (config.ball) skinConfig.ball = config.ball;
    if (config.background) skinConfig.background = config.background;
  }

  function updateState(state) {
    currentState = state;
  }

  function startRendering() {
    if (animFrameId) cancelAnimationFrame(animFrameId);
    renderLoop();
  }

  function stopRendering() {
    if (animFrameId) {
      cancelAnimationFrame(animFrameId);
      animFrameId = null;
    }
  }

  function renderLoop() {
    render();
    animFrameId = requestAnimationFrame(renderLoop);
  }

  function render() {
    if (!ctx || !currentState) return;

    const state = currentState;

    // Background
    ctx.fillStyle = skinConfig.background;
    ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);

    // Center line (dashed)
    ctx.setLineDash([8, 8]);
    ctx.strokeStyle = '#2d2d5e';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(CANVAS_W / 2, 0);
    ctx.lineTo(CANVAS_W / 2, CANVAS_H);
    ctx.stroke();
    ctx.setLineDash([]);

    // Paddles
    // Left paddle (player 1)
    ctx.fillStyle = amPlayer1 ? skinConfig.paddle : '#6b7280';
    ctx.shadowColor = amPlayer1 ? skinConfig.paddle : 'transparent';
    ctx.shadowBlur = amPlayer1 ? 15 : 0;
    ctx.fillRect(10, state.paddle1.y, PADDLE_W, PADDLE_H);
    ctx.shadowBlur = 0;

    // Right paddle (player 2)
    ctx.fillStyle = !amPlayer1 ? skinConfig.paddle : '#6b7280';
    ctx.shadowColor = !amPlayer1 ? skinConfig.paddle : 'transparent';
    ctx.shadowBlur = !amPlayer1 ? 15 : 0;
    ctx.fillRect(CANVAS_W - PADDLE_W - 10, state.paddle2.y, PADDLE_W, PADDLE_H);
    ctx.shadowBlur = 0;

    // Ball
    ctx.fillStyle = skinConfig.ball;
    ctx.shadowColor = skinConfig.ball;
    ctx.shadowBlur = 12;
    ctx.beginPath();
    ctx.arc(state.ball.x + BALL_SIZE / 2, state.ball.y + BALL_SIZE / 2, BALL_SIZE / 2, 0, Math.PI * 2);
    ctx.fill();
    ctx.shadowBlur = 0;

    // Score (large, centered)
    ctx.fillStyle = 'rgba(255,255,255,0.1)';
    ctx.font = 'bold 120px monospace';
    ctx.textAlign = 'center';
    ctx.fillText(state.score.p1, CANVAS_W / 4, CANVAS_H / 2 + 40);
    ctx.fillText(state.score.p2, (CANVAS_W * 3) / 4, CANVAS_H / 2 + 40);
  }

  function renderCountdown(seconds) {
    if (!ctx) return;
    ctx.fillStyle = '#0f0f2a';
    ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);
    ctx.fillStyle = '#a855f7';
    ctx.font = 'bold 100px monospace';
    ctx.textAlign = 'center';
    ctx.fillText(seconds, CANVAS_W / 2, CANVAS_H / 2 + 35);
    ctx.fillStyle = '#888';
    ctx.font = '20px sans-serif';
    ctx.fillText('Get Ready!', CANVAS_W / 2, CANVAS_H / 2 + 80);
  }

  // ---- Input Handling ----
  function setupInput() {
    const keys = {};

    document.addEventListener('keydown', (e) => {
      if (!gameId) return;
      keys[e.key] = true;
      updateInput(keys);
    });

    document.addEventListener('keyup', (e) => {
      if (!gameId) return;
      keys[e.key] = false;
      updateInput(keys);
    });
  }

  function updateInput(keys) {
    let dir = 'stop';

    // W/S or ArrowUp/ArrowDown
    if (keys['w'] || keys['W'] || keys['ArrowUp']) dir = 'up';
    if (keys['s'] || keys['S'] || keys['ArrowDown']) dir = 'down';

    if (dir !== currentInput) {
      currentInput = dir;
      // Send to server via socket
      if (window.socket && gameId) {
        window.socket.emit('paddle-move', { gameId, direction: dir });
      }
    }
  }

  function cleanup() {
    stopRendering();
    gameId = null;
    currentState = null;
    currentInput = 'stop';
  }

  return {
    init, setGameInfo, setSkins, updateState,
    startRendering, stopRendering, renderCountdown,
    cleanup,
  };
})();
