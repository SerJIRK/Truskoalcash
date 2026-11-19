/**
 * truskadurak — Процедурный звуковой движок (Web Audio API)
 * Звук открытия банки пива, рингтоны Skype, жужжание мухи, звон бокалов и разбитое стекло.
 */

export class SoundEngine {
  constructor() {
    this.ctx = null;
    this.ringTimer = null;
    this.flyNodes = null;
  }

  ensureContext() {
    if (!this.ctx) {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      this.ctx = new AudioCtx();
    }
    if (this.ctx.state === 'suspended') {
      this.ctx.resume().catch(() => {});
    }
    return this.ctx;
  }

  /**
   * Реалистичный процедурный звук открытия алюминиевой банки (щелчок ключа + треск + пшик газа)
   */
  playCanOpen() {
    const ctx = this.ensureContext();
    const now = ctx.currentTime;

    // 1. Металлический щелчок ключа-открывашки
    const clickOsc = ctx.createOscillator();
    const clickGain = ctx.createGain();
    clickOsc.type = 'triangle';
    clickOsc.frequency.setValueAtTime(3400, now);
    clickOsc.frequency.exponentialRampToValueAtTime(1100, now + 0.025);
    clickGain.gain.setValueAtTime(0.001, now);
    clickGain.gain.linearRampToValueAtTime(0.32, now + 0.004);
    clickGain.gain.exponentialRampToValueAtTime(0.001, now + 0.032);
    clickOsc.connect(clickGain);
    clickGain.connect(ctx.destination);
    clickOsc.start(now);
    clickOsc.stop(now + 0.035);

    // 2. Хруст проминания алюминиевой крышки
    const snapTime = now + 0.045;
    const snapOsc = ctx.createOscillator();
    const snapGain = ctx.createGain();
    snapOsc.type = 'square';
    snapOsc.frequency.setValueAtTime(2200, snapTime);
    snapOsc.frequency.exponentialRampToValueAtTime(620, snapTime + 0.03);
    const snapFilter = ctx.createBiquadFilter();
    snapFilter.type = 'bandpass';
    snapFilter.frequency.setValueAtTime(2600, snapTime);
    snapFilter.Q.value = 3.0;
    snapGain.gain.setValueAtTime(0.001, snapTime);
    snapGain.gain.linearRampToValueAtTime(0.26, snapTime + 0.005);
    snapGain.gain.exponentialRampToValueAtTime(0.001, snapTime + 0.045);
    snapOsc.connect(snapFilter);
    snapFilter.connect(snapGain);
    snapGain.connect(ctx.destination);
    snapOsc.start(snapTime);
    snapOsc.stop(snapTime + 0.05);

    // 3. Пшик углекислого газа (фильтрованный белый шум с шипением пены)
    const hissStart = now + 0.04;
    const hissDuration = 0.36;
    const bufferSize = Math.floor(ctx.sampleRate * hissDuration);
    const noiseBuffer = ctx.createBuffer(1, bufferSize, ctx.sampleRate);
    const data = noiseBuffer.getChannelData(0);
    for (let i = 0; i < bufferSize; i++) {
      // Лёгкая микро-модуляция имитирует пузырьки
      const fizz = Math.random() > 0.94 ? 1.45 : 0.8;
      data[i] = (Math.random() * 2 - 1) * fizz;
    }

    const noiseSrc = ctx.createBufferSource();
    noiseSrc.buffer = noiseBuffer;

    const hpFilter = ctx.createBiquadFilter();
    hpFilter.type = 'highpass';
    hpFilter.frequency.setValueAtTime(2400, hissStart);

    const bpFilter = ctx.createBiquadFilter();
    bpFilter.type = 'bandpass';
    bpFilter.frequency.setValueAtTime(6800, hissStart);
    bpFilter.frequency.exponentialRampToValueAtTime(2200, hissStart + hissDuration);
    bpFilter.Q.value = 0.9;

    const hissGain = ctx.createGain();
    hissGain.gain.setValueAtTime(0.001, hissStart);
    hissGain.gain.linearRampToValueAtTime(0.32, hissStart + 0.025);
    hissGain.gain.exponentialRampToValueAtTime(0.08, hissStart + 0.14);
    hissGain.gain.exponentialRampToValueAtTime(0.001, hissStart + hissDuration);

    noiseSrc.connect(hpFilter);
    hpFilter.connect(bpFilter);
    bpFilter.connect(hissGain);
    hissGain.connect(ctx.destination);
    noiseSrc.start(hissStart);
    noiseSrc.stop(hissStart + hissDuration);
  }

  /**
   * Классический гудок исходящего вызова Skype (пульсирующий мягкий аккорд)
   */
  playOutgoingRing() {
    this.stopRing();
    const playPulse = () => {
      const ctx = this.ensureContext();
      const now = ctx.currentTime;
      const freqs = [392.0, 493.88, 587.33]; // Тёплый G-major гудок

      freqs.forEach((f, idx) => {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = idx === 0 ? 'sine' : 'triangle';
        osc.frequency.setValueAtTime(f, now);

        const lfo = ctx.createOscillator();
        const lfoGain = ctx.createGain();
        lfo.frequency.value = 4.2;
        lfoGain.gain.value = 0.018;
        lfo.connect(lfoGain);
        lfoGain.connect(gain.gain);

        gain.gain.setValueAtTime(0.001, now);
        gain.gain.linearRampToValueAtTime(0.065 / (idx + 1), now + 0.14);
        gain.gain.setValueAtTime(0.065 / (idx + 1), now + 1.05);
        gain.gain.exponentialRampToValueAtTime(0.001, now + 1.35);

        osc.connect(gain);
        gain.connect(ctx.destination);

        osc.start(now);
        lfo.start(now);
        osc.stop(now + 1.4);
        lfo.stop(now + 1.4);
      });
    };

    playPulse();
    this.ringTimer = window.setInterval(playPulse, 3100);
  }

  /**
   * Классический мелодичный рингтон входящего звонка Skype
   */
  playIncomingRing() {
    this.stopRing();
    const playPhrase = () => {
      const ctx = this.ensureContext();
      const now = ctx.currentTime;
      // Пузырьковая восходящая мелодия в духе классического Skype
      const notes = [
        { f: 523.25, t: 0.0, d: 0.18 },
        { f: 659.25, t: 0.14, d: 0.18 },
        { f: 783.99, t: 0.28, d: 0.2 },
        { f: 1046.5, t: 0.44, d: 0.34 },
        { f: 783.99, t: 0.72, d: 0.16 },
        { f: 880.0, t: 0.88, d: 0.2 },
        { f: 1174.66, t: 1.06, d: 0.42 },
      ];

      notes.forEach(({ f, t, d }) => {
        const start = now + t;
        const osc = ctx.createOscillator();
        const overtone = ctx.createOscillator();
        const gain = ctx.createGain();

        osc.type = 'sine';
        osc.frequency.setValueAtTime(f, start);
        overtone.type = 'triangle';
        overtone.frequency.setValueAtTime(f * 2, start);

        const overGain = ctx.createGain();
        overGain.gain.value = 0.18;

        gain.gain.setValueAtTime(0.001, start);
        gain.gain.linearRampToValueAtTime(0.14, start + 0.025);
        gain.gain.exponentialRampToValueAtTime(0.001, start + d);

        osc.connect(gain);
        overtone.connect(overGain);
        overGain.connect(gain);
        gain.connect(ctx.destination);

        osc.start(start);
        overtone.start(start);
        osc.stop(start + d + 0.02);
        overtone.stop(start + d + 0.02);
      });
    };

    playPhrase();
    this.ringTimer = window.setInterval(playPhrase, 2800);
  }

  stopRing() {
    if (this.ringTimer !== null) {
      clearInterval(this.ringTimer);
      this.ringTimer = null;
    }
  }

  /**
   * Классический нисходящий звук завершения звонка Skype
   */
  playHangup() {
    this.stopRing();
    const ctx = this.ensureContext();
    const now = ctx.currentTime;
    const notes = [
      { f: 587.33, t: 0.0, d: 0.14 },
      { f: 440.0, t: 0.12, d: 0.16 },
      { f: 329.63, t: 0.25, d: 0.34 },
    ];

    notes.forEach(({ f, t, d }) => {
      const start = now + t;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(f, start);
      osc.frequency.exponentialRampToValueAtTime(f * 0.96, start + d);

      gain.gain.setValueAtTime(0.001, start);
      gain.gain.linearRampToValueAtTime(0.18, start + 0.015);
      gain.gain.exponentialRampToValueAtTime(0.001, start + d);

      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(start);
      osc.stop(start + d + 0.02);
    });
  }

  /**
   * Короткий приветственный аккорд при соединении
   */
  playCallConnected() {
    const ctx = this.ensureContext();
    const now = ctx.currentTime;
    [523.25, 783.99].forEach((f, idx) => {
      const start = now + idx * 0.09;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(f, start);
      gain.gain.setValueAtTime(0.001, start);
      gain.gain.linearRampToValueAtTime(0.12, start + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.001, start + 0.26);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(start);
      osc.stop(start + 0.28);
    });
  }

  /**
   * Тестовый звук проверки динамиков/наушников
   */
  playTestSound() {
    const ctx = this.ensureContext();
    const now = ctx.currentTime;
    const sequence = [
      { f: 440, pan: -0.7, t: 0.0 },
      { f: 554.37, pan: 0.0, t: 0.16 },
      { f: 659.25, pan: 0.7, t: 0.32 },
      { f: 880, pan: 0.0, t: 0.48 },
    ];

    sequence.forEach(({ f, pan, t }) => {
      const start = now + t;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'triangle';
      osc.frequency.setValueAtTime(f, start);

      gain.gain.setValueAtTime(0.001, start);
      gain.gain.linearRampToValueAtTime(0.15, start + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.001, start + 0.32);

      if (typeof ctx.createStereoPanner === 'function') {
        const panner = ctx.createStereoPanner();
        panner.pan.setValueAtTime(pan, start);
        osc.connect(gain);
        gain.connect(panner);
        panner.connect(ctx.destination);
      } else {
        osc.connect(gain);
        gain.connect(ctx.destination);
      }

      osc.start(start);
      osc.stop(start + 0.35);
    });
  }

  /**
   * Звук нового сообщения в чате
   */
  playMessagePop() {
    const ctx = this.ensureContext();
    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(640, now);
    osc.frequency.exponentialRampToValueAtTime(980, now + 0.07);
    gain.gain.setValueAtTime(0.001, now);
    gain.gain.linearRampToValueAtTime(0.1, now + 0.012);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.11);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(now);
    osc.stop(now + 0.12);
  }

  /**
   * Противное жужжание мухи со стереопанорамированием
   */
  startFlyBuzz() {
    this.stopFlyBuzz();
    const ctx = this.ensureContext();
    const now = ctx.currentTime;

    const osc = ctx.createOscillator();
    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(195, now);

    const lfo = ctx.createOscillator();
    const lfoGain = ctx.createGain();
    lfo.frequency.value = 31;
    lfoGain.gain.value = 24;
    lfo.connect(lfoGain);
    lfoGain.connect(osc.frequency);

    const filter = ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.value = 780;
    filter.Q.value = 2.4;

    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.001, now);
    gain.gain.linearRampToValueAtTime(0.07, now + 0.12);

    let panner = null;
    if (typeof ctx.createStereoPanner === 'function') {
      panner = ctx.createStereoPanner();
      panner.pan.value = 0;
      osc.connect(filter);
      filter.connect(gain);
      gain.connect(panner);
      panner.connect(ctx.destination);
    } else {
      osc.connect(filter);
      filter.connect(gain);
      gain.connect(ctx.destination);
    }

    osc.start(now);
    lfo.start(now);
    this.flyNodes = { osc, lfo, gain, filter, panner };
  }

  updateFlyBuzz(xNorm, isLanded) {
    if (!this.flyNodes || !this.ctx) return;
    const now = this.ctx.currentTime;
    const { osc, gain, panner } = this.flyNodes;
    const targetFreq = isLanded ? 140 : 190 + Math.abs(Math.sin(now * 9)) * 45;
    const targetGain = isLanded ? 0.012 : 0.075;
    osc.frequency.setTargetAtTime(targetFreq, now, 0.05);
    gain.gain.setTargetAtTime(targetGain, now, 0.06);
    if (panner) {
      const pan = Math.max(-0.9, Math.min(0.9, xNorm * 2 - 1));
      panner.pan.setTargetAtTime(pan, now, 0.05);
    }
  }

  stopFlyBuzz() {
    if (!this.flyNodes) return;
    const { osc, lfo, gain } = this.flyNodes;
    try {
      if (this.ctx) {
        gain.gain.setTargetAtTime(0.0001, this.ctx.currentTime, 0.03);
      }
      setTimeout(() => {
        try {
          osc.stop();
          lfo.stop();
          osc.disconnect();
          lfo.disconnect();
        } catch {
          // Узлы уже остановлены
        }
      }, 90);
    } catch {
      // Игнорируем
    }
    this.flyNodes = null;
  }

  /**
   * Хлопок при прихлопывании мухи
   */
  playFlySwat() {
    const ctx = this.ensureContext();
    const now = ctx.currentTime;
    const len = Math.floor(ctx.sampleRate * 0.12);
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const ch = buf.getChannelData(0);
    for (let i = 0; i < len; i++) {
      ch[i] = (Math.random() * 2 - 1) * Math.exp(-i / (len * 0.25));
    }
    const src = ctx.createBufferSource();
    src.buffer = buf;

    const filter = ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.value = 950;
    filter.Q.value = 0.8;

    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.45, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.12);

    src.connect(filter);
    filter.connect(gain);
    gain.connect(ctx.destination);
    src.start(now);
  }

  /**
   * Звон стеклянной бутылки при отбивании
   */
  playGlassClink() {
    const ctx = this.ensureContext();
    const now = ctx.currentTime;
    const partials = [
      { f: 1860, g: 0.16, d: 0.42 },
      { f: 2740, g: 0.11, d: 0.34 },
      { f: 3890, g: 0.08, d: 0.24 },
      { f: 5210, g: 0.05, d: 0.16 },
    ];

    partials.forEach(({ f, g, d }) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(f, now);
      gain.gain.setValueAtTime(0.001, now);
      gain.gain.linearRampToValueAtTime(g, now + 0.005);
      gain.gain.exponentialRampToValueAtTime(0.0008, now + d);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(now);
      osc.stop(now + d + 0.02);
    });
  }

  /**
   * Громкий двойной звон пивных кружек («Чокнуться!»)
   */
  playCheersClink() {
    const ctx = this.ensureContext();
    const now = ctx.currentTime;

    [0, 0.07].forEach((offset, hitIdx) => {
      const t = now + offset;
      const scale = hitIdx === 0 ? 1 : 0.72;
      [1420, 2190, 3180, 4460].forEach((freq, i) => {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(freq * (hitIdx === 0 ? 1 : 1.04), t);
        gain.gain.setValueAtTime(0.001, t);
        gain.gain.linearRampToValueAtTime((0.22 / (i + 1)) * scale, t + 0.006);
        gain.gain.exponentialRampToValueAtTime(0.0008, t + 0.65 - i * 0.09);
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start(t);
        osc.stop(t + 0.68);
      });
    });
  }

  /**
   * Звук разбитого стекла при падении бутылки
   */
  playGlassBreak() {
    const ctx = this.ensureContext();
    const now = ctx.currentTime;

    // Ударный всплеск шума
    const dur = 0.22;
    const len = Math.floor(ctx.sampleRate * dur);
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const ch = buf.getChannelData(0);
    for (let i = 0; i < len; i++) {
      ch[i] = (Math.random() * 2 - 1) * Math.exp(-i / (len * 0.3));
    }
    const noise = ctx.createBufferSource();
    noise.buffer = buf;
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 2600;
    const nGain = ctx.createGain();
    nGain.gain.setValueAtTime(0.32, now);
    nGain.gain.exponentialRampToValueAtTime(0.001, now + dur);
    noise.connect(hp);
    hp.connect(nGain);
    nGain.connect(ctx.destination);
    noise.start(now);

    // Россыпь стеклянных осколков
    for (let i = 0; i < 12; i++) {
      const start = now + i * 0.028 + Math.random() * 0.025;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'triangle';
      osc.frequency.setValueAtTime(2200 + Math.random() * 4800, start);
      gain.gain.setValueAtTime(0.001, start);
      gain.gain.linearRampToValueAtTime(0.08 * (1 - i / 15), start + 0.004);
      gain.gain.exponentialRampToValueAtTime(0.0008, start + 0.09 + Math.random() * 0.09);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(start);
      osc.stop(start + 0.22);
    }
  }
}
