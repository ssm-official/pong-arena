// ===========================================
// Game Client — Canvas rendering + input
// ===========================================
// Your paddle: client-side prediction (offset reconciliation).
// Opponent + ball: interpolation between two most recent server states.
//   Renders one tick behind for perfectly smooth constant-speed motion.
// All positions rounded to integers.

const GameClient = (() => {
  const CANVAS_W = 800;
  const CANVAS_H = 600;
  const PADDLE_W = 14;
  const PADDLE_H = 110;
  const PADDLE_SPEED = 6;
  const BALL_SIZE = 12;
  const SERVER_TICK_MS = 1000 / 60;

  let canvas = null;
  let ctx = null;
  let myWallet = null;
  let amPlayer1 = false;
  let gameId = null;
  let animFrameId = null;
  let inputInterval = null;
  let lastFrameTime = 0;
  let skinConfig = { paddle: '#a855f7', ball: '#ffffff', background: '#0f0f2a' };
  let mirrored = false;

  // --- Your paddle: offset reconciliation ---
  let serverMyY = CANVAS_H / 2 - PADDLE_H / 2;
  let myOffset = 0;

  // --- Interpolation buffer for opponent + ball ---
  // We store the two most recent server snapshots and interpolate between them.
  // This gives perfectly smooth constant-speed motion at exactly 1 tick of latency.
  let prevSnap = null;  // previous server state
  let currSnap = null;  // most recent server state
  let snapElapsed = 0;  // ms since currSnap arrived

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
    prevSnap = null;
    currSnap = null;
    snapElapsed = 0;
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

    // --- Your paddle: reconcile prediction ---
    const newServerY = amPlayer1 ? state.paddle1.y : state.paddle2.y;
    myOffset -= (newServerY - serverMyY);
    serverMyY = newServerY;
    myOffset *= 0.97;
    if (myOffset > 30) myOffset = 30;
    if (myOffset < -30) myOffset = -30;

    // --- Push new snapshot into interpolation buffer ---
    prevSnap = currSnap;
    currSnap = {
      remoteY: amPlayer1 ? state.paddle2.y : state.paddle1.y,
      ballX: state.ball.x,
      ballY: state.ball.y,
    };
    snapElapsed = 0;
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
    }, 16);
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

    // --- Your paddle prediction ---
    if (currentInput === 'up') {
      myOffset -= PADDLE_SPEED * ticks;
    } else if (currentInput === 'down') {
      myOffset += PADDLE_SPEED * ticks;
    }
    const myY = Math.round(
      Math.max(0, Math.min(CANVAS_H - PADDLE_H, serverMyY + myOffset))
    );

    // --- Interpolate opponent + ball between two server snapshots ---
    snapElapsed += delta;
    let oppY, bx, by;

    if (prevSnap && currSnap) {
      // Interpolation factor: 0 = prevSnap, 1 = currSnap
      const t = Math.min(snapElapsed / SERVER_TICK_MS, 1);
      oppY = prevSnap.remoteY + (currSnap.remoteY - prevSnap.remoteY) * t;
      bx = prevSnap.ballX + (currSnap.ballX - prevSnap.ballX) * t;
      by = prevSnap.ballY + (currSnap.ballY - prevSnap.ballY) * t;
    } else if (currSnap) {
      oppY = currSnap.remoteY;
      bx = currSnap.ballX;
      by = currSnap.ballY;
    } else {
      oppY = CANVAS_H / 2 - PADDLE_H / 2;
      bx = CANVAS_W / 2;
      by = CANVAS_H / 2;
    }

    render(myY, Math.round(oppY), Math.round(bx), Math.round(by));
    animFrameId = requestAnimationFrame(renderLoop);
  }

  function render(myDisplayY, oppY, bx, by) {
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

    // Score
    ctx.fillStyle = 'rgba(255,255,255,0.08)';
    ctx.font = 'bold 140px monospace';
    ctx.textAlign = 'center';
    const leftScore = mirrored ? displayScore.p2 : displayScore.p1;
    const rightScore = mirrored ? displayScore.p1 : displayScore.p2;
    ctx.fillText(leftScore, CANVAS_W / 4, CANVAS_H / 2 + 50);
    ctx.fillText(rightScore, (CANVAS_W * 3) / 4, CANVAS_H / 2 + 50);

    // Paddles
    const p1Y = amPlayer1 ? myDisplayY : oppY;
    const p2Y = amPlayer1 ? oppY : myDisplayY;

    if (!mirrored) {
      drawPaddle(10, p1Y, amPlayer1);
      drawPaddle(CANVAS_W - PADDLE_W - 10, p2Y, !amPlayer1);
    } else {
      drawPaddle(10, p2Y, !amPlayer1);
      drawPaddle(CANVAS_W - PADDLE_W - 10, p1Y, amPlayer1);
    }

    // Ball
    const drawBx = mirrored ? (CANVAS_W - bx - BALL_SIZE) : bx;
    ctx.fillStyle = skinConfig.ball;
    ctx.shadowColor = skinConfig.ball;
    ctx.shadowBlur = 10;
    ctx.beginPath();
    ctx.arc(drawBx + BALL_SIZE / 2, by + BALL_SIZE / 2, BALL_SIZE / 2, 0, Math.PI * 2);
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
    ctx.shadowBlur = isMe ? 10 : 0;

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
    prevSnap = null;
    currSnap = null;
    Object.keys(keys).forEach(k => keys[k] = false);
  }

  return {
    init, setGameInfo, setSkins, setMirrored, updateState,
    startRendering, stopRendering, renderCountdown,
    cleanup,
  };
})();
