// ===========================================
// Game Client — Canvas rendering + input
// ===========================================
// Receives state from server, renders to canvas.
// Sends input to server via socket.

const GameClient = (() => {
  const CANVAS_W = 800;
  const CANVAS_H = 600;
  const PADDLE_W = 14;
  const PADDLE_H = 110;
  const BALL_SIZE = 12;

  let canvas = null;
  let ctx = null;
  let currentState = null;
  let myWallet = null;
  let amPlayer1 = false;
  let gameId = null;
  let animFrameId = null;
  let currentInput = 'stop';
  let inputInterval = null;
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

    // Send input state every 50ms for responsiveness (resends in case of packet loss)
    if (inputInterval) clearInterval(inputInterval);
    inputInterval = setInterval(() => {
      if (window.socket && gameId && currentInput !== 'stop') {
        window.socket.emit('paddle-move', { gameId, direction: currentInput });
      }
    }, 50);
  }

  function stopRendering() {
    if (animFrameId) {
      cancelAnimationFrame(animFrameId);
      animFrameId = null;
    }
    if (inputInterval) {
      clearInterval(inputInterval);
      inputInterval = null;
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

    // Score (large, behind everything)
    ctx.fillStyle = 'rgba(255,255,255,0.08)';
    ctx.font = 'bold 140px monospace';
    ctx.textAlign = 'center';
    ctx.fillText(state.score.p1, CANVAS_W / 4, CANVAS_H / 2 + 50);
    ctx.fillText(state.score.p2, (CANVAS_W * 3) / 4, CANVAS_H / 2 + 50);

    // Paddles with rounded corners and glow
    drawPaddle(10, state.paddle1.y, amPlayer1);
    drawPaddle(CANVAS_W - PADDLE_W - 10, state.paddle2.y, !amPlayer1);

    // Ball with glow
    ctx.fillStyle = skinConfig.ball;
    ctx.shadowColor = skinConfig.ball;
    ctx.shadowBlur = 15;
    ctx.beginPath();
    ctx.arc(state.ball.x + BALL_SIZE / 2, state.ball.y + BALL_SIZE / 2, BALL_SIZE / 2, 0, Math.PI * 2);
    ctx.fill();
    ctx.shadowBlur = 0;

    // Pause overlay between points
    if (state.paused) {
      ctx.fillStyle = 'rgba(0,0,0,0.3)';
      ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);
      ctx.fillStyle = '#a855f7';
      ctx.font = 'bold 32px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('Get Ready...', CANVAS_W / 2, CANVAS_H / 2 + 12);
    }
  }

  function drawPaddle(x, y, isMe) {
    const color = isMe ? skinConfig.paddle : '#6b7280';
    ctx.fillStyle = color;
    ctx.shadowColor = isMe ? skinConfig.paddle : 'transparent';
    ctx.shadowBlur = isMe ? 18 : 0;

    // Rounded rectangle
    const r = 6;
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + PADDLE_W - r, y);
    ctx.quadraticCurveTo(x + PADDLE_W, y, x + PADDLE_W, y + r);
    ctx.lineTo(x + PADDLE_W, y + PADDLE_H - r);
    ctx.quadraticCurveTo(x + PADDLE_W, y + PADDLE_H, x + PADDLE_W - r, y + PADDLE_H);
    ctx.lineTo(x + r, y + PADDLE_H);
    ctx.quadraticCurveTo(x, y + PADDLE_H, x, y + PADDLE_H - r);
    ctx.lineTo(x, y + r);
    ctx.quadraticCurveTo(x, y, x + r, y);
    ctx.closePath();
    ctx.fill();
    ctx.shadowBlur = 0;
  }

  function renderCountdown(seconds) {
    if (!ctx) return;
    ctx.fillStyle = '#0f0f2a';
    ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);
    ctx.fillStyle = '#a855f7';
    ctx.font = 'bold 120px monospace';
    ctx.textAlign = 'center';
    ctx.fillText(seconds, CANVAS_W / 2, CANVAS_H / 2 + 40);
    ctx.fillStyle = '#888';
    ctx.font = '24px sans-serif';
    ctx.fillText('Get Ready!', CANVAS_W / 2, CANVAS_H / 2 + 90);
  }

  // ---- Input Handling ----
  function setupInput() {
    const keys = {};

    document.addEventListener('keydown', (e) => {
      if (!gameId) return;
      if (['w', 'W', 's', 'S', 'ArrowUp', 'ArrowDown'].includes(e.key)) {
        e.preventDefault(); // prevent page scroll
      }
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

    if (keys['w'] || keys['W'] || keys['ArrowUp']) dir = 'up';
    if (keys['s'] || keys['S'] || keys['ArrowDown']) dir = 'down';

    if (dir !== currentInput) {
      currentInput = dir;
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
