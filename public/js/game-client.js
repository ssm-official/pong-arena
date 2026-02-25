// ===========================================
// Game Client — Canvas rendering + input
// ===========================================
// Uses PongSim (browser global) for shared constants + prediction.
// Own paddle: 100% local, never overwritten by server.
// Ball: accept server position each snapshot, predict wall bounces between.
// Opponent paddle: lerp toward latest server position.

const GameClient = (() => {
  const CANVAS_W = PongSim.CANVAS_W;
  const CANVAS_H = PongSim.CANVAS_H;
  const PADDLE_W = PongSim.PADDLE_W;
  const PADDLE_H = PongSim.PADDLE_H;
  const PADDLE_SPEED = PongSim.PADDLE_SPEED;
  const BALL_SIZE = PongSim.BALL_SIZE;
  const PHYSICS_DT = 1000 / 60;

  const OPP_PADDLE_LERP = 0.25;

  // Skin image render dimensions (centered on paddle hitbox)
  const SKIN_DRAW_W = 60;
  const SKIN_DRAW_H = 200;

  // --- Game Sound Effects (Web Audio API) ---
  let gameAudioCtx = null;
  function getGameAudio() {
    if (!gameAudioCtx) gameAudioCtx = new (window.AudioContext || window.webkitAudioContext)();
    return gameAudioCtx;
  }
  function playGameSound(type) {
    try {
      const ctx = getGameAudio();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain);
      gain.connect(ctx.destination);
      if (type === 'paddle') {
        osc.frequency.value = 440;
        osc.type = 'square';
        gain.gain.value = 0.1;
        gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.08);
        osc.start(ctx.currentTime);
        osc.stop(ctx.currentTime + 0.08);
      } else if (type === 'wall') {
        osc.frequency.value = 300;
        osc.type = 'triangle';
        gain.gain.value = 0.06;
        gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.06);
        osc.start(ctx.currentTime);
        osc.stop(ctx.currentTime + 0.06);
      } else if (type === 'score') {
        osc.frequency.value = 220;
        osc.type = 'sawtooth';
        gain.gain.value = 0.12;
        gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.3);
        osc.start(ctx.currentTime);
        osc.stop(ctx.currentTime + 0.3);
      }
    } catch (e) { /* audio not available */ }
  }

  let canvas = null;
  let ctx = null;
  let myWallet = null;
  let amPlayer1 = false;
  let gameId = null;
  let animFrameId = null;
  let lastFrameTime = 0;
  let skinConfig = { paddle: '#a855f7', ball: '#ffffff', background: '#0f0f2a' };
  let mirrored = false;

  // Skin data for both players
  let mySkin = null;
  let opponentSkin = null;
  let mySkinImage = null;
  let opponentSkinImage = null;

  // --- Own paddle ---
  let myY = CANVAS_H / 2 - PADDLE_H / 2;

  // --- Opponent paddle (smoothed) ---
  let oppTargetY = CANVAS_H / 2 - PADDLE_H / 2;
  let oppDisplayY = CANVAS_H / 2 - PADDLE_H / 2;

  // --- Ball: local prediction ---
  let ballX = CANVAS_W / 2;
  let ballY = CANVAS_H / 2;
  let ballVx = 0;
  let ballVy = 0;
  let accumulator = 0;

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
    myY = CANVAS_H / 2 - PADDLE_H / 2;
    oppTargetY = CANVAS_H / 2 - PADDLE_H / 2;
    oppDisplayY = CANVAS_H / 2 - PADDLE_H / 2;
    ballX = CANVAS_W / 2;
    ballY = CANVAS_H / 2;
    ballVx = 0;
    ballVy = 0;
    accumulator = 0;
    lastFrameTime = 0;
  }

  function setSkins(config) {
    if (config.paddle) skinConfig.paddle = config.paddle;
    if (config.ball) skinConfig.ball = config.ball;
    if (config.background) skinConfig.background = config.background;
  }

  function setPlayerSkins(p1Skin, p2Skin) {
    if (amPlayer1) {
      mySkin = p1Skin;
      opponentSkin = p2Skin;
    } else {
      mySkin = p2Skin;
      opponentSkin = p1Skin;
    }

    mySkinImage = null;
    opponentSkinImage = null;

    if (mySkin && mySkin.type === 'image' && mySkin.imageUrl) {
      const img = new Image();
      img.src = mySkin.imageUrl;
      img.onload = () => { mySkinImage = img; };
    }
    if (opponentSkin && opponentSkin.type === 'image' && opponentSkin.imageUrl) {
      const img = new Image();
      img.src = opponentSkin.imageUrl;
      img.onload = () => { opponentSkinImage = img; };
    }

    if (mySkin && mySkin.type === 'color' && mySkin.cssValue) {
      skinConfig.paddle = mySkin.cssValue;
    } else if (!mySkin) {
      skinConfig.paddle = '#a855f7';
    }
  }

  function setMirrored(val) {
    mirrored = !!val;
  }

  /**
   * Called when a server state snapshot arrives.
   * Own paddle: NEVER touched (100% local).
   * Ball: accept server position + velocity, reset prediction.
   * Opponent paddle: set target for smooth lerp.
   */
  function updateState(state, sounds) {
    displayScore = state.score;
    isPaused = state.paused;

    // Play sounds
    if (sounds && sounds.length > 0) {
      sounds.forEach(s => playGameSound(s));
    } else if (state.sound) {
      playGameSound(state.sound);
    }

    // --- Own paddle: 100% local. Server is authoritative for collisions,
    // but client-side rendering trusts local input (identical physics). ---

    // --- Opponent paddle: set target, display lerps toward it each frame ---
    oppTargetY = amPlayer1 ? state.paddle2.y : state.paddle1.y;

    // --- Ball: accept server state directly ---
    ballX = state.ball.x;
    ballY = state.ball.y;
    ballVx = state.ball.vx || 0;
    ballVy = state.ball.vy || 0;
    accumulator = 0;
  }

  function startRendering() {
    if (animFrameId) cancelAnimationFrame(animFrameId);
    lastFrameTime = 0;
    accumulator = 0;
    animFrameId = requestAnimationFrame(renderLoop);
  }

  function stopRendering() {
    if (animFrameId) { cancelAnimationFrame(animFrameId); animFrameId = null; }
  }

  function renderLoop(timestamp) {
    if (!lastFrameTime) {
      lastFrameTime = timestamp;
      animFrameId = requestAnimationFrame(renderLoop);
      return;
    }
    let delta = timestamp - lastFrameTime;
    lastFrameTime = timestamp;

    // Cap delta to prevent spiral of death on tab switch
    if (delta > 200) delta = 200;

    accumulator += delta;

    while (accumulator >= PHYSICS_DT) {
      accumulator -= PHYSICS_DT;

      // Own paddle: move using PongSim constants
      if (currentInput === 'up') {
        myY = Math.max(0, myY - PADDLE_SPEED);
      } else if (currentInput === 'down') {
        myY = Math.min(CANVAS_H - PADDLE_H, myY + PADDLE_SPEED);
      }

      // Ball: predict between server snapshots (full physics incl. paddle collisions)
      if (!isPaused) {
        // Build a temporary state with local paddle positions for PongSim
        const p1Y = amPlayer1 ? myY : oppDisplayY;
        const p2Y = amPlayer1 ? oppDisplayY : myY;
        const tmpState = {
          ball: { x: ballX, y: ballY, vx: ballVx, vy: ballVy },
          paddle1: { y: p1Y },
          paddle2: { y: p2Y }
        };
        const result = PongSim.stepBall(tmpState);
        ballX = tmpState.ball.x;
        ballY = tmpState.ball.y;
        ballVx = tmpState.ball.vx;
        ballVy = tmpState.ball.vy;

        if (result.sound) playGameSound(result.sound);
      }
    }

    // Opponent paddle: smooth lerp toward target
    const oppDiff = oppTargetY - oppDisplayY;
    if (Math.abs(oppDiff) < 1) {
      oppDisplayY = oppTargetY;
    } else {
      oppDisplayY += oppDiff * OPP_PADDLE_LERP;
    }

    // Clamp ball to canvas for drawing
    const drawBallX = Math.max(0, Math.min(CANVAS_W - BALL_SIZE, ballX));
    const drawBallY = Math.max(0, Math.min(CANVAS_H - BALL_SIZE, ballY));

    render(
      Math.round(myY),
      Math.round(oppDisplayY),
      Math.round(drawBallX),
      Math.round(drawBallY)
    );
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
      drawPaddle(PongSim.P1_X, p1Y, amPlayer1, amPlayer1 ? mySkin : opponentSkin, amPlayer1 ? mySkinImage : opponentSkinImage, false);
      drawPaddle(PongSim.P2_LEFT, p2Y, !amPlayer1, !amPlayer1 ? mySkin : opponentSkin, !amPlayer1 ? mySkinImage : opponentSkinImage, true);
    } else {
      drawPaddle(PongSim.P1_X, p2Y, !amPlayer1, !amPlayer1 ? mySkin : opponentSkin, !amPlayer1 ? mySkinImage : opponentSkinImage, false);
      drawPaddle(PongSim.P2_LEFT, p1Y, amPlayer1, amPlayer1 ? mySkin : opponentSkin, amPlayer1 ? mySkinImage : opponentSkinImage, true);
    }

    // Ball
    const drawBx = mirrored ? (CANVAS_W - bx - BALL_SIZE) : bx;
    const bcx = drawBx + BALL_SIZE / 2;
    const bcy = by + BALL_SIZE / 2;
    ctx.fillStyle = 'rgba(168, 85, 247, 0.15)';
    ctx.beginPath();
    ctx.arc(bcx, bcy, BALL_SIZE, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = skinConfig.ball;
    ctx.shadowColor = skinConfig.ball;
    ctx.shadowBlur = 18;
    ctx.beginPath();
    ctx.arc(bcx, bcy, BALL_SIZE / 2, 0, Math.PI * 2);
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

  function drawPaddle(x, y, isMe, skin, skinImage, isRightSide) {
    let paddleColor;
    if (skin && skin.type === 'color' && skin.cssValue) {
      paddleColor = skin.cssValue;
    } else if (isMe) {
      paddleColor = skinConfig.paddle;
    } else {
      paddleColor = '#6b7280';
    }

    if (skin && skin.type === 'image' && skinImage) {
      const centerX = x + PADDLE_W / 2;
      const centerY = y + PADDLE_H / 2;
      const drawX = centerX - SKIN_DRAW_W / 2;
      const drawY = centerY - SKIN_DRAW_H / 2;

      ctx.save();
      if (isRightSide) {
        ctx.translate(centerX * 2, 0);
        ctx.scale(-1, 1);
        ctx.drawImage(skinImage, drawX, drawY, SKIN_DRAW_W, SKIN_DRAW_H);
      } else {
        ctx.drawImage(skinImage, drawX, drawY, SKIN_DRAW_W, SKIN_DRAW_H);
      }
      ctx.restore();
      return;
    }

    ctx.fillStyle = paddleColor;
    ctx.shadowColor = isMe ? paddleColor : 'transparent';
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
      const tag = document.activeElement && document.activeElement.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;
      if (['w', 'W', 's', 'S', 'ArrowUp', 'ArrowDown'].includes(e.key)) {
        e.preventDefault();
      }
      keys[e.key] = true;
      sendInput();
    });
    document.addEventListener('keyup', (e) => {
      if (!gameId) return;
      const tag = document.activeElement && document.activeElement.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;
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
    accumulator = 0;
    myY = CANVAS_H / 2 - PADDLE_H / 2;
    oppTargetY = CANVAS_H / 2 - PADDLE_H / 2;
    oppDisplayY = CANVAS_H / 2 - PADDLE_H / 2;
    ballX = CANVAS_W / 2;
    ballY = CANVAS_H / 2;
    ballVx = 0;
    ballVy = 0;
    mySkin = null;
    opponentSkin = null;
    mySkinImage = null;
    opponentSkinImage = null;
    skinConfig.paddle = '#a855f7';
    Object.keys(keys).forEach(k => keys[k] = false);
  }

  return {
    init, setGameInfo, setSkins, setPlayerSkins, setMirrored, updateState,
    startRendering, stopRendering, renderCountdown,
    cleanup,
  };
})();
