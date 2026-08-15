use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
use reqwest::multipart;
use serde::{Deserialize, Serialize};
use std::sync::OnceLock;
use std::time::Duration;

const SAMPLE_RATE: u32 = 16_000;
const CHANNELS: u16 = 1;
const BITS_PER_SAMPLE: u16 = 16;
const WAV_HEADER_LEN: usize = 44;

const GROQ_STT_URL: &str = "https://api.groq.com/openai/v1/audio/transcriptions";
const GROQ_CHAT_URL: &str = "https://api.groq.com/openai/v1/chat/completions";
const GROQ_MODELS_URL: &str = "https://api.groq.com/openai/v1/models";
const GROQ_STT_MODEL: &str = "whisper-large-v3-turbo";
const GROQ_CHAT_MODEL: &str = "llama-3.1-8b-instant";

const CF_WHISPER_MODEL: &str = "@cf/openai/whisper-large-v3-turbo";
const CF_LLM_MODEL: &str = "@cf/meta/llama-3.1-8b-instruct";
const OPENROUTER_CHAT_URL: &str = "https://openrouter.ai/api/v1/chat/completions";
const OPENROUTER_MODELS_URL: &str = "https://openrouter.ai/api/v1/models";
const OPENROUTER_CHAT_MODEL: &str = "openai/gpt-4o-mini";
const CF_TOKEN_VERIFY_URL: &str = "https://api.cloudflare.com/client/v4/user/tokens/verify";

fn cf_models_search_url(account_id: &str) -> String {
    format!(
        "https://api.cloudflare.com/client/v4/accounts/{}/ai/models/search",
        account_id.trim()
    )
}

async fn cloudflare_response_ok(resp: reqwest::Response) -> bool {
    if !resp.status().is_success() {
        return false;
    }
    let body = resp.text().await.unwrap_or_default();
    serde_json::from_str::<serde_json::Value>(&body)
        .ok()
        .and_then(|v| v.get("success").and_then(|s| s.as_bool()))
        .unwrap_or(true)
}

static PROVIDER_CLIENT: OnceLock<reqwest::Client> = OnceLock::new();

fn http() -> &'static reqwest::Client {
    PROVIDER_CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .timeout(Duration::from_secs(45))
            .build()
            .expect("failed to build provider reqwest client")
    })
}

#[derive(Debug, Serialize, Deserialize)]
pub struct ProviderResult {
    pub source_text: String,
    pub translated_text: String,
}

/// Build a valid RIFF WAV (PCM s16le, 16 kHz, mono) around raw PCM bytes.
pub fn pcm_to_wav(pcm: &[u8]) -> Vec<u8> {
    let data_len = pcm.len() as u32;
    let byte_rate = SAMPLE_RATE * u32::from(CHANNELS) * u32::from(BITS_PER_SAMPLE) / 8;
    let block_align = CHANNELS * BITS_PER_SAMPLE / 8;
    let mut wav = Vec::with_capacity(WAV_HEADER_LEN + pcm.len());
    wav.extend_from_slice(b"RIFF");
    wav.extend_from_slice(&(36 + data_len).to_le_bytes());
    wav.extend_from_slice(b"WAVE");
    wav.extend_from_slice(b"fmt ");
    wav.extend_from_slice(&16u32.to_le_bytes());
    wav.extend_from_slice(&1u16.to_le_bytes());
    wav.extend_from_slice(&CHANNELS.to_le_bytes());
    wav.extend_from_slice(&SAMPLE_RATE.to_le_bytes());
    wav.extend_from_slice(&byte_rate.to_le_bytes());
    wav.extend_from_slice(&block_align.to_le_bytes());
    wav.extend_from_slice(&BITS_PER_SAMPLE.to_le_bytes());
    wav.extend_from_slice(b"data");
    wav.extend_from_slice(&data_len.to_le_bytes());
    wav.extend_from_slice(pcm);
    wav
}

fn wants_openrouter(llm_provider: &Option<String>) -> bool {
    matches!(llm_provider.as_deref(), Some("openrouter"))
}

fn resolve_model(provided: Option<&str>, fallback: &str) -> String {
    match provided {
        Some(value) if !value.trim().is_empty() => value.trim().to_string(),
        _ => fallback.to_string(),
    }
}

fn language_hint(source_language: &str) -> Option<&str> {
    let trimmed = source_language.trim();
    if trimmed.is_empty() || trimmed.eq_ignore_ascii_case("auto") {
        None
    } else {
        Some(trimmed)
    }
}

fn translation_prompt(source_language: &str, target_language: &str, text: &str) -> String {
    format!(
        "Translate the following text to {target}. If the source language is specified as {source}, use that. Return only the translation, with no quotes or explanation.\n\n{text}",
        target = target_language,
        source = source_language,
        text = text
    )
}

fn http_error_status(status: reqwest::StatusCode, body: &str) -> String {
    let code = status.as_u16();
    eprintln!("[provider] HTTP {code} {body}");
    let snippet: String = body.chars().take(180).collect();
    format!("HTTP {code} {snippet}")
}

async fn groq_transcribe(
    api_key: &str,
    wav: Vec<u8>,
    source_language: &str,
    stt_model: &str,
) -> Result<String, String> {
    let mut form = multipart::Form::new().text("model", stt_model.to_string()).part(
        "file",
        multipart::Part::bytes(wav)
            .file_name("audio.wav")
            .mime_str("audio/wav")
            .map_err(|e| e.to_string())?,
    );
    if let Some(lang) = language_hint(source_language) {
        form = form.text("language", lang.to_string());
    }

    let resp = http()
        .post(GROQ_STT_URL)
        .bearer_auth(api_key)
        .multipart(form)
        .send()
        .await
        .map_err(|e| format!("Groq STT request failed: {e}"))?;
    let status = resp.status();
    let body = resp.text().await.map_err(|e| e.to_string())?;
    if !status.is_success() {
        return Err(http_error_status(status, &body));
    }
    let parsed: serde_json::Value =
        serde_json::from_str(&body).map_err(|e| format!("Groq STT JSON: {e}"))?;
    Ok(parsed
        .get("text")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim()
        .to_string())
}

async fn groq_translate(
    api_key: &str,
    source_language: &str,
    target_language: &str,
    text: &str,
    llm_model: &str,
) -> Result<String, String> {
    if text.is_empty() {
        return Ok(String::new());
    }
    if source_language == target_language {
        return Ok(text.to_string());
    }
    let payload = serde_json::json!({
        "model": llm_model,
        "temperature": 0.2,
        "messages": [
            {"role": "system", "content": "You are a precise translator. Output only the translated text."},
            {"role": "user", "content": translation_prompt(source_language, target_language, text)}
        ]
    });
    let resp = http()
        .post(GROQ_CHAT_URL)
        .bearer_auth(api_key)
        .json(&payload)
        .send()
        .await
        .map_err(|e| format!("Groq chat request failed: {e}"))?;
    let status = resp.status();
    let body = resp.text().await.map_err(|e| e.to_string())?;
    if !status.is_success() {
        return Err(http_error_status(status, &body));
    }
    let parsed: serde_json::Value =
        serde_json::from_str(&body).map_err(|e| format!("Groq chat JSON: {e}"))?;
    Ok(parsed
        .pointer("/choices/0/message/content")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim()
        .to_string())
}

fn cf_run_url(account_id: &str, model: &str) -> String {
    format!("https://api.cloudflare.com/client/v4/accounts/{account_id}/ai/run/{model}")
}

async fn cloudflare_transcribe(
    account_id: &str,
    api_token: &str,
    wav: &[u8],
    source_language: &str,
    stt_model: &str,
) -> Result<String, String> {
    let mut payload = serde_json::json!({
        "audio": B64.encode(wav),
    });
    if let Some(lang) = language_hint(source_language) {
        payload["language"] = serde_json::Value::String(lang.to_string());
    }
    let resp = http()
        .post(cf_run_url(account_id, stt_model))
        .bearer_auth(api_token)
        .json(&payload)
        .send()
        .await
        .map_err(|e| format!("Cloudflare STT request failed: {e}"))?;
    let status = resp.status();
    let body = resp.text().await.map_err(|e| e.to_string())?;
    if !status.is_success() {
        return Err(http_error_status(status, &body));
    }
    let parsed: serde_json::Value =
        serde_json::from_str(&body).map_err(|e| format!("Cloudflare STT JSON: {e}"))?;
    let text = parsed
        .pointer("/result/text")
        .or_else(|| parsed.get("text"))
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim()
        .to_string();
    Ok(text)
}

async fn cloudflare_translate(
    account_id: &str,
    api_token: &str,
    source_language: &str,
    target_language: &str,
    text: &str,
    llm_model: &str,
) -> Result<String, String> {
    if text.is_empty() {
        return Ok(String::new());
    }
    if source_language == target_language {
        return Ok(text.to_string());
    }
    let payload = serde_json::json!({
        "messages": [
            {"role": "system", "content": "You are a precise translator. Output only the translated text."},
            {"role": "user", "content": translation_prompt(source_language, target_language, text)}
        ]
    });
    let resp = http()
        .post(cf_run_url(account_id, llm_model))
        .bearer_auth(api_token)
        .json(&payload)
        .send()
        .await
        .map_err(|e| format!("Cloudflare LLM request failed: {e}"))?;
    let status = resp.status();
    let body = resp.text().await.map_err(|e| e.to_string())?;
    if !status.is_success() {
        return Err(http_error_status(status, &body));
    }
    let parsed: serde_json::Value =
        serde_json::from_str(&body).map_err(|e| format!("Cloudflare LLM JSON: {e}"))?;
    let translated = parsed
        .pointer("/result/response")
        .or_else(|| parsed.pointer("/result/output"))
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim()
        .to_string();
    Ok(translated)
}

async fn openrouter_translate(
    api_key: &str,
    source_language: &str,
    target_language: &str,
    text: &str,
    llm_model: &str,
) -> Result<String, String> {
    if text.is_empty() {
        return Ok(String::new());
    }
    if source_language == target_language {
        return Ok(text.to_string());
    }
    let payload = serde_json::json!({
        "model": llm_model,
        "temperature": 0.2,
        "stream": false,
        "messages": [
            {"role": "system", "content": "You are a precise translator. Output only the translated text."},
            {"role": "user", "content": translation_prompt(source_language, target_language, text)}
        ]
    });
    let resp = http()
        .post(OPENROUTER_CHAT_URL)
        .bearer_auth(api_key)
        .header("Content-Type", "application/json")
        .json(&payload)
        .send()
        .await
        .map_err(|e| format!("OpenRouter request failed: {e}"))?;
    let status = resp.status();
    let body = resp.text().await.map_err(|e| e.to_string())?;
    if !status.is_success() {
        return Err(http_error_status(status, &body));
    }
    let parsed: serde_json::Value =
        serde_json::from_str(&body).map_err(|e| format!("OpenRouter JSON: {e}"))?;
    Ok(parsed
        .pointer("/choices/0/message/content")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim()
        .to_string())
}

#[tauri::command]
pub async fn groq_transcribe_and_translate(
    pcm: Vec<u8>,
    source_language: String,
    target_language: String,
    api_key: String,
    stt_model: Option<String>,
    llm_model: Option<String>,
    llm_provider: Option<String>,
    openrouter_api_key: Option<String>,
    openrouter_model: Option<String>,
) -> Result<ProviderResult, String> {
    if api_key.trim().is_empty() {
        return Err("Groq API key is required".into());
    }
    if pcm.is_empty() {
        return Err("Empty audio".into());
    }
    let stt = resolve_model(stt_model.as_deref(), GROQ_STT_MODEL);
    let llm = resolve_model(llm_model.as_deref(), GROQ_CHAT_MODEL);
    let wav = pcm_to_wav(&pcm);
    let source_text = groq_transcribe(&api_key, wav, &source_language, &stt).await?;
    let translated_text = if wants_openrouter(&llm_provider) {
        let or_key = openrouter_api_key.unwrap_or_default();
        if or_key.trim().is_empty() {
            return Err("OpenRouter API key is required".into());
        }
        let or_model = resolve_model(openrouter_model.as_deref(), OPENROUTER_CHAT_MODEL);
        openrouter_translate(
            &or_key,
            &source_language,
            &target_language,
            &source_text,
            &or_model,
        )
        .await?
    } else {
        groq_translate(&api_key, &source_language, &target_language, &source_text, &llm).await?
    };
    Ok(ProviderResult {
        source_text,
        translated_text,
    })
}

#[tauri::command]
pub async fn cloudflare_transcribe_and_translate(
    pcm: Vec<u8>,
    source_language: String,
    target_language: String,
    account_id: String,
    api_token: String,
    stt_model: Option<String>,
    llm_model: Option<String>,
    llm_provider: Option<String>,
    openrouter_api_key: Option<String>,
    openrouter_model: Option<String>,
) -> Result<ProviderResult, String> {
    if account_id.trim().is_empty() || api_token.trim().is_empty() {
        return Err("Cloudflare account ID and API token are required".into());
    }
    if pcm.is_empty() {
        return Err("Empty audio".into());
    }
    let stt = resolve_model(stt_model.as_deref(), CF_WHISPER_MODEL);
    let llm = resolve_model(llm_model.as_deref(), CF_LLM_MODEL);
    let wav = pcm_to_wav(&pcm);
    let source_text =
        cloudflare_transcribe(&account_id, &api_token, &wav, &source_language, &stt).await?;
    let translated_text = if wants_openrouter(&llm_provider) {
        let or_key = openrouter_api_key.unwrap_or_default();
        if or_key.trim().is_empty() {
            return Err("OpenRouter API key is required".into());
        }
        let or_model = resolve_model(openrouter_model.as_deref(), OPENROUTER_CHAT_MODEL);
        openrouter_translate(
            &or_key,
            &source_language,
            &target_language,
            &source_text,
            &or_model,
        )
        .await?
    } else {
        cloudflare_translate(
            &account_id,
            &api_token,
            &source_language,
            &target_language,
            &source_text,
            &llm,
        )
        .await?
    };
    Ok(ProviderResult {
        source_text,
        translated_text,
    })
}

#[tauri::command]
pub async fn groq_ping(api_key: String) -> Result<bool, String> {
    if api_key.trim().is_empty() {
        return Ok(false);
    }
    let resp = http()
        .get(GROQ_MODELS_URL)
        .bearer_auth(api_key)
        .send()
        .await
        .map_err(|e| format!("Groq ping failed: {e}"))?;
    Ok(resp.status().is_success())
}

#[tauri::command]
pub async fn cloudflare_ping(account_id: String, api_token: String) -> Result<bool, String> {
    if account_id.trim().is_empty() || api_token.trim().is_empty() {
        return Ok(false);
    }
    // Workers AI tokens often cannot call /user/tokens/verify (User permission),
    // but they can list/run models on the account — same path as STT/translate.
    let models = http()
        .get(cf_models_search_url(&account_id))
        .bearer_auth(api_token.trim())
        .send()
        .await
        .map_err(|e| format!("Cloudflare ping failed: {e}"))?;
    if cloudflare_response_ok(models).await {
        return Ok(true);
    }
    let verify = http()
        .get(CF_TOKEN_VERIFY_URL)
        .bearer_auth(api_token.trim())
        .send()
        .await
        .map_err(|e| format!("Cloudflare ping failed: {e}"))?;
    Ok(cloudflare_response_ok(verify).await)
}

#[tauri::command]
pub async fn openrouter_ping(api_key: String) -> Result<bool, String> {
    if api_key.trim().is_empty() {
        return Ok(false);
    }
    let resp = http()
        .get(OPENROUTER_MODELS_URL)
        .bearer_auth(api_key.trim())
        .send()
        .await
        .map_err(|e| format!("OpenRouter ping failed: {e}"))?;
    Ok(resp.status().is_success())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wav_header_is_44_bytes_plus_pcm() {
        let pcm = vec![0u8, 1, 2, 3, 4, 5, 6, 7];
        let wav = pcm_to_wav(&pcm);
        assert_eq!(wav.len(), WAV_HEADER_LEN + pcm.len());
        assert_eq!(&wav[0..4], b"RIFF");
        assert_eq!(&wav[8..12], b"WAVE");
        assert_eq!(&wav[12..16], b"fmt ");
        assert_eq!(&wav[36..40], b"data");
        assert_eq!(&wav[44..], pcm.as_slice());
        let declared = u32::from_le_bytes(wav[4..8].try_into().unwrap());
        assert_eq!(declared, (wav.len() - 8) as u32);
        let data_len = u32::from_le_bytes(wav[40..44].try_into().unwrap());
        assert_eq!(data_len, pcm.len() as u32);
        let sample_rate = u32::from_le_bytes(wav[24..28].try_into().unwrap());
        assert_eq!(sample_rate, 16_000);
        let channels = u16::from_le_bytes(wav[22..24].try_into().unwrap());
        assert_eq!(channels, 1);
        let bits = u16::from_le_bytes(wav[34..36].try_into().unwrap());
        assert_eq!(bits, 16);
    }

    #[test]
    fn language_hint_skips_auto() {
        assert_eq!(language_hint("auto"), None);
        assert_eq!(language_hint(""), None);
        assert_eq!(language_hint("vi"), Some("vi"));
    }

    #[test]
    fn cf_models_search_url_uses_account_path() {
        let url = cf_models_search_url("  acct123  ");
        assert_eq!(
            url,
            "https://api.cloudflare.com/client/v4/accounts/acct123/ai/models/search"
        );
        assert!(!url.contains("user/tokens/verify"));
    }

    #[test]
    fn wants_openrouter_only_for_openrouter_provider() {
        assert!(wants_openrouter(&Some("openrouter".into())));
        assert!(!wants_openrouter(&Some("engine".into())));
        assert!(!wants_openrouter(&None));
    }

    #[test]
    fn resolve_model_uses_fallback_when_empty() {
        assert_eq!(resolve_model(None, "fallback"), "fallback");
        assert_eq!(resolve_model(Some("  "), "fallback"), "fallback");
        assert_eq!(
            resolve_model(Some("llama-3.3-70b-versatile"), "fallback"),
            "llama-3.3-70b-versatile"
        );
    }
}
