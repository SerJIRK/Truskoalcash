/**
 * truskadurak — WebRTC & PeerJS менеджер (строго 2 слота на PIN-комнату)
 * Реализует хост/гость слоты, блокировку третьего участника, DataChannel и видеозвонок.
 */

import { CONFIG, getIceServers } from './config.js';

export class WebRTCManager {
  constructor(callbacks) {
    this.cb = callbacks;
    this.peer = null;
    this.dataConn = null;
    this.mediaCall = null;
    this.pin = null;
    this.role = null; // 'host' | 'guest'
    this.profile = null;
    this.remoteProfile = null;
    this.localStream = null;
    this.heartbeatTimer = null;
    this.destroyed = false;
  }

  getRoomBaseId(pin) {
    return `${CONFIG.ROOM_PREFIX}${pin}`;
  }

  getHostId(pin) {
    return `${this.getRoomBaseId(pin)}-host`;
  }

  getGuestId(pin) {
    return `${this.getRoomBaseId(pin)}-guest`;
  }

  /**
   * Подключение к комнате по 4-значному PIN-коду.
   * Слот 1 = host, Слот 2 = guest, Слот 3+ = блокировка «Ящик пуст».
   */
  joinRoom(pin, profile) {
    this.leaveRoom();
    this.destroyed = false;
    this.pin = pin;
    this.profile = profile;
    this.cb.onStatusChange('searching', 'Поиск друга');
    this._attemptPeerId(this.getHostId(pin), 'host');
  }

  _attemptPeerId(peerId, roleAttempt) {
    if (this.destroyed) return;
    if (typeof window.Peer === 'undefined') {
      this.cb.onError('Библиотека PeerJS не загрузилась. Проверьте подключение к интернету.');
      return;
    }

    const peer = new window.Peer(peerId, {
      config: {
        iceServers: getIceServers(),
      },
      debug: 1,
    });

    this.peer = peer;
    let opened = false;

    peer.on('open', () => {
      if (this.destroyed) {
        peer.destroy();
        return;
      }
      opened = true;
      this.role = roleAttempt;
      this.cb.onRoleAssigned(this.role);

      if (this.role === 'host') {
        this.cb.onStatusChange('searching', 'Поиск друга');
      } else {
        this.cb.onStatusChange('connecting', 'Установка P2P соединения');
        this._connectToHost();
      }
    });

    peer.on('connection', (conn) => {
      // Строгая защита от 3-го участника на стороне хоста
      if (this.dataConn && this.dataConn.open && this.dataConn.peer !== conn.peer) {
        conn.on('open', () => {
          try {
            conn.send({ type: 'ROOM_FULL' });
          } catch {
            // Игнорируем
          }
          setTimeout(() => conn.close(), 150);
        });
        return;
      }
      this._bindDataConnection(conn);
    });

    peer.on('call', (incomingCall) => {
      this.mediaCall = incomingCall;
      this._bindMediaCall(incomingCall);
      // Если звонок уже принят локально и поток готов — отвечаем сразу
      if (this.localStream) {
        incomingCall.answer(this.localStream);
      }
    });

    peer.on('error', (err) => {
      if (this.destroyed) return;

      if (!opened && err.type === 'unavailable-id') {
        try {
          peer.destroy();
        } catch {
          // Игнорируем
        }
        this.peer = null;

        if (roleAttempt === 'host') {
          // Хост-слот занят — пробуем занять гостевой слот
          this._attemptPeerId(this.getGuestId(this.pin), 'guest');
        } else {
          // Оба слота (host и guest) заняты! Третий лишний!
          this.cb.onStatusChange('room-full', 'Комната занята');
          this.cb.onRoomFull(this.pin);
        }
        return;
      }

      if (err.type === 'peer-unavailable') {
        this.cb.onStatusChange('searching', 'Поиск друга');
        return;
      }

      if (err.type === 'network' || err.type === 'disconnected' || err.type === 'server-error') {
        this.cb.onStatusChange('disconnected', 'Связь потеряна');
      }
    });

    peer.on('disconnected', () => {
      if (!this.destroyed) {
        this.cb.onStatusChange('disconnected', 'Переподключение...');
        try {
          peer.reconnect();
        } catch {
          // Игнорируем
        }
      }
    });
  }

  _connectToHost() {
    if (!this.peer || this.destroyed) return;
    const hostId = this.getHostId(this.pin);
    const conn = this.peer.connect(hostId, {
      reliable: true,
      metadata: { profile: this.profile },
    });
    this._bindDataConnection(conn);
  }

  _bindDataConnection(conn) {
    if (this.dataConn && this.dataConn !== conn) {
      try {
        this.dataConn.close();
      } catch {
        // Игнорируем
      }
    }

    this.dataConn = conn;
    this.cb.onStatusChange('connecting', 'Установка P2P соединения');

    conn.on('open', () => {
      if (this.destroyed) return;
      this.cb.onStatusChange('connected', 'В эфире');
      this.sendData({
        type: 'HELLO',
        profile: this.profile,
        role: this.role,
      });
      this._startHeartbeat();
    });

    conn.on('data', (payload) => {
      if (!payload || typeof payload !== 'object') return;
      if (payload.type === 'ROOM_FULL') {
        this.leaveRoom();
        this.cb.onRoomFull(this.pin);
        return;
      }
      if (payload.type === 'PING') {
        this.sendData({ type: 'PONG' });
        return;
      }
      if (payload.type === 'PONG') {
        return;
      }
      if (payload.type === 'HELLO') {
        this.remoteProfile = payload.profile;
        this.cb.onPeerConnected(payload.profile);
        this.sendData({
          type: 'HELLO_ACK',
          profile: this.profile,
          role: this.role,
        });
        return;
      }
      if (payload.type === 'HELLO_ACK') {
        this.remoteProfile = payload.profile;
        this.cb.onPeerConnected(payload.profile);
        return;
      }
      if (payload.type === 'PROFILE_UPDATE') {
        this.remoteProfile = payload.profile;
        this.cb.onPeerProfileUpdated(payload.profile);
        return;
      }
      this.cb.onDataMessage(payload);
    });

    conn.on('close', () => {
      this._stopHeartbeat();
      if (this.dataConn === conn) {
        this.dataConn = null;
      }
      if (!this.destroyed) {
        this.remoteProfile = null;
        this.endMediaCall();
        this.cb.onStatusChange('searching', 'Поиск друга');
        this.cb.onPeerDisconnected();
      }
    });

    conn.on('error', () => {
      if (!this.destroyed) {
        this.cb.onStatusChange('disconnected', 'Ошибка P2P канала');
      }
    });
  }

  _startHeartbeat() {
    this._stopHeartbeat();
    this.heartbeatTimer = window.setInterval(() => {
      if (this.dataConn && this.dataConn.open) {
        this.sendData({ type: 'PING' });
      }
    }, 5000);
  }

  _stopHeartbeat() {
    if (this.heartbeatTimer !== null) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  updateMyProfile(profile) {
    this.profile = profile;
    this.sendData({ type: 'PROFILE_UPDATE', profile });
  }

  sendData(payload) {
    if (this.dataConn && this.dataConn.open) {
      try {
        this.dataConn.send(payload);
        return true;
      } catch {
        return false;
      }
    }
    return false;
  }

  /**
   * Инициировать медиа-звонок (вызывается после того, как собеседник нажал «Ответить»)
   */
  startMediaCall(stream) {
    this.localStream = stream;
    if (!this.peer || !this.dataConn) return;
    const remotePeerId = this.dataConn.peer;
    const call = this.peer.call(remotePeerId, stream);
    this.mediaCall = call;
    this._bindMediaCall(call);
  }

  /**
   * Привязать локальный поток для ответа на входящий медиа-вызов
   */
  setLocalStreamForAnswer(stream) {
    this.localStream = stream;
    if (this.mediaCall && !this.mediaCall.open) {
      try {
        this.mediaCall.answer(stream);
      } catch {
        // Звонок уже мог быть принят
      }
    }
  }

  _bindMediaCall(call) {
    call.on('stream', (remoteStream) => {
      this.cb.onStatusChange('in-call', 'В эфире');
      this.cb.onRemoteStream(remoteStream);
    });

    call.on('close', () => {
      if (this.mediaCall === call) {
        this.mediaCall = null;
      }
      this.cb.onMediaCallClosed();
    });

    call.on('error', () => {
      this.cb.onStatusChange('disconnected', 'Сбой медиапотока');
    });
  }

  /**
   * Бесшовная замена видео- или аудиодорожки во время активного звонка
   * (при переключении виртуального фона, размытия или смене камеры/микрофона)
   */
  async replaceTrack(newTrack) {
    if (!this.mediaCall || !this.mediaCall.peerConnection || !newTrack) return;
    const senders = this.mediaCall.peerConnection.getSenders();
    const sender = senders.find((s) => s.track && s.track.kind === newTrack.kind);
    if (sender) {
      try {
        await sender.replaceTrack(newTrack);
      } catch {
        // Игнорируем, если соединение в процессе закрытия
      }
    }
  }

  endMediaCall() {
    if (this.mediaCall) {
      try {
        this.mediaCall.close();
      } catch {
        // Игнорируем
      }
      this.mediaCall = null;
    }
    this.localStream = null;
  }

  /**
   * Полное переподключение к комнате с текущим PIN и свежими настройками ICE/TURN
   */
  reconnect() {
    if (!this.pin || !this.profile) return;
    const pin = this.pin;
    const profile = this.profile;
    this.joinRoom(pin, profile);
  }

  leaveRoom() {
    this.destroyed = true;
    this._stopHeartbeat();
    this.endMediaCall();
    if (this.dataConn) {
      try {
        this.dataConn.close();
      } catch {
        // Игнорируем
      }
      this.dataConn = null;
    }
    if (this.peer) {
      try {
        this.peer.destroy();
      } catch {
        // Игнорируем
      }
      this.peer = null;
    }
    this.remoteProfile = null;
    this.role = null;
  }
}
