/**
 * truskadurak — Конфигурация, константы и работа с localStorage
 */

export const CONFIG = {
  ROOM_PREFIX: 'truskadurak-room-',
  PIN_LENGTH: 4,
  AVATARS: ['🍺', '🥃', '🦊', '🐻', '🦝', '👽', '🤖', '🤠', '🐙', '💀'],
  THEMES: ['night-bar', 'cyberpunk', 'skype-2010'],
  QUICK_TOASTS: [
    'За встречу! 🍻',
    'Будем! 🍺',
    'Наливай! 🥃',
    'Дзынь! ✨',
    'За здоровье! 🥂',
  ],
  DEFAULT_ICE_SERVERS: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun2.l.google.com:19302' },
  ],
  STORAGE_KEYS: {
    PROFILE: 'truskadurak_profile_v1',
    THEME: 'truskadurak_theme_v1',
    TURN: 'truskadurak_turn_v1',
    DEVICES: 'truskadurak_devices_v1',
    BG: 'truskadurak_bg_v1',
  },
  MEDIAPIPE: {
    VISION_URL: 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/vision_bundle.mjs',
    WASM_URL: 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm',
    SELFIE_MODEL:
      'https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_segmenter/float16/latest/selfie_segmenter.tflite',
    HAND_MODEL:
      'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/latest/hand_landmarker.task',
  },
};

export function loadStorage(key, fallback = null) {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return fallback;
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

export function saveStorage(key, value) {
  try {
    if (value === null || value === undefined) {
      localStorage.removeItem(key);
    } else {
      localStorage.setItem(key, JSON.stringify(value));
    }
  } catch {
    // Игнорируем переполнение или блокировку storage
  }
}

export function getSavedTurnConfig() {
  return loadStorage(CONFIG.STORAGE_KEYS.TURN, {
    url: '',
    username: '',
    credential: '',
  });
}

export function getIceServers() {
  const servers = [...CONFIG.DEFAULT_ICE_SERVERS];
  const turn = getSavedTurnConfig();
  if (turn && turn.url && turn.url.trim()) {
    const entry = { urls: turn.url.trim() };
    if (turn.username && turn.username.trim()) {
      entry.username = turn.username.trim();
    }
    if (turn.credential && turn.credential.trim()) {
      entry.credential = turn.credential.trim();
    }
    servers.push(entry);
  }
  return servers;
}
