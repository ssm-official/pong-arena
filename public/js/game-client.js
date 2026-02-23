// ===========================================
// Game Client — Canvas rendering + input
// ===========================================
// Server-authoritative: ALL positions come from server state.
// Both paddles, ball interpolated with lerp for smooth display.
// Your paddle uses a faster lerp so it feels responsive.
// No client-side prediction — ensures both players see the same thing
// and collision always matches what's on screen.

const GameClient = (() => {
  const CANVAS_W = 800;
  const CANVAS_H = 600;
  const PADDLE_W = 14;
  const PADDLE_H = 110;
  const BALL_SIZE = 12;
  const SERVER_TICK_MS = 1000 / 60;

  // Lerp factors per server tick — your paddle is faster for responsiveness
  const MY_PADDLE_LERP = 0.55;
  const REMOTE_PADDLE_LERP = 0.35;
  const BALL_LERP = 0.5;

  let canvas = null;
  let ctx = null;
  let serverState = null;
  let myWallet = null;
  let amPlayer1 = false;
  let gameId = null;
  let animFrameId = null;
  let inputInterval = null;
  let lastFrameTime = 0;
  let skinConfig = { paddle: '#a855f7', ball: '#ffffff', background: '#0f0f2a' };

  // Display positions — all driven by server, smoothed with lerp
  let displayP1Y = CANVAS_H / 2 - PADDLE_H / 2;
  let displayP2Y = CANVAS_H / 2 - PADDLE_H / 2;
  let targetP1Y = CANVAS_H / 2 - PADDLE_H / 2;
  let targetP2Y = CANVAS_H / 2 - PADDLE_H / 2;
  let displayBall = { x: CANVAS_W / 2, y: CANVAS_H / 2 };
  let displayScore = { p1: 0, p2: 0 };
  let isPaused = false;

  // Input tracking
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
    displayP1Y = targetP1Y = mid;
    displayP2Y = targetP2Y = mid;
    displayBall = { x: CANVAS_W / 2, y: CANVAS_H / 2 };
    lastFrameTime = 0;
  }

  function setSkins(config) {
    if (config.paddle) skinConfig.paddle = config.paddle;
    if (config.ball) skinConfig.ball = config.ball;
    if (config.background) skinConfig.background = config.background;
  }

  function updateState(state) {
    serverState = state;
    displayScore = state.score;
    isPaused = state.paused;

    // Set targets from server — lerp will smooth the display
    targetP1Y = state.paddle1.y;
    targetP2Y = state.paddle2.y;
  }

  function startRendering() {
    if (animFrameId) cancelAnimationFrame(animFrameId);
    lastFrameTime = 0;
    animFrameId = requestAnimationFrame(renderLoop);

    // Resend input every 50ms as heartbeat for packet loss
    if (inputInterval) clearInterval(inputInterval);
    inputInterval = setInterval(() => {
      if (window.socket && gameId && currentInput !== 'stop') {
        window.socket.emit('paddle-move', { gameId, direction: currentInput });
      }
    }, 50);
  }

  function stopRendering() {
    if (animFrameId) { cancelAnimationFrame(animFrameId); animFrameId = null; }
    if (inputInterval) { clearInterval(inputInterval); inputInterval = null; }
  }

  function renderLoop(timestamp) {
    if (!lastFrameTime) lastFrameTime = timestamp;
    const delta = timestamp - lastFrameTime;
    lastFrameTime = timestamp;

    // How many server ticks worth of time passed this frame
    const ticks = Math.min(delta / SERVER_TICK_MS, 4); // cap to prevent huge jumps

    // Frame-rate independent lerp: 1 - (1 - base)^ticks
    const myLerp = 1 - Math.pow(1 - MY_PADDLE_LERP, ticks);
    const remoteLerp = 1 - Math.pow(1 - REMOTE_PADDLE_LERP, ticks);
    const ballLerp = 1 - Math.pow(1 - BALL_LERP, ticks);

    // Interpolate both paddles toward server targets
    displayP1Y = lerp(displayP1Y, targetP1Y, amPlayer1 ? myLerp : remoteLerp);
    displayP2Y = lerp(displayP2Y, targetP2Y, amPlayer1 ? remoteLerp : myLerp);

    // Interpolate ball
    if (serverState) {
      displayBall.x = lerp(displayBall.x, serverState.ball.x, ballLerp);
      displayBall.y = lerp(displayBall.y, serverState.ball.y, ballLerp);
    }

    render();
    animFrameId = requestAnimationFrame(renderLoop);
  }

  function lerp(current, target, factor) {
    return current + (target - current) * factor;
  }

  function render() {
    if (!ctx) return;

    // Background
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

    // Score
    ctx.fillStyle = 'rgba(255,255,255,0.08)';
    ctx.font = 'bold 140px monospace';
    ctx.textAlign = 'center';
    ctx.fillText(displayScore.p1, CANVAS_W / 4, CANVAS_H / 2 + 50);
    ctx.fillText(displayScore.p2, (CANVAS_W * 3) / 4, CANVAS_H / 2 + 50);

    // Paddles
    drawPaddle(10, displayP1Y, amPlayer1);
    drawPaddle(CANVAS_W - PADDLE_W - 10, displayP2Y, !amPlayer1);

    // Ball
    ctx.fillStyle = skinConfig.ball;
    ctx.shadowColor = skinConfig.ball;
    ctx.shadowBlur = 15;
    ctx.beginPath();
    ctx.arc(displayBall.x + BALL_SIZE / 2, displayBall.y + BALL_SIZE / 2, BALL_SIZE / 2, 0, Math.PI * 2);
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
    const color = isMe ? skinConfig.paddle : '#6b7280';
    ctx.fillStyle = color;
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

  // ---- Input Handling ----
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
    serverState = null;
    currentInput = 'stop';
    lastFrameTime = 0;
    Object.keys(keys).forEach(k => keys[k] = false);
  }

  return {
    init, setGameInfo, setSkins, updateState,
    startRendering, stopRendering, renderCountdown,
    cleanup,
  };
})();
