use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;

/// Translation term: source → target mapping for Soniox
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct TranslationTerm {
    pub source: String,
    pub target: String,
}

/// Custom context for Soniox — provides domain-specific hints
#[derive(Debug, Serialize, Deserialize, Clone, Default)]
#[serde(default)]
pub struct CustomContext {
    pub domain: Option<String>,
    pub translation_terms: Vec<TranslationTerm>,
}

/// App settings — persisted to JSON
#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(default)]
pub struct Settings {
    /// Soniox API key
    pub soniox_api_key: String,
    /// OpenAI API key (for gpt-realtime-translate)
    pub openai_api_key: String,
    /// Alibaba Cloud DashScope API key (for Qwen LiveTranslate Flash)
    #[serde(default)]
    pub qwen_api_key: String,
    /// Groq API key (Whisper + chat translation)
    #[serde(default)]
    pub groq_api_key: String,
    /// Cloudflare account ID (Workers AI)
    #[serde(default)]
    pub cloudflare_account_id: String,
    /// Cloudflare API token (Workers AI)
    #[serde(default)]
    pub cloudflare_api_token: String,
    /// Groq Whisper model
    #[serde(default = "default_groq_stt_model")]
    pub groq_stt_model: String,
    /// Groq chat model used for translation
    #[serde(default = "default_groq_llm_model")]
    pub groq_llm_model: String,
    /// Cloudflare Whisper model
    #[serde(default = "default_cloudflare_stt_model")]
    pub cloudflare_stt_model: String,
    /// Cloudflare Workers AI LLM used for translation
    #[serde(default = "default_cloudflare_llm_model")]
    pub cloudflare_llm_model: String,
    /// LLM source for cloud engines: "openrouter" | "engine"
    #[serde(default = "default_llm_provider")]
    pub llm_provider: String,
    /// OpenRouter API key (chat completions)
    #[serde(default)]
    pub openrouter_api_key: String,
    /// OpenRouter chat model
    #[serde(default = "default_openrouter_llm_model")]
    pub openrouter_llm_model: String,
    /// Whether Azure AI Translator Text is available in the translation chain.
    #[serde(default)]
    pub azure_translator_enabled: bool,
    /// Azure Translator subscription key.
    #[serde(default)]
    pub azure_translator_key: String,
    /// Azure resource region. Empty is valid for a single-service global resource.
    #[serde(default)]
    pub azure_translator_region: String,
    /// Azure Translator base or full text-translation endpoint.
    #[serde(default = "default_azure_translator_endpoint")]
    pub azure_translator_endpoint: String,
    /// Source language: "auto" or ISO 639-1 code
    pub source_language: String,
    /// Target language: ISO 639-1 code
    pub target_language: String,
    /// Audio source: "system" | "microphone" | "both"
    pub audio_source: String,
    /// Overlay opacity: 0.0 - 1.0
    pub overlay_opacity: f64,
    /// Font size in px
    pub font_size: u32,
    /// Max transcript lines to display
    pub max_lines: u32,
    /// Whether to show original text alongside translation
    pub show_original: bool,
    /// Translation mode: "groq" | "cloudflare" | "local"
    pub translation_mode: String,
    /// Optional custom context for better transcription
    pub custom_context: Option<CustomContext>,
    /// ElevenLabs API key for TTS narration
    pub elevenlabs_api_key: String,
    /// Whether TTS narration is enabled
    pub tts_enabled: bool,
    /// TTS provider: "edge" | "microsoft" | "google-free" | "tiktok" | "google" | "elevenlabs"
    pub tts_provider: String,
    /// ElevenLabs voice ID
    pub tts_voice_id: String,
    /// TTS speed multiplier (Web Speech)
    pub tts_speed: f64,
    /// Edge TTS voice name
    pub edge_tts_voice: String,
    /// Edge TTS speed percentage
    pub edge_tts_speed: i32,
    /// Auto-read new translations aloud
    pub tts_auto_read: bool,
    /// Google Cloud TTS API key
    pub google_tts_api_key: String,
    /// Google TTS voice name
    pub google_tts_voice: String,
    /// Google TTS speaking rate
    pub google_tts_speed: f64,
    /// Microsoft v2 (Edge endpoint, dynamic voice list) selected voice
    pub microsoft_v2_voice: String,
    /// Microsoft v2 speed percentage (reuses edge synth)
    pub microsoft_v2_speed: i32,
    /// Google Free (android-tts) language token, e.g. "vi-VN" | "en-US"
    pub google_free_voice: String,
    /// Optional user Google API key for Google Free. When set, overrides the build-time
    /// GOOGLE_FREE_TTS_KEY. Empty → fall back to the build-time key (if any).
    #[serde(default)]
    pub google_free_api_key: String,
    /// Google Free client-side playback speed (endpoint has no rate param). 1.0 = normal.
    #[serde(default = "default_local_tts_speed")]
    pub google_free_speed: f32,
    /// TikTok TTS speaker code, e.g. "BV074_streaming"
    pub tiktok_voice: String,
    /// TikTok client-side playback speed (endpoint has no rate param). 1.0 = normal.
    #[serde(default = "default_local_tts_speed")]
    pub tiktok_speed: f32,
    /// TikTok sessionid cookie (user-supplied; required by the endpoint)
    pub tiktok_session_id: String,
    /// Local offline (Piper/sherpa-onnx) selected voice id, e.g. "vi_VN-vais1000-medium"
    #[serde(default)]
    pub local_tts_voice: String,
    /// Local offline TTS speed (1.0 = normal). Piper length-scale is applied inversely.
    #[serde(default = "default_local_tts_speed")]
    pub local_tts_speed: f32,
    /// Folder where local TTS models are stored; empty = default app-data location.
    #[serde(default)]
    pub local_tts_models_dir: String,
    /// OpenAI Realtime: when true server generates translated audio.
    /// Default false — speaker → mic feedback loop on shared devices.
    #[serde(default)]
    pub openai_audio_output: bool,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            soniox_api_key: String::new(),
            openai_api_key: String::new(),
            qwen_api_key: String::new(),
            groq_api_key: String::new(),
            cloudflare_account_id: String::new(),
            cloudflare_api_token: String::new(),
            groq_stt_model: default_groq_stt_model(),
            groq_llm_model: default_groq_llm_model(),
            cloudflare_stt_model: default_cloudflare_stt_model(),
            cloudflare_llm_model: default_cloudflare_llm_model(),
            llm_provider: default_llm_provider(),
            openrouter_api_key: String::new(),
            openrouter_llm_model: default_openrouter_llm_model(),
            azure_translator_enabled: false,
            azure_translator_key: String::new(),
            azure_translator_region: String::new(),
            azure_translator_endpoint: default_azure_translator_endpoint(),
            source_language: "auto".to_string(),
            target_language: "vi".to_string(),
            audio_source: "system".to_string(),
            overlay_opacity: 0.85,
            font_size: 16,
            max_lines: 5,
            show_original: true,
            translation_mode: "groq".to_string(),
            custom_context: None,
            elevenlabs_api_key: String::new(),
            tts_enabled: false,
            tts_provider: "edge".to_string(),
            tts_voice_id: "21m00Tcm4TlvDq8ikWAM".to_string(),
            tts_speed: 1.2,
            edge_tts_voice: "vi-VN-HoaiMyNeural".to_string(),
            edge_tts_speed: 50,
            tts_auto_read: true,
            google_tts_api_key: String::new(),
            google_tts_voice: "vi-VN-Chirp3-HD-Aoede".to_string(),
            google_tts_speed: 1.0,
            microsoft_v2_voice: "vi-VN-HoaiMyNeural".to_string(),
            microsoft_v2_speed: 20,
            google_free_voice: "vi-VN".to_string(),
            google_free_api_key: String::new(),
            google_free_speed: 1.0,
            tiktok_voice: "BV074_streaming".to_string(),
            tiktok_speed: 1.0,
            tiktok_session_id: String::new(),
            local_tts_voice: "vi_VN-vais1000-medium".to_string(),
            local_tts_speed: 1.0,
            local_tts_models_dir: String::new(),
            openai_audio_output: false,
        }
    }
}

/// Serde default for `local_tts_speed` (field-level default would give 0.0).
fn default_local_tts_speed() -> f32 {
    1.0
}

fn default_groq_stt_model() -> String {
    "whisper-large-v3-turbo".to_string()
}

fn default_groq_llm_model() -> String {
    "llama-3.1-8b-instant".to_string()
}

fn default_cloudflare_stt_model() -> String {
    "@cf/openai/whisper-large-v3-turbo".to_string()
}

fn default_cloudflare_llm_model() -> String {
    "@cf/meta/llama-3.1-8b-instruct-fast".to_string()
}

fn default_llm_provider() -> String {
    "openrouter".to_string()
}

fn default_openrouter_llm_model() -> String {
    "openai/gpt-4o-mini".to_string()
}

fn default_azure_translator_endpoint() -> String {
    "https://api.cognitive.microsofttranslator.com".to_string()
}

/// Get the settings file path
/// ~/Library/Application Support/com.personal.translator/settings.json
fn settings_path() -> PathBuf {
    let mut path = dirs::config_dir().unwrap_or_else(|| PathBuf::from("."));
    path.push("com.personal.translator");
    path.push("settings.json");
    path
}

/// Map legacy engine names onto the supported groq|cloudflare|local set.
/// Credentials are never copied across providers.
pub fn normalize_translation_mode(mode: &str) -> String {
    match mode {
        "groq" | "cloudflare" | "local" => mode.to_string(),
        "soniox" | "openai" | "qwen" | "standard" => "groq".to_string(),
        _ => "groq".to_string(),
    }
}

impl Settings {
    /// Load settings from disk, or return defaults
    pub fn load() -> Self {
        let path = settings_path();
        let mut settings = if path.exists() {
            match fs::read_to_string(&path) {
                Ok(content) => serde_json::from_str(&content).unwrap_or_default(),
                Err(_) => Self::default(),
            }
        } else {
            Self::default()
        };
        settings.translation_mode = normalize_translation_mode(&settings.translation_mode);
        settings
    }

    /// Save settings to disk
    pub fn save(&self) -> Result<(), String> {
        let path = settings_path();

        // Ensure parent directory exists
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)
                .map_err(|e| format!("Failed to create config dir: {}", e))?;
        }

        let json = serde_json::to_string_pretty(self)
            .map_err(|e| format!("Failed to serialize: {}", e))?;

        fs::write(&path, json).map_err(|e| format!("Failed to write settings: {}", e))?;

        Ok(())
    }
}

/// Thread-safe settings state managed by Tauri
pub struct SettingsState(pub Mutex<Settings>);

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_mode_is_groq() {
        let s = Settings::default();
        assert_eq!(s.translation_mode, "groq");
        assert_eq!(s.groq_stt_model, "whisper-large-v3-turbo");
        assert_eq!(s.groq_llm_model, "llama-3.1-8b-instant");
        assert_eq!(s.cloudflare_llm_model, "@cf/meta/llama-3.1-8b-instruct");
        assert_eq!(s.llm_provider, "openrouter");
        assert_eq!(s.openrouter_llm_model, "openai/gpt-4o-mini");
        assert!(s.groq_api_key.is_empty());
        assert!(s.cloudflare_account_id.is_empty());
        assert!(s.cloudflare_api_token.is_empty());
    }

    #[test]
    fn deserializes_legacy_soniox_json_without_new_fields() {
        let json = r#"{
            "soniox_api_key": "legacy-soniox",
            "openai_api_key": "",
            "source_language": "ja",
            "target_language": "vi",
            "audio_source": "system",
            "overlay_opacity": 0.85,
            "font_size": 16,
            "max_lines": 5,
            "show_original": true,
            "translation_mode": "soniox",
            "elevenlabs_api_key": "",
            "tts_enabled": false,
            "tts_provider": "edge",
            "tts_voice_id": "x",
            "tts_speed": 1.2,
            "edge_tts_voice": "vi-VN-HoaiMyNeural",
            "edge_tts_speed": 50,
            "tts_auto_read": true,
            "google_tts_api_key": "",
            "google_tts_voice": "v",
            "google_tts_speed": 1.0,
            "microsoft_v2_voice": "v",
            "microsoft_v2_speed": 20,
            "google_free_voice": "vi-VN",
            "tiktok_voice": "BV074_streaming",
            "tiktok_session_id": ""
        }"#;
        let s: Settings = serde_json::from_str(json).expect("legacy settings should load");
        assert_eq!(s.soniox_api_key, "legacy-soniox");
        assert_eq!(s.groq_api_key, "");
        assert_eq!(s.translation_mode, "soniox");
        assert_eq!(normalize_translation_mode(&s.translation_mode), "groq");
    }

    #[test]
    fn normalize_maps_legacy_modes_without_copying_credentials() {
        assert_eq!(normalize_translation_mode("openai"), "groq");
        assert_eq!(normalize_translation_mode("qwen"), "groq");
        assert_eq!(normalize_translation_mode("standard"), "groq");
        assert_eq!(normalize_translation_mode("cloudflare"), "cloudflare");
        assert_eq!(normalize_translation_mode("local"), "local");
    }

    #[test]
    fn new_fields_round_trip() {
        let mut s = Settings::default();
        s.groq_api_key = "gsk_test".into();
        s.cloudflare_account_id = "acct".into();
        s.cloudflare_api_token = "tok".into();
        s.translation_mode = "cloudflare".into();
        s.target_language = "en".into();
        let json = serde_json::to_string(&s).unwrap();
        let back: Settings = serde_json::from_str(&json).unwrap();
        assert_eq!(back.groq_api_key, "gsk_test");
        assert_eq!(back.cloudflare_account_id, "acct");
        assert_eq!(back.cloudflare_api_token, "tok");
        assert_eq!(back.translation_mode, "cloudflare");
        assert_eq!(back.target_language, "en");
        assert_eq!(back.tts_provider, "edge");
    }
}
