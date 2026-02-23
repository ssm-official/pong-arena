// ===========================================
// Game Client — Canvas rendering + input
// ===========================================
// Your paddle: client-side prediction with offset reconciliation.
//   - Moves instantly on input (no waiting for server round-trip)
//   - Server updates adjust the offset so prediction stays in sync
//   - Both players see nearly identical positions
// Opponent paddle + ball: server state with lerp (smooth jitter).

const GameClient = (() => {
  const CANVAS_W = 800;
  const CANVAS_H = 600;
  const PADDLE_W = 14;
  const PADDLE_H = 110;
  const PADDLE_SPEED = 10;
  const BALL_SIZE = 12;
  const SERVER_TICK_MS = 1000 / 60;
  const REMOTE_LERP = 0.4;
  const BALL_LERP = 0.5;

  let canvas = null;
  let ctx = null;
  let myWallet = null;
  let amPlayer1 = false;
  let gameId = null;
  let animFrameId = null;
  let inputInterval = null;
  let lastFrameTime = 0;
  let skinConfig = { paddle: '#a855f7', ball: '#ffffff', background: '#0f0f2a' };
  let mirrored = false; // if true, flip view so your paddle is on the right

  // --- Your paddle: prediction with offset reconciliation ---
  let serverMyY = CANVAS_H / 2 - PADDLE_H / 2;  // last known server position
  let myOffset = 0;  // prediction offset (local movement since last server update)

  // --- Opponent paddle: lerped ---
  let remoteTargetY = CANVAS_H / 2 - PADDLE_H / 2;
  let remoteDisplayY = CANVAS_H / 2 - PADDLE_H / 2;

  // --- Ball: lerped ---
  let ballTarget = { x: CANVAS_W / 2, y: CANVAS_H / 2 };
  let ballDisplay = { x: CANVAS_W / 2, y: CANVAS_H / 2 };

  let displayScore = { p1: 0, p2: 0 };
  let isPaused = false;

  const keys = {};
  let currentInput = 'stop';

  function init(canvasElement, wallet) {
    canvas = canvasElement;
    ctx = canvas.getContext('2d');
    myWallet = wallet;
    setupInput();
  }

  function setGameInfo(gId, player1Wallet) {
    gameId = gId;
    amPlayer1 = (myWallet === player1Wallet);
    const mid = CANVAS_H / 2 - PADDLE_H / 2;
    serverMyY = mid;
    myOffset = 0;
    remoteTargetY = mid;
    remoteDisplayY = mid;
    ballTarget = { x: CANVAS_W / 2, y: CANVAS_H / 2 };
    ballDisplay = { x: CANVAS_W / 2, y: CANVAS_H / 2 };
    lastFrameTime = 0;
  }

  function setSkins(config) {
    if (config.paddle) skinConfig.paddle = config.paddle;
    if (config.ball) skinConfig.ball = config.ball;
    if (config.background) skinConfig.background = config.background;
  }

  function setMirrored(val) {
    mirrored = !!val;
  }

  function updateState(state) {
    displayScore = state.score;
    isPaused = state.paused;

    // --- Reconcile your paddle prediction ---
    const newServerY = amPlayer1 ? state.paddle1.y : state.paddle2.y;
    // Subtract the server's movement from our offset.
    // If server moved 10px down and we predicted 10px down, offset stays ~0.
    // If server hasn't received our input yet (moved 0), offset stays as-is.
    myOffset -= (newServerY - serverMyY);
    serverMyY = newServerY;

    // If offset is unreasonably large (bad latency spike), decay it fast
    if (Math.abs(myOffset) > 50) {
      myOffset *= 0.3;
    }

    // Opponent paddle target
    remoteTargetY = amPlayer1 ? state.paddle2.y : state.paddle1.y;

    // Ball target
    ballTarget.x = state.ball.x;
    ballTarget.y = state.ball.y;
  }

  function startRendering() {
    if (animFrameId) cancelAnimationFrame(animFrameId);
    lastFrameTime = 0;
    animFrameId = requestAnimationFrame(renderLoop);

    if (inputInterval) clearInterval(inputInterval);
    inputInterval = setInterval(() => {
      if (window.socket && gameId) {
        window.socket.emit('paddle-move', { gameId, direction: currentInput });
      }
    }, 33);
  }

  function stopRendering() {
    if (animFrameId) { cancelAnimationFrame(animFrameId); animFrameId = null; }
    if (inputInterval) { clearInterval(inputInterval); inputInterval = null; }
  }

  function renderLoop(timestamp) {
    if (!lastFrameTime) lastFrameTime = timestamp;
    const delta = timestamp - lastFrameTime;
    lastFrameTime = timestamp;
    const ticks = Math.min(delta / SERVER_TICK_MS, 4);

    // --- Your paddle: add local prediction to offset ---
    if (currentInput === 'up') {
      myOffset -= PADDLE_SPEED * ticks;
    } else if (currentInput === 'down') {
      myOffset += PADDLE_SPEED * ticks;
    }

    // Display = server position + prediction offset, clamped to bounds
    const myDisplayY = Math.max(0, Math.min(CANVAS_H - PADDLE_H, serverMyY + myOffset));

    // --- Opponent paddle: lerp ---
    const rLerp = 1 - Math.pow(1 - REMOTE_LERP, ticks);
    remoteDisplayY = lerp(remoteDisplayY, remoteTargetY, rLerp);

    // --- Ball: lerp ---
    const bLerp = 1 - Math.pow(1 - BALL_LERP, ticks);
    ballDisplay.x = lerp(ballDisplay.x, ballTarget.x, bLerp);
    ballDisplay.y = lerp(ballDisplay.y, ballTarget.y, bLerp);

    render(myDisplayY);
    animFrameId = requestAnimationFrame(renderLoop);
  }

  function lerp(a, b, t) {
    return a + (b - a) * t;
  }

  // Mirror an x coordinate horizontally
  function mx(x) { return mirrored ? CANVAS_W - x : x; }

  function render(myDisplayY) {
    if (!ctx) return;

    ctx.fillStyle = skinConfig.background;
    ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);

    // Center line
    ctx.setLineDash([8, 8]);
    ctx.strokeStyle = '#2d2d5e';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(CANVAS_W / 2, 0);
    ctx.lineTo(CANVAS_W / 2, CANVAS_H);
    ctx.stroke();
    ctx.setLineDash([]);

    // Score — when mirrored, swap left/right score positions
    ctx.fillStyle = 'rgba(255,255,255,0.08)';
    ctx.font = 'bold 140px monospace';
    ctx.textAlign = 'center';
    const leftScore = mirrored ? displayScore.p2 : displayScore.p1;
    const rightScore = mirrored ? displayScore.p1 : displayScore.p2;
    ctx.fillText(leftScore, CANVAS_W / 4, CANVAS_H / 2 + 50);
    ctx.fillText(rightScore, (CANVAS_W * 3) / 4, CANVAS_H / 2 + 50);

    // Paddle positions from server
    const p1Y = amPlayer1 ? myDisplayY : remoteDisplayY;
    const p2Y = amPlayer1 ? remoteDisplayY : myDisplayY;

    if (!mirrored) {
      // Normal: p1 left, p2 right
      drawPaddle(10, p1Y, amPlayer1);
      drawPaddle(CANVAS_W - PADDLE_W - 10, p2Y, !amPlayer1);
    } else {
      // Mirrored: p2 on left, p1 on right
      drawPaddle(10, p2Y, !amPlayer1);
      drawPaddle(CANVAS_W - PADDLE_W - 10, p1Y, amPlayer1);
    }

    // Ball — mirror x position
    const bx = mirrored ? (CANVAS_W - ballDisplay.x - BALL_SIZE) : ballDisplay.x;
    ctx.fillStyle = skinConfig.ball;
    ctx.shadowColor = skinConfig.ball;
    ctx.shadowBlur = 15;
    ctx.beginPath();
    ctx.arc(bx + BALL_SIZE / 2, ballDisplay.y + BALL_SIZE / 2, BALL_SIZE / 2, 0, Math.PI * 2);
    ctx.fill();
    ctx.shadowBlur = 0;

    // Pause overlay
    if (isPaused) {
      ctx.fillStyle = 'rgba(0,0,0,0.3)';
      ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);
      ctx.fillStyle = '#a855f7';
      ctx.font = 'bold 32px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('Get Ready...', CANVAS_W / 2, CANVAS_H / 2 + 12);
    }
  }

  function drawPaddle(x, y, isMe) {
    ctx.fillStyle = isMe ? skinConfig.paddle : '#6b7280';
    ctx.shadowColor = isMe ? skinConfig.paddle : 'transparent';
    ctx.shadowBlur = isMe ? 18 : 0;

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

  function setupInput() {
    document.addEventListener('keydown', (e) => {
      if (!gameId) return;
      if (['w', 'W', 's', 'S', 'ArrowUp', 'ArrowDown'].includes(e.key)) {
        e.preventDefault();
      }
      keys[e.key] = true;
      sendInput();
    });
    document.addEventListener('keyup', (e) => {
      if (!gameId) return;
      keys[e.key] = false;
      sendInput();
    });
  }

  function sendInput() {
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
    currentInput = 'stop';
    lastFrameTime = 0;
    myOffset = 0;
    Object.keys(keys).forEach(k => keys[k] = false);
  }

  return {
    init, setGameInfo, setSkins, setMirrored, updateState,
    startRendering, stopRendering, renderCountdown,
    cleanup,
  };
})();
