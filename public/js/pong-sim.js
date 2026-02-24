// ===========================================
// PongSim — Shared Deterministic Physics
// ===========================================
// Isomorphic module: works in Node.js (require) and browser (<script>).
// Contains zero randomness — all random values (launch angle/dir)
// must be injected by the caller.

(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.PongSim = factory();
  }
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // =============================================
  // CONSTANTS
  // =============================================
  var CANVAS_W = 800;
  var CANVAS_H = 600;
  var PADDLE_W = 26;
  var PADDLE_H = 110;
  var PADDLE_SPEED = 6;
  var BALL_SIZE = 16;
  var BALL_SPEED_INITIAL = 4;
  var BALL_SPEED_INCREMENT = 0.25;
  var BALL_MAX_SPEED = 14;
  var WIN_SCORE = 5;
  var SCORE_PAUSE_TICKS = 120; // 2 seconds at 60 ticks/sec

  // Paddle edge positions (left edge of paddle 1, right edge of paddle 1, etc.)
  var P1_X = 10;
  var P1_RIGHT = P1_X + PADDLE_W;       // 36
  var P2_LEFT = CANVAS_W - 10 - PADDLE_W; // 764
  var P2_RIGHT = CANVAS_W - 10;           // 790

  // =============================================
  // STATE FACTORY
  // =============================================
  function createState() {
    return {
      ball: {
        x: CANVAS_W / 2 - BALL_SIZE / 2,
        y: CANVAS_H / 2 - BALL_SIZE / 2,
        vx: 0,
        vy: 0
      },
      paddle1: { y: CANVAS_H / 2 - PADDLE_H / 2 },
      paddle2: { y: CANVAS_H / 2 - PADDLE_H / 2 },
      score: { p1: 0, p2: 0 },
      status: 'playing',
      winner: null,
      paused: false,
      pauseTicks: 0,
      sound: null
    };
  }

  // =============================================
  // INPUT
  // =============================================
  // playerIndex: 1 or 2
  // direction: 'up', 'down', or 'stop'
  function applyInput(state, playerIndex, direction) {
    var paddle = playerIndex === 1 ? state.paddle1 : state.paddle2;
    if (direction === 'up') {
      paddle.y = Math.max(0, paddle.y - PADDLE_SPEED);
    } else if (direction === 'down') {
      paddle.y = Math.min(CANVAS_H - PADDLE_H, paddle.y + PADDLE_SPEED);
    }
  }

  // =============================================
  // BALL STEP — Sub-step swept collision
  // =============================================
  // Returns { scored: null | 1 | 2, sound: null | 'wall' | 'paddle' | 'score' }
  function stepBall(state) {
    var ball = state.ball;
    var paddle1 = state.paddle1;
    var paddle2 = state.paddle2;
    var result = { scored: null, sound: null };

    // Number of sub-steps based on speed vs paddle width
    var speed = Math.sqrt(ball.vx * ball.vx + ball.vy * ball.vy);
    var steps = Math.max(1, Math.ceil(speed / (PADDLE_W / 2)));
    var stepVx = ball.vx / steps;
    var stepVy = ball.vy / steps;

    for (var s = 0; s < steps; s++) {
      var oldX = ball.x;
      var oldY = ball.y;

      ball.x += stepVx;
      ball.y += stepVy;

      // --- Top wall bounce ---
      if (ball.y <= 0) {
        ball.vy = Math.abs(ball.vy);
        ball.y = -ball.y;
        result.sound = 'wall';
      }
      // --- Bottom wall bounce ---
      if (ball.y >= CANVAS_H - BALL_SIZE) {
        ball.vy = -Math.abs(ball.vy);
        ball.y = 2 * (CANVAS_H - BALL_SIZE) - ball.y;
        result.sound = 'wall';
      }

      // --- Left paddle collision (player 1) ---
      if (ball.vx < 0) {
        // Swept test: ball left edge crossed paddle right edge this sub-step
        if (oldX >= P1_RIGHT && ball.x < P1_RIGHT) {
          var t = (oldX - P1_RIGHT) / (oldX - ball.x);
          var hitY = oldY + (ball.y - oldY) * t;
          if (hitY + BALL_SIZE >= paddle1.y && hitY <= paddle1.y + PADDLE_H) {
            var spd = Math.min(Math.abs(ball.vx) + BALL_SPEED_INCREMENT, BALL_MAX_SPEED);
            ball.vx = spd;
            ball.x = P1_RIGHT;
            ball.y = hitY;
            var hitPos = (ball.y + BALL_SIZE / 2 - paddle1.y) / PADDLE_H;
            ball.vy = (hitPos - 0.5) * spd * 1.5;
            result.sound = 'paddle';
            break;
          }
        }
        // Overlap fallback
        if (ball.x < P1_RIGHT && ball.x + BALL_SIZE > P1_X &&
            ball.y + BALL_SIZE > paddle1.y && ball.y < paddle1.y + PADDLE_H) {
          var spd2 = Math.min(Math.abs(ball.vx) + BALL_SPEED_INCREMENT, BALL_MAX_SPEED);
          ball.vx = spd2;
          ball.x = P1_RIGHT;
          var hitPos2 = (ball.y + BALL_SIZE / 2 - paddle1.y) / PADDLE_H;
          ball.vy = (hitPos2 - 0.5) * spd2 * 1.5;
          result.sound = 'paddle';
          break;
        }
      }

      // --- Right paddle collision (player 2) ---
      if (ball.vx > 0) {
        var oldRight = oldX + BALL_SIZE;
        var newRight = ball.x + BALL_SIZE;
        // Swept test: ball right edge crossed paddle left edge this sub-step
        if (oldRight <= P2_LEFT && newRight > P2_LEFT) {
          var t2 = (P2_LEFT - oldRight) / (newRight - oldRight);
          var hitY2 = oldY + (ball.y - oldY) * t2;
          if (hitY2 + BALL_SIZE >= paddle2.y && hitY2 <= paddle2.y + PADDLE_H) {
            var spd3 = Math.min(Math.abs(ball.vx) + BALL_SPEED_INCREMENT, BALL_MAX_SPEED);
            ball.vx = -spd3;
            ball.x = P2_LEFT - BALL_SIZE;
            ball.y = hitY2;
            var hitPos3 = (ball.y + BALL_SIZE / 2 - paddle2.y) / PADDLE_H;
            ball.vy = (hitPos3 - 0.5) * spd3 * 1.5;
            result.sound = 'paddle';
            break;
          }
        }
        // Overlap fallback
        if (ball.x + BALL_SIZE > P2_LEFT && ball.x < P2_RIGHT &&
            ball.y + BALL_SIZE > paddle2.y && ball.y < paddle2.y + PADDLE_H) {
          var spd4 = Math.min(Math.abs(ball.vx) + BALL_SPEED_INCREMENT, BALL_MAX_SPEED);
          ball.vx = -spd4;
          ball.x = P2_LEFT - BALL_SIZE;
          var hitPos4 = (ball.y + BALL_SIZE / 2 - paddle2.y) / PADDLE_H;
          ball.vy = (hitPos4 - 0.5) * spd4 * 1.5;
          result.sound = 'paddle';
          break;
        }
      }

      // --- Scoring ---
      if (ball.x + BALL_SIZE < 0) {
        result.scored = 2; // player 2 scores
        result.sound = 'score';
        return result;
      }
      if (ball.x > CANVAS_W) {
        result.scored = 1; // player 1 scores
        result.sound = 'score';
        return result;
      }
    }

    return result;
  }

  // =============================================
  // BALL LAUNCH — caller injects angle + direction
  // =============================================
  function launchBall(state, angle, direction) {
    state.ball.vx = Math.cos(angle) * BALL_SPEED_INITIAL * direction;
    state.ball.vy = Math.sin(angle) * BALL_SPEED_INITIAL;
  }

  // =============================================
  // RESET BALL AFTER SCORE
  // =============================================
  function resetBallAfterScore(state) {
    state.ball.x = CANVAS_W / 2 - BALL_SIZE / 2;
    state.ball.y = CANVAS_H / 2 - BALL_SIZE / 2;
    state.ball.vx = 0;
    state.ball.vy = 0;
    state.pauseTicks = SCORE_PAUSE_TICKS;
    state.paused = true;
  }

  // =============================================
  // TICK PAUSE — decrement pauseTicks
  // =============================================
  // Returns true when pause ends (pauseTicks reaches 0)
  function tickPause(state) {
    if (state.pauseTicks <= 0) return false;
    state.pauseTicks--;
    if (state.pauseTicks === 0) {
      state.paused = false;
      return true; // pause just ended, caller should launch ball
    }
    return false;
  }

  // =============================================
  // CLONE STATE — deep copy for snapshots
  // =============================================
  function cloneState(state) {
    return {
      ball: { x: state.ball.x, y: state.ball.y, vx: state.ball.vx, vy: state.ball.vy },
      paddle1: { y: state.paddle1.y },
      paddle2: { y: state.paddle2.y },
      score: { p1: state.score.p1, p2: state.score.p2 },
      status: state.status,
      winner: state.winner,
      paused: state.paused,
      pauseTicks: state.pauseTicks,
      sound: state.sound
    };
  }

  // =============================================
  // SERIALIZE STATE — network-ready shape
  // =============================================
  // Strips internal fields (pauseTicks) for network transmission
  function serializeState(state) {
    return {
      ball: { x: state.ball.x, y: state.ball.y, vx: state.ball.vx, vy: state.ball.vy },
      paddle1: { y: state.paddle1.y },
      paddle2: { y: state.paddle2.y },
      score: { p1: state.score.p1, p2: state.score.p2 },
      status: state.status,
      winner: state.winner,
      paused: state.paused,
      sound: state.sound
    };
  }

  // =============================================
  // PUBLIC API
  // =============================================
  return {
    // Constants
    CANVAS_W: CANVAS_W,
    CANVAS_H: CANVAS_H,
    PADDLE_W: PADDLE_W,
    PADDLE_H: PADDLE_H,
    PADDLE_SPEED: PADDLE_SPEED,
    BALL_SIZE: BALL_SIZE,
    BALL_SPEED_INITIAL: BALL_SPEED_INITIAL,
    BALL_SPEED_INCREMENT: BALL_SPEED_INCREMENT,
    BALL_MAX_SPEED: BALL_MAX_SPEED,
    WIN_SCORE: WIN_SCORE,
    SCORE_PAUSE_TICKS: SCORE_PAUSE_TICKS,
    P1_X: P1_X,
    P1_RIGHT: P1_RIGHT,
    P2_LEFT: P2_LEFT,
    P2_RIGHT: P2_RIGHT,

    // Functions
    createState: createState,
    applyInput: applyInput,
    stepBall: stepBall,
    launchBall: launchBall,
    resetBallAfterScore: resetBallAfterScore,
    tickPause: tickPause,
    cloneState: cloneState,
    serializeState: serializeState
  };
}));
