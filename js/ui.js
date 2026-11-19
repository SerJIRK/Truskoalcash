/**
 * truskadurak — Контроллер интерфейса (DOM, Ящик пива, Темы, Перетаскивание PiP, Чат и Настройки)
 */

import { CONFIG, loadStorage, saveStorage } from './config.js';

export class UIController {
  constructor() {
    this.screens = {
      pin: document.getElementById('screen-pin'),
      locked: document.getElementById('screen-locked'),
      profile: document.getElementById('screen-profile'),
      lobby: document.getElementById('screen-lobby'),
      call: document.getElementById('screen-call'),
    };

    this.overlays = {
      outgoing: document.getElementById('overlay-outgoing'),
      incoming: document.getElementById('overlay-incoming'),
      settings: document.getElementById('modal-settings'),
    };

    this.toastContainer = document.getElementById('toast-container');
    this.chatDrawer = document.getElementById('chat-drawer');
    this.unreadCount = 0;
    this.callTimerInterval = null;
    this.callStartMs = 0;
    this.penaltyTimeout = null;

    this._initDraggablePiP();
  }

  /* ========================================================================
     ТЕМЫ ОФОРМЛЕНИЯ
     ======================================================================== */
  initTheme(onThemeChange) {
    const saved = loadStorage(CONFIG.STORAGE_KEYS.THEME, 'night-bar');
    const validTheme = CONFIG.THEMES.includes(saved) ? saved : 'night-bar';
    this.applyTheme(validTheme);

    document.querySelectorAll('[data-theme-select]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const theme = btn.getAttribute('data-theme-select');
        this.applyTheme(theme);
        if (onThemeChange) onThemeChange(theme);
      });
    });
  }

  applyTheme(themeId) {
    document.documentElement.setAttribute('data-theme', themeId);
    saveStorage(CONFIG.STORAGE_KEYS.THEME, themeId);
    document.querySelectorAll('[data-theme-select]').forEach((btn) => {
      const isActive = btn.getAttribute('data-theme-select') === themeId;
      btn.classList.toggle('theme-btn--active', isActive);
    });
  }

  /* ========================================================================
     ПЕРЕКЛЮЧЕНИЕ ЭКРАНОВ И ОВЕРЛЕЕВ
     ======================================================================== */
  showScreen(name) {
    Object.entries(this.screens).forEach(([key, el]) => {
      el.classList.toggle('screen--active', key === name);
    });
  }

  showOutgoingCall(friendProfile) {
    document.getElementById('outgoing-avatar').textContent = friendProfile?.avatar || '🍺';
    document.getElementById('outgoing-name').textContent = friendProfile?.name || 'Собеседник';
    this.overlays.outgoing.hidden = false;
  }

  hideOutgoingCall() {
    this.overlays.outgoing.hidden = true;
  }

  showIncomingCall(friendProfile) {
    const name = friendProfile?.name || 'Собеседник';
    document.getElementById('incoming-avatar').textContent = friendProfile?.avatar || '🍺';
    const nameEl = document.getElementById('incoming-name');
    nameEl.textContent = name;
    nameEl.setAttribute('data-text', name);
    this.overlays.incoming.hidden = false;
  }

  hideIncomingCall() {
    this.overlays.incoming.hidden = true;
  }

  showSettingsModal() {
    this.overlays.settings.hidden = false;
  }

  hideSettingsModal() {
    this.overlays.settings.hidden = true;
  }

  isSettingsOpen() {
    return !this.overlays.settings.hidden;
  }

  /* ========================================================================
     ЯЩИК ПИВА (3×3 БАНКИ) И PIN-ДИСПЛЕЙ
     ======================================================================== */
  renderBeerCrate(onCanPress) {
    const grid = document.getElementById('crate-grid');
    grid.innerHTML = '';

    for (let digit = 1; digit <= 9; digit++) {
      const slot = document.createElement('div');
      slot.className = 'can-slot';

      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'can-btn';
      btn.setAttribute('data-digit', String(digit));
      btn.setAttribute('aria-label', `Банка ${digit}`);
      btn.innerHTML = `
        <span class="can-inner-ring" aria-hidden="true"></span>
        <span class="can-tab" aria-hidden="true"></span>
        <span class="can-digit">${digit}</span>
        <span class="can-fizz" aria-hidden="true"></span>
      `;

      btn.addEventListener('click', () => {
        btn.classList.remove('can-btn--opening');
        // Принудительный перезапуск CSS-анимации пшика
        void btn.offsetWidth;
        btn.classList.add('can-btn--opening');
        window.setTimeout(() => btn.classList.remove('can-btn--opening'), 460);
        onCanPress(String(digit));
      });

      slot.appendChild(btn);
      grid.appendChild(slot);
    }
  }

  updatePinDisplay(pinString) {
    const slots = document.querySelectorAll('#pin-display .pin-slot');
    slots.forEach((slot, idx) => {
      const char = pinString[idx] || '';
      slot.textContent = char;
      slot.classList.toggle('pin-slot--filled', Boolean(char));
    });
  }

  setLockedPinLabel(pin) {
    document.getElementById('locked-pin-label').textContent = pin || '----';
  }

  /* ========================================================================
     ПРОФИЛЬ (ЭМОДЗИ-АВАТАРЫ)
     ======================================================================== */
  renderAvatarPicker(selectedAvatar, onSelect) {
    const grid = document.getElementById('avatar-grid');
    grid.innerHTML = '';

    CONFIG.AVATARS.forEach((emoji) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'avatar-option';
      btn.textContent = emoji;
      btn.setAttribute('role', 'radio');
      btn.setAttribute('aria-label', `Аватар ${emoji}`);
      const isSelected = emoji === selectedAvatar;
      btn.classList.toggle('avatar-option--selected', isSelected);
      btn.setAttribute('aria-checked', String(isSelected));

      btn.addEventListener('click', () => {
        grid.querySelectorAll('.avatar-option').forEach((el) => {
          el.classList.remove('avatar-option--selected');
          el.setAttribute('aria-checked', 'false');
        });
        btn.classList.add('avatar-option--selected');
        btn.setAttribute('aria-checked', 'true');
        onSelect(emoji);
      });

      grid.appendChild(btn);
    });
  }

  /* ========================================================================
     ЛОББИ И СТАТУСЫ ПОДКЛЮЧЕНИЯ
     ======================================================================== */
  updateLobbySelf(profile, pin, role) {
    document.getElementById('lobby-pin-code').textContent = pin || '----';
    document.getElementById('my-avatar').textContent = profile.avatar;
    document.getElementById('my-name').textContent = profile.name;
    document.getElementById('my-role-label').textContent = role === 'guest' ? 'Гость стола' : 'Хост стола';
    document.getElementById('local-pip-avatar').textContent = profile.avatar;
  }

  updateLobbyFriend(friendProfile) {
    const card = document.getElementById('friend-card');
    const avatarEl = document.getElementById('friend-avatar');
    const metaEl = document.getElementById('friend-meta');
    const nameEl = document.getElementById('friend-name');
    const readyEl = document.getElementById('friend-ready-status');
    const hintEl = document.getElementById('friend-waiting-hint');
    const callBtn = document.getElementById('btn-call-friend');
    const lobbyInput = document.getElementById('lobby-chat-input');
    const lobbySend = document.getElementById('lobby-chat-send');

    if (friendProfile) {
      card.setAttribute('data-connected', 'true');
      avatarEl.textContent = friendProfile.avatar;
      metaEl.textContent = 'Собутыльник на связи';
      nameEl.textContent = friendProfile.name;
      readyEl.hidden = false;
      hintEl.hidden = true;
      callBtn.disabled = false;
      lobbyInput.disabled = false;
      lobbySend.disabled = false;

      document.getElementById('call-peer-avatar').textContent = friendProfile.avatar;
      document.getElementById('call-peer-name').textContent = friendProfile.name;
      document.getElementById('remote-placeholder-avatar').textContent = friendProfile.avatar;
      document.getElementById('remote-placeholder-name').textContent = friendProfile.name;
    } else {
      card.setAttribute('data-connected', 'false');
      avatarEl.textContent = '🍻';
      metaEl.textContent = 'Свободный стул';
      nameEl.textContent = 'Ждём собутыльника…';
      readyEl.hidden = true;
      hintEl.hidden = false;
      callBtn.disabled = true;
      lobbyInput.disabled = true;
      lobbySend.disabled = true;
    }
  }

  updateConnectionStatus(state, text) {
    const lobbyState = document.getElementById('lobby-conn-state');
    const lobbyText = document.getElementById('lobby-conn-text');
    const callState = document.getElementById('call-conn-state');
    const callText = document.getElementById('call-conn-text');

    lobbyState.setAttribute('data-state', state);
    lobbyText.textContent = text;
    callState.setAttribute('data-state', state);
    callText.textContent = text;
  }

  /* ========================================================================
     УПРАВЛЕНИЕ ВИДЕОЗВОНКОМ, ТАЙМЕРОМ И ПЕРЕТАСКИВАНИЕМ PiP
     ======================================================================== */
  setRemoteVideoVisible(hasStream) {
    document.getElementById('remote-placeholder').hidden = hasStream;
  }

  updateMicButton(enabled) {
    const btn = document.getElementById('btn-toggle-mic');
    btn.setAttribute('data-active', String(enabled));
    btn.querySelector('.dock-icon').textContent = enabled ? '🎤' : '🔇';
    btn.querySelector('.dock-label').textContent = enabled ? 'Микрофон' : 'Выкл.';
  }

  updateCamButton(enabled) {
    const btn = document.getElementById('btn-toggle-cam');
    btn.setAttribute('data-active', String(enabled));
    btn.querySelector('.dock-icon').textContent = enabled ? '📹' : '🚫';
    btn.querySelector('.dock-label').textContent = enabled ? 'Камера' : 'Выкл.';
    document.getElementById('local-pip-off').hidden = enabled;
  }

  startCallTimer() {
    this.stopCallTimer();
    this.callStartMs = Date.now();
    const timerEl = document.getElementById('call-timer');
    timerEl.textContent = '00:00';
    this.callTimerInterval = window.setInterval(() => {
      const sec = Math.floor((Date.now() - this.callStartMs) / 1000);
      const m = String(Math.floor(sec / 60)).padStart(2, '0');
      const s = String(sec % 60).padStart(2, '0');
      timerEl.textContent = `${m}:${s}`;
    }, 1000);
  }

  stopCallTimer() {
    if (this.callTimerInterval !== null) {
      clearInterval(this.callTimerInterval);
      this.callTimerInterval = null;
    }
  }

  _initDraggablePiP() {
    const pip = document.getElementById('local-pip');
    if (!pip) return;

    let dragging = false;
    let offsetX = 0;
    let offsetY = 0;

    pip.addEventListener('pointerdown', (e) => {
      dragging = true;
      pip.classList.add('local-pip--dragging');
      pip.setPointerCapture(e.pointerId);
      const rect = pip.getBoundingClientRect();
      offsetX = e.clientX - rect.left;
      offsetY = e.clientY - rect.top;
      pip.style.right = 'auto';
      pip.style.bottom = 'auto';
      pip.style.left = `${rect.left}px`;
      pip.style.top = `${rect.top}px`;
    });

    pip.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      const maxX = window.innerWidth - pip.offsetWidth - 10;
      const maxY = window.innerHeight - pip.offsetHeight - 10;
      const nextX = Math.max(10, Math.min(maxX, e.clientX - offsetX));
      const nextY = Math.max(10, Math.min(maxY, e.clientY - offsetY));
      pip.style.left = `${nextX}px`;
      pip.style.top = `${nextY}px`;
    });

    const stopDrag = () => {
      if (!dragging) return;
      dragging = false;
      pip.classList.remove('local-pip--dragging');
    };

    pip.addEventListener('pointerup', stopDrag);
    pip.addEventListener('pointercancel', stopDrag);
  }

  /* ========================================================================
     AR-ИГРЫ: СТАТУСЫ КНОПОК, HUD И ШТРАФНАЯ ПЛАШКА
     ======================================================================== */
  toggleGamesPopover(forceState) {
    const pop = document.getElementById('games-popover');
    const shouldShow = typeof forceState === 'boolean' ? forceState : pop.hidden;
    pop.hidden = !shouldShow;
  }

  updateFlyControl(isMyTurn) {
    const btn = document.getElementById('btn-launch-fly');
    const status = document.getElementById('fly-turn-status');
    btn.disabled = !isMyTurn;
    status.textContent = isMyTurn
      ? 'Ваш ход — отправьте муху другу!'
      : 'Ход друга — ждите ответного троллинга';
  }

  updateBottleGameUI(active, score) {
    const hud = document.getElementById('bottle-hud');
    const btn = document.getElementById('btn-toggle-bottle');
    const scoreEl = document.getElementById('bottle-score');
    hud.hidden = !active;
    scoreEl.textContent = String(score);
    btn.textContent = active ? 'Остановить' : 'Начать';
  }

  showPenaltyBanner(text = 'Штрафной глоток! 🍺') {
    const banner = document.getElementById('penalty-banner');
    banner.textContent = text;
    banner.hidden = false;
    if (this.penaltyTimeout) clearTimeout(this.penaltyTimeout);
    this.penaltyTimeout = window.setTimeout(() => {
      banner.hidden = true;
    }, 2400);
  }

  /* ========================================================================
     ТЕКСТОВЫЙ ЧАТ И БЫСТРЫЕ ТОСТЫ
     ======================================================================== */
  renderQuickToasts(onSendToast) {
    ['lobby-quick-toasts', 'call-quick-toasts'].forEach((id) => {
      const wrap = document.getElementById(id);
      wrap.innerHTML = '';
      CONFIG.QUICK_TOASTS.forEach((toastText) => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'toast-chip';
        btn.textContent = toastText;
        btn.addEventListener('click', () => onSendToast(toastText));
        wrap.appendChild(btn);
      });
    });
  }

  appendChatMessage({ author, avatar, text, time, mine }) {
    ['lobby-chat-messages', 'call-chat-messages'].forEach((id) => {
      const list = document.getElementById(id);
      const empty = list.querySelector('.chat-empty');
      if (empty) empty.remove();

      const item = document.createElement('div');
      item.className = `chat-msg ${mine ? 'chat-msg--mine' : ''}`;

      const head = document.createElement('div');
      head.className = 'chat-msg-head';
      head.textContent = `${avatar} ${author} · ${time}`;

      const body = document.createElement('div');
      body.className = 'chat-msg-text';
      body.textContent = text;

      item.appendChild(head);
      item.appendChild(body);
      list.appendChild(item);
      list.scrollTop = list.scrollHeight;
    });

    if (!mine && !this.isChatOpen()) {
      this.unreadCount += 1;
      this._renderUnreadBadge();
    }
  }

  clearChatMessages() {
    ['lobby-chat-messages', 'call-chat-messages'].forEach((id) => {
      const list = document.getElementById(id);
      list.innerHTML = '<div class="chat-empty">Напишите тост или сообщение — доставится мгновенно по P2P.</div>';
    });
    this.unreadCount = 0;
    this._renderUnreadBadge();
  }

  isChatOpen() {
    return this.chatDrawer.classList.contains('chat-drawer--open');
  }

  toggleChatDrawer(forceState) {
    const shouldOpen = typeof forceState === 'boolean' ? forceState : !this.isChatOpen();
    this.chatDrawer.classList.toggle('chat-drawer--open', shouldOpen);
    this.chatDrawer.setAttribute('aria-hidden', String(!shouldOpen));
    if (shouldOpen) {
      this.unreadCount = 0;
      this._renderUnreadBadge();
    }
  }

  _renderUnreadBadge() {
    const badge = document.getElementById('chat-unread-badge');
    if (this.unreadCount > 0) {
      badge.textContent = String(this.unreadCount > 99 ? '99+' : this.unreadCount);
      badge.hidden = false;
    } else {
      badge.hidden = true;
    }
  }

  /* ========================================================================
     НАСТРОЙКИ: УСТРОЙСТВА, ФОН, ИНДИКАТОР МИКРОФОНА И TURN
     ======================================================================== */
  populateDevices({ cameras, microphones }, selected) {
    const camSel = document.getElementById('select-camera');
    const micSel = document.getElementById('select-mic');

    camSel.innerHTML = '';
    if (cameras.length === 0) {
      camSel.innerHTML = '<option value="">Камера не найдена</option>';
    } else {
      cameras.forEach((d, idx) => {
        const opt = document.createElement('option');
        opt.value = d.deviceId;
        opt.textContent = d.label || `Камера ${idx + 1}`;
        opt.selected = d.deviceId === selected.videoId;
        camSel.appendChild(opt);
      });
    }

    micSel.innerHTML = '';
    if (microphones.length === 0) {
      micSel.innerHTML = '<option value="">Микрофон не найден</option>';
    } else {
      microphones.forEach((d, idx) => {
        const opt = document.createElement('option');
        opt.value = d.deviceId;
        opt.textContent = d.label || `Микрофон ${idx + 1}`;
        opt.selected = d.deviceId === selected.audioId;
        micSel.appendChild(opt);
      });
    }
  }

  syncBackgroundControls(bgConfig) {
    document.querySelectorAll('#bg-mode-selector [data-bg-mode]').forEach((btn) => {
      btn.classList.toggle('seg-btn--active', btn.getAttribute('data-bg-mode') === bgConfig.mode);
    });

    document.getElementById('blur-control-group').hidden = bgConfig.mode !== 'blur';
    document.getElementById('virtual-bg-group').hidden = bgConfig.mode !== 'virtual';

    const slider = document.getElementById('blur-strength-slider');
    slider.value = String(bgConfig.blurAmount);
    document.getElementById('blur-strength-val').textContent = `${bgConfig.blurAmount}px`;

    document.querySelectorAll('#bg-presets [data-bg-preset]').forEach((btn) => {
      btn.classList.toggle('preset-btn--active', btn.getAttribute('data-bg-preset') === bgConfig.preset);
    });
  }

  setVisionStatusBadge(text) {
    document.getElementById('vision-status-label').textContent = text;
  }

  updateMicMeter(level) {
    const bars = document.querySelectorAll('#mic-meter .mic-meter-bar');
    const litCount = Math.round(level * bars.length);
    bars.forEach((bar, i) => {
      const lit = i < litCount;
      bar.classList.toggle('mic-meter-bar--lit', lit && i < 7);
      bar.classList.toggle('mic-meter-bar--mid', lit && i >= 7 && i < 10);
      bar.classList.toggle('mic-meter-bar--hot', lit && i >= 10);
      bar.style.height = lit ? `${35 + ((i + 1) / bars.length) * 65}%` : '22%';
    });
  }

  syncTurnInputs(turn) {
    document.getElementById('turn-url-input').value = turn?.url || '';
    document.getElementById('turn-user-input').value = turn?.username || '';
    document.getElementById('turn-cred-input').value = turn?.credential || '';
  }

  /* ========================================================================
     ВСПЛЫВАЮЩИЕ УВЕДОМЛЕНИЯ (TOASTS)
     ======================================================================== */
  showToast(message, variant = 'info') {
    const el = document.createElement('div');
    el.className = `toast ${variant === 'error' ? 'toast--error' : variant === 'success' ? 'toast--success' : ''}`;
    el.textContent = message;
    this.toastContainer.appendChild(el);
    window.setTimeout(() => {
      el.remove();
    }, 3400);
  }
}
