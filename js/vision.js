/**
 * truskadurak — Движок камеры, аудио-индикатора и MediaPipe Tasks Vision
 * - Сегментация человека (Blur / Процедурные виртуальные фоны / Своя картинка)
 * - Плавный fallback на оригинальный MediaStream камеры
 * - HandLandmarker + резервный детектор движения руки для AR-игр
 */

import { CONFIG, loadStorage, saveStorage } from './config.js';

export class VisionEngine {
  constructor(callbacks = {}) {
    this.cb = callbacks;
    this.rawVideo = document.getElementById('raw-camera-video');
    this.outputCanvas = document.getElementById('vision-output-canvas');
    this.outputCtx = this.outputCanvas.getContext('2d');

    this.rawStream = null;
    this.processedStream = null;
    this.activeStream = null;

    // Состояние камеры и микрофона
    this.micEnabled = true;
    this.camEnabled = true;
    this.selectedDevices = loadStorage(CONFIG.STORAGE_KEYS.DEVICES, {
      videoId: '',
      audioId: '',
    });

    // Настройки фона
    this.bgConfig = loadStorage(CONFIG.STORAGE_KEYS.BG, {
      mode: 'none', // 'none' | 'blur' | 'virtual'
      blurAmount: 14,
      preset: 'pub', // 'pub' | 'cyberbar' | 'banya' | 'beach' | 'custom'
    });
    this.customBgImage = null;

    // MediaPipe инстансы
    this.mpVisionModule = null;
    this.mpFileset = null;
    this.segmenter = null;
    this.segmenterLoading = false;
    this.segmenterFailed = false;

    this.handLandmarker = null;
    this.handLoading = false;
    this.handFailed = false;
    this.handTrackingActive = false;

    // Вспомогательные canvas для композитинга и фона
    this.bgCanvas = document.createElement('canvas');
    this.bgCanvas.width = 640;
    this.bgCanvas.height = 480;
    this.bgCtx = this.bgCanvas.getContext('2d');

    this.maskCanvas = document.createElement('canvas');
    this.maskCanvas.width = 640;
    this.maskCanvas.height = 480;
    this.maskCtx = this.maskCanvas.getContext('2d');

    this.personCanvas = document.createElement('canvas');
    this.personCanvas.width = 640;
    this.personCanvas.height = 480;
    this.personCtx = this.personCanvas.getContext('2d');

    // Резервный детектор движения (32x24) если HandLandmarker грузится/недоступен
    this.motionCanvas = document.createElement('canvas');
    this.motionCanvas.width = 32;
    this.motionCanvas.height = 24;
    this.motionCtx = this.motionCanvas.getContext('2d', { willReadFrequently: true });
    this.prevMotionFrame = null;

    // Последнее обнаруженное положение руки (нормализовано 0..1, отзеркалено)
    this.handState = {
      detected: false,
      x: 0.5,
      y: 0.5,
      vx: 0,
      vy: 0,
      speed: 0,
      source: 'none',
      updatedAt: 0,
    };

    // Аудио-анализатор для индикатора громкости микрофона
    this.meterCtx = null;
    this.meterAnalyser = null;
    this.meterSource = null;
    this.meterData = null;

    this.rafId = null;
    this.lastVideoTime = -1;
    this.lastHandDetectTs = 0;

    this._renderVirtualBackground(0);
  }

  /**
   * Запустить или перезапустить камеру/микрофон с выбранными устройствами
   */
  async startCamera(videoDeviceId = this.selectedDevices.videoId, audioDeviceId = this.selectedDevices.audioId) {
    this.selectedDevices = {
      videoId: videoDeviceId || '',
      audioId: audioDeviceId || '',
    };
    saveStorage(CONFIG.STORAGE_KEYS.DEVICES, this.selectedDevices);

    this._stopRawTracks();

    const constraints = {
      video: videoDeviceId
        ? { deviceId: { exact: videoDeviceId }, width: { ideal: 640 }, height: { ideal: 480 } }
        : { width: { ideal: 640 }, height: { ideal: 480 }, facingMode: 'user' },
      audio: audioDeviceId
        ? { deviceId: { exact: audioDeviceId }, echoCancellation: true, noiseSuppression: true }
        : { echoCancellation: true, noiseSuppression: true },
    };

    try {
      this.rawStream = await navigator.mediaDevices.getUserMedia(constraints);
    } catch {
      // Fallback без жёсткого deviceId (если ранее выбранная камера отключена)
      try {
        this.rawStream = await navigator.mediaDevices.getUserMedia({
          video: { width: { ideal: 640 }, height: { ideal: 480 } },
          audio: true,
        });
      } catch {
        // Последний fallback — только аудио, если камеры вообще нет
        this.rawStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      }
    }

    this.rawVideo.srcObject = this.rawStream;
    try {
      await this.rawVideo.play();
    } catch {
      // Игнорируем автоплей до клика
    }

    if (this.rawVideo.videoWidth > 0 && this.rawVideo.videoHeight > 0) {
      const targetW = Math.min(640, this.rawVideo.videoWidth);
      const targetH = Math.round((targetW / this.rawVideo.videoWidth) * this.rawVideo.videoHeight);
      [this.outputCanvas, this.bgCanvas, this.personCanvas].forEach((c) => {
        c.width = targetW;
        c.height = targetH;
      });
    }

    this._applyMuteStates();
    this._setupMicAnalyser();
    this._ensureLoop();

    if (this.bgConfig.mode !== 'none') {
      this._ensureSegmenterLoaded();
    }

    return this.getOutgoingStream();
  }

  async listDevices() {
    try {
      const all = await navigator.mediaDevices.enumerateDevices();
      return {
        cameras: all.filter((d) => d.kind === 'videoinput'),
        microphones: all.filter((d) => d.kind === 'audioinput'),
      };
    } catch {
      return { cameras: [], microphones: [] };
    }
  }

  /**
   * Возвращает поток для отправки в WebRTC:
   * - В режиме 'none' — оригинальный MediaStream камеры (максимальная скорость и надёжность)
   * - В режимах 'blur'/'virtual' (когда MediaPipe готов) — canvas.captureStream(30) + аудиодорожка
   */
  getOutgoingStream() {
    if (!this.rawStream) return null;

    const useCanvas =
      this.bgConfig.mode !== 'none' &&
      this.segmenter &&
      !this.segmenterFailed &&
      this.rawStream.getVideoTracks().length > 0;

    if (!useCanvas) {
      this.activeStream = this.rawStream;
      return this.activeStream;
    }

    if (!this.processedStream) {
      const canvasStream = this.outputCanvas.captureStream(30);
      this.rawStream.getAudioTracks().forEach((track) => canvasStream.addTrack(track));
      this.processedStream = canvasStream;
    } else {
      // Обновляем аудиодорожку, если микрофон переключился
      const existingAudio = this.processedStream.getAudioTracks();
      const rawAudio = this.rawStream.getAudioTracks();
      if (rawAudio[0] && existingAudio[0] !== rawAudio[0]) {
        existingAudio.forEach((t) => this.processedStream.removeTrack(t));
        this.processedStream.addTrack(rawAudio[0]);
      }
    }

    this.activeStream = this.processedStream;
    return this.activeStream;
  }

  setMicEnabled(enabled) {
    this.micEnabled = enabled;
    this._applyMuteStates();
  }

  setCamEnabled(enabled) {
    this.camEnabled = enabled;
    this._applyMuteStates();
  }

  _applyMuteStates() {
    if (!this.rawStream) return;
    this.rawStream.getAudioTracks().forEach((t) => {
      t.enabled = this.micEnabled;
    });
    this.rawStream.getVideoTracks().forEach((t) => {
      t.enabled = this.camEnabled;
    });
  }

  /**
   * Настройка режима фона (none / blur / virtual)
   */
  async setBackgroundConfig(partial) {
    this.bgConfig = { ...this.bgConfig, ...partial };
    saveStorage(CONFIG.STORAGE_KEYS.BG, this.bgConfig);

    if (this.bgConfig.mode !== 'none') {
      this._emitVisionStatus('Загрузка MediaPipe сегментации...');
      await this._ensureSegmenterLoaded();
    } else {
      this._emitVisionStatus('Камера: оригинал');
    }

    const stream = this.getOutgoingStream();
    if (this.cb.onStreamUpdated) {
      this.cb.onStreamUpdated(stream);
    }
    return stream;
  }

  loadCustomBackgroundFile(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const img = new Image();
        img.onload = () => {
          this.customBgImage = img;
          this.setBackgroundConfig({ mode: 'virtual', preset: 'custom' }).then(resolve);
        };
        img.onerror = reject;
        img.src = reader.result;
      };
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
  }

  setHandTrackingActive(active) {
    this.handTrackingActive = active;
    if (active) {
      this._ensureHandLandmarkerLoaded();
      this._ensureLoop();
    } else {
      this.handState.detected = false;
    }
  }

  getHandState() {
    // Сбрасываем устаревшую позицию руки через 350 мс
    if (performance.now() - this.handState.updatedAt > 350) {
      this.handState.detected = false;
      this.handState.speed = 0;
    }
    return this.handState;
  }

  /**
   * Текущий уровень громкости микрофона (0..1) для живого индикатора в настройках
   */
  getMicLevel() {
    if (!this.meterAnalyser || !this.meterData) return 0;
    this.meterAnalyser.getByteTimeDomainData(this.meterData);
    let sum = 0;
    for (let i = 0; i < this.meterData.length; i++) {
      const v = (this.meterData[i] - 128) / 128;
      sum += v * v;
    }
    const rms = Math.sqrt(sum / this.meterData.length);
    return Math.min(1, rms * 4.2);
  }

  _setupMicAnalyser() {
    if (!this.rawStream || this.rawStream.getAudioTracks().length === 0) return;
    try {
      if (!this.meterCtx) {
        const AudioCtx = window.AudioContext || window.webkitAudioContext;
        this.meterCtx = new AudioCtx();
      }
      if (this.meterCtx.state === 'suspended') {
        this.meterCtx.resume().catch(() => {});
      }
      if (this.meterSource) {
        try {
          this.meterSource.disconnect();
        } catch {
          // Игнорируем
        }
      }
      this.meterAnalyser = this.meterCtx.createAnalyser();
      this.meterAnalyser.fftSize = 256;
      this.meterData = new Uint8Array(this.meterAnalyser.fftSize);
      this.meterSource = this.meterCtx.createMediaStreamSource(this.rawStream);
      this.meterSource.connect(this.meterAnalyser);
    } catch {
      // Игнорируем, если аудиоконтекст заблокирован
    }
  }

  async _loadMediaPipeBase() {
    if (this.mpVisionModule && this.mpFileset) {
      return { vision: this.mpVisionModule, fileset: this.mpFileset };
    }
    const visionUrl = CONFIG.MEDIAPIPE.VISION_URL;
    const vision = await import(/* @vite-ignore */ visionUrl);
    const fileset = await vision.FilesetResolver.forVisionTasks(CONFIG.MEDIAPIPE.WASM_URL);
    this.mpVisionModule = vision;
    this.mpFileset = fileset;
    return { vision, fileset };
  }

  async _ensureSegmenterLoaded() {
    if (this.segmenter || this.segmenterLoading || this.segmenterFailed) return;
    this.segmenterLoading = true;
    try {
      const { vision, fileset } = await this._loadMediaPipeBase();
      this.segmenter = await vision.ImageSegmenter.createFromOptions(fileset, {
        baseOptions: {
          modelAssetPath: CONFIG.MEDIAPIPE.SELFIE_MODEL,
          delegate: 'GPU',
        },
        runningMode: 'VIDEO',
        outputCategoryMask: false,
        outputConfidenceMasks: true,
      });
      this._emitVisionStatus(
        this.bgConfig.mode === 'blur' ? 'Фон: размытие активно' : 'Фон: виртуальный фон активен'
      );
      if (this.cb.onStreamUpdated) {
        this.cb.onStreamUpdated(this.getOutgoingStream());
      }
    } catch {
      this.segmenterFailed = true;
      this._emitVisionStatus('MediaPipe недоступен — используется оригинал');
      if (this.cb.onNotice) {
        this.cb.onNotice('Не удалось загрузить MediaPipe сегментацию, включён обычный поток камеры.');
      }
    } finally {
      this.segmenterLoading = false;
    }
  }

  async _ensureHandLandmarkerLoaded() {
    if (this.handLandmarker || this.handLoading || this.handFailed) return;
    this.handLoading = true;
    try {
      const { vision, fileset } = await this._loadMediaPipeBase();
      this.handLandmarker = await vision.HandLandmarker.createFromOptions(fileset, {
        baseOptions: {
          modelAssetPath: CONFIG.MEDIAPIPE.HAND_MODEL,
          delegate: 'GPU',
        },
        runningMode: 'VIDEO',
        numHands: 2,
      });
    } catch {
      this.handFailed = true;
    } finally {
      this.handLoading = false;
    }
  }

  _emitVisionStatus(label) {
    if (this.cb.onVisionStatus) {
      this.cb.onVisionStatus(label);
    }
  }

  _ensureLoop() {
    if (this.rafId !== null) return;
    const tick = (now) => {
      this._processFrame(now);
      this.rafId = requestAnimationFrame(tick);
    };
    this.rafId = requestAnimationFrame(tick);
  }

  _processFrame(now) {
    if (!this.rawVideo || this.rawVideo.readyState < 2 || this.rawVideo.videoWidth === 0) {
      return;
    }

    const w = this.outputCanvas.width;
    const h = this.outputCanvas.height;

    // 1. Обработка фона на Canvas (если активен режим blur или virtual и готов MediaPipe)
    if (this.bgConfig.mode !== 'none' && this.segmenter && !this.segmenterFailed) {
      if (this.rawVideo.currentTime !== this.lastVideoTime) {
        this.lastVideoTime = this.rawVideo.currentTime;
        try {
          const result = this.segmenter.segmentForVideo(this.rawVideo, now);
          const confMasks = result.confidenceMasks;
          if (confMasks && confMasks.length > 0) {
            const mask = confMasks[0];
            this._compositeSegmentedFrame(mask, w, h, now);
          } else {
            this.outputCtx.drawImage(this.rawVideo, 0, 0, w, h);
          }
          result.close();
        } catch {
          this.outputCtx.drawImage(this.rawVideo, 0, 0, w, h);
        }
      }
    }

    // 2. Распознавание рук (HandLandmarker или резервный детектор движения) для AR-игр
    if (this.handTrackingActive && now - this.lastHandDetectTs > 45) {
      this.lastHandDetectTs = now;
      if (this.handLandmarker && !this.handFailed) {
        try {
          const handRes = this.handLandmarker.detectForVideo(this.rawVideo, now);
          if (handRes.landmarks && handRes.landmarks.length > 0) {
            const hand = handRes.landmarks[0];
            // Центр ладони (точка 9) + указательный палец (точка 8)
            const palm = hand[9] || hand[8] || hand[0];
            // Отзеркаливаем X, чтобы движение правой рукой совпадало с экраном
            const nx = 1 - palm.x;
            const ny = palm.y;
            const vx = nx - this.handState.x;
            const vy = ny - this.handState.y;
            this.handState = {
              detected: true,
              x: nx,
              y: ny,
              vx,
              vy,
              speed: Math.hypot(vx, vy),
              source: 'mediapipe',
              updatedAt: now,
            };
          }
        } catch {
          this._detectMotionFallback(now);
        }
      } else {
        this._detectMotionFallback(now);
      }
    }
  }

  _compositeSegmentedFrame(confidenceMask, w, h, now) {
    const maskData = confidenceMask.getAsFloat32Array();
    const mw = confidenceMask.width;
    const mh = confidenceMask.height;

    if (this.maskCanvas.width !== mw || this.maskCanvas.height !== mh) {
      this.maskCanvas.width = mw;
      this.maskCanvas.height = mh;
    }

    const imgData = this.maskCtx.createImageData(mw, mh);
    const dst = imgData.data;
    for (let i = 0; i < maskData.length; i++) {
      // Плавный порог маски человека (мягкие края без «лесенок»)
      const conf = maskData[i];
      const alpha = Math.max(0, Math.min(255, Math.round(((conf - 0.35) / 0.4) * 255)));
      const p = i * 4;
      dst[p] = 255;
      dst[p + 1] = 255;
      dst[p + 2] = 255;
      dst[p + 3] = alpha;
    }
    this.maskCtx.putImageData(imgData, 0, 0);

    // Шаг 1: Отрисовываем фон на outputCanvas
    this.outputCtx.save();
    if (this.bgConfig.mode === 'blur') {
      this.outputCtx.filter = `blur(${this.bgConfig.blurAmount}px)`;
      this.outputCtx.drawImage(this.rawVideo, -16, -16, w + 32, h + 32);
      this.outputCtx.filter = 'none';
    } else {
      this._renderVirtualBackground(now);
      this.outputCtx.drawImage(this.bgCanvas, 0, 0, w, h);
    }
    this.outputCtx.restore();

    // Шаг 2: Вырезаем человека по сглаженной маске
    this.personCtx.clearRect(0, 0, w, h);
    this.personCtx.save();
    this.personCtx.filter = 'blur(2px)';
    this.personCtx.drawImage(this.maskCanvas, 0, 0, w, h);
    this.personCtx.filter = 'none';
    this.personCtx.globalCompositeOperation = 'source-in';
    this.personCtx.drawImage(this.rawVideo, 0, 0, w, h);
    this.personCtx.restore();

    // Шаг 3: Накладываем человека поверх фона
    this.outputCtx.drawImage(this.personCanvas, 0, 0, w, h);
  }

  /**
   * Резервный детектор взмаха руки по межкадровой разнице (работает даже без WebGL/MediaPipe)
   */
  _detectMotionFallback(now) {
    const mw = this.motionCanvas.width;
    const mh = this.motionCanvas.height;
    this.motionCtx.drawImage(this.rawVideo, 0, 0, mw, mh);
    const frame = this.motionCtx.getImageData(0, 0, mw, mh).data;

    if (this.prevMotionFrame) {
      let sumX = 0;
      let sumY = 0;
      let count = 0;

      for (let y = 0; y < mh; y++) {
        for (let x = 0; x < mw; x++) {
          const idx = (y * mw + x) * 4;
          const diff =
            Math.abs(frame[idx] - this.prevMotionFrame[idx]) +
            Math.abs(frame[idx + 1] - this.prevMotionFrame[idx + 1]) +
            Math.abs(frame[idx + 2] - this.prevMotionFrame[idx + 2]);
          if (diff > 95) {
            sumX += 1 - x / mw; // Зеркально
            sumY += y / mh;
            count++;
          }
        }
      }

      if (count >= 12) {
        const nx = sumX / count;
        const ny = sumY / count;
        const vx = nx - this.handState.x;
        const vy = ny - this.handState.y;
        this.handState = {
          detected: true,
          x: nx,
          y: ny,
          vx,
          vy,
          speed: Math.min(0.4, Math.hypot(vx, vy) + count / 280),
          source: 'motion',
          updatedAt: now,
        };
      }
    }

    this.prevMotionFrame = new Uint8ClampedArray(frame);
  }

  /**
   * Процедурная отрисовка встроенных виртуальных фонов на Canvas
   */
  _renderVirtualBackground(now) {
    const ctx = this.bgCtx;
    const w = this.bgCanvas.width;
    const h = this.bgCanvas.height;
    const t = now * 0.001;
    const preset = this.bgConfig.preset;

    if (preset === 'custom' && this.customBgImage) {
      const img = this.customBgImage;
      const scale = Math.max(w / img.width, h / img.height);
      const dw = img.width * scale;
      const dh = img.height * scale;
      ctx.drawImage(img, (w - dw) / 2, (h - dh) / 2, dw, dh);
      return;
    }

    if (preset === 'pub') {
      // Уютный паб с полками бутылок и тёплыми лампами Эдисона
      const wallGrad = ctx.createLinearGradient(0, 0, 0, h);
      wallGrad.addColorStop(0, '#23140b');
      wallGrad.addColorStop(0.55, '#3b2112');
      wallGrad.addColorStop(1, '#1a0e08');
      ctx.fillStyle = wallGrad;
      ctx.fillRect(0, 0, w, h);

      // Кирпичная текстура
      ctx.strokeStyle = 'rgba(0,0,0,0.22)';
      ctx.lineWidth = 1;
      for (let y = 0; y < h; y += 26) {
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(w, y);
        ctx.stroke();
      }

      // 3 деревянные полки с подсвеченными бутылками
      const shelfYs = [150, 265, 375];
      const bottleColors = ['#d98218', '#2a7f43', '#b83227', '#e0a938', '#4c2d19', '#1e6b52'];
      shelfYs.forEach((sy, sIdx) => {
        const glow = ctx.createLinearGradient(0, sy - 75, 0, sy);
        glow.addColorStop(0, 'rgba(255, 188, 88, 0)');
        glow.addColorStop(1, 'rgba(255, 188, 88, 0.25)');
        ctx.fillStyle = glow;
        ctx.fillRect(30, sy - 75, w - 60, 75);

        for (let i = 0; i < 11; i++) {
          const bx = 50 + i * 51 + (sIdx % 2) * 14;
          const bh = 42 + ((i * 17 + sIdx * 11) % 24);
          ctx.fillStyle = bottleColors[(i + sIdx * 2) % bottleColors.length];
          ctx.fillRect(bx, sy - bh, 18, bh);
          ctx.fillRect(bx + 5, sy - bh - 16, 8, 16);
          ctx.fillStyle = 'rgba(255,255,255,0.25)';
          ctx.fillRect(bx + 3, sy - bh + 5, 3, bh - 12);
          ctx.fillStyle = '#f5e6c8';
          ctx.fillRect(bx + 2, sy - bh * 0.58, 14, 14);
        }

        ctx.fillStyle = '#5a321a';
        ctx.fillRect(24, sy, w - 48, 12);
        ctx.fillStyle = '#2b160b';
        ctx.fillRect(24, sy + 12, w - 48, 5);
      });

      // Тёплые подвесные лампы сверху
      [140, 320, 500].forEach((lx, idx) => {
        const pulse = 0.85 + Math.sin(t * 2 + idx) * 0.08;
        ctx.strokeStyle = '#120a05';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(lx, 0);
        ctx.lineTo(lx, 54);
        ctx.stroke();

        const bulbGlow = ctx.createRadialGradient(lx, 62, 4, lx, 62, 95);
        bulbGlow.addColorStop(0, `rgba(255, 224, 140, ${0.85 * pulse})`);
        bulbGlow.addColorStop(0.3, `rgba(255, 168, 60, ${0.32 * pulse})`);
        bulbGlow.addColorStop(1, 'rgba(255, 168, 60, 0)');
        ctx.fillStyle = bulbGlow;
        ctx.beginPath();
        ctx.arc(lx, 62, 95, 0, Math.PI * 2);
        ctx.fill();

        ctx.fillStyle = '#fff3c4';
        ctx.beginPath();
        ctx.arc(lx, 62, 9, 0, Math.PI * 2);
        ctx.fill();
      });
      return;
    }

    if (preset === 'cyberbar') {
      // Неоновый кибер-бар
      const sky = ctx.createLinearGradient(0, 0, 0, h);
      sky.addColorStop(0, '#090318');
      sky.addColorStop(0.55, '#1d0938');
      sky.addColorStop(1, '#090214');
      ctx.fillStyle = sky;
      ctx.fillRect(0, 0, w, h);

      // Неоновая сетка перспективы
      ctx.strokeStyle = 'rgba(0, 240, 255, 0.28)';
      ctx.lineWidth = 1.2;
      const horizon = h * 0.62;
      for (let i = -8; i <= 8; i++) {
        ctx.beginPath();
        ctx.moveTo(w / 2 + i * 24, horizon);
        ctx.lineTo(w / 2 + i * 110, h);
        ctx.stroke();
      }
      for (let r = 0; r < 7; r++) {
        const y = horizon + Math.pow((r + (t * 0.6) % 1) / 7, 1.7) * (h - horizon);
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(w, y);
        ctx.stroke();
      }

      // Неоновые вывески и сияние
      const glowPink = ctx.createRadialGradient(130, 140, 10, 130, 140, 160);
      glowPink.addColorStop(0, 'rgba(255, 42, 133, 0.55)');
      glowPink.addColorStop(1, 'rgba(255, 42, 133, 0)');
      ctx.fillStyle = glowPink;
      ctx.fillRect(0, 0, 320, 320);

      const glowCyan = ctx.createRadialGradient(510, 150, 10, 510, 150, 160);
      glowCyan.addColorStop(0, 'rgba(0, 240, 255, 0.45)');
      glowCyan.addColorStop(1, 'rgba(0, 240, 255, 0)');
      ctx.fillStyle = glowCyan;
      ctx.fillRect(320, 0, 320, 320);

      ctx.strokeStyle = '#ff2a85';
      ctx.lineWidth = 3;
      ctx.strokeRect(56, 72, 146, 56);
      ctx.fillStyle = '#ff68ab';
      ctx.font = '700 24px Rubik, sans-serif';
      ctx.fillText('CYBER BAR', 68, 109);

      ctx.strokeStyle = '#00f0ff';
      ctx.beginPath();
      ctx.arc(515, 115, 42, 0, Math.PI * 2);
      ctx.stroke();
      return;
    }

    if (preset === 'banya') {
      // Баня с деревянными брёвнами, вениками и мягким паром
      const logH = 54;
      for (let y = 0; y < h; y += logH) {
        const logGrad = ctx.createLinearGradient(0, y, 0, y + logH);
        logGrad.addColorStop(0, '#6e4522');
        logGrad.addColorStop(0.25, '#b67d42');
        logGrad.addColorStop(0.65, '#8c5a2b');
        logGrad.addColorStop(1, '#4a2b13');
        ctx.fillStyle = logGrad;
        ctx.fillRect(0, y, w, logH);
      }

      // Берёзовые веники по бокам
      [92, w - 92].forEach((vx, idx) => {
        ctx.save();
        ctx.translate(vx, 120);
        ctx.rotate(idx === 0 ? -0.18 : 0.18);
        ctx.fillStyle = '#5c3a1e';
        ctx.fillRect(-6, -42, 12, 46);
        for (let i = 0; i < 24; i++) {
          const angle = (i / 24) * Math.PI * 2;
          const rx = Math.cos(angle) * (24 + (i % 3) * 10);
          const ry = 32 + Math.sin(angle) * 42;
          ctx.fillStyle = i % 2 === 0 ? '#3e7a2b' : '#589c3b';
          ctx.beginPath();
          ctx.ellipse(rx, ry, 14, 9, angle, 0, Math.PI * 2);
          ctx.fill();
        }
        ctx.restore();
      });

      // Поднимающийся пар
      for (let i = 0; i < 8; i++) {
        const px = ((i * 97 + t * 18) % (w + 120)) - 60;
        const py = h - ((t * 32 + i * 75) % (h + 120));
        const steam = ctx.createRadialGradient(px, py, 10, px, py, 95);
        steam.addColorStop(0, 'rgba(255, 250, 240, 0.22)');
        steam.addColorStop(1, 'rgba(255, 250, 240, 0)');
        ctx.fillStyle = steam;
        ctx.beginPath();
        ctx.arc(px, py, 95, 0, Math.PI * 2);
        ctx.fill();
      }
      return;
    }

    // Ночной пляж на закате ('beach')
    const sunset = ctx.createLinearGradient(0, 0, 0, h * 0.65);
    sunset.addColorStop(0, '#0f102b');
    sunset.addColorStop(0.45, '#462252');
    sunset.addColorStop(0.8, '#c7523b');
    sunset.addColorStop(1, '#f4a24d');
    ctx.fillStyle = sunset;
    ctx.fillRect(0, 0, w, h * 0.65);

    // Звёзды
    ctx.fillStyle = 'rgba(255, 255, 255, 0.85)';
    for (let i = 0; i < 32; i++) {
      const sx = (i * 73) % w;
      const sy = (i * 29) % (h * 0.35);
      const r = 1 + ((i + Math.floor(t * 2)) % 2);
      ctx.fillRect(sx, sy, r, r);
    }

    // Заходящее солнце
    const sunGrad = ctx.createRadialGradient(w / 2, h * 0.6, 8, w / 2, h * 0.6, 75);
    sunGrad.addColorStop(0, '#fff3b0');
    sunGrad.addColorStop(0.45, '#ff9e3d');
    sunGrad.addColorStop(1, 'rgba(255, 110, 50, 0)');
    ctx.fillStyle = sunGrad;
    ctx.beginPath();
    ctx.arc(w / 2, h * 0.6, 75, 0, Math.PI * 2);
    ctx.fill();

    // Ночной океан с бликами
    const sea = ctx.createLinearGradient(0, h * 0.62, 0, h);
    sea.addColorStop(0, '#1c1836');
    sea.addColorStop(1, '#080914');
    ctx.fillStyle = sea;
    ctx.fillRect(0, h * 0.62, w, h * 0.38);

    ctx.fillStyle = 'rgba(255, 178, 86, 0.45)';
    for (let i = 0; i < 12; i++) {
      const wy = h * 0.65 + i * 13;
      const ww = 90 - i * 4 + Math.sin(t * 2.5 + i) * 14;
      ctx.fillRect(w / 2 - ww / 2, wy, ww, 3);
    }

    // Силуэты пальм по краям
    ctx.fillStyle = '#090612';
    ctx.beginPath();
    ctx.moveTo(0, h);
    ctx.quadraticCurveTo(46, h * 0.55, 92, h * 0.25);
    ctx.lineTo(106, h * 0.27);
    ctx.quadraticCurveTo(64, h * 0.55, 32, h);
    ctx.fill();

    ctx.beginPath();
    ctx.moveTo(w, h);
    ctx.quadraticCurveTo(w - 46, h * 0.55, w - 92, h * 0.25);
    ctx.lineTo(w - 106, h * 0.27);
    ctx.quadraticCurveTo(w - 64, h * 0.55, w - 32, h);
    ctx.fill();
  }

  _stopRawTracks() {
    if (this.rawStream) {
      this.rawStream.getTracks().forEach((t) => t.stop());
      this.rawStream = null;
    }
    this.processedStream = null;
  }

  stopAll() {
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
    this.handTrackingActive = false;
    this._stopRawTracks();
  }
}
