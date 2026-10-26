// ============================================================
// Flappy Bird - 全新重制版
// 纯原生 Canvas 实现，零依赖、离线可玩
// 架构：固定时间步长物理 + 状态机 (READY/PLAYING/DYING/OVER)
// ============================================================
"use strict";

(function () {
  // ---------- 配置 ----------
  const CFG = {
    W: 400, H: 600,
    GROUND_H: 80,
    gravity: 2100,          // px/s^2
    jumpForce: -560,        // px/s
    birdX: 90,
    birdR: 13,              // 碰撞半径
    pipeSpeed: 140,         // px/s
    pipeW: 56,
    gap: 165,
    gapMin: 122,
    spawnDist: 220,         // 管道间距（像素）
    speedGain: 1.6,         // 每分增加的速度
    speedMax: 90,           // 最大加成
  };

  // ---------- 画布 ----------
  const canvas = document.createElement("canvas");
  canvas.width = CFG.W;
  canvas.height = CFG.H;
  document.body.appendChild(canvas);
  const ctx = canvas.getContext("2d");

  function fitScreen() {
    const s = Math.min(innerWidth / CFG.W, innerHeight / CFG.H, 1.5);
    canvas.style.width = CFG.W * s + "px";
    canvas.style.height = CFG.H * s + "px";
  }
  addEventListener("resize", fitScreen);
  fitScreen();

  // ---------- 状态 ----------
  const ST = { READY: 0, PLAYING: 1, DYING: 2, OVER: 3 };
  let state = ST.READY;
  let score = 0;
  let best = +(localStorage.getItem("flappyBest2") || 0);
  let newBest = false;
  let time = 0;           // 全局时间（秒）
  let overAt = 0;
  let flash = 0;          // 撞击白闪
  let paused = false;

  const bird = { x: CFG.birdX, y: CFG.H / 2, vy: 0, rot: 0, wing: 0 };
  let pipes = [];         // {x, top, passed}
  let particles = [];
  let clouds = [];
  let groundX = 0;
  let distSinceSpawn = 0;
  let speed = CFG.pipeSpeed;
  let gap = CFG.gap;

  for (let i = 0; i < 6; i++) {
    clouds.push({ x: Math.random() * CFG.W, y: 30 + Math.random() * 180, s: 0.5 + Math.random() * 0.9 });
  }

  // ---------- 音效 ----------
  const AC = window.AudioContext || window.webkitAudioContext;
  let actx = null;
  function audio() { if (!actx && AC) actx = new AC(); if (actx && actx.state === "suspended") actx.resume(); }
  function tone(freq, dur, type, vol, slideTo) {
    if (!actx) return;
    const o = actx.createOscillator(), g = actx.createGain(), t = actx.currentTime;
    o.type = type; o.frequency.setValueAtTime(freq, t);
    if (slideTo) o.frequency.linearRampToValueAtTime(slideTo, t + dur);
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    o.connect(g); g.connect(actx.destination);
    o.start(t); o.stop(t + dur);
  }
  const sfx = {
    flap:  () => tone(420, 0.12, "sine",   0.14, 760),
    point: () => { tone(920, 0.07, "square", 0.05); setTimeout(() => tone(1380, 0.12, "square", 0.05), 60); },
    hit:   () => tone(160, 0.22, "sawtooth", 0.16, 70),
    die:   () => setTimeout(() => tone(700, 0.5, "sine", 0.08, 120), 120),
  };

  // ---------- 工具 ----------
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const rand = (a, b) => a + Math.random() * (b - a);

  function burst(x, y, colors, n = 12) {
    for (let i = 0; i < n; i++) {
      particles.push({
        x, y,
        vx: rand(-130, 130), vy: rand(-260, -40),
        life: rand(0.4, 0.8), t: 0, r: rand(2, 4.5),
        c: colors[(Math.random() * colors.length) | 0],
      });
    }
  }

  // ---------- 昼夜主题 ----------
  function theme() {
    // 每 15 分在白天 <-> 黑夜间切换（平滑过渡）
    const phase = score % 30;
    const t = phase < 15 ? 0 : clamp((phase - 12) / 3, 0, 1); // 3分内完成过渡
    const lerp = (a, b) => a + (b - a) * t;
    const mix = (c1, c2) => `rgb(${(lerp(c1[0], c2[0])) | 0},${(lerp(c1[1], c2[1])) | 0},${(lerp(c1[2], c2[2])) | 0})`;
    return {
      night: t > 0.5,
      skyTop: mix([112, 197, 235], [26, 28, 64]),
      skyBot: mix([205, 240, 252], [70, 46, 96]),
      hill: mix([126, 200, 120], [40, 52, 78]),
      cloud: t > 0.5 ? "rgba(255,255,255,0.25)" : "rgba(255,255,255,0.8)",
      ground: mix([222, 184, 106], [120, 96, 70]),
      groundDark: mix([196, 156, 82], [96, 76, 55]),
    };
  }

  // ---------- 游戏流程 ----------
  function reset() {
    bird.x = CFG.birdX; bird.y = CFG.H / 2; bird.vy = 0; bird.rot = 0;
    pipes = []; particles = [];
    score = 0; speed = CFG.pipeSpeed; gap = CFG.gap;
    distSinceSpawn = CFG.spawnDist * 0.55; // 开局稍等再出第一根
    newBest = false;
  }

  function flap() {
    audio();
    if (state === ST.READY) {
      state = ST.PLAYING;
      reset();
      bird.vy = CFG.jumpForce;
      sfx.flap();
    } else if (state === ST.PLAYING) {
      bird.vy = CFG.jumpForce;
      bird.wing = 0;
      sfx.flap();
      burst(bird.x - 10, bird.y + 10, ["#ffffff", "#e8f4ff"], 5);
    } else if (state === ST.OVER && time - overAt > 0.6) {
      state = ST.READY;
    }
  }

  function die() {
    if (state !== ST.PLAYING) return;
    state = ST.DYING;
    flash = 1;
    sfx.hit(); sfx.die();
    burst(bird.x, bird.y, ["#ff5a4e", "#ffb347", "#ffffff"], 18);
    if (score > best) { best = score; newBest = true; localStorage.setItem("flappyBest2", best); }
  }

  // ---------- 更新 ----------
  function spawnPipe() {
    const margin = 60;
    pipes.push({ x: CFG.W + 10, top: rand(margin, CFG.H - CFG.GROUND_H - margin - gap), passed: false });
  }

  function update(dt) {
    time += dt;
    flash = Math.max(0, flash - dt * 3);

    // 云
    const th = theme();
    for (const c of clouds) {
      c.x -= speed * 0.25 * c.s * dt * (state === ST.PLAYING || state === ST.DYING ? 1 : 0.6);
      if (c.x < -90) { c.x = CFG.W + 90; c.y = rand(30, 210); }
    }

    // 粒子
    for (let i = particles.length - 1; i >= 0; i--) {
      const p = particles[i];
      p.t += dt; p.x += p.vx * dt; p.y += p.vy * dt; p.vy += 700 * dt;
      if (p.t >= p.life) particles.splice(i, 1);
    }

    if (state === ST.READY) {
      bird.y = CFG.H / 2 + Math.sin(time * 4.5) * 10;
      bird.rot = Math.sin(time * 4.5) * 0.12;
      bird.wing += dt * 14;
      groundX = (groundX - speed * 0.5 * dt) % 24;
      return;
    }

    if (state === ST.DYING || state === ST.OVER) {
      bird.vy += CFG.gravity * 1.35 * dt;
      bird.y += bird.vy * dt;
      bird.rot = Math.min(bird.rot + dt * 6, Math.PI / 2);
      const floor = CFG.H - CFG.GROUND_H - CFG.birdR;
      if (bird.y >= floor) {
        bird.y = floor;
        bird.vy = 0;
        if (state === ST.DYING) { state = ST.OVER; overAt = time; }
      }
      return;
    }

    // ---- PLAYING ----
    bird.vy += CFG.gravity * dt;
    bird.y += bird.vy * dt;
    bird.rot = clamp(bird.vy / 600, -0.42, 1.25);
    bird.wing += dt * (bird.vy < 0 ? 26 : 12);
    groundX = (groundX - speed * dt) % 24;

    // 管道
    distSinceSpawn += speed * dt;
    if (distSinceSpawn >= CFG.spawnDist) { distSinceSpawn -= CFG.spawnDist; spawnPipe(); }
    for (let i = pipes.length - 1; i >= 0; i--) {
      const p = pipes[i];
      p.x -= speed * dt;
      if (p.x + CFG.pipeW < -10) { pipes.splice(i, 1); continue; }
      // 碰撞（圆 vs 矩形）
      if (circleRect(bird.x, bird.y, CFG.birdR, p.x, 0, CFG.pipeW, p.top) ||
          circleRect(bird.x, bird.y, CFG.birdR, p.x, p.top + gap, CFG.pipeW, CFG.H - CFG.GROUND_H - p.top - gap)) {
        die(); return;
      }
      // 得分
      if (!p.passed && p.x + CFG.pipeW < bird.x - CFG.birdR) {
        p.passed = true;
        score++;
        sfx.point();
        burst(bird.x + 14, bird.y, ["#ffe066", "#fff3b0"], 10);
        speed = Math.min(CFG.pipeSpeed + score * CFG.speedGain, CFG.pipeSpeed + CFG.speedMax);
        gap = Math.max(CFG.gap - score * 1.1, CFG.gapMin);
      }
    }

    // 地面 / 天空碰撞
    if (bird.y + CFG.birdR >= CFG.H - CFG.GROUND_H || bird.y - CFG.birdR <= 0) {
      bird.y = clamp(bird.y, CFG.birdR, CFG.H - CFG.GROUND_H - CFG.birdR);
      die();
    }
  }

  function circleRect(cx, cy, r, rx, ry, rw, rh) {
    const nx = clamp(cx, rx, rx + rw), ny = clamp(cy, ry, ry + rh);
    const dx = cx - nx, dy = cy - ny;
    return dx * dx + dy * dy < r * r;
  }

  // ---------- 绘制 ----------
  function draw() {
    const th = theme();

    // 天空
    const grad = ctx.createLinearGradient(0, 0, 0, CFG.H);
    grad.addColorStop(0, th.skyTop);
    grad.addColorStop(1, th.skyBot);
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, CFG.W, CFG.H);

    // 星星（夜晚）
    if (th.night) {
      ctx.fillStyle = "rgba(255,255,255,0.9)";
      for (let i = 0; i < 24; i++) {
        const sx = (i * 97 + 31) % CFG.W, sy = (i * 53 + 17) % 300;
        ctx.globalAlpha = 0.4 + 0.6 * Math.abs(Math.sin(time * 1.5 + i));
        ctx.fillRect(sx, sy, 2, 2);
      }
      ctx.globalAlpha = 1;
      // 月亮
      ctx.fillStyle = "#f5f0dc";
      ctx.beginPath(); ctx.arc(320, 80, 26, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = th.skyTop;
      ctx.beginPath(); ctx.arc(310, 72, 22, 0, Math.PI * 2); ctx.fill();
    } else {
      // 太阳
      ctx.fillStyle = "rgba(255,240,150,0.95)";
      ctx.beginPath(); ctx.arc(320, 80, 28, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = "rgba(255,240,150,0.25)";
      ctx.beginPath(); ctx.arc(320, 80, 42, 0, Math.PI * 2); ctx.fill();
    }

    // 云
    ctx.fillStyle = th.cloud;
    for (const c of clouds) {
      ctx.beginPath();
      ctx.ellipse(c.x, c.y, 34 * c.s, 15 * c.s, 0, 0, Math.PI * 2);
      ctx.ellipse(c.x + 22 * c.s, c.y + 4, 24 * c.s, 12 * c.s, 0, 0, Math.PI * 2);
      ctx.ellipse(c.x - 24 * c.s, c.y + 6, 22 * c.s, 11 * c.s, 0, 0, Math.PI * 2);
      ctx.fill();
    }

    // 远山
    ctx.fillStyle = th.hill;
    ctx.globalAlpha = 0.5;
    ctx.beginPath();
    ctx.moveTo(0, CFG.H - CFG.GROUND_H);
    for (let x = 0; x <= CFG.W; x += 20) {
      ctx.lineTo(x, CFG.H - CFG.GROUND_H - 34 - Math.sin(x * 0.02 + 2) * 22 - Math.sin(x * 0.008) * 16);
    }
    ctx.lineTo(CFG.W, CFG.H - CFG.GROUND_H);
    ctx.fill();
    ctx.globalAlpha = 1;

    // 管道
    for (const p of pipes) drawPipe(p, th);

    // 地面
    const gy = CFG.H - CFG.GROUND_H;
    ctx.fillStyle = th.ground;
    ctx.fillRect(0, gy, CFG.W, CFG.GROUND_H);
    ctx.fillStyle = th.groundDark;
    ctx.fillRect(0, gy, CFG.W, 8);
    // 草皮条纹
    ctx.fillStyle = th.night ? "#2e5a3a" : "#5cb85c";
    for (let x = groundX - 24; x < CFG.W + 24; x += 24) {
      ctx.beginPath();
      ctx.moveTo(x, gy + 8); ctx.lineTo(x + 12, gy + 8); ctx.lineTo(x + 6, gy + 18);
      ctx.closePath(); ctx.fill();
    }
    // 土壤斑点
    ctx.fillStyle = "rgba(0,0,0,0.08)";
    for (let x = groundX * 0.6 - 40; x < CFG.W + 40; x += 46) {
      ctx.beginPath(); ctx.ellipse(((x % (CFG.W + 80)) + CFG.W + 80) % (CFG.W + 80), gy + 46, 7, 4, 0, 0, Math.PI * 2); ctx.fill();
    }

    // 粒子
    for (const p of particles) {
      ctx.globalAlpha = 1 - p.t / p.life;
      ctx.fillStyle = p.c;
      ctx.beginPath(); ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2); ctx.fill();
    }
    ctx.globalAlpha = 1;

    drawBird();

    // 记分板
    if (state !== ST.READY) {
      ctx.font = "bold 34px sans-serif";
      ctx.textAlign = "center";
      ctx.lineWidth = 5; ctx.strokeStyle = "rgba(0,0,0,0.35)";
      ctx.strokeText(score, CFG.W / 2, 58);
      ctx.fillStyle = "#fff";
      ctx.fillText(score, CFG.W / 2, 58);
    }

    if (state === ST.READY) drawReady();
    if (state === ST.OVER) drawOver();

    // 撞击白闪
    if (flash > 0) {
      ctx.fillStyle = `rgba(255,255,255,${flash * 0.8})`;
      ctx.fillRect(0, 0, CFG.W, CFG.H);
    }

    // 暂停遮罩
    if (paused) {
      ctx.fillStyle = "rgba(0,0,0,0.55)";
      ctx.fillRect(0, 0, CFG.W, CFG.H);
      ctx.fillStyle = "#fff";
      ctx.font = "bold 26px sans-serif";
      ctx.textAlign = "center";
      ctx.fillText("已暂停", CFG.W / 2, CFG.H / 2 - 8);
      ctx.font = "15px sans-serif";
      ctx.fillText("按 P 继续", CFG.W / 2, CFG.H / 2 + 20);
    }
  }

  function drawPipe(p, th) {
    const capH = 18, capOver = 4;
    const drawSeg = (y, h) => {
      const g = ctx.createLinearGradient(p.x, 0, p.x + CFG.pipeW, 0);
      g.addColorStop(0, th.night ? "#1e6e38" : "#3fa34d");
      g.addColorStop(0.5, th.night ? "#3fa35a" : "#6fcf7c");
      g.addColorStop(1, th.night ? "#14512a" : "#2e8440");
      ctx.fillStyle = g;
      ctx.fillRect(p.x, y, CFG.pipeW, h);
      ctx.strokeStyle = th.night ? "#0d3a1e" : "#1e6b30";
      ctx.lineWidth = 2;
      ctx.strokeRect(p.x + 1, y + 1, CFG.pipeW - 2, h - 2);
    };
    drawSeg(0, p.top - capH);
    drawSeg(p.top + gap + capH, CFG.H - CFG.GROUND_H - p.top - gap - capH);
    // 管口盖
    drawSeg(p.top - capH, capH);
    ctx.fillStyle = th.night ? "#2a8a48" : "#57b96a";
    ctx.fillRect(p.x - capOver, p.top - capH, CFG.pipeW + capOver * 2, capH);
    ctx.strokeRect(p.x - capOver + 1, p.top - capH + 1, CFG.pipeW + capOver * 2 - 2, capH - 2);
    drawSeg(p.top + gap, capH);
    ctx.fillStyle = th.night ? "#2a8a48" : "#57b96a";
    ctx.fillRect(p.x - capOver, p.top + gap, CFG.pipeW + capOver * 2, capH);
    ctx.strokeRect(p.x - capOver + 1, p.top + gap + 1, CFG.pipeW + capOver * 2 - 2, capH - 2);
  }

  function drawBird() {
    ctx.save();
    ctx.translate(bird.x, bird.y);
    ctx.rotate(bird.rot);
    // 身体
    const g = ctx.createRadialGradient(-3, -4, 2, 0, 0, 16);
    g.addColorStop(0, "#ffe066");
    g.addColorStop(1, "#f2a900");
    ctx.fillStyle = g;
    ctx.strokeStyle = "#b57e00";
    ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(0, 0, CFG.birdR + 2, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    // 肚皮
    ctx.fillStyle = "#fdf1cf";
    ctx.beginPath(); ctx.ellipse(1, 6, 8, 5.5, 0, 0, Math.PI * 2); ctx.fill();
    // 翅膀
    const wy = Math.sin(bird.wing) * 6;
    ctx.fillStyle = "#fff3b0";
    ctx.beginPath(); ctx.ellipse(-4, wy + 1, 9, 5.5, -0.3 + wy * 0.05, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = "#d9a300"; ctx.lineWidth = 1.5; ctx.stroke();
    // 眼睛
    ctx.fillStyle = "#fff";
    ctx.beginPath(); ctx.arc(6.5, -5.5, 5, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = "#b57e00"; ctx.lineWidth = 1; ctx.stroke();
    ctx.fillStyle = "#222";
    ctx.beginPath(); ctx.arc(8, -5.5, 2.2, 0, Math.PI * 2); ctx.fill();
    // 高光
    ctx.fillStyle = "#fff";
    ctx.beginPath(); ctx.arc(9, -6.5, 0.9, 0, Math.PI * 2); ctx.fill();
    // 嘴
    ctx.fillStyle = "#ff8c2e";
    ctx.beginPath();
    ctx.moveTo(11, 0); ctx.lineTo(20, 2.5); ctx.lineTo(11, 6);
    ctx.closePath(); ctx.fill();
    ctx.strokeStyle = "#d96a10"; ctx.lineWidth = 1; ctx.stroke();
    ctx.restore();
  }

  function drawReady() {
    ctx.textAlign = "center";
    // 标题
    ctx.font = "bold 42px sans-serif";
    ctx.lineWidth = 6; ctx.strokeStyle = "rgba(0,0,0,0.35)";
    ctx.strokeText("Flappy Bird", CFG.W / 2, 175);
    const tg = ctx.createLinearGradient(0, 145, 0, 185);
    tg.addColorStop(0, "#fff7cf"); tg.addColorStop(1, "#ffcf3f");
    ctx.fillStyle = tg;
    ctx.fillText("Flappy Bird", CFG.W / 2, 175);
    // 提示
    ctx.font = "17px sans-serif";
    ctx.lineWidth = 4;
    ctx.strokeText("点击 / 空格 起飞", CFG.W / 2, 430);
    ctx.fillStyle = "#fff";
    ctx.fillText("点击 / 空格 起飞", CFG.W / 2, 430);
    if (best > 0) {
      ctx.font = "15px sans-serif";
      ctx.strokeText("最高分: " + best, CFG.W / 2, 458);
      ctx.fillStyle = "rgba(255,255,255,0.85)";
      ctx.fillText("最高分: " + best, CFG.W / 2, 458);
    }
  }

  function medalFor(s) {
    if (s >= 40) return { c1: "#e5e4e2", c2: "#a8a8a8", name: "铂牌" };
    if (s >= 30) return { c1: "#ffd700", c2: "#c9a200", name: "金牌" };
    if (s >= 20) return { c1: "#c0c0c0", c2: "#8f8f8f", name: "银牌" };
    if (s >= 10) return { c1: "#cd7f32", c2: "#96591f", name: "铜牌" };
    return null;
  }

  function drawOver() {
    ctx.fillStyle = "rgba(0,0,0,0.45)";
    ctx.fillRect(0, 0, CFG.W, CFG.H);

    // 结算面板
    const pw = 280, ph = 220, px = (CFG.W - pw) / 2, py = 170;
    ctx.fillStyle = "#fff8e7";
    roundRect(px, py, pw, ph, 14); ctx.fill();
    ctx.strokeStyle = "#d9b96a"; ctx.lineWidth = 3;
    roundRect(px, py, pw, ph, 14); ctx.stroke();

    ctx.textAlign = "center";
    ctx.fillStyle = "#e05545";
    ctx.font = "bold 30px sans-serif";
    ctx.fillText("游戏结束", CFG.W / 2, py + 42);

    // 奖牌
    const m = medalFor(score);
    if (m) {
      const mx = px + 52, my = py + 108;
      const mg = ctx.createRadialGradient(mx - 4, my - 4, 2, mx, my, 22);
      mg.addColorStop(0, m.c1); mg.addColorStop(1, m.c2);
      ctx.fillStyle = mg;
      ctx.beginPath(); ctx.arc(mx, my, 21, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = m.c2; ctx.lineWidth = 3; ctx.stroke();
      ctx.fillStyle = "rgba(255,255,255,0.85)";
      ctx.font = "bold 15px sans-serif";
      ctx.fillText(m.name[0], mx, my + 5);
      // 缎带
      ctx.fillStyle = "#e05545";
      ctx.beginPath(); ctx.moveTo(mx - 10, my - 16); ctx.lineTo(mx - 3, my - 26); ctx.lineTo(mx + 2, my - 14); ctx.closePath(); ctx.fill();
      ctx.fillStyle = "#4a90d9";
      ctx.beginPath(); ctx.moveTo(mx + 10, my - 16); ctx.lineTo(mx + 3, my - 26); ctx.lineTo(mx - 2, my - 14); ctx.closePath(); ctx.fill();
    }

    ctx.fillStyle = "#8a7a52";
    ctx.font = "16px sans-serif";
    ctx.textAlign = m ? "right" : "center";
    const tx = m ? px + pw - 42 : CFG.W / 2;
    ctx.fillText("得分", tx, py + 88);
    ctx.font = "bold 30px sans-serif";
    ctx.fillStyle = "#333";
    ctx.fillText(score, tx, py + 120);
    ctx.font = "16px sans-serif";
    ctx.fillStyle = "#8a7a52";
    ctx.fillText("最高分", tx, py + 152);
    ctx.font = "bold 22px sans-serif";
    ctx.fillStyle = "#333";
    ctx.fillText(best, tx, py + 180);

    if (newBest) {
      ctx.save();
      ctx.translate(px + pw - 34, py + 84);
      ctx.rotate(0.25);
      ctx.fillStyle = "#e05545";
      roundRect(-26, -12, 52, 20, 4); ctx.fill();
      ctx.fillStyle = "#fff";
      ctx.font = "bold 11px sans-serif";
      ctx.textAlign = "center";
      ctx.fillText("新纪录", 0, 2);
      ctx.restore();
    }

    ctx.textAlign = "center";
    ctx.fillStyle = "rgba(255,255,255,0.9)";
    ctx.font = "15px sans-serif";
    ctx.fillText("点击 / 空格 返回", CFG.W / 2, py + ph + 36);
  }

  function roundRect(x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  // ---------- 主循环（固定时间步长）----------
  const STEP = 1 / 120;
  let acc = 0, last = performance.now();

  function loop(now) {
    requestAnimationFrame(loop);
    let dt = (now - last) / 1000;
    last = now;
    if (paused) { draw(); return; }
    dt = Math.min(dt, 0.1); // 切后台回来防止大跳
    acc += dt;
    while (acc >= STEP) { update(STEP); acc -= STEP; }
    draw();
  }
  requestAnimationFrame(loop);

  // ---------- 输入 ----------
  function press(e) {
    if (e && e.target === canvas) e.preventDefault();
    flap();
  }
  canvas.addEventListener("pointerdown", press);
  addEventListener("keydown", (e) => {
    if (e.code === "Space" || e.code === "ArrowUp") { e.preventDefault(); flap(); }
    if (e.code === "KeyP" && (state === ST.PLAYING || paused)) {
      paused = !paused;
      if (!paused) last = performance.now();
    }
  });
  // 切后台自动暂停
  document.addEventListener("visibilitychange", () => {
    if (document.hidden && state === ST.PLAYING) paused = true;
  });
})();
