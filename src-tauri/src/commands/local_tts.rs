//! Local offline neural TTS — Piper (VITS) models run on-device via sherpa-onnx.
//!
//! Fully offline: phonemization uses the espeak-ng-data bundled inside each model
//! archive (no remote phonemizer). sherpa-onnx is statically linked, so there are no
//! native dylibs to bundle. Models are user-downloaded on demand into a configurable
//! folder and deletable from the UI.
//!
//! Phase 1 (this file): engine wrapper, static voice catalog, storage-path helpers,
//! id validation, WAV encoding, engine cache, and `local_tts_speak`.
//! Phase 2 adds list/download/delete commands (same module).

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use base64::Engine as _;
use bzip2::read::BzDecoder;
use futures_util::StreamExt;
use serde::Serialize;
use sha2::{Digest, Sha256};
use sherpa_onnx::{
    GenerationConfig, OfflineTts, OfflineTtsConfig, OfflineTtsModelConfig,
    OfflineTtsVitsModelConfig,
};
use std::io::Write as _;

use crate::settings::SettingsState;

use tauri::ipc::Channel;

/// A curated, free/legal Piper voice available for download.
pub struct VoiceEntry {
    pub id: &'static str,
    pub display: &'static str,
    pub lang: &'static str,     // ISO 639-1, e.g. "vi" | "en" | "ro"
    pub package: &'static str,  // tarball stem on the release (`<package>.tar.bz2`)
    pub base_url: &'static str, // release base the tarball is hosted on
    pub sha256: &'static str,   // integrity check of the downloaded .tar.bz2
    pub approx_size_bytes: u64,
    pub sample_rate: u32,
}

/// Base URL for the upstream sherpa-onnx `tts-models` release (public voices).
pub const RELEASE_BASE: &str = "https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models";

/// Base URL for this project's custom Vietnamese voices (self-contained tarballs
/// with bundled espeak-ng-data). Contributed by @quanhieu (nghimestudio/nghitts).
pub const CUSTOM_VI_BASE: &str =
    "https://github.com/phuc-nt/my-translator/releases/download/tts-models-vi";

/// Static catalog — multi-language free Piper voices (sherpa-onnx tts-models).
/// SHA-256 values pinned from the published release assets (integrity gate).
pub const CATALOG: &[VoiceEntry] = &[
    // ── Vietnamese ──────────────────────────────────────────
    VoiceEntry {
        id: "vi_VN-vais1000-medium",
        display: "Vietnamese — VAIS1000 (medium)",
        lang: "vi",
        package: "vits-piper-vi_VN-vais1000-medium",
        base_url: RELEASE_BASE,
        sha256: "fa1367710767d36ed5cf13b4a449e20c35ffd12791c2e47c2e64142bfa55551a",
        approx_size_bytes: 67_154_040,
        sample_rate: 22_050,
    },
    VoiceEntry {
        id: "vi_VN-25hours_single-low",
        display: "Vietnamese — 25 hours (low)",
        lang: "vi",
        package: "vits-piper-vi_VN-25hours_single-low",
        base_url: RELEASE_BASE,
        sha256: "8aa8bbe88a1cb26ef4f33de56fced1720e72ec00491d23a3551de25a53c75149",
        approx_size_bytes: 67_059_380,
        sample_rate: 16_000,
    },
    VoiceEntry {
        id: "adam1",
        display: "Vietnamese — Adam (custom)",
        lang: "vi",
        package: "vits-piper-adam1",
        base_url: CUSTOM_VI_BASE,
        sha256: "4567253186404699da56fc3fdb7730dbdf8d4fca38ea792dde11a6277332e592",
        approx_size_bytes: 67_243_654,
        sample_rate: 22_050,
    },
    VoiceEntry {
        id: "minhquang",
        display: "Vietnamese — Minh Quang (custom)",
        lang: "vi",
        package: "vits-piper-minhquang",
        base_url: CUSTOM_VI_BASE,
        sha256: "c113ac010cc474446e9aa0e81bf1faca55c73d507ef19682b74fca1f9a2a07f9",
        approx_size_bytes: 67_246_724,
        sample_rate: 22_050,
    },
    // ── English ─────────────────────────────────────────────
    VoiceEntry {
        id: "en_US-ryan-medium",
        display: "English (US) — Ryan (medium)",
        lang: "en",
        package: "vits-piper-en_US-ryan-medium",
        base_url: RELEASE_BASE,
        sha256: "c546af78b6395b4e7c4ce1ed899438b64426a362f5d4ec5fecd090ded9ad7505",
        approx_size_bytes: 63_000_000,
        sample_rate: 22_050,
    },
    VoiceEntry {
        id: "en_US-lessac-medium",
        display: "English (US) — Lessac (medium)",
        lang: "en",
        package: "vits-piper-en_US-lessac-medium",
        base_url: RELEASE_BASE,
        sha256: "9e3febfacf0abf4270172d2958bcec246032b7e88efc2720840cc80c93de334e",
        approx_size_bytes: 67_230_653,
        sample_rate: 22_050,
    },
    VoiceEntry {
        id: "en_US-amy-medium",
        display: "English (US) — Amy (medium)",
        lang: "en",
        package: "vits-piper-en_US-amy-medium",
        base_url: RELEASE_BASE,
        sha256: "9a5d1fc497f85e8022b785bff5f8105203b1e33099ee6265203efc70b0cb0264",
        approx_size_bytes: 67_223_746,
        sample_rate: 22_050,
    },
    VoiceEntry {
        id: "en_GB-alba-medium",
        display: "English (UK) — Alba (medium)",
        lang: "en",
        package: "vits-piper-en_GB-alba-medium",
        base_url: RELEASE_BASE,
        sha256: "fcd45962906933eec4431d3688f7d74aaac8713c87c6717f91fd3b23463aa1a1",
        approx_size_bytes: 67_212_349,
        sample_rate: 22_050,
    },
    // ── Romanian & European ─────────────────────────────────
    VoiceEntry {
        id: "ro_RO-mihai-medium",
        display: "Romanian — Mihai (medium)",
        lang: "ro",
        package: "vits-piper-ro_RO-mihai-medium",
        base_url: RELEASE_BASE,
        sha256: "cfbee3cdc25cf063339f69e189f4d93cc3be6610d267567537323ced3cf87f4d",
        approx_size_bytes: 67_182_137,
        sample_rate: 22_050,
    },
    VoiceEntry {
        id: "fr_FR-siwis-medium",
        display: "French — Siwis (medium)",
        lang: "fr",
        package: "vits-piper-fr_FR-siwis-medium",
        base_url: RELEASE_BASE,
        sha256: "375909aa30842b3a4efa10b1beb1d761af792960ae6873b4d53889f96c66195b",
        approx_size_bytes: 67_207_459,
        sample_rate: 22_050,
    },
    VoiceEntry {
        id: "de_DE-thorsten-medium",
        display: "German — Thorsten (medium)",
        lang: "de",
        package: "vits-piper-de_DE-thorsten-medium",
        base_url: RELEASE_BASE,
        sha256: "50487d9c95fdf2191f31d2588569381063ba1591dcd4c7d4bdd30f12b2191714",
        approx_size_bytes: 67_214_254,
        sample_rate: 22_050,
    },
    VoiceEntry {
        id: "es_ES-sharvard-medium",
        display: "Spanish — Sharvard (medium)",
        lang: "es",
        package: "vits-piper-es_ES-sharvard-medium",
        base_url: RELEASE_BASE,
        sha256: "b30a7a83df0518f0ee1c7039506648cade99f1f9b498fc49ed2ced2e2536bb5a",
        approx_size_bytes: 80_318_184,
        sample_rate: 22_050,
    },
    VoiceEntry {
        id: "it_IT-paola-medium",
        display: "Italian — Paola (medium)",
        lang: "it",
        package: "vits-piper-it_IT-paola-medium",
        base_url: RELEASE_BASE,
        sha256: "7541f75778afa164e44e34baaef63befad7698595df26a95ca944b63ef1a16b4",
        approx_size_bytes: 67_221_173,
        sample_rate: 22_050,
    },
    VoiceEntry {
        id: "pt_BR-faber-medium",
        display: "Portuguese (BR) — Faber (medium)",
        lang: "pt",
        package: "vits-piper-pt_BR-faber-medium",
        base_url: RELEASE_BASE,
        sha256: "7add3f923ad6bc25ca8a192805fd1a64d1b3893e4611c4a9719545a825039a83",
        approx_size_bytes: 67_183_065,
        sample_rate: 22_050,
    },
    VoiceEntry {
        id: "pl_PL-gosia-medium",
        display: "Polish — Gosia (medium)",
        lang: "pl",
        package: "vits-piper-pl_PL-gosia-medium",
        base_url: RELEASE_BASE,
        sha256: "75bd34dcbdc4dd98d763954756b4b34b4208100497c836381542e4d73dcefa9c",
        approx_size_bytes: 67_211_182,
        sample_rate: 22_050,
    },
    VoiceEntry {
        id: "nl_NL-pim-medium",
        display: "Dutch — Pim (medium)",
        lang: "nl",
        package: "vits-piper-nl_NL-pim-medium",
        base_url: RELEASE_BASE,
        sha256: "e78ed301bf6fc66561a04c110754cd6928d772630a3b80b09a83f89410130171",
        approx_size_bytes: 67_240_538,
        sample_rate: 22_050,
    },
    VoiceEntry {
        id: "cs_CZ-jirka-medium",
        display: "Czech — Jirka (medium)",
        lang: "cs",
        package: "vits-piper-cs_CZ-jirka-medium",
        base_url: RELEASE_BASE,
        sha256: "321aafd83dd89b3d5b2c36c5898e0710d4f472f3c191cb7f73901a89b7f8539f",
        approx_size_bytes: 67_212_775,
        sample_rate: 22_050,
    },
    VoiceEntry {
        id: "sk_SK-lili-medium",
        display: "Slovak — Lili (medium)",
        lang: "sk",
        package: "vits-piper-sk_SK-lili-medium",
        base_url: RELEASE_BASE,
        sha256: "a00dfbca5d34733862a59d9e309f4e94a92fccc9337c2b124de9a241b604fc0d",
        approx_size_bytes: 67_183_092,
        sample_rate: 22_050,
    },
    VoiceEntry {
        id: "hu_HU-anna-medium",
        display: "Hungarian — Anna (medium)",
        lang: "hu",
        package: "vits-piper-hu_HU-anna-medium",
        base_url: RELEASE_BASE,
        sha256: "c67b13e57b71eca19098fe499afc35ebce8f63a0b524017c786af2025821216a",
        approx_size_bytes: 67_167_701,
        sample_rate: 22_050,
    },
    VoiceEntry {
        id: "el_GR-rapunzelina-low",
        display: "Greek — Rapunzelina (low)",
        lang: "el",
        package: "vits-piper-el_GR-rapunzelina-low",
        base_url: RELEASE_BASE,
        sha256: "bb868070a9ba0d7220b3d7c9291a998c2f60accdb73525bd63b8751b86dd4839",
        approx_size_bytes: 67_105_521,
        sample_rate: 16_000,
    },
    VoiceEntry {
        id: "sv_SE-nst-medium",
        display: "Swedish — NST (medium)",
        lang: "sv",
        package: "vits-piper-sv_SE-nst-medium",
        base_url: RELEASE_BASE,
        sha256: "5aed0f5ab75135fc3ba6a4f3567e171d72df753305b08a01ca42f79411587f67",
        approx_size_bytes: 67_144_884,
        sample_rate: 22_050,
    },
    VoiceEntry {
        id: "da_DK-talesyntese-medium",
        display: "Danish — Talesyntese (medium)",
        lang: "da",
        package: "vits-piper-da_DK-talesyntese-medium",
        base_url: RELEASE_BASE,
        sha256: "f2e2cbcdb2b21e76f93635b35105d07b37997ace434d7289d04b689a97c19bd0",
        approx_size_bytes: 67_185_257,
        sample_rate: 22_050,
    },
    // ── Slavic / other ──────────────────────────────────────
    VoiceEntry {
        id: "ru_RU-irina-medium",
        display: "Russian — Irina (medium)",
        lang: "ru",
        package: "vits-piper-ru_RU-irina-medium",
        base_url: RELEASE_BASE,
        sha256: "1fc0f54e5e084fe287c07909f2f6e0ba6d857864cf800e3ab80286a4e8233008",
        approx_size_bytes: 67_153_308,
        sample_rate: 22_050,
    },
    VoiceEntry {
        id: "uk_UA-ukrainian_tts-medium",
        display: "Ukrainian — TTS (medium)",
        lang: "uk",
        package: "vits-piper-uk_UA-ukrainian_tts-medium",
        base_url: RELEASE_BASE,
        sha256: "92be6ff21ebb1cbcc0c71121a6437db8d060cee5785287aaa6a19a2548f59c03",
        approx_size_bytes: 80_355_083,
        sample_rate: 22_050,
    },
    VoiceEntry {
        id: "tr_TR-dfki-medium",
        display: "Turkish — DFKI (medium)",
        lang: "tr",
        package: "vits-piper-tr_TR-dfki-medium",
        base_url: RELEASE_BASE,
        sha256: "b63babaefcdd63202c7079aba25b72a2013825ad5895e2aeff03d1ae5a5b3bbf",
        approx_size_bytes: 67_201_221,
        sample_rate: 22_050,
    },
    // ── Asian / MENA ────────────────────────────────────────
    VoiceEntry {
        id: "zh_CN-huayan-medium",
        display: "Chinese — Huayan (medium)",
        lang: "zh",
        package: "vits-piper-zh_CN-huayan-medium",
        base_url: RELEASE_BASE,
        sha256: "dbdfec42b91d9cee31cce9ff4b3e9c305eb6fbf60546d071f7e46273554cce6b",
        approx_size_bytes: 67_255_926,
        sample_rate: 22_050,
    },
    VoiceEntry {
        id: "ar_JO-kareem-medium",
        display: "Arabic — Kareem (medium)",
        lang: "ar",
        package: "vits-piper-ar_JO-kareem-medium",
        base_url: RELEASE_BASE,
        sha256: "9ebbcea30e0fbd588f7b2cb45ee897d6aeb1bf5791cbc037a7b5a3f641e3dbce",
        approx_size_bytes: 67_177_830,
        sample_rate: 22_050,
    },
    VoiceEntry {
        id: "hi_IN-priyamvada-medium",
        display: "Hindi — Priyamvada (medium)",
        lang: "hi",
        package: "vits-piper-hi_IN-priyamvada-medium",
        base_url: RELEASE_BASE,
        sha256: "399d91cc97eb288725633261f26b715f9a971e3bf7ec4fa1d7910cd0080d37eb",
        approx_size_bytes: 67_240_610,
        sample_rate: 22_050,
    },
    VoiceEntry {
        id: "id_ID-news_tts-medium",
        display: "Indonesian — News TTS (medium)",
        lang: "id",
        package: "vits-piper-id_ID-news_tts-medium",
        base_url: RELEASE_BASE,
        sha256: "634b0169fe41c368e9fafe128f30647f9e0301e852ce503cd78146db524f1f12",
        approx_size_bytes: 67_243_848,
        sample_rate: 22_050,
    },
    // NOTE: banmai / minhkhang / minhthu are omitted — their .onnx crash
    // sherpa-onnx (Ort::Exception) at synth. Re-add once re-exported by the
    // author so they load under onnxruntime (sherpa-onnx 1.13.3).
];

/// Look up a downloadable catalog entry by id (used only by download).
pub fn catalog_entry(id: &str) -> Result<&'static VoiceEntry, String> {
    CATALOG
        .iter()
        .find(|v| v.id == id)
        .ok_or_else(|| format!("Unknown voice id: {id}"))
}

/// Validate that `id` is a safe single path segment (no separators/traversal).
/// Speak/delete accept any installed voice (catalog OR imported), so the safety
/// gate here is the charset check + the canonicalize-within-root check in `model_dir`.
fn ensure_safe_id(id: &str) -> Result<(), String> {
    if id.is_empty()
        || id == "."
        || id == ".."
        || id.contains('/')
        || id.contains('\\')
        || !id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '-' | '.'))
    {
        return Err(format!("Invalid voice id: {id}"));
    }
    Ok(())
}

/// Default models root: `<config>/com.personal.translator/piper-models`.
fn default_models_root() -> PathBuf {
    let mut p = dirs::config_dir().unwrap_or_else(|| PathBuf::from("."));
    p.push("com.personal.translator");
    p.push("piper-models");
    p
}

/// Resolve the active models root from settings (user-chosen dir, else default),
/// creating it if missing.
pub fn models_root(settings: &SettingsState) -> Result<PathBuf, String> {
    let configured = {
        let s = settings.0.lock().map_err(|_| "settings lock poisoned")?;
        s.local_tts_models_dir.trim().to_string()
    };
    let root = if configured.is_empty() {
        default_models_root()
    } else {
        PathBuf::from(configured)
    };
    std::fs::create_dir_all(&root).map_err(|e| format!("Failed to create models dir: {e}"))?;
    Ok(root)
}

/// Directory for a validated voice id inside the active root.
/// Canonicalizes and asserts the result stays within `root` (defense in depth).
pub fn model_dir(root: &Path, id: &str) -> Result<PathBuf, String> {
    ensure_safe_id(id)?; // charset/traversal guard (allows catalog + imported ids)
    let dir = root.join(id);
    // If it exists, ensure it did not escape the root via symlink/traversal.
    if let Ok(canon) = dir.canonicalize() {
        let root_canon = root.canonicalize().unwrap_or_else(|_| root.to_path_buf());
        if !canon.starts_with(&root_canon) {
            return Err("Resolved model path escaped the models directory".into());
        }
    }
    Ok(dir)
}

/// A voice is installed only when its dir has the `.complete` sentinel written
/// after a successful extraction (an interrupted extract never looks installed).
pub fn is_installed(dir: &Path) -> bool {
    dir.join(".complete").exists()
}

/// Locate the model files inside an installed voice dir: the `.onnx`, `tokens.txt`,
/// and `espeak-ng-data/`.
fn resolve_model_files(dir: &Path) -> Result<(PathBuf, PathBuf, PathBuf), String> {
    if !is_installed(dir) {
        return Err("Voice not installed".into());
    }
    let onnx = std::fs::read_dir(dir)
        .map_err(|e| format!("Cannot read model dir: {e}"))?
        .filter_map(|e| e.ok().map(|e| e.path()))
        .find(|p| p.extension().and_then(|s| s.to_str()) == Some("onnx"))
        .ok_or("No .onnx model file found")?;
    let tokens = dir.join("tokens.txt");
    let espeak = dir.join("espeak-ng-data");
    if !tokens.exists() || !espeak.exists() {
        return Err("Model is missing tokens.txt or espeak-ng-data".into());
    }
    Ok((onnx, tokens, espeak))
}

/// A loaded engine, wrapped so synthesis is serialized per voice and so a delete
/// can wait for any in-flight synthesis to finish before removing files.
type Engine = Arc<Mutex<OfflineTts>>;

/// Managed state: a tiny LRU of loaded engines (model load is 1–3 s) plus the
/// set of in-flight downloads (Phase 2, dedup guard). Fields are `Arc` so they can
/// be cloned into `spawn_blocking` closures.
pub struct LocalTtsState {
    engines: Arc<Mutex<Vec<(String, Engine)>>>,
    pub downloading: Arc<Mutex<HashSet<String>>>,
}

impl Default for LocalTtsState {
    fn default() -> Self {
        Self {
            engines: Arc::new(Mutex::new(Vec::new())),
            downloading: Arc::new(Mutex::new(HashSet::new())),
        }
    }
}

/// Max engines kept warm (bilingual/two-way switching without constant reloads).
const ENGINE_CACHE_CAP: usize = 2;

impl LocalTtsState {
    fn get_cached(engines: &Arc<Mutex<Vec<(String, Engine)>>>, id: &str) -> Option<Engine> {
        let mut list = engines.lock().ok()?;
        if let Some(pos) = list.iter().position(|(k, _)| k == id) {
            let item = list.remove(pos);
            let eng = item.1.clone();
            list.push(item); // move to most-recently-used
            Some(eng)
        } else {
            None
        }
    }

    fn insert(engines: &Arc<Mutex<Vec<(String, Engine)>>>, id: String, eng: Engine) {
        if let Ok(mut list) = engines.lock() {
            list.retain(|(k, _)| k != &id);
            list.push((id, eng));
            while list.len() > ENGINE_CACHE_CAP {
                list.remove(0);
            }
        }
    }

    /// Remove a voice's engine from the cache and return it (if present).
    /// Phase 2 delete calls this, then locks the returned engine, guaranteeing no
    /// in-flight synthesis is reading the model files before they are removed.
    pub fn evict(&self, id: &str) -> Option<Engine> {
        let mut list = self.engines.lock().ok()?;
        if let Some(pos) = list.iter().position(|(k, _)| k == id) {
            Some(list.remove(pos).1)
        } else {
            None
        }
    }
}

/// Encode mono f32 samples as a 16-bit PCM WAV byte buffer.
fn wav_from_samples(samples: &[f32], sample_rate: i32) -> Vec<u8> {
    let sr = sample_rate.max(1) as u32;
    let bits_per_sample: u16 = 16;
    let channels: u16 = 1;
    let byte_rate = sr * channels as u32 * (bits_per_sample / 8) as u32;
    let block_align = channels * (bits_per_sample / 8);
    let data_len = (samples.len() * 2) as u32;
    let mut buf = Vec::with_capacity(44 + data_len as usize);
    buf.extend_from_slice(b"RIFF");
    buf.extend_from_slice(&(36 + data_len).to_le_bytes());
    buf.extend_from_slice(b"WAVE");
    buf.extend_from_slice(b"fmt ");
    buf.extend_from_slice(&16u32.to_le_bytes()); // PCM fmt chunk size
    buf.extend_from_slice(&1u16.to_le_bytes()); // audio format = PCM
    buf.extend_from_slice(&channels.to_le_bytes());
    buf.extend_from_slice(&sr.to_le_bytes());
    buf.extend_from_slice(&byte_rate.to_le_bytes());
    buf.extend_from_slice(&block_align.to_le_bytes());
    buf.extend_from_slice(&bits_per_sample.to_le_bytes());
    buf.extend_from_slice(b"data");
    buf.extend_from_slice(&data_len.to_le_bytes());
    for &s in samples {
        let clamped = s.clamp(-1.0, 1.0);
        let v = (clamped * 32767.0) as i16;
        buf.extend_from_slice(&v.to_le_bytes());
    }
    buf
}

// ---------------------------------------------------------------------------
// Phase 2 — model list / download / delete
// ---------------------------------------------------------------------------

/// A catalog voice merged with its on-disk install state (sent to the frontend).
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VoiceInfo {
    pub id: String,
    pub display: String,
    pub lang: String,
    pub url: String,
    pub approx_size_bytes: u64,
    pub sample_rate: u32,
    pub installed: bool,
    pub installed_bytes: Option<u64>,
    /// True for a locally-imported voice folder (not in the download catalog).
    pub imported: bool,
}

/// Progress events streamed to the frontend during a download.
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct DownloadProgress {
    pub id: String,
    pub phase: String, // "downloading" | "extracting" | "done" | "error"
    pub received: u64,
    pub total: u64,
    pub message: Option<String>,
}

/// Recursive byte size of a directory (best effort).
fn dir_size(dir: &Path) -> u64 {
    let mut total = 0;
    if let Ok(rd) = std::fs::read_dir(dir) {
        for entry in rd.flatten() {
            let p = entry.path();
            if p.is_dir() {
                total += dir_size(&p);
            } else if let Ok(md) = entry.metadata() {
                total += md.len();
            }
        }
    }
    total
}

/// Cap on decompressed archive size (bz2-bomb / disk-fill defense).
const MAX_EXTRACT_BYTES: u64 = 500_000_000;

/// Return the resolved absolute models directory (custom folder if set, else the
/// per-OS default). Display-only — does NOT create the directory.
#[tauri::command]
pub fn local_tts_models_dir_path(
    settings: tauri::State<'_, SettingsState>,
) -> Result<String, String> {
    let configured = {
        let s = settings.0.lock().map_err(|_| "settings lock poisoned")?;
        s.local_tts_models_dir.trim().to_string()
    };
    let root = if configured.is_empty() {
        default_models_root()
    } else {
        PathBuf::from(configured)
    };
    Ok(root.to_string_lossy().into_owned())
}

/// List the catalog with per-voice install state from the active models root.
/// Also garbage-collects stale `.tmp-*` dirs and incomplete installs.
#[tauri::command]
pub async fn local_tts_list_models(
    settings: tauri::State<'_, SettingsState>,
) -> Result<Vec<VoiceInfo>, String> {
    let root = models_root(&settings)?;
    // GC: remove any leftover temp dirs and incomplete (crash-interrupted) installs.
    if let Ok(rd) = std::fs::read_dir(&root) {
        for entry in rd.flatten() {
            let name = entry.file_name();
            let name = name.to_string_lossy();
            let p = entry.path();
            if !p.is_dir() {
                continue;
            }
            if name.starts_with(".tmp-") {
                let _ = std::fs::remove_dir_all(&p);
            } else if CATALOG.iter().any(|v| v.id == name) && !is_installed(&p) {
                let _ = std::fs::remove_dir_all(&p);
            }
        }
    }
    let mut list: Vec<VoiceInfo> = CATALOG
        .iter()
        .map(|v| {
            let dir = root.join(v.id);
            let installed = is_installed(&dir);
            VoiceInfo {
                id: v.id.to_string(),
                display: v.display.to_string(),
                lang: v.lang.to_string(),
                url: format!("{}/{}.tar.bz2", v.base_url, v.package),
                approx_size_bytes: v.approx_size_bytes,
                sample_rate: v.sample_rate,
                installed,
                installed_bytes: installed.then(|| dir_size(&dir)),
                imported: false,
            }
        })
        .collect();

    // Imported voices: any other installed voice folder in the models root that isn't a
    // catalog entry (e.g. a user-supplied Piper model). Valid = has .complete + resolvable
    // model files (.onnx + tokens.txt + espeak-ng-data).
    if let Ok(rd) = std::fs::read_dir(&root) {
        for entry in rd.flatten() {
            let dir = entry.path();
            if !dir.is_dir() {
                continue;
            }
            let name = entry.file_name().to_string_lossy().to_string();
            if name.starts_with('.') || CATALOG.iter().any(|v| v.id == name) {
                continue; // skip hidden/shared dirs (e.g. espeak-ng-data) and catalog ids
            }
            if ensure_safe_id(&name).is_err() || resolve_model_files(&dir).is_err() {
                continue;
            }
            list.push(VoiceInfo {
                id: name.clone(),
                display: name,
                lang: String::new(), // unknown; UI shows imported voices regardless of language
                url: String::new(),
                approx_size_bytes: 0,
                sample_rate: 0,
                installed: true,
                installed_bytes: Some(dir_size(&dir)),
                imported: true,
            });
        }
    }
    list.sort_by(|a, b| a.display.to_lowercase().cmp(&b.display.to_lowercase()));
    Ok(list)
}

/// RAII guard that clears the in-flight download marker for `id` on drop.
struct DownloadGuard {
    set: Arc<Mutex<HashSet<String>>>,
    id: String,
}
impl Drop for DownloadGuard {
    fn drop(&mut self) {
        if let Ok(mut s) = self.set.lock() {
            s.remove(&self.id);
        }
    }
}

/// Download + verify + extract a voice model. Streams progress over `on_progress`.
#[tauri::command]
pub async fn local_tts_download_model(
    id: String,
    on_progress: Channel<DownloadProgress>,
    state: tauri::State<'_, LocalTtsState>,
    settings: tauri::State<'_, SettingsState>,
) -> Result<(), String> {
    let entry = catalog_entry(&id)?;
    let root = models_root(&settings)?;

    // Dedup: reject a second concurrent download of the same id.
    {
        let mut inflight = state
            .downloading
            .lock()
            .map_err(|_| "download lock poisoned")?;
        if !inflight.insert(id.clone()) {
            return Err("Already downloading this voice".into());
        }
    }
    let _guard = DownloadGuard {
        set: state.downloading.clone(),
        id: id.clone(),
    };

    // Re-download of an already-installed voice: drop its cached engine and wait for any
    // in-flight synthesis to finish, so the extract's remove-and-rename can't pull model
    // files out from under a running generate().
    if let Some(engine) = state.evict(&id) {
        drop(engine.lock().map_err(|_| "engine lock poisoned")?);
    }

    let emit = |phase: &str, received: u64, total: u64, message: Option<String>| {
        let _ = on_progress.send(DownloadProgress {
            id: id.clone(),
            phase: phase.to_string(),
            received,
            total,
            message,
        });
    };

    let result = download_and_extract(entry, &root, &id, &emit).await;
    match &result {
        Ok(_) => emit("done", 0, 0, None),
        Err(e) => emit("error", 0, 0, Some(e.clone())),
    }
    result
}

async fn download_and_extract(
    entry: &VoiceEntry,
    root: &Path,
    id: &str,
    emit: &impl Fn(&str, u64, u64, Option<String>),
) -> Result<(), String> {
    let tmp = root.join(format!(".tmp-{id}"));
    let _ = std::fs::remove_dir_all(&tmp);
    std::fs::create_dir_all(&tmp).map_err(|e| format!("Failed to create temp dir: {e}"))?;
    // Clean up temp dir on any early return.
    let cleanup = || {
        let _ = std::fs::remove_dir_all(&tmp);
    };

    let url = format!("{}/{}.tar.bz2", entry.base_url, entry.package);
    // Dedicated client: NO total timeout (large download), but bound connect + per-read so a
    // stalled socket cannot hang the stream forever.
    let client = reqwest::Client::builder()
        .connect_timeout(std::time::Duration::from_secs(30))
        .read_timeout(std::time::Duration::from_secs(60))
        .build()
        .map_err(|e| format!("client build failed: {e}"))?;
    let resp = client.get(&url).send().await.map_err(|e| {
        cleanup();
        format!("Download request failed: {e}")
    })?;
    if !resp.status().is_success() {
        cleanup();
        return Err(format!("Download HTTP {}", resp.status().as_u16()));
    }
    let total = resp.content_length().unwrap_or(entry.approx_size_bytes);

    let archive_path = tmp.join("archive.tar.bz2");
    let mut file = std::fs::File::create(&archive_path)
        .map_err(|e| format!("Failed to open temp file: {e}"))?;
    let mut hasher = Sha256::new();
    let mut received: u64 = 0;
    let mut stream = resp.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = match chunk {
            Ok(c) => c,
            Err(e) => {
                cleanup();
                return Err(format!("Download interrupted: {e}"));
            }
        };
        hasher.update(&chunk);
        if let Err(e) = file.write_all(&chunk) {
            cleanup();
            return Err(format!("Write failed: {e}"));
        }
        received += chunk.len() as u64;
        emit("downloading", received, total, None);
    }
    drop(file);

    // Integrity gate: fail closed on checksum mismatch.
    let digest = hex::encode(hasher.finalize());
    if !digest.eq_ignore_ascii_case(entry.sha256) {
        cleanup();
        return Err("Downloaded file failed integrity check (SHA-256 mismatch)".into());
    }

    emit("extracting", total, total, None);
    let extract_dir = tmp.join("extract");
    std::fs::create_dir_all(&extract_dir).map_err(|e| format!("mkdir failed: {e}"))?;
    if let Err(e) = extract_archive(&archive_path, &extract_dir) {
        cleanup();
        return Err(e);
    }

    // Atomic-ish install: clear any existing target, then rename into place.
    let final_dir = root.join(id);
    let _ = std::fs::remove_dir_all(&final_dir);
    if let Err(e) = std::fs::rename(&extract_dir, &final_dir) {
        cleanup();
        return Err(format!("Failed to finalize model: {e}"));
    }
    // Mark complete only after files are in place.
    if let Err(e) = std::fs::write(final_dir.join(".complete"), b"1") {
        let _ = std::fs::remove_dir_all(&final_dir);
        cleanup();
        return Err(format!("Failed to write completion marker: {e}"));
    }
    cleanup();
    Ok(())
}

/// Decode a `.tar.bz2` into `dest`, stripping the single top-level directory the
/// Piper archives use, sanitizing entry paths, and enforcing a size cap.
fn extract_archive(archive: &Path, dest: &Path) -> Result<(), String> {
    let f = std::fs::File::open(archive).map_err(|e| format!("open archive: {e}"))?;
    let mut tar = tar::Archive::new(BzDecoder::new(f));
    let mut total: u64 = 0;
    let entries = tar.entries().map_err(|e| format!("read archive: {e}"))?;
    for entry in entries {
        let mut entry = entry.map_err(|e| format!("archive entry: {e}"))?;
        total += entry.size();
        if total > MAX_EXTRACT_BYTES {
            return Err("Archive exceeds maximum allowed size".into());
        }
        let path = entry
            .path()
            .map_err(|e| format!("bad entry path: {e}"))?
            .into_owned();
        // Strip the leading `vits-piper-<pkg>/` component so files land in dest root.
        let rel: PathBuf = path.components().skip(1).collect();
        if rel.as_os_str().is_empty() {
            continue;
        }
        // Sanitize: reject traversal / absolute paths.
        for comp in rel.components() {
            use std::path::Component;
            match comp {
                Component::Normal(_) => {}
                _ => return Err("Unsafe path in archive".into()),
            }
        }
        let out = dest.join(&rel);
        if entry.header().entry_type().is_dir() {
            std::fs::create_dir_all(&out).map_err(|e| format!("mkdir: {e}"))?;
        } else {
            if let Some(parent) = out.parent() {
                std::fs::create_dir_all(parent).map_err(|e| format!("mkdir: {e}"))?;
            }
            entry
                .unpack(&out)
                .map_err(|e| format!("unpack {}: {e}", rel.display()))?;
        }
    }
    Ok(())
}

/// Delete an installed voice: evict its cached engine (waiting for any in-flight
/// synthesis to finish), then remove the files from disk.
#[tauri::command]
pub async fn local_tts_delete_model(
    id: String,
    state: tauri::State<'_, LocalTtsState>,
    settings: tauri::State<'_, SettingsState>,
) -> Result<(), String> {
    let root = models_root(&settings)?;
    let dir = model_dir(&root, &id)?; // ensures a safe id within the models root
    if !dir.exists() {
        return Err("Voice not installed".into());
    }
    // Evict from cache and block until any in-flight synthesis releases the engine,
    // so no generate() is reading espeak-ng-data while we delete it.
    if let Some(engine) = state.evict(&id) {
        // Acquire-then-release: blocks until any in-flight synthesis finishes. Since the
        // engine is already evicted from the cache, no new synthesis can obtain it, so
        // once this returns no generate() is reading the model files.
        drop(engine.lock().map_err(|_| "engine lock poisoned")?);
    }
    std::fs::remove_dir_all(&dir).map_err(|e| format!("Failed to delete model: {e}"))?;
    if dir.exists() {
        return Err("Model directory still present after delete".into());
    }
    Ok(())
}

/// Build a Piper VITS engine from the model files.
fn create_engine(onnx: &Path, tokens: &Path, espeak: &Path) -> Result<OfflineTts, String> {
    let config = OfflineTtsConfig {
        model: OfflineTtsModelConfig {
            vits: OfflineTtsVitsModelConfig {
                model: Some(onnx.to_string_lossy().into_owned()),
                tokens: Some(tokens.to_string_lossy().into_owned()),
                data_dir: Some(espeak.to_string_lossy().into_owned()),
                ..Default::default()
            },
            num_threads: 2,
            ..Default::default()
        },
        ..Default::default()
    };
    OfflineTts::create(&config).ok_or_else(|| "Failed to create TTS engine".to_string())
}

/// Synthesize `text` with the local voice `voice_id`. Returns base64 WAV.
#[tauri::command]
pub async fn local_tts_speak(
    text: String,
    voice_id: String,
    speed: f32,
    state: tauri::State<'_, LocalTtsState>,
    settings: tauri::State<'_, SettingsState>,
) -> Result<String, String> {
    if text.trim().is_empty() {
        return Err("Empty text".into());
    }
    let root = models_root(&settings)?;
    let dir = model_dir(&root, &voice_id)?; // ensures a safe id within the models root
    let (onnx, tokens, espeak) = resolve_model_files(&dir)?;

    let engines = state.engines.clone();
    let speed = if speed > 0.0 { speed } else { 1.0 };

    // Heavy CPU work (model load + synthesis) off the async runtime.
    let b64 = tokio::task::spawn_blocking(move || -> Result<String, String> {
        let engine = match LocalTtsState::get_cached(&engines, &voice_id) {
            Some(e) => e,
            None => {
                let e = Arc::new(Mutex::new(create_engine(&onnx, &tokens, &espeak)?));
                LocalTtsState::insert(&engines, voice_id.clone(), e.clone());
                e
            }
        };
        let guard = engine.lock().map_err(|_| "engine lock poisoned")?;
        let gen = GenerationConfig {
            speed,
            sid: 0,
            ..Default::default()
        };
        let audio = guard
            .generate_with_config(&text, &gen, None::<fn(&[f32], f32) -> bool>)
            .ok_or("Synthesis failed")?;
        let wav = wav_from_samples(audio.samples(), audio.sample_rate());
        Ok(base64::engine::general_purpose::STANDARD.encode(&wav))
    })
    .await
    .map_err(|e| format!("TTS task failed: {e}"))??;

    Ok(b64)
}
