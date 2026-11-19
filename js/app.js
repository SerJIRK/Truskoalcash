/**
 * truskadurak — Главный контроллер приложения
 * Связывает авторизацию «Ящик пива», WebRTC (PeerJS), звук, MediaPipe Vision и AR-игры.
 */

import { CONFIG, loadStorage, saveStorage, getSavedTurnConfig } from './config.js';
import { SoundEngine } from './sound.js';
import { WebRTCManager } from './webrtc.js';
import { VisionEngine } from './vision.js';
import { GamesEngine } from './games.js';
import { UIController } from './ui.js';

class TruskaDurakApp {
  constructor() {
    this.sound = new SoundEngine();
    this.ui = new UIController();

    this.currentPin = '';
    this.activePin = '';
    this.myProfile = loadStorage(CONFIG.STORAGE_KEYS.PROFILE, null);
    this.selectedAvatar = this.myProfile?.avatar || CONFIG.AVATARS[0];
    this.friendProfile = null;
    this.editingProfileFromLobby = false;

    this.inCall = false;
    this.flyIsMyTurn = true;
    this.micMeterRaf = null;

    this.vision = new VisionEngine({
      onStreamUpdated: (stream) => this._handleLocalStreamUpdated(stream),
      onVisionStatus: (label) => this.ui.setVisionStatusBadge(label),
      onNotice: (msg) => this.ui.showToast(msg, 'info'),
    });

    this.rtc = new WebRTCManager({
      onRoleAssigned: (role) => this._onRoleAssigned(role),
      onStatusChange: (state, text) => this.ui.updateConnectionStatus(state, text),
      onRoomFull: (pin) => this._onRoomFull(pin),
      onPeerConnected: (profile) => this._onPeerConnected(profile),
      onPeerProfileUpdated: (profile) => this._onPeerProfileUpdated(profile),
      onPeerDisconnected: () => this._onPeerDisconnected(),
      onDataMessage: (msg) => this._onDataMessage(msg),
      onRemoteStream: (stream) => this._onRemoteStream(stream),
      onMediaCallClosed: () => this._onMediaCallClosed(),
      onError: (msg) => this.ui.showToast(msg, 'error'),
    });

    this.games = new GamesEngine(
      document.getElementById('ar-canvas'),
      this.sound,
      this.vision,
      {
        onFlySwatted: () => {
          this.rtc.sendData({ type: 'GAME_FLY_SWATTED' });
          this.ui.showToast('Муха прихлопнута!', 'success');
        },
        onBottleHit: (newScore) => {
          this.ui.updateBottleGameUI(true, newScore);
          this.rtc.sendData({ type: 'GAME_BOTTLE_SCORE', score: newScore });
        },
        onBottleMissed: () => {
          this.ui.showPenaltyBanner('Штрафной глоток! 🍺');
          this.rtc.sendData({ type: 'GAME_BOTTLE_MISS' });
        },
      }
    );

    this._bindAllEvents();
    this._bootstrap();
  }

  _bootstrap() {
    this.ui.initTheme();
    this.ui.renderBeerCrate((digit) => this._onPinDigit(digit));
    this.ui.renderQuickToasts((text) => this._sendChatMessage(text));
    this.ui.syncBackgroundControls(this.vision.bgConfig);
    this.ui.syncTurnInputs(getSavedTurnConfig());
    this.ui.showScreen('pin');
  }

  _bindAllEvents() {
    // 1. PIN-экран (Ящик пива)
    document.getElementById('btn-pin-reset').addEventListener('click', () => {
      this.currentPin = '';
      this.ui.updatePinDisplay(this.currentPin);
    });

    document.getElementById('btn-pin-backspace').addEventListener('click', () => {
      this.currentPin = this.currentPin.slice(0, -1);
      this.ui.updatePinDisplay(this.currentPin);
    });

    document.getElementById('btn-pin-settings').addEventListener('click', () => {
      this._openSettingsModal();
    });

    // Ввод PIN с клавиатуры (цифры 1–9, Backspace, Escape)
    window.addEventListener('keydown', (e) => {
      if (!document.getElementById('screen-pin').classList.contains('screen--active')) return;
      if (this.ui.isSettingsOpen()) return;
      if (e.key >= '1' && e.key <= '9') {
        const canBtn = document.querySelector(`.can-btn[data-digit="${e.key}"]`);
        if (canBtn) canBtn.click();
      } else if (e.key === 'Backspace') {
        this.currentPin = this.currentPin.slice(0, -1);
        this.ui.updatePinDisplay(this.currentPin);
      } else if (e.key === 'Escape') {
        this.currentPin = '';
        this.ui.updatePinDisplay(this.currentPin);
      }
    });

    // 2. Экран блокировки комнаты (3-й лишний)
    document.getElementById('btn-locked-back').addEventListener('click', () => {
      this.currentPin = '';
      this.ui.updatePinDisplay('');
      this.ui.showScreen('pin');
    });

    // 3. Экран профиля
    document.getElementById('btn-profile-back').addEventListener('click', () => {
      if (this.editingProfileFromLobby) {
        this.editingProfileFromLobby = false;
        this.ui.showScreen('lobby');
      } else {
        this.currentPin = '';
        this.ui.updatePinDisplay('');
        this.ui.showScreen('pin');
      }
    });

    document.getElementById('profile-form').addEventListener('submit', (e) => {
      e.preventDefault();
      const input = document.getElementById('profile-name-input');
      const name = input.value.trim();
      if (!name) {
        this.ui.showToast('Введите ваше имя за столом', 'error');
        input.focus();
        return;
      }

      this.myProfile = {
        name,
        avatar: this.selectedAvatar,
      };
      saveStorage(CONFIG.STORAGE_KEYS.PROFILE, this.myProfile);

      if (this.editingProfileFromLobby) {
        this.editingProfileFromLobby = false;
        this.ui.updateLobbySelf(this.myProfile, this.activePin, this.rtc.role);
        this.rtc.updateMyProfile(this.myProfile);
        this.ui.showScreen('lobby');
        this.ui.showToast('Профиль обновлён', 'success');
      } else {
        this._enterLobbyWithPin(this.activePin);
      }
    });

    // 4. Лобби
    document.getElementById('btn-copy-pin').addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(this.activePin);
        this.ui.showToast(`PIN ${this.activePin} скопирован`, 'success');
      } catch {
        this.ui.showToast(`Ваш PIN комнаты: ${this.activePin}`);
      }
    });

    document.getElementById('btn-edit-profile').addEventListener('click', () => {
      this.editingProfileFromLobby = true;
      this._openProfileScreen();
    });

    document.getElementById('btn-leave-room').addEventListener('click', () => {
      this._leaveRoomCompletely();
    });

    document.getElementById('btn-lobby-settings').addEventListener('click', () => {
      this._openSettingsModal();
    });

    document.getElementById('btn-lobby-reconnect').addEventListener('click', () => {
      this.ui.showToast('Переподключаемся к комнате...');
      this.rtc.reconnect();
    });

    document.getElementById('btn-call-friend').addEventListener('click', () => {
      this._initiateOutgoingCall();
    });

    // Чат в лобби
    document.getElementById('lobby-chat-form').addEventListener('submit', (e) => {
      e.preventDefault();
      const input = document.getElementById('lobby-chat-input');
      const text = input.value.trim();
      if (!text) return;
      input.value = '';
      this._sendChatMessage(text);
    });

    // 5. Исходящий / Входящий вызов
    document.getElementById('btn-cancel-call').addEventListener('click', () => {
      this.sound.playHangup();
      this.ui.hideOutgoingCall();
      this.rtc.sendData({ type: 'CALL_CANCEL' });
    });

    document.getElementById('btn-accept-call').addEventListener('click', () => {
      this._acceptIncomingCall();
    });

    document.getElementById('btn-reject-call').addEventListener('click', () => {
      this.sound.playHangup();
      this.ui.hideIncomingCall();
      this.rtc.sendData({ type: 'CALL_REJECT' });
    });

    // 6. Экран видеозвонка
    document.getElementById('btn-toggle-mic').addEventListener('click', () => {
      const next = !this.vision.micEnabled;
      this.vision.setMicEnabled(next);
      this.ui.updateMicButton(next);
    });

    document.getElementById('btn-toggle-cam').addEventListener('click', () => {
      const next = !this.vision.camEnabled;
      this.vision.setCamEnabled(next);
      this.ui.updateCamButton(next);
    });

    document.getElementById('btn-call-settings').addEventListener('click', () => {
      this._openSettingsModal();
    });

    document.getElementById('btn-call-reconnect').addEventListener('click', () => {
      this.ui.showToast('Переподключаем звонок...');
      this._reconnectActiveCall();
    });

    document.getElementById('btn-hangup').addEventListener('click', () => {
      this._hangupCall(true);
    });

    // Чат во время звонка
    document.getElementById('btn-toggle-chat').addEventListener('click', () => {
      this.ui.toggleChatDrawer();
    });

    document.getElementById('btn-close-chat').addEventListener('click', () => {
      this.ui.toggleChatDrawer(false);
    });

    document.getElementById('call-chat-form').addEventListener('submit', (e) => {
      e.preventDefault();
      const input = document.getElementById('call-chat-input');
      const text = input.value.trim();
      if (!text) return;
      input.value = '';
      this._sendChatMessage(text);
    });

    // 7. Приколы / AR-игры (только ПК)
    document.getElementById('btn-toggle-games').addEventListener('click', () => {
      this.ui.toggleGamesPopover();
    });

    document.getElementById('btn-close-games').addEventListener('click', () => {
      this.ui.toggleGamesPopover(false);
    });

    document.getElementById('btn-launch-fly').addEventListener('click', () => {
      if (!this.flyIsMyTurn) return;
      this.flyIsMyTurn = false;
      this.ui.updateFlyControl(false);
      this.rtc.sendData({ type: 'GAME_FLY_LAUNCH' });
      this.ui.showToast('Муха полетела на экран друга!', 'success');
      this.ui.toggleGamesPopover(false);
    });

    document.getElementById('btn-toggle-bottle').addEventListener('click', () => {
      this._toggleBottleGame();
    });

    document.getElementById('btn-stop-bottle-hud').addEventListener('click', () => {
      if (this.games.bottleActive) {
        this._toggleBottleGame();
      }
    });

    document.getElementById('btn-cheers').addEventListener('click', () => {
      this.games.triggerCheers();
      this.rtc.sendData({ type: 'GAME_CHEERS' });
      this.ui.toggleGamesPopover(false);
    });

    // 8. Модальное окно «Настройка и проверка связи»
    const closeSettings = () => this._closeSettingsModal();
    document.getElementById('btn-close-settings').addEventListener('click', closeSettings);
    document.getElementById('btn-done-settings').addEventListener('click', closeSettings);

    document.getElementById('btn-test-sound').addEventListener('click', () => {
      this.sound.playTestSound();
      this.ui.showToast('Воспроизводится тестовый сигнал');
    });

    document.getElementById('select-camera').addEventListener('change', async (e) => {
      const videoId = e.target.value;
      const audioId = document.getElementById('select-mic').value;
      await this._switchDevices(videoId, audioId);
    });

    document.getElementById('select-mic').addEventListener('change', async (e) => {
      const videoId = document.getElementById('select-camera').value;
      const audioId = e.target.value;
      await this._switchDevices(videoId, audioId);
    });

    document.querySelectorAll('#bg-mode-selector [data-bg-mode]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const mode = btn.getAttribute('data-bg-mode');
        this.ui.syncBackgroundControls({ ...this.vision.bgConfig, mode });
        await this.vision.setBackgroundConfig({ mode });
      });
    });

    document.getElementById('blur-strength-slider').addEventListener('input', async (e) => {
      const blurAmount = Number(e.target.value);
      document.getElementById('blur-strength-val').textContent = `${blurAmount}px`;
      await this.vision.setBackgroundConfig({ blurAmount });
    });

    document.querySelectorAll('#bg-presets [data-bg-preset]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const preset = btn.getAttribute('data-bg-preset');
        this.ui.syncBackgroundControls({ ...this.vision.bgConfig, mode: 'virtual', preset });
        await this.vision.setBackgroundConfig({ mode: 'virtual', preset });
      });
    });

    document.getElementById('bg-upload-input').addEventListener('change', async (e) => {
      const file = e.target.files?.[0];
      if (!file) return;
      try {
        await this.vision.loadCustomBackgroundFile(file);
        this.ui.syncBackgroundControls(this.vision.bgConfig);
        this.ui.showToast('Свой виртуальный фон загружен!', 'success');
      } catch {
        this.ui.showToast('Не удалось прочитать изображение', 'error');
      }
      e.target.value = '';
    });

    document.getElementById('btn-save-turn').addEventListener('click', () => {
      const turn = {
        url: document.getElementById('turn-url-input').value.trim(),
        username: document.getElementById('turn-user-input').value.trim(),
        credential: document.getElementById('turn-cred-input').value.trim(),
      };
      saveStorage(CONFIG.STORAGE_KEYS.TURN, turn);
      this.ui.showToast('Настройки TURN сохранены. Нажмите «Переподключиться» для применения.', 'success');
    });

    document.getElementById('btn-clear-turn').addEventListener('click', () => {
      const empty = { url: '', username: '', credential: '' };
      saveStorage(CONFIG.STORAGE_KEYS.TURN, empty);
      this.ui.syncTurnInputs(empty);
      this.ui.showToast('Кастомный TURN очищен (используются Google STUN)');
    });
  }

  /* ========================================================================
     ЛОГИКА ВХОДА ПО PIN-КОДУ (ЯЩИК ПИВА)
     ======================================================================== */
  _onPinDigit(digit) {
    this.sound.playCanOpen();
    if (this.currentPin.length >= CONFIG.PIN_LENGTH) return;

    this.currentPin += digit;
    this.ui.updatePinDisplay(this.currentPin);

    if (this.currentPin.length === CONFIG.PIN_LENGTH) {
      this.activePin = this.currentPin;
      window.setTimeout(() => {
        if (!this.myProfile || !this.myProfile.name) {
          this.editingProfileFromLobby = false;
          this._openProfileScreen();
        } else {
          this._enterLobbyWithPin(this.activePin);
        }
      }, 320);
    }
  }

  _openProfileScreen() {
    const nameInput = document.getElementById('profile-name-input');
    nameInput.value = this.myProfile?.name || '';
    this.selectedAvatar = this.myProfile?.avatar || CONFIG.AVATARS[0];
    this.ui.renderAvatarPicker(this.selectedAvatar, (emoji) => {
      this.selectedAvatar = emoji;
    });
    this.ui.showScreen('profile');
    nameInput.focus();
  }

  _enterLobbyWithPin(pin) {
    this.activePin = pin;
    this.friendProfile = null;
    this.ui.clearChatMessages();
    this.ui.updateLobbySelf(this.myProfile, pin, 'host');
    this.ui.updateLobbyFriend(null);
    this.ui.showScreen('lobby');
    this.rtc.joinRoom(pin, this.myProfile);
  }

  _leaveRoomCompletely() {
    this._hangupCall(false);
    this.rtc.leaveRoom();
    this.vision.stopAll();
    this.currentPin = '';
    this.activePin = '';
    this.friendProfile = null;
    this.ui.updatePinDisplay('');
    this.ui.showScreen('pin');
  }

  /* ========================================================================
     КОЛБЭКИ WEBRTC / PEERJS
     ======================================================================== */
  _onRoleAssigned(role) {
    this.ui.updateLobbySelf(this.myProfile, this.activePin, role);
    // Хост получает право первого запуска мухи
    this.flyIsMyTurn = role === 'host';
    this.ui.updateFlyControl(this.flyIsMyTurn);
  }

  _onRoomFull(pin) {
    this.sound.playHangup();
    this.ui.setLockedPinLabel(pin);
    this.ui.showScreen('locked');
  }

  _onPeerConnected(profile) {
    this.friendProfile = profile;
    this.ui.updateLobbyFriend(profile);
    this.sound.playCallConnected();
    this.ui.showToast(`${profile.avatar} ${profile.name} зашёл за стол!`, 'success');
  }

  _onPeerProfileUpdated(profile) {
    this.friendProfile = profile;
    this.ui.updateLobbyFriend(profile);
  }

  _onPeerDisconnected() {
    const prevName = this.friendProfile?.name || 'Собеседник';
    this.friendProfile = null;
    this.ui.updateLobbyFriend(null);
    this.ui.hideOutgoingCall();
    this.ui.hideIncomingCall();
    if (this.inCall) {
      this._hangupCall(false);
    }
    this.ui.showToast(`${prevName} покинул стол`, 'info');
  }

  _onDataMessage(msg) {
    switch (msg.type) {
      case 'CALL_REQUEST':
        this.sound.playIncomingRing();
        this.ui.showIncomingCall(this.friendProfile);
        break;

      case 'CALL_CANCEL':
        this.sound.stopRing();
        this.ui.hideIncomingCall();
        this.ui.showToast('Собеседник отменил вызов');
        break;

      case 'CALL_REJECT':
        this.sound.playHangup();
        this.ui.hideOutgoingCall();
        this.ui.showToast('Собеседник сбросил вызов');
        break;

      case 'CALL_ACCEPT':
        this.sound.stopRing();
        this.sound.playCallConnected();
        this.ui.hideOutgoingCall();
        this._enterCallScreenAndStartMedia(true);
        break;

      case 'CALL_HANGUP':
        this._hangupCall(false);
        this.ui.showToast('Собеседник завершил звонок');
        break;

      case 'CHAT_MSG':
        this.sound.playMessagePop();
        this.ui.appendChatMessage({
          author: msg.author || this.friendProfile?.name || 'Друг',
          avatar: msg.avatar || this.friendProfile?.avatar || '🍺',
          text: msg.text,
          time: msg.time || this._formatTime(),
          mine: false,
        });
        break;

      case 'GAME_FLY_LAUNCH':
        // На наш экран прилетела муха — и право ответного хода переходит нам!
        this.flyIsMyTurn = true;
        this.ui.updateFlyControl(true);
        if (this.inCall && window.innerWidth > 768) {
          this.games.spawnFly();
          this.ui.showToast('К вам залетела муха! Прихлопните кликом или взмахом руки!');
        }
        break;

      case 'GAME_FLY_SWATTED':
        this.ui.showToast('Собеседник прихлопнул вашу муху!');
        break;

      case 'GAME_BOTTLE_STATE':
        if (window.innerWidth > 768 && this.inCall) {
          if (msg.active) {
            this.games.startBottleGame(msg.score || 0);
            this.ui.updateBottleGameUI(true, msg.score || 0);
            this.ui.showToast('Запущена AR-игра «Отбей бутылку»!');
          } else {
            this.games.stopBottleGame();
            this.ui.updateBottleGameUI(false, msg.score || 0);
          }
        }
        break;

      case 'GAME_BOTTLE_SCORE':
        this.games.setSharedScore(msg.score || 0);
        this.ui.updateBottleGameUI(this.games.bottleActive, msg.score || 0);
        break;

      case 'GAME_BOTTLE_MISS':
        this.ui.showPenaltyBanner(`${this.friendProfile?.name || 'Друг'}: штрафной глоток! 🍺`);
        break;

      case 'GAME_CHEERS':
        if (this.inCall) {
          this.games.triggerCheers();
        }
        break;

      default:
        break;
    }
  }

  /* ========================================================================
     МЕХАНИКА ЗВОНКА (SKYPE-STYLE)
     ======================================================================== */
  _initiateOutgoingCall() {
    if (!this.friendProfile) {
      this.ui.showToast('Сначала дождитесь подключения друга', 'error');
      return;
    }
    this.sound.playOutgoingRing();
    this.ui.showOutgoingCall(this.friendProfile);
    this.rtc.sendData({ type: 'CALL_REQUEST' });
  }

  async _acceptIncomingCall() {
    this.sound.stopRing();
    this.sound.playCallConnected();
    this.ui.hideIncomingCall();
    await this._enterCallScreenAndStartMedia(false);
    this.rtc.sendData({ type: 'CALL_ACCEPT' });
  }

  async _enterCallScreenAndStartMedia(isCaller) {
    this.inCall = true;
    this.ui.showScreen('call');
    this.ui.setRemoteVideoVisible(false);
    this.ui.startCallTimer();
    this.ui.updateMicButton(this.vision.micEnabled);
    this.ui.updateCamButton(this.vision.camEnabled);

    try {
      const stream = this.vision.rawStream
        ? this.vision.getOutgoingStream()
        : await this.vision.startCamera();

      this._attachLocalVideoStreams(stream);

      if (isCaller) {
        this.rtc.startMediaCall(stream);
      } else {
        this.rtc.setLocalStreamForAnswer(stream);
      }
    } catch {
      this.ui.showToast('Не удалось получить доступ к камере/микрофону', 'error');
    }
  }

  _onRemoteStream(remoteStream) {
    const remoteVideo = document.getElementById('remote-video');
    remoteVideo.srcObject = remoteStream;
    remoteVideo.play().catch(() => {});
    this.ui.setRemoteVideoVisible(true);
  }

  _onMediaCallClosed() {
    if (this.inCall) {
      this._hangupCall(false);
    }
  }

  _hangupCall(notifyPeer) {
    this.sound.stopRing();
    if (this.inCall) {
      this.sound.playHangup();
    }
    this.inCall = false;
    this.ui.stopCallTimer();
    this.ui.hideOutgoingCall();
    this.ui.hideIncomingCall();
    this.ui.toggleChatDrawer(false);
    this.ui.toggleGamesPopover(false);
    this.ui.updateBottleGameUI(false, 0);
    this.games.resetAll();

    if (notifyPeer) {
      this.rtc.sendData({ type: 'CALL_HANGUP' });
    }
    this.rtc.endMediaCall();

    const remoteVideo = document.getElementById('remote-video');
    remoteVideo.srcObject = null;
    this.ui.setRemoteVideoVisible(false);

    if (this.activePin) {
      this.ui.showScreen('lobby');
    }
  }

  async _reconnectActiveCall() {
    if (!this.inCall) return;
    try {
      const stream = this.vision.getOutgoingStream() || (await this.vision.startCamera());
      this.rtc.endMediaCall();
      this.rtc.startMediaCall(stream);
    } catch {
      this.rtc.reconnect();
    }
  }

  /* ========================================================================
     ЧАТ И AR-ИГРЫ
     ======================================================================== */
  _sendChatMessage(text) {
    if (!this.friendProfile) {
      this.ui.showToast('Собеседник ещё не подключён', 'error');
      return;
    }
    const time = this._formatTime();
    const payload = {
      type: 'CHAT_MSG',
      author: this.myProfile.name,
      avatar: this.myProfile.avatar,
      text,
      time,
    };
    this.rtc.sendData(payload);
    this.ui.appendChatMessage({
      author: this.myProfile.name,
      avatar: this.myProfile.avatar,
      text,
      time,
      mine: true,
    });
  }

  _toggleBottleGame() {
    const nextActive = !this.games.bottleActive;
    if (nextActive) {
      this.games.startBottleGame(0);
      this.ui.updateBottleGameUI(true, 0);
      this.ui.toggleGamesPopover(false);
      this.ui.showToast('Поднимите руку перед камерой и отбивайте падающие бутылки!');
    } else {
      this.games.stopBottleGame();
      this.ui.updateBottleGameUI(false, this.games.sharedScore);
    }
    this.rtc.sendData({
      type: 'GAME_BOTTLE_STATE',
      active: nextActive,
      score: nextActive ? 0 : this.games.sharedScore,
    });
  }

  /* ========================================================================
     МОДАЛЬНОЕ ОКНО НАСТРОЕК И ПРОВЕРКИ СВЯЗИ
     ======================================================================== */
  async _openSettingsModal() {
    this.ui.showSettingsModal();
    this.ui.syncTurnInputs(getSavedTurnConfig());
    this.ui.syncBackgroundControls(this.vision.bgConfig);

    try {
      const stream = this.vision.rawStream
        ? this.vision.getOutgoingStream()
        : await this.vision.startCamera();

      this._attachLocalVideoStreams(stream);
      document.getElementById('settings-preview-fallback').hidden = true;

      const devices = await this.vision.listDevices();
      this.ui.populateDevices(devices, this.vision.selectedDevices);
      this._startMicMeterLoop();
    } catch {
      document.getElementById('settings-preview-fallback').hidden = false;
      document.getElementById('settings-preview-fallback').textContent =
        'Нет доступа к камере или микрофону. Разрешите доступ в браузере.';
    }
  }

  _closeSettingsModal() {
    this.ui.hideSettingsModal();
    this._stopMicMeterLoop();
    const previewVideo = document.getElementById('settings-preview-video');
    previewVideo.srcObject = null;
    // Если мы в лобби (не в звонке), освобождаем камеру, чтобы не горел индикатор
    if (!this.inCall) {
      this.vision.stopAll();
    }
  }

  async _switchDevices(videoId, audioId) {
    try {
      const stream = await this.vision.startCamera(videoId, audioId);
      await this._handleLocalStreamUpdated(stream);
      this.ui.showToast('Устройства обновлены', 'success');
    } catch {
      this.ui.showToast('Не удалось переключить устройство', 'error');
    }
  }

  async _handleLocalStreamUpdated(stream) {
    if (!stream) return;
    this._attachLocalVideoStreams(stream);
    if (this.inCall) {
      const vTrack = stream.getVideoTracks()[0];
      const aTrack = stream.getAudioTracks()[0];
      if (vTrack) await this.rtc.replaceTrack(vTrack);
      if (aTrack) await this.rtc.replaceTrack(aTrack);
    }
  }

  _attachLocalVideoStreams(stream) {
    if (!stream) return;
    const localVideo = document.getElementById('local-video');
    if (localVideo.srcObject !== stream) {
      localVideo.srcObject = stream;
      localVideo.play().catch(() => {});
    }

    if (this.ui.isSettingsOpen()) {
      const previewVideo = document.getElementById('settings-preview-video');
      if (previewVideo.srcObject !== stream) {
        previewVideo.srcObject = stream;
        previewVideo.play().catch(() => {});
      }
      document.getElementById('settings-preview-fallback').hidden = Boolean(stream);
    }
  }

  _startMicMeterLoop() {
    this._stopMicMeterLoop();
    const tick = () => {
      if (!this.ui.isSettingsOpen()) return;
      const level = this.vision.getMicLevel();
      this.ui.updateMicMeter(level);
      this.micMeterRaf = requestAnimationFrame(tick);
    };
    this.micMeterRaf = requestAnimationFrame(tick);
  }

  _stopMicMeterLoop() {
    if (this.micMeterRaf !== null) {
      cancelAnimationFrame(this.micMeterRaf);
      this.micMeterRaf = null;
    }
    this.ui.updateMicMeter(0);
  }

  _formatTime() {
    const d = new Date();
    const hh = String(d.getHours()).padStart(2, '0');
    const mm = String(d.getMinutes()).padStart(2, '0');
    return `${hh}:${mm}`;
  }
}

window.addEventListener('DOMContentLoaded', () => {
  new TruskaDurakApp();
});
