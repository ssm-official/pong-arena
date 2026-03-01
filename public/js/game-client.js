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

  const OPP_PADDLE_LERP = 0.4;
  const SYNC_INTERVAL_MS = 16; // ~60Hz position sync (match server tick rate)

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

  // Aura data for both players
  let myAura = null;
  let opponentAura = null;
  let auraTime = 0;

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
  let lastSyncTime = 0;

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
    lastSyncTime = 0;
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

  function setPlayerAuras(p1Aura, p2Aura) {
    if (amPlayer1) {
      myAura = p1Aura;
      opponentAura = p2Aura;
    } else {
      myAura = p2Aura;
      opponentAura = p1Aura;
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
        // Use oppTargetY (latest server position) for prediction accuracy, not lerped display
        const p1Y = amPlayer1 ? myY : oppTargetY;
        const p2Y = amPlayer1 ? oppTargetY : myY;
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

    // Sync own paddle position to server every frame (~60Hz)
    // Server no longer moves paddles independently — this is the sole source of truth
    if (window.socket && gameId && timestamp - lastSyncTime >= SYNC_INTERVAL_MS) {
      lastSyncTime = timestamp;
      window.socket.emit('paddle-sync', { gameId, y: myY });
    }

    // Advance aura animation clock
    auraTime += delta / 1000;

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

    // Determine aura assignments per visual slot
    const p1Aura = amPlayer1 ? myAura : opponentAura;
    const p2Aura = amPlayer1 ? opponentAura : myAura;

    if (!mirrored) {
      // Draw auras BEFORE paddles so paddle renders on top
      if (p1Aura && p1Aura.config) drawAura(PongSim.P1_X, p1Y, p1Aura, auraTime);
      if (p2Aura && p2Aura.config) drawAura(PongSim.P2_LEFT, p2Y, p2Aura, auraTime);
      drawPaddle(PongSim.P1_X, p1Y, amPlayer1, amPlayer1 ? mySkin : opponentSkin, amPlayer1 ? mySkinImage : opponentSkinImage, false);
      drawPaddle(PongSim.P2_LEFT, p2Y, !amPlayer1, !amPlayer1 ? mySkin : opponentSkin, !amPlayer1 ? mySkinImage : opponentSkinImage, true);
    } else {
      if (p2Aura && p2Aura.config) drawAura(PongSim.P1_X, p2Y, p2Aura, auraTime);
      if (p1Aura && p1Aura.config) drawAura(PongSim.P2_LEFT, p1Y, p1Aura, auraTime);
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

  // ===========================================
  // AURA EFFECTS — 7 animated canvas effects
  // ===========================================
  function drawAura(x, y, aura, t) {
    const cfg = aura.config;
    if (!cfg || !cfg.effect) return;
    const intensity = cfg.intensity || 1.0;
    const speed = cfg.speed || 1.0;
    const color = cfg.color || '#a855f7';
    const color2 = cfg.color2 || color;
    const st = t * speed; // speed-adjusted time

    switch (cfg.effect) {
      case 'glow-pulse': drawGlowPulse(x, y, color, intensity, st); break;
      case 'particle-trail': drawParticleTrail(x, y, color, color2, intensity, st); break;
      case 'ring-orbit': drawRingOrbit(x, y, color, intensity, st); break;
      case 'flame': drawFlame(x, y, color, color2, intensity, st); break;
      case 'electric': drawElectric(x, y, color, intensity, st); break;
      case 'rainbow': drawRainbow(x, y, intensity, st); break;
      case 'frost': drawFrost(x, y, color, intensity, st); break;
    }
  }

  function drawGlowPulse(x, y, color, intensity, t) {
    ctx.save();
    const cx = x + PADDLE_W / 2;
    const cy = y + PADDLE_H / 2;
    const pulse = 0.5 + 0.5 * Math.sin(t * 3);
    const blur = (15 + pulse * 20) * intensity;
    ctx.shadowColor = color;
    ctx.shadowBlur = blur;
    ctx.fillStyle = 'rgba(0,0,0,0)';
    ctx.beginPath();
    ctx.roundRect(x - 4, y - 4, PADDLE_W + 8, PADDLE_H + 8, 8);
    ctx.fill();
    // Double pass for stronger glow
    ctx.shadowBlur = blur * 0.6;
    ctx.fill();
    ctx.shadowBlur = 0;
    ctx.restore();
  }

  function drawParticleTrail(x, y, color, color2, intensity, t) {
    ctx.save();
    const count = Math.floor(12 * intensity);
    for (let i = 0; i < count; i++) {
      const seed = i * 137.508; // golden angle
      const phase = (t * 2 + seed) % 4;
      const side = i % 4; // 0=top, 1=right, 2=bottom, 3=left
      let px, py;
      const progress = phase / 4;
      if (side === 0) { px = x + progress * PADDLE_W; py = y - 3 + Math.sin(t * 3 + seed) * 5; }
      else if (side === 1) { px = x + PADDLE_W + 3 + Math.sin(t * 3 + seed) * 5; py = y + progress * PADDLE_H; }
      else if (side === 2) { px = x + PADDLE_W - progress * PADDLE_W; py = y + PADDLE_H + 3 + Math.sin(t * 3 + seed) * 5; }
      else { px = x - 3 + Math.sin(t * 3 + seed) * 5; py = y + PADDLE_H - progress * PADDLE_H; }
      const size = (2 + Math.sin(t * 5 + seed) * 1.5) * intensity;
      const alpha = 0.4 + 0.3 * Math.sin(t * 4 + seed);
      ctx.globalAlpha = alpha;
      ctx.fillStyle = i % 2 === 0 ? color : color2;
      ctx.beginPath();
      ctx.arc(px, py, size, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
    ctx.restore();
  }

  function drawRingOrbit(x, y, color, intensity, t) {
    ctx.save();
    const cx = x + PADDLE_W / 2;
    const cy = y + PADDLE_H / 2;
    const count = Math.floor(6 * intensity);
    for (let i = 0; i < count; i++) {
      const angle = (t * 2 + i * (Math.PI * 2 / count));
      const rx = (PADDLE_W / 2 + 12) * intensity;
      const ry = (PADDLE_H / 2 + 8) * intensity;
      const px = cx + Math.cos(angle) * rx;
      const py = cy + Math.sin(angle) * ry;
      const size = 2.5 * intensity;
      ctx.fillStyle = color;
      ctx.shadowColor = color;
      ctx.shadowBlur = 6;
      ctx.globalAlpha = 0.7;
      ctx.beginPath();
      ctx.arc(px, py, size, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.shadowBlur = 0;
    ctx.globalAlpha = 1;
    ctx.restore();
  }

  function drawFlame(x, y, color, color2, intensity, t) {
    ctx.save();
    const count = Math.floor(16 * intensity);
    for (let i = 0; i < count; i++) {
      const seed = i * 97.31;
      const edge = i % 2; // 0=left edge, 1=right edge
      const baseX = edge === 0 ? x - 2 : x + PADDLE_W + 2;
      const baseY = y + (i / count) * PADDLE_H;
      const flicker = Math.sin(t * 8 + seed) * 4 + Math.sin(t * 13 + seed * 2) * 2;
      const rise = Math.sin(t * 6 + seed) * 6;
      const px = baseX + (edge === 0 ? -flicker : flicker);
      const py = baseY + rise;
      const size = (1.5 + Math.sin(t * 10 + seed) * 1.5) * intensity;
      const alpha = 0.3 + 0.4 * Math.abs(Math.sin(t * 7 + seed));
      ctx.globalAlpha = alpha;
      ctx.fillStyle = Math.sin(t * 5 + seed) > 0 ? color : color2;
      ctx.beginPath();
      ctx.arc(px, py, size, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
    ctx.restore();
  }

  function drawElectric(x, y, color, intensity, t) {
    ctx.save();
    ctx.strokeStyle = color;
    ctx.shadowColor = color;
    ctx.shadowBlur = 8;
    ctx.lineWidth = 1.5 * intensity;
    const segments = Math.floor(6 * intensity);
    for (let i = 0; i < segments; i++) {
      const seed = i * 53.7;
      // Only draw if "active" this frame (flickering)
      if (Math.sin(t * 12 + seed) < 0.2) continue;
      ctx.globalAlpha = 0.5 + 0.5 * Math.abs(Math.sin(t * 15 + seed));
      const startAngle = (t * 3 + seed) % (Math.PI * 2);
      const cx = x + PADDLE_W / 2;
      const cy = y + PADDLE_H / 2;
      const r = PADDLE_W / 2 + 6 + Math.sin(t * 8 + seed) * 4;
      ctx.beginPath();
      const sx = cx + Math.cos(startAngle) * r;
      const sy = cy + Math.sin(startAngle) * (PADDLE_H / 2 + 6);
      ctx.moveTo(sx, sy);
      for (let j = 1; j <= 3; j++) {
        const a = startAngle + j * 0.3;
        const jr = r + (Math.random() - 0.5) * 8 * intensity;
        ctx.lineTo(
          cx + Math.cos(a) * jr,
          cy + Math.sin(a) * (PADDLE_H / 2 + 6 + (Math.random() - 0.5) * 6)
        );
      }
      ctx.stroke();
    }
    ctx.shadowBlur = 0;
    ctx.globalAlpha = 1;
    ctx.restore();
  }

  function drawRainbow(x, y, intensity, t) {
    ctx.save();
    const hue = (t * 60) % 360;
    const color = `hsl(${hue}, 100%, 60%)`;
    const cx = x + PADDLE_W / 2;
    const cy = y + PADDLE_H / 2;
    const pulse = 0.5 + 0.5 * Math.sin(t * 2);
    const blur = (12 + pulse * 18) * intensity;
    ctx.shadowColor = color;
    ctx.shadowBlur = blur;
    ctx.fillStyle = 'rgba(0,0,0,0)';
    ctx.beginPath();
    ctx.roundRect(x - 4, y - 4, PADDLE_W + 8, PADDLE_H + 8, 8);
    ctx.fill();
    ctx.shadowBlur = blur * 0.5;
    ctx.fill();
    // Small orbiting dots in rainbow
    const count = Math.floor(4 * intensity);
    for (let i = 0; i < count; i++) {
      const a = t * 2 + i * (Math.PI * 2 / count);
      const h2 = (hue + i * 90) % 360;
      ctx.shadowBlur = 4;
      ctx.shadowColor = `hsl(${h2}, 100%, 60%)`;
      ctx.fillStyle = `hsl(${h2}, 100%, 60%)`;
      ctx.globalAlpha = 0.6;
      ctx.beginPath();
      ctx.arc(
        cx + Math.cos(a) * (PADDLE_W / 2 + 10),
        cy + Math.sin(a) * (PADDLE_H / 2 + 6),
        2 * intensity, 0, Math.PI * 2
      );
      ctx.fill();
    }
    ctx.shadowBlur = 0;
    ctx.globalAlpha = 1;
    ctx.restore();
  }

  function drawFrost(x, y, color, intensity, t) {
    ctx.save();
    const frostColor = color || '#93c5fd';
    const count = Math.floor(10 * intensity);
    for (let i = 0; i < count; i++) {
      const seed = i * 173.13;
      const phase = ((t * 0.5 + seed / 100) % 3) / 3; // slow drift
      const side = i % 4;
      let px, py;
      if (side === 0) { px = x + phase * PADDLE_W; py = y - 4 + Math.sin(t + seed) * 3; }
      else if (side === 1) { px = x + PADDLE_W + 4 + Math.sin(t + seed) * 3; py = y + phase * PADDLE_H; }
      else if (side === 2) { px = x + PADDLE_W * (1 - phase); py = y + PADDLE_H + 4 + Math.sin(t + seed) * 3; }
      else { px = x - 4 + Math.sin(t + seed) * 3; py = y + PADDLE_H * (1 - phase); }
      // Snowflake-like: small cross
      const size = (1.5 + Math.sin(t * 0.8 + seed) * 0.8) * intensity;
      ctx.globalAlpha = 0.3 + 0.3 * Math.sin(t * 0.7 + seed);
      ctx.strokeStyle = frostColor;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(px - size, py); ctx.lineTo(px + size, py);
      ctx.moveTo(px, py - size); ctx.lineTo(px, py + size);
      ctx.stroke();
      // Small dot center
      ctx.fillStyle = frostColor;
      ctx.beginPath();
      ctx.arc(px, py, size * 0.5, 0, Math.PI * 2);
      ctx.fill();
    }
    // Subtle icy glow
    ctx.shadowColor = frostColor;
    ctx.shadowBlur = 8 * intensity;
    ctx.fillStyle = 'rgba(0,0,0,0)';
    ctx.globalAlpha = 0.3;
    ctx.beginPath();
    ctx.roundRect(x - 3, y - 3, PADDLE_W + 6, PADDLE_H + 6, 6);
    ctx.fill();
    ctx.shadowBlur = 0;
    ctx.globalAlpha = 1;
    ctx.restore();
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
        window.socket.emit('paddle-move', { gameId, direction: dir, y: myY });
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
    lastSyncTime = 0;
    mySkin = null;
    opponentSkin = null;
    mySkinImage = null;
    opponentSkinImage = null;
    myAura = null;
    opponentAura = null;
    auraTime = 0;
    skinConfig.paddle = '#a855f7';
    Object.keys(keys).forEach(k => keys[k] = false);
  }

  return {
    init, setGameInfo, setSkins, setPlayerSkins, setPlayerAuras, setMirrored, updateState,
    startRendering, stopRendering, renderCountdown,
    cleanup,
  };
})();
