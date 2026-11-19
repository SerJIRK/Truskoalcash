/**
 * truskadurak — Движок интерактивных AR-игр и приколов поверх видеозвонка (ПК)
 * 1. «Запустить муху» (кривые Безье, жужжание, прихлопывание мышкой или взмахом руки)
 * 2. «Отбей бутылку» (процедурная стеклянная бутылка, удар рукой через HandLandmarker/motion, штрафной глоток)
 * 3. «Чокнуться» (синхронные процедурные пивные кружки с пеной и звоном бокалов)
 */

export class GamesEngine {
  constructor(canvas, soundEngine, visionEngine, callbacks) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.sound = soundEngine;
    this.vision = visionEngine;
    this.cb = callbacks;

    this.rafId = null;
    this.lastTime = 0;

    // Состояние мухи
    this.fly = null;
    // Состояние игры «Отбей бутылку»
    this.bottleActive = false;
    this.bottles = [];
    this.bottleSpawnCooldown = 0;
    this.sharedScore = 0;

    // Состояние анимации «Чокнуться»
    this.cheersAnim = null;

    // Частицы (осколки стекла, искры, пена, облачко хлопка)
    this.particles = [];
    this.floatingTexts = [];

    this._onResize = () => this._resizeCanvas();
    this._onCanvasPointerDown = (e) => this._handlePointerDown(e);

    window.addEventListener('resize', this._onResize);
    this.canvas.addEventListener('pointerdown', this._onCanvasPointerDown);
    this._resizeCanvas();
  }

  _resizeCanvas() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const rect = this.canvas.getBoundingClientRect();
    const w = Math.max(1, Math.floor(rect.width || window.innerWidth));
    const h = Math.max(1, Math.floor(rect.height || window.innerHeight));
    this.canvas.width = w * dpr;
    this.canvas.height = h * dpr;
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.width = w;
    this.height = h;
  }

  _updateInteractivity() {
    const interactive = Boolean(this.fly) || this.bottleActive;
    this.canvas.classList.toggle('ar-canvas--interactive', interactive);
    this.vision.setHandTrackingActive(interactive);
  }

  _ensureLoop() {
    if (this.rafId !== null) return;
    this.lastTime = performance.now();
    const tick = (now) => {
      const dt = Math.min(0.05, (now - this.lastTime) / 1000);
      this.lastTime = now;
      this._update(dt, now);
      this._render(now);

      if (this._hasActiveWork()) {
        this.rafId = requestAnimationFrame(tick);
      } else {
        this.rafId = null;
        this.ctx.clearRect(0, 0, this.width, this.height);
        this._updateInteractivity();
      }
    };
    this.rafId = requestAnimationFrame(tick);
  }

  _hasActiveWork() {
    return (
      Boolean(this.fly) ||
      this.bottleActive ||
      this.bottles.length > 0 ||
      Boolean(this.cheersAnim) ||
      this.particles.length > 0 ||
      this.floatingTexts.length > 0
    );
  }

  /* ========================================================================
     1. «ЗАПУСТИТЬ МУХУ»
     ======================================================================== */
  spawnFly() {
    this._resizeCanvas();
    const startX = Math.random() > 0.5 ? -30 : this.width + 30;
    const startY = this.height * (0.2 + Math.random() * 0.5);

    this.fly = {
      x: startX,
      y: startY,
      angle: 0,
      state: 'flying', // 'flying' | 'landed' | 'fleeing'
      t: 0,
      duration: 1.4,
      p0: { x: startX, y: startY },
      p1: { x: this.width * 0.3, y: this.height * 0.15 },
      p2: { x: this.width * 0.7, y: this.height * 0.65 },
      p3: { x: this.width * 0.5, y: this.height * 0.44 },
      landTimer: 0,
      flightsBeforeLand: 2,
      wingPhase: 0,
      vx: 0,
      vy: 0,
    };

    this.sound.startFlyBuzz();
    this._updateInteractivity();
    this._ensureLoop();
  }

  _pickNextFlySegment(landOnFace) {
    const f = this.fly;
    if (!f) return;
    f.p0 = { x: f.x, y: f.y };
    f.p1 = {
      x: this.width * (0.1 + Math.random() * 0.8),
      y: this.height * (0.1 + Math.random() * 0.75),
    };
    f.p2 = {
      x: this.width * (0.1 + Math.random() * 0.8),
      y: this.height * (0.1 + Math.random() * 0.75),
    };

    if (landOnFace) {
      f.p3 = {
        x: this.width * (0.45 + (Math.random() - 0.5) * 0.16),
        y: this.height * (0.42 + (Math.random() - 0.5) * 0.14),
      };
      f.willLand = true;
      f.duration = 1.1 + Math.random() * 0.6;
    } else {
      f.p3 = {
        x: this.width * (0.15 + Math.random() * 0.7),
        y: this.height * (0.15 + Math.random() * 0.65),
      };
      f.willLand = false;
      f.duration = 0.85 + Math.random() * 0.75;
    }
    f.t = 0;
  }

  _swatFly(byHand = false) {
    if (!this.fly || this.fly.state === 'fleeing') return;
    this.sound.playFlySwat();
    this.sound.stopFlyBuzz();

    // Облачко хлопка
    for (let i = 0; i < 16; i++) {
      const a = (i / 16) * Math.PI * 2;
      const sp = 90 + Math.random() * 140;
      this.particles.push({
        x: this.fly.x,
        y: this.fly.y,
        vx: Math.cos(a) * sp,
        vy: Math.sin(a) * sp,
        size: 4 + Math.random() * 5,
        color: i % 2 === 0 ? '#ffffff' : '#f5c25b',
        life: 0.45,
        maxLife: 0.45,
      });
    }

    this.floatingTexts.push({
      x: this.fly.x,
      y: this.fly.y - 16,
      text: byHand ? 'Прихлопнул рукой!' : 'Улетела!',
      color: '#ffffff',
      life: 1.0,
      maxLife: 1.0,
    });

    // Муха стремительно улетает за экран
    this.fly.state = 'fleeing';
    const exitAngle = Math.random() * Math.PI * 2;
    this.fly.vx = Math.cos(exitAngle) * 1100;
    this.fly.vy = Math.sin(exitAngle) * 1100;
    this.fly.angle = exitAngle;

    if (this.cb.onFlySwatted) {
      this.cb.onFlySwatted();
    }
  }

  /* ========================================================================
     2. «ОТБЕЙ БУТЫЛКУ» (AR-ИГРА С РУКАМИ)
     ======================================================================== */
  startBottleGame(initialScore = 0) {
    this._resizeCanvas();
    this.bottleActive = true;
    this.sharedScore = initialScore;
    this.bottles = [];
    this.bottleSpawnCooldown = 0.6;
    this._updateInteractivity();
    this._ensureLoop();
  }

  stopBottleGame() {
    this.bottleActive = false;
    this.bottles = [];
    this._updateInteractivity();
  }

  setSharedScore(score) {
    this.sharedScore = score;
  }

  _spawnBottle() {
    const margin = Math.min(180, this.width * 0.22);
    const x = margin + Math.random() * Math.max(80, this.width - margin * 2);
    this.bottles.push({
      x,
      y: -90,
      vx: (Math.random() - 0.5) * 28,
      vy: 135 + Math.random() * 45,
      rot: (Math.random() - 0.5) * 0.35,
      vRot: (Math.random() - 0.5) * 0.9,
      hit: false,
      radius: 46,
      variant: Math.random() > 0.45 ? 'emerald' : 'amber',
    });
  }

  _hitBottle(bottle, hitX, hitY) {
    if (bottle.hit) return;
    bottle.hit = true;
    const dir = bottle.x >= hitX ? 1 : -1;
    bottle.vx = dir * (460 + Math.random() * 240);
    bottle.vy = -340 - Math.random() * 160;
    bottle.vRot = dir * (9 + Math.random() * 5);

    this.sound.playGlassClink();

    for (let i = 0; i < 18; i++) {
      const a = Math.random() * Math.PI * 2;
      const sp = 110 + Math.random() * 220;
      this.particles.push({
        x: bottle.x,
        y: bottle.y,
        vx: Math.cos(a) * sp,
        vy: Math.sin(a) * sp,
        size: 3 + Math.random() * 4,
        color: i % 2 === 0 ? '#ffe066' : '#ffffff',
        life: 0.55,
        maxLife: 0.55,
      });
    }

    this.floatingTexts.push({
      x: bottle.x,
      y: bottle.y - 30,
      text: '+1',
      color: '#ffe066',
      life: 0.95,
      maxLife: 0.95,
    });

    this.sharedScore += 1;
    if (this.cb.onBottleHit) {
      this.cb.onBottleHit(this.sharedScore);
    }
  }

  _shatterBottle(bottle) {
    this.sound.playGlassBreak();
    const shardColor = bottle.variant === 'emerald' ? '#3cb371' : '#d98a26';
    for (let i = 0; i < 28; i++) {
      const a = -Math.PI * Math.random();
      const sp = 120 + Math.random() * 280;
      this.particles.push({
        x: bottle.x,
        y: this.height - 16,
        vx: Math.cos(a) * sp,
        vy: Math.sin(a) * sp - 40,
        size: 4 + Math.random() * 6,
        color: i % 3 === 0 ? '#e8f5e9' : shardColor,
        life: 0.85,
        maxLife: 0.85,
        gravity: 480,
      });
    }

    if (this.cb.onBottleMissed) {
      this.cb.onBottleMissed();
    }
  }

  /* ========================================================================
     3. «ЧОКНУТЬСЯ» (СИНХРОННЫЕ ПИВНЫЕ КРУЖКИ)
     ======================================================================== */
  triggerCheers() {
    this._resizeCanvas();
    this.cheersAnim = {
      elapsed: 0,
      duration: 2.4,
      clinked: false,
    };
    this._ensureLoop();
  }

  /* ========================================================================
     ОБРАБОТКА КЛИКА МЫШКОЙ (МУХА + РЕЗЕРВНЫЙ КЛИК ПО БУТЫЛКЕ)
     ======================================================================== */
  _handlePointerDown(e) {
    const rect = this.canvas.getBoundingClientRect();
    const px = e.clientX - rect.left;
    const py = e.clientY - rect.top;

    if (this.fly && this.fly.state !== 'fleeing') {
      const dist = Math.hypot(px - this.fly.x, py - this.fly.y);
      if (dist <= 62) {
        this._swatFly(false);
        return;
      }
    }

    if (this.bottleActive) {
      for (const b of this.bottles) {
        if (!b.hit && Math.hypot(px - b.x, py - b.y) <= b.radius + 24) {
          this._hitBottle(b, px, py);
          break;
        }
      }
    }
  }

  /* ========================================================================
     ОБНОВЛЕНИЕ ФИЗИКИ (60 FPS)
     ======================================================================== */
  _update(dt, now) {
    const hand = this.vision.getHandState();
    const handX = hand.x * this.width;
    const handY = hand.y * this.height;

    // 1. Обновление мухи
    if (this.fly) {
      const f = this.fly;
      f.wingPhase += dt * (f.state === 'landed' ? 6 : 68);

      if (f.state === 'fleeing') {
        f.x += f.vx * dt;
        f.y += f.vy * dt;
        if (f.x < -80 || f.x > this.width + 80 || f.y < -80 || f.y > this.height + 80) {
          this.fly = null;
          this._updateInteractivity();
        }
      } else {
        // Проверка взмаха руки перед камерой для прихлопывания мухи
        if (hand.detected) {
          const distToHand = Math.hypot(handX - f.x, handY - f.y);
          if (distToHand < 115 || (hand.speed > 0.085 && distToHand < 200)) {
            this._swatFly(true);
          }
        }

        if (this.fly && f.state === 'flying') {
          f.t += dt / f.duration;
          if (f.t >= 1) {
            f.t = 1;
            if (f.willLand) {
              f.state = 'landed';
              f.landTimer = 2.4 + Math.random() * 1.4;
            } else {
              f.flightsBeforeLand -= 1;
              this._pickNextFlySegment(f.flightsBeforeLand <= 0);
            }
          }

          const u = 1 - f.t;
          const prevX = f.x;
          const prevY = f.y;
          // Кубическая кривая Безье + органическое дрожание полёта
          const bx =
            u * u * u * f.p0.x +
            3 * u * u * f.t * f.p1.x +
            3 * u * f.t * f.t * f.p2.x +
            f.t * f.t * f.t * f.p3.x;
          const by =
            u * u * u * f.p0.y +
            3 * u * u * f.t * f.p1.y +
            3 * u * f.t * f.t * f.p2.y +
            f.t * f.t * f.t * f.p3.y;

          f.x = bx + Math.sin(now * 0.028) * 5;
          f.y = by + Math.cos(now * 0.034) * 5;
          f.angle = Math.atan2(f.y - prevY, f.x - prevX);
          this.sound.updateFlyBuzz(f.x / Math.max(1, this.width), false);
        } else if (this.fly && f.state === 'landed') {
          f.landTimer -= dt;
          this.sound.updateFlyBuzz(f.x / Math.max(1, this.width), true);
          if (f.landTimer <= 0) {
            f.state = 'flying';
            f.flightsBeforeLand = 2 + Math.floor(Math.random() * 2);
            this._pickNextFlySegment(false);
          }
        }
      }
    }

    // 2. Обновление падающих бутылок
    if (this.bottleActive) {
      this.bottleSpawnCooldown -= dt;
      if (this.bottleSpawnCooldown <= 0 && this.bottles.filter((b) => !b.hit).length < 2) {
        this._spawnBottle();
        this.bottleSpawnCooldown = 2.6 + Math.random() * 1.4;
      }
    }

    for (let i = this.bottles.length - 1; i >= 0; i--) {
      const b = this.bottles[i];
      b.x += b.vx * dt;
      b.y += b.vy * dt;
      b.rot += b.vRot * dt;
      if (b.hit) {
        b.vy += 680 * dt;
      } else if (hand.detected) {
        const dist = Math.hypot(handX - b.x, handY - b.y);
        if (dist <= b.radius + 68) {
          this._hitBottle(b, handX, handY);
        }
      }

      if (!b.hit && b.y > this.height + 20) {
        this._shatterBottle(b);
        this.bottles.splice(i, 1);
      } else if (b.hit && (b.y > this.height + 160 || b.x < -160 || b.x > this.width + 160)) {
        this.bottles.splice(i, 1);
      }
    }

    // 3. Обновление анимации «Чокнуться»
    if (this.cheersAnim) {
      this.cheersAnim.elapsed += dt;
      if (!this.cheersAnim.clinked && this.cheersAnim.elapsed >= 0.42) {
        this.cheersAnim.clinked = true;
        this.sound.playCheersClink();
        const cx = this.width / 2;
        const cy = this.height * 0.48;
        for (let i = 0; i < 30; i++) {
          const a = Math.random() * Math.PI * 2;
          const sp = 110 + Math.random() * 260;
          this.particles.push({
            x: cx,
            y: cy - 30,
            vx: Math.cos(a) * sp,
            vy: Math.sin(a) * sp - 80,
            size: 4 + Math.random() * 6,
            color: i % 2 === 0 ? '#fff9e6' : '#f5be41',
            life: 0.9,
            maxLife: 0.9,
            gravity: 340,
          });
        }
      }
      if (this.cheersAnim.elapsed >= this.cheersAnim.duration) {
        this.cheersAnim = null;
      }
    }

    // 4. Частицы и всплывающий текст
    for (let i = this.particles.length - 1; i >= 0; i--) {
      const p = this.particles[i];
      p.life -= dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      if (p.gravity) p.vy += p.gravity * dt;
      if (p.life <= 0) this.particles.splice(i, 1);
    }

    for (let i = this.floatingTexts.length - 1; i >= 0; i--) {
      const ft = this.floatingTexts[i];
      ft.life -= dt;
      ft.y -= 48 * dt;
      if (ft.life <= 0) this.floatingTexts.splice(i, 1);
    }
  }

  /* ========================================================================
     ОТРИСОВКА НА CANVAS
     ======================================================================== */
  _render(now) {
    const ctx = this.ctx;
    ctx.clearRect(0, 0, this.width, this.height);

    // Индикатор распознанной руки во время AR-игры
    const hand = this.vision.getHandState();
    if (hand.detected && (this.bottleActive || this.fly)) {
      const hx = hand.x * this.width;
      const hy = hand.y * this.height;
      ctx.save();
      ctx.beginPath();
      ctx.arc(hx, hy, 34, 0, Math.PI * 2);
      ctx.strokeStyle = 'rgba(255, 224, 102, 0.85)';
      ctx.lineWidth = 3;
      ctx.stroke();
      ctx.fillStyle = 'rgba(255, 224, 102, 0.16)';
      ctx.fill();
      ctx.restore();
    }

    // Падающие бутылки
    for (const b of this.bottles) {
      this._drawBottle(ctx, b);
    }

    // Муха
    if (this.fly) {
      this._drawFly(ctx, this.fly, now);
    }

    // Анимация «Чокнуться»
    if (this.cheersAnim) {
      this._drawCheersMugs(ctx, this.cheersAnim, now);
    }

    // Частицы
    for (const p of this.particles) {
      ctx.save();
      ctx.globalAlpha = Math.max(0, p.life / p.maxLife);
      ctx.fillStyle = p.color;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }

    // Всплывающие надписи (+1, Прихлопнул!)
    for (const ft of this.floatingTexts) {
      ctx.save();
      ctx.globalAlpha = Math.max(0, ft.life / ft.maxLife);
      ctx.font = '800 28px Rubik, sans-serif';
      ctx.textAlign = 'center';
      ctx.lineWidth = 5;
      ctx.strokeStyle = 'rgba(0,0,0,0.65)';
      ctx.strokeText(ft.text, ft.x, ft.y);
      ctx.fillStyle = ft.color;
      ctx.fillText(ft.text, ft.x, ft.y);
      ctx.restore();
    }
  }

  /**
   * Реалистичная процедурная муха с крыльями, лапками и красными глазами
   */
  _drawFly(ctx, f, now) {
    ctx.save();
    ctx.translate(f.x, f.y);
    ctx.rotate(f.angle + Math.PI / 2);

    // Тень под мухой (ближе когда села)
    const shadowOff = f.state === 'landed' ? 4 : 16;
    ctx.fillStyle = 'rgba(0, 0, 0, 0.34)';
    ctx.beginPath();
    ctx.ellipse(shadowOff, shadowOff, 11, 16, 0, 0, Math.PI * 2);
    ctx.fill();

    // Лапки (6 штук, шевелятся)
    ctx.strokeStyle = '#141418';
    ctx.lineWidth = 1.6;
    const twitch = f.state === 'landed' ? Math.sin(now * 0.025) * 2.5 : 0;
    [-1, 1].forEach((side) => {
      [-7, 0, 8].forEach((ly, idx) => {
        ctx.beginPath();
        ctx.moveTo(side * 4, ly);
        ctx.lineTo(side * (13 + (idx === 0 ? twitch : 0)), ly + (idx - 1) * 5);
        ctx.lineTo(side * 17, ly + (idx - 1) * 8 + 3);
        ctx.stroke();
      });
    });

    // Брюшко и грудка
    const bodyGrad = ctx.createRadialGradient(-2, 4, 2, 0, 6, 14);
    bodyGrad.addColorStop(0, '#3a424d');
    bodyGrad.addColorStop(0.55, '#191d24');
    bodyGrad.addColorStop(1, '#090a0d');
    ctx.fillStyle = bodyGrad;
    ctx.beginPath();
    ctx.ellipse(0, 7, 7.5, 11, 0, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = '#1f232b';
    ctx.beginPath();
    ctx.ellipse(0, -4, 6.5, 7, 0, 0, Math.PI * 2);
    ctx.fill();

    // Голова и красные фасеточные глаза
    ctx.fillStyle = '#14151a';
    ctx.beginPath();
    ctx.arc(0, -12, 5.2, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = '#a81818';
    ctx.beginPath();
    ctx.ellipse(-3.6, -13, 2.6, 3.2, -0.25, 0, Math.PI * 2);
    ctx.ellipse(3.6, -13, 2.6, 3.2, 0.25, 0, Math.PI * 2);
    ctx.fill();

    // Вибрирующие полупрозрачные крылья с прожилками
    const wingSpread = f.state === 'landed' ? 0.32 : 0.72 + Math.sin(f.wingPhase) * 0.55;
    [-1, 1].forEach((side) => {
      ctx.save();
      ctx.translate(side * 3, -3);
      ctx.rotate(side * wingSpread);
      ctx.fillStyle = 'rgba(225, 240, 255, 0.45)';
      ctx.strokeStyle = 'rgba(90, 105, 125, 0.65)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.ellipse(side * 12, 6, 6.5, 16, side * 0.22, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      ctx.restore();
    });

    ctx.restore();
  }

  /**
   * Процедурная стеклянная бутылка пива с бликами, этикеткой и кроненпробкой
   */
  _drawBottle(ctx, b) {
    ctx.save();
    ctx.translate(b.x, b.y);
    ctx.rotate(b.rot);

    const isGreen = b.variant === 'emerald';
    const bodyDark = isGreen ? '#0c4022' : '#572808';
    const bodyMid = isGreen ? '#1e7a44' : '#a85212';
    const bodyLight = isGreen ? '#4ec97f' : '#eb9834';

    // Тень
    ctx.shadowColor = 'rgba(0, 0, 0, 0.45)';
    ctx.shadowBlur = 14;
    ctx.shadowOffsetY = 6;

    // Контур бутылки
    const grad = ctx.createLinearGradient(-22, 0, 22, 0);
    grad.addColorStop(0, bodyDark);
    grad.addColorStop(0.32, bodyLight);
    grad.addColorStop(0.65, bodyMid);
    grad.addColorStop(1, bodyDark);

    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.moveTo(-9, -62);
    ctx.lineTo(9, -62);
    ctx.lineTo(11, -30);
    ctx.quadraticCurveTo(24, -14, 24, 4);
    ctx.lineTo(24, 54);
    ctx.quadraticCurveTo(24, 62, 16, 62);
    ctx.lineTo(-16, 62);
    ctx.quadraticCurveTo(-24, 62, -24, 54);
    ctx.lineTo(-24, 4);
    ctx.quadraticCurveTo(-24, -14, -11, -30);
    ctx.closePath();
    ctx.fill();

    ctx.shadowColor = 'transparent';

    // Золотистая этикетка
    ctx.fillStyle = '#f5e7c4';
    ctx.fillRect(-22, 4, 44, 34);
    ctx.fillStyle = '#b92b27';
    ctx.fillRect(-22, 13, 44, 15);
    ctx.fillStyle = '#fff8e7';
    ctx.font = '700 8px Rubik, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('TRUSKA', 0, 23);

    // Стеклянный вертикальный блик
    ctx.fillStyle = 'rgba(255, 255, 255, 0.36)';
    ctx.beginPath();
    ctx.roundRect(-16, -2, 6, 54, 3);
    ctx.fill();
    ctx.beginPath();
    ctx.roundRect(-6, -54, 3, 24, 2);
    ctx.fill();

    // Кроненпробка сверху
    ctx.fillStyle = '#e8b339';
    ctx.strokeStyle = '#7a540b';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.roundRect(-11, -69, 22, 9, 3);
    ctx.fill();
    ctx.stroke();

    ctx.restore();
  }

  /**
   * Синхронные пивные кружки с пеной для «Чокнуться»
   */
  _drawCheersMugs(ctx, anim, now) {
    const t = anim.elapsed;
    const cx = this.width / 2;
    const cy = this.height * 0.52;

    // Фаза сближения (0..0.42), удержание с покачиванием (0.42..1.85), уход (1.85..2.4)
    let approach = 1;
    let alpha = 1;
    if (t < 0.42) {
      const k = t / 0.42;
      approach = 1 - Math.pow(1 - k, 3);
    } else if (t > 1.85) {
      const k = (t - 1.85) / (anim.duration - 1.85);
      alpha = Math.max(0, 1 - k);
      approach = 1 - k * 0.35;
    }

    const offset = (1 - approach) * 260 + 56;
    const tilt = approach * 0.24 + (t > 0.42 && t < 0.72 ? Math.sin((t - 0.42) * 24) * 0.06 : 0);

    ctx.save();
    ctx.globalAlpha = alpha;

    // Левая кружка
    this._drawSingleMug(ctx, cx - offset, cy, tilt, -1, now);
    // Правая кружка
    this._drawSingleMug(ctx, cx + offset, cy, -tilt, 1, now);

    // Вспышка и подпись при столкновении
    if (t >= 0.4) {
      const burstAlpha = Math.max(0, 1 - (t - 0.4) * 2.1);
      if (burstAlpha > 0) {
        ctx.save();
        ctx.globalAlpha = burstAlpha;
        ctx.strokeStyle = '#fff5c2';
        ctx.lineWidth = 4;
        for (let i = 0; i < 8; i++) {
          const a = (i / 8) * Math.PI * 2;
          ctx.beginPath();
          ctx.moveTo(cx + Math.cos(a) * 18, cy - 35 + Math.sin(a) * 18);
          ctx.lineTo(cx + Math.cos(a) * 64, cy - 35 + Math.sin(a) * 64);
          ctx.stroke();
        }
        ctx.restore();
      }

      ctx.font = '800 36px Rubik, sans-serif';
      ctx.textAlign = 'center';
      ctx.lineWidth = 6;
      ctx.strokeStyle = 'rgba(0, 0, 0, 0.7)';
      ctx.strokeText('Дзынь! За встречу!', cx, cy + 128);
      ctx.fillStyle = '#ffd666';
      ctx.fillText('Дзынь! За встречу!', cx, cy + 128);
    }

    ctx.restore();
  }

  _drawSingleMug(ctx, x, y, rot, handleSide, now) {
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(rot);

    // Стеклянная ручка
    ctx.strokeStyle = 'rgba(235, 245, 255, 0.85)';
    ctx.lineWidth = 12;
    ctx.beginPath();
    ctx.arc(handleSide * 44, 6, 26, handleSide > 0 ? -Math.PI / 2 : Math.PI / 2, handleSide > 0 ? Math.PI / 2 : -Math.PI / 2);
    ctx.stroke();

    // Корпус кружки
    const beerGrad = ctx.createLinearGradient(-40, -50, 40, 65);
    beerGrad.addColorStop(0, '#f7c548');
    beerGrad.addColorStop(0.55, '#d98316');
    beerGrad.addColorStop(1, '#9c4e08');
    ctx.fillStyle = beerGrad;
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.85)';
    ctx.lineWidth = 5;
    ctx.beginPath();
    ctx.roundRect(-42, -56, 84, 122, [8, 8, 16, 16]);
    ctx.fill();
    ctx.stroke();

    // Вертикальные грани и пузырьки
    ctx.fillStyle = 'rgba(255, 255, 255, 0.22)';
    [-22, 0, 22].forEach((gx) => {
      ctx.beginPath();
      ctx.roundRect(gx - 5, -34, 10, 84, 5);
      ctx.fill();
    });

    ctx.fillStyle = 'rgba(255, 248, 210, 0.65)';
    for (let i = 0; i < 8; i++) {
      const bx = -28 + ((i * 19) % 56);
      const by = 52 - (((now * 0.045 + i * 23) % 90));
      ctx.beginPath();
      ctx.arc(bx, by, 2.5 + (i % 2), 0, Math.PI * 2);
      ctx.fill();
    }

    // Пышная шапка белой пены сверху
    ctx.fillStyle = '#fffdf5';
    [
      { x: -30, y: -58, r: 19 },
      { x: -10, y: -68, r: 22 },
      { x: 14, y: -66, r: 21 },
      { x: 32, y: -56, r: 18 },
      { x: 0, y: -54, r: 20 },
    ].forEach((c) => {
      ctx.beginPath();
      ctx.arc(c.x, c.y, c.r, 0, Math.PI * 2);
      ctx.fill();
    });

    // Подтёк пены по краю
    ctx.beginPath();
    ctx.roundRect(-36, -54, 12, 30, 6);
    ctx.roundRect(18, -52, 10, 22, 5);
    ctx.fill();

    ctx.restore();
  }

  resetAll() {
    this.fly = null;
    this.bottleActive = false;
    this.bottles = [];
    this.cheersAnim = null;
    this.particles = [];
    this.floatingTexts = [];
    this.sound.stopFlyBuzz();
    this._updateInteractivity();
    this.ctx.clearRect(0, 0, this.width, this.height);
  }
}
