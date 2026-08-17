/**
 * Settings Manager — handles loading/saving settings via Tauri IPC
 */

import { migrateTranslationMode } from './mode-utils.js';

const { invoke } = window.__TAURI__.core;

// Default settings shape
const DEFAULT_SETTINGS = {
  groq_api_key: '',
  groq_stt_model: 'whisper-large-v3-turbo',
  groq_llm_model: 'openai/gpt-oss-120b',
  groq_enabled: true,
  llm_provider: 'automatic',
  llm_fallback: true,
  cloudflare_account_id: '',
  cloudflare_api_token: '',
  cloudflare_stt_model: '@cf/openai/whisper-large-v3-turbo',
  cloudflare_enabled: true,
  assemblyai_enabled: true,
  assemblyai_api_key: '',
  assemblyai_region: 'global',
  assemblyai_streaming_model: 'universal-streaming-english',
  assemblyai_speaker_labels: false,
  assemblyai_medical: false,
  assemblyai_redact_pii: false,
  assemblyai_filter_profanity: false,
  assemblyai_min_turn_silence_ms: 400,
  assemblyai_max_turn_silence_ms: 1280,
  assemblyai_vad_threshold: 0.4,
  assemblyai_end_of_turn_confidence: 0.4,
  source_language: 'auto',
  target_language: 'vi',
  audio_source: 'system',
  overlay_opacity: 0.85,
  font_size: 16,
  max_lines: 5,
  show_original: true,
  translation_mode: 'automatic',
  custom_context: null,
  // Provider fallback settings
  azure_translator_enabled: false,
  azure_translator_key: '',
  azure_translator_region: '',
  azure_translator_endpoint: 'https://api.cognitive.microsofttranslator.com',
  gemini_enabled: false,
  gemini_api_key: '',
  gemini_model: 'gemini-3.1-flash-lite',
  ollama_enabled: false,
  ollama_base_url: 'http://127.0.0.1:11434',
  ollama_model: '',
  local_stt_enabled: false,
  // TTS settings
  elevenlabs_api_key: '',
  tts_enabled: false,
  tts_provider: 'edge',
  tts_voice_id: '21m00Tcm4TlvDq8ikWAM',
  tts_speed: 1.2,
  edge_tts_voice: 'vi-VN-HoaiMyNeural',
  edge_tts_speed: 50,
  tts_auto_read: true,
  // Google Cloud (premium) — kept for parity with backend defaults
  google_tts_api_key: '',
  google_tts_voice: 'vi-VN-Chirp3-HD-Aoede',
  google_tts_speed: 1.0,
  // New free online providers (Trudio-style)
  microsoft_v2_voice: 'vi-VN-HoaiMyNeural',
  microsoft_v2_speed: 20,
  google_free_voice: 'vi-VN',
  google_free_api_key: '',
  google_free_speed: 1.0,
  tiktok_voice: 'BV074_streaming',
  tiktok_speed: 1.0,
  tiktok_session_id: '',
  // Local offline (Piper/sherpa-onnx)
  local_tts_voice: 'vi_VN-vais1000-medium',
  local_tts_speed: 1.0,
  local_tts_models_dir: '',
};

class SettingsManager {
  constructor() {
    this.settings = { ...DEFAULT_SETTINGS };
    this._listeners = [];
  }

/**
 * Load settings from Rust backend
 */
async load() {
  try {
    const settings = await invoke('get_settings');
    this.settings = { ...DEFAULT_SETTINGS, ...settings };
    this.settings.translation_mode = migrateTranslationMode(this.settings.translation_mode);
    if (this.settings.llm_provider === 'openrouter' || this.settings.llm_provider === 'engine' || this.settings.llm_provider === 'groq-llm' || this.settings.llm_provider === 'groq' || this.settings.llm_provider === 'cloudflare-llm' || this.settings.llm_provider === 'cloudflare') {
      this.settings.llm_provider = 'automatic';
    }

    // Migrate deprecated model defaults (preserve custom selections)
    this.settings = this._migrateModelDefaults(this.settings);
  } catch (err) {
    console.error('Failed to load settings:', err);
    this.settings = { ...DEFAULT_SETTINGS };
  }
  this._notify();
  return this.settings;
}

/**
 * Migrate deprecated model defaults while preserving custom selections
 * that are still in the current allowlists.
 */
_migrateModelDefaults(settings) {
  const ALLOWED_GROQ_LLM = [
    'openai/gpt-oss-120b',
    'openai/gpt-oss-20b',
    'qwen/qwen3.6-27b',
  ];
  const ALLOWED_GEMINI = [
    'gemini-3.5-flash-lite',
    'gemini-3.1-flash-lite',
  ];

  if (!ALLOWED_GROQ_LLM.includes(settings.groq_llm_model)) {
    settings.groq_llm_model = DEFAULT_SETTINGS.groq_llm_model;
  }
  if (!ALLOWED_GEMINI.includes(settings.gemini_model)) {
    settings.gemini_model = DEFAULT_SETTINGS.gemini_model;
  }

  return settings;
}

  /**
   * Save settings to Rust backend
   */
  async save(newSettings) {
    try {
      const merged = { ...this.settings, ...newSettings };
      await invoke('save_settings', { newSettings: merged });
      this.settings = merged;
      this._notify();
      return true;
    } catch (err) {
      console.error('Failed to save settings:', err);
      throw err;
    }
  }

  /**
   * Get current settings (cached)
   */
  get() {
    return { ...this.settings };
  }

  /**
   * Subscribe to settings changes
   */
  onChange(callback) {
    this._listeners.push(callback);
    return () => {
      this._listeners = this._listeners.filter(l => l !== callback);
    };
  }

  _notify() {
    const settings = this.get();
    this._listeners.forEach(cb => cb(settings));
  }
}

// Singleton
export const settingsManager = new SettingsManager();
