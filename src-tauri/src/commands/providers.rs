use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
use reqwest::{multipart, Url};
use serde::{Deserialize, Serialize};
use std::sync::OnceLock;
use std::time::Duration;
use uuid::Uuid;

const SAMPLE_RATE: u32 = 16_000;
const CHANNELS: u16 = 1;
const BITS_PER_SAMPLE: u16 = 16;
const WAV_HEADER_LEN: usize = 44;

const GROQ_STT_URL: &str = "https://api.groq.com/openai/v1/audio/transcriptions";
const GROQ_CHAT_URL: &str = "https://api.groq.com/openai/v1/chat/completions";
const GROQ_MODELS_URL: &str = "https://api.groq.com/openai/v1/models";
const GROQ_STT_MODEL: &str = "whisper-large-v3-turbo";
const GROQ_CHAT_MODEL: &str = "openai/gpt-oss-120b";

const CF_WHISPER_MODEL: &str = "@cf/openai/whisper-large-v3-turbo";
const CF_LLM_MODEL: &str = "@cf/meta/llama-3.1-8b-instruct-fp8-fast";
const OPENROUTER_CHAT_URL: &str = "https://openrouter.ai/api/v1/chat/completions";
const OPENROUTER_MODELS_URL: &str = "https://openrouter.ai/api/v1/models";
const OPENROUTER_CHAT_MODEL: &str = "openai/gpt-4o-mini";
const CF_TOKEN_VERIFY_URL: &str = "https://api.cloudflare.com/client/v4/user/tokens/verify";
const GEMINI_DEFAULT_MODEL: &str = "gemini-3.1-flash-lite";
const GEMINI_MODELS_BASE: &str = "https://generativelanguage.googleapis.com/v1beta/models";
const AZURE_TRANSLATOR_ENDPOINT: &str = "https://api.cognitive.microsofttranslator.com";

fn gemini_model_id(model: &str) -> &str {
    let trimmed = model.trim();
    trimmed.strip_prefix("models/").unwrap_or(trimmed)
}

fn gemini_model_lookup_url(model: &str) -> String {
    format!("{GEMINI_MODELS_BASE}/{}", gemini_model_id(model))
}

fn gemini_models_list_url() -> &'static str {
    GEMINI_MODELS_BASE
}

fn gemini_url_with_key(base: &str, api_key: &str) -> Result<Url, String> {
    let mut endpoint = Url::parse(base).map_err(|e| format!("Gemini: Invalid URL ({e})"))?;
    endpoint.query_pairs_mut().append_pair("key", api_key.trim());
    Ok(endpoint)
}

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

fn language_name(code: &str) -> String {
    let lower = code.trim().to_ascii_lowercase();
    match lower.as_str() {
        "auto" | "" => "the source language".to_string(),
        "en" => "English".to_string(),
        "ro" => "Romanian".to_string(),
        "vi" => "Vietnamese".to_string(),
        "fr" => "French".to_string(),
        "de" => "German".to_string(),
        "es" => "Spanish".to_string(),
        "it" => "Italian".to_string(),
        "pt" | "pt-br" => "Portuguese".to_string(),
        "ja" => "Japanese".to_string(),
        "ko" => "Korean".to_string(),
        "zh" | "zh-cn" => "Chinese (Simplified)".to_string(),
        "zh-tw" => "Chinese (Traditional)".to_string(),
        "ru" => "Russian".to_string(),
        "ar" => "Arabic".to_string(),
        "hi" => "Hindi".to_string(),
        "th" => "Thai".to_string(),
        "id" => "Indonesian".to_string(),
        "tr" => "Turkish".to_string(),
        "pl" => "Polish".to_string(),
        "nl" => "Dutch".to_string(),
        "uk" => "Ukrainian".to_string(),
        "sq" => "Albanian".to_string(),
        other => other.to_string(),
    }
}

fn translation_system_prompt(target_language: &str) -> String {
    let target_name = language_name(target_language);
    format!(
        "You are a machine translator. Translate into {target_name} only. \
         Output ONLY the translated text — no quotes, labels, markdown, or commentary. \
         Never switch to another language."
    )
}

fn translation_prompt(source_language: &str, target_language: &str, text: &str) -> String {
    let source_name = language_name(source_language);
    let target_name = language_name(target_language);
    format!(
        "Translate this text from {source_name} into {target_name}.\n\
         Target language code: {target_code}\n\
         Rules:\n\
         - Write every word in {target_name} only\n\
         - Do not invent a different target language\n\
         - Keep meaning accurate; return only the translation\n\n\
         Text:\n{text}",
        source_name = source_name,
        target_name = target_name,
        target_code = target_language,
        text = text
    )
}

fn error_kind_for_status(code: u16) -> &'static str {
    match code {
        429 => "quota",
        408 | 500..=599 => "temporary",
        400 | 401 | 403 | 404 | 410 => "config",
        _ => "temporary",
    }
}

fn retry_after_ms(headers: &reqwest::header::HeaderMap) -> Option<u64> {
    let value = headers
        .get("retry-after")
        .or_else(|| headers.get("x-ratelimit-reset"))
        .and_then(|v| v.to_str().ok())?;
    if let Ok(seconds) = value.parse::<u64>() {
        return Some(seconds.saturating_mul(1000));
    }
    None
}

fn provider_error_json(
    provider: &str,
    capability: &str,
    status: reqwest::StatusCode,
    message: &str,
    retry_after_ms: Option<u64>,
) -> String {
    let code = status.as_u16();
    serde_json::json!({
        "provider": provider,
        "capability": capability,
        "kind": error_kind_for_status(code),
        "status": code,
        "retryAfterMs": retry_after_ms,
        "message": message,
    })
    .to_string()
}

fn http_error_status(status: reqwest::StatusCode, body: &str) -> String {
    let code = status.as_u16();
    eprintln!("[provider] HTTP {code}");
    // Always embed "HTTP {code}" so wrap_provider_error preserves the real status
    // (otherwise "Quota exhausted: …" without digits is mis-wrapped as 500/temporary).
    if let Ok(v) = serde_json::from_str::<serde_json::Value>(body) {
        if let Some(msg) = v
            .pointer("/error/message")
            .or_else(|| v.pointer("/errors/0/message"))
            .and_then(|m| m.as_str())
        {
            let short: String = msg.chars().take(140).collect();
            return match code {
                429 => format!("Quota exhausted (HTTP 429): {short}"),
                401 | 403 => format!("Auth failed (HTTP {code}): {short}"),
                410 => format!("Model unavailable (HTTP 410): {short}"),
                _ => format!("HTTP {code}: {short}"),
            };
        }
    }
    match code {
        429 => "Quota exhausted (HTTP 429)".into(),
        401 | 403 => format!("Authentication failed (HTTP {code})"),
        410 => "Model deprecated or removed (HTTP 410)".into(),
        _ => format!("HTTP {code}"),
    }
}

fn resolve_cloudflare_llm(provided: Option<&str>) -> String {
    let model = resolve_model(provided, CF_LLM_MODEL);
    match model.as_str() {
        "@cf/qwen/qwen3-30b-a3b-fp8" | "@cf/meta/llama-3.1-8b-instruct-fp8-fast" => model,
        _ => CF_LLM_MODEL.to_string(),
    }
}

fn cloudflare_translate_payload(
    source_language: &str,
    target_language: &str,
    text: &str,
) -> serde_json::Value {
    serde_json::json!({
        "messages": [
            {"role": "system", "content": translation_system_prompt(target_language)},
            {"role": "user", "content": translation_prompt(source_language, target_language, text)}
        ]
    })
}

fn cloudflare_translated_text(parsed: &serde_json::Value) -> String {
    parsed
        .pointer("/result/translated_text")
        .or_else(|| parsed.pointer("/result/response"))
        .or_else(|| parsed.pointer("/result/output"))
        .or_else(|| parsed.get("translated_text"))
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim()
        .to_string()
}

const GROQ_LLM_ALLOWED: &[&str] = &[
    "openai/gpt-oss-120b",
    "openai/gpt-oss-20b",
    "qwen/qwen3.6-27b",
];

/// Groq chat model ids, including current vendor/model names.
fn resolve_groq_llm(provided: Option<&str>) -> String {
    let model = resolve_model(provided, GROQ_CHAT_MODEL);
    if GROQ_LLM_ALLOWED.contains(&model.as_str()) {
        return model;
    }
    GROQ_CHAT_MODEL.to_string()
}

fn groq_is_qwen(model: &str) -> bool {
    model.starts_with("qwen/")
}

fn groq_is_gpt_oss(model: &str) -> bool {
    model.starts_with("openai/gpt-oss")
}

fn groq_translate_payload(
    llm_model: &str,
    source_language: &str,
    target_language: &str,
    text: &str,
) -> serde_json::Value {
    if groq_is_gpt_oss(llm_model) {
        // Groq docs: avoid system prompts on GPT-OSS; 20b otherwise burns the
        // live-tx budget on reasoning and the chain falls through.
        let instructions = format!(
            "{}\n\n{}",
            translation_system_prompt(target_language),
            translation_prompt(source_language, target_language, text)
        );
        return serde_json::json!({
            "model": llm_model,
            "messages": [{ "role": "user", "content": instructions }],
            "temperature": 0.6,
            "reasoning_effort": "low",
            "include_reasoning": false,
            "max_completion_tokens": 1024
        });
    }

    let mut payload = serde_json::json!({
        "model": llm_model,
        "messages": [
            {"role": "system", "content": translation_system_prompt(target_language)},
            {"role": "user", "content": translation_prompt(source_language, target_language, text)}
        ]
    });
    if groq_is_qwen(llm_model) {
        payload["reasoning_effort"] = serde_json::Value::String("none".into());
        payload["reasoning_format"] = serde_json::Value::String("hidden".into());
    } else {
        payload["temperature"] = serde_json::json!(0.2);
    }
    payload
}

fn groq_message_text(parsed: &serde_json::Value) -> String {
    let msg = match parsed.pointer("/choices/0/message") {
        Some(value) => value,
        None => return String::new(),
    };
    let content = msg.get("content").and_then(|v| v.as_str()).unwrap_or("");
    let trimmed = strip_think_tags(content);
    if !trimmed.is_empty() {
        return trimmed;
    }
    msg.get("reasoning_content")
        .or_else(|| msg.get("reasoning"))
        .and_then(|v| v.as_str())
        .map(strip_think_tags)
        .unwrap_or_default()
}

fn strip_think_tags(text: &str) -> String {
    let mut out = text.to_string();
    while let Some(start) = out.find("<think>") {
        let Some(end) = out[start..].find("</think>") else { break };
        out.replace_range(start..start + end + "</think>".len(), "");
    }
    out.trim().to_string()
}

async fn groq_transcribe(
    api_key: &str,
    wav: Vec<u8>,
    source_language: &str,
    stt_model: &str,
) -> Result<String, String> {
    let mut form = multipart::Form::new()
        .text("model", stt_model.to_string())
        .part(
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
    let payload = groq_translate_payload(llm_model, source_language, target_language, text);
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
    Ok(groq_message_text(&parsed))
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
    let payload = cloudflare_translate_payload(source_language, target_language, text);
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
    Ok(cloudflare_translated_text(&parsed))
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
            {"role": "system", "content": translation_system_prompt(target_language)},
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

// Azure Translator — maps application language codes to Azure-supported codes
fn map_language_to_azure(lang_code: &str) -> Option<String> {
    match lang_code.to_lowercase().as_str() {
        "auto" | "" => None,
        "vi" => Some("vi".to_string()),
        "en" => Some("en".to_string()),
        "es" => Some("es".to_string()),
        "fr" => Some("fr".to_string()),
        "de" => Some("de".to_string()),
        "zh" => Some("zh-Hans".to_string()),
        "zh-cn" => Some("zh-Hans".to_string()),
        "zh-tw" => Some("zh-Hant".to_string()),
        "ja" => Some("ja".to_string()),
        "ko" => Some("ko".to_string()),
        "pt" => Some("pt-PT".to_string()),
        "pt-br" => Some("pt-BR".to_string()),
        "ru" => Some("ru".to_string()),
        "ar" => Some("ar".to_string()),
        "hi" => Some("hi".to_string()),
        "th" => Some("th".to_string()),
        "id" => Some("id".to_string()),
        "tr" => Some("tr".to_string()),
        "pl" => Some("pl".to_string()),
        "nl" => Some("nl".to_string()),
        "it" => Some("it".to_string()),
        "sv" => Some("sv".to_string()),
        "no" => Some("nb".to_string()),
        "da" => Some("da".to_string()),
        "fi" => Some("fi".to_string()),
        "cs" => Some("cs".to_string()),
        "uk" => Some("uk".to_string()),
        "he" => Some("he".to_string()),
        "fa" => Some("fa".to_string()),
        "el" => Some("el".to_string()),
        _ => Some(lang_code.to_string()), // Pass through unknown codes
    }
}

fn azure_endpoint_allowed(host: &str) -> bool {
    host == "api.cognitive.microsofttranslator.com"
        || host.ends_with(".cognitive.microsofttranslator.com")
        || host.ends_with(".cognitiveservices.azure.com")
}

fn azure_translate_url(
    endpoint: &str,
    source_language: Option<&str>,
    target_language: &str,
) -> Result<Url, String> {
    let raw_endpoint = if endpoint.trim().is_empty() {
        AZURE_TRANSLATOR_ENDPOINT
    } else {
        endpoint.trim()
    };
    let mut url = Url::parse(raw_endpoint)
        .map_err(|_| "Azure Translator: Invalid endpoint URL".to_string())?;

    if url.scheme() != "https" || !url.username().is_empty() || url.password().is_some() {
        return Err("Azure Translator: Endpoint must be an HTTPS Azure URL".to_string());
    }
    let host = url
        .host_str()
        .ok_or_else(|| "Azure Translator: Endpoint host is missing".to_string())?;
    if !azure_endpoint_allowed(host) {
        return Err("Azure Translator: Endpoint is not an Azure Translator host".to_string());
    }

    let path = url.path().trim_end_matches('/');
    if !path.ends_with("/translate") {
        let translation_path = if path.is_empty() && host.ends_with(".cognitiveservices.azure.com")
        {
            "/translator/text/v3.0/translate".to_string()
        } else {
            format!("{path}/translate")
        };
        url.set_path(&translation_path);
    }
    url.set_query(None);
    url.set_fragment(None);
    {
        let mut query = url.query_pairs_mut();
        query.append_pair("api-version", "3.0");
        query.append_pair("to", target_language);
        if let Some(source) = source_language {
            query.append_pair("from", source);
        }
    }
    Ok(url)
}

fn azure_region_header(region: &str) -> Option<&str> {
    let region = region.trim();
    if region.is_empty() || region.eq_ignore_ascii_case("global") {
        None
    } else {
        Some(region)
    }
}

async fn azure_translate(
    subscription_key: &str,
    region: &str,
    endpoint: &str,
    source_language: &str,
    target_language: &str,
    text: &str,
) -> Result<String, String> {
    if text.is_empty() {
        return Ok(String::new());
    }
    if source_language == target_language {
        return Ok(text.to_string());
    }

    let target = map_language_to_azure(target_language)
        .ok_or_else(|| format!("Azure: Unsupported target language: {}", target_language))?;

    let source = map_language_to_azure(source_language);
    let url = azure_translate_url(endpoint, source.as_deref(), &target)?;

    let payload = serde_json::json!([{"text": text}]);

    let mut request = http()
        .post(url.as_str())
        .header("Ocp-Apim-Subscription-Key", subscription_key)
        .header("Content-Type", "application/json")
        .header("X-ClientTraceId", Uuid::new_v4().to_string())
        .json(&payload);
    if let Some(region) = azure_region_header(region) {
        request = request.header("Ocp-Apim-Subscription-Region", region);
    }
    let resp = request
        .send()
        .await
        .map_err(|e| format!("Azure Translator request failed: {e}"))?;

    let status = resp.status();
    let body = resp.text().await.map_err(|e| e.to_string())?;

    if !status.is_success() {
        let code = status.as_u16();
        match code {
            401 | 403 => {
                return Err(
                    "Azure Translator: Authentication failed; check key, region, and endpoint"
                        .to_string(),
                )
            }
            429 => return Err("Azure Translator: Rate limit exceeded".to_string()),
            500..=599 => return Err("Azure Translator: Service unavailable".to_string()),
            _ => return Err(format!("Azure Translator error ({})", code)),
        }
    }

    let parsed: serde_json::Value =
        serde_json::from_str(&body).map_err(|e| format!("Azure Translator JSON: {e}"))?;

    let translated = parsed
        .get(0)
        .and_then(|v| v.pointer("/translations/0/text"))
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim()
        .to_string();

    if translated.is_empty() {
        return Err("Azure Translator: Empty response".to_string());
    }

    Ok(translated)
}

async fn gemini_translate(
    api_key: &str,
    source_language: &str,
    target_language: &str,
    text: &str,
    model: &str,
) -> Result<String, String> {
    if text.is_empty() {
        return Ok(String::new());
    }
    if source_language == target_language {
        return Ok(text.to_string());
    }

    let system_prompt = translation_system_prompt(target_language);

    let payload = serde_json::json!({
        "contents": [{
            "parts": [{"text": translation_prompt(source_language, target_language, text)}]
        }],
        "systemInstruction": {
            "parts": [{"text": system_prompt}]
        },
        "generationConfig": {
            "temperature": 0.1,
            "topP": 0.95,
            "maxOutputTokens": 1000
        }
    });

    let model_id = if model.trim().is_empty() {
        GEMINI_DEFAULT_MODEL
    } else {
        gemini_model_id(model)
    };
    let key = api_key.trim();
    let endpoint = gemini_url_with_key(
        &format!("{GEMINI_MODELS_BASE}/{model_id}:generateContent"),
        key,
    )?;

    let resp = http()
        .post(endpoint.as_str())
        .header("Content-Type", "application/json")
        .json(&payload)
        .send()
        .await
        .map_err(|e| format!("Gemini request failed: {e}"))?;

    let status = resp.status();
    let retry = retry_after_ms(resp.headers());
    let body = resp.text().await.map_err(|e| e.to_string())?;

    if !status.is_success() {
        let code = status.as_u16();
        let api_msg = serde_json::from_str::<serde_json::Value>(&body)
            .ok()
            .and_then(|v| {
                v.pointer("/error/message")
                    .and_then(|m| m.as_str())
                    .map(|s| s.chars().take(120).collect::<String>())
            })
            .unwrap_or_default();
        match code {
            401 | 403 => {
                let message = if api_msg.is_empty() {
                    "Gemini: Invalid API key".to_string()
                } else {
                    format!("Gemini: {api_msg}")
                };
                return Err(provider_error_json("gemini", "translation", status, &message, None));
            }
            404 => {
                return Err(provider_error_json(
                    "gemini",
                    "translation",
                    status,
                    &format!(
                        "Gemini: Model '{model_id}' not found — try gemini-3.1-flash-lite or gemini-flash-lite-latest"
                    ),
                    None,
                ));
            }
            429 => {
                return Err(provider_error_json(
                    "gemini",
                    "translation",
                    status,
                    "Gemini: Rate limit exceeded (quota exhausted)",
                    retry,
                ));
            }
            500..=599 => {
                return Err(provider_error_json(
                    "gemini",
                    "translation",
                    status,
                    "Gemini: Service unavailable",
                    None,
                ));
            }
            400 => {
                let message = if api_msg.is_empty() {
                    "Gemini: Invalid request".to_string()
                } else {
                    format!("Gemini: {api_msg}")
                };
                return Err(provider_error_json("gemini", "translation", status, &message, None));
            }
            _ => {
                let message = if api_msg.is_empty() {
                    format!("Gemini error ({code})")
                } else {
                    format!("Gemini: {api_msg}")
                };
                return Err(provider_error_json("gemini", "translation", status, &message, None));
            }
        }
    }

    let parsed: serde_json::Value =
        serde_json::from_str(&body).map_err(|e| format!("Gemini JSON: {e}"))?;

    let translated = parsed
        .pointer("/candidates/0/content/parts/0/text")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim()
        .to_string();

    if translated.is_empty() {
        return Err("Gemini: Empty response".to_string());
    }

    Ok(translated)
}

async fn ollama_translate(
    base_url: &str,
    model_name: &str,
    source_language: &str,
    target_language: &str,
    text: &str,
) -> Result<String, String> {
    if text.is_empty() {
        return Ok(String::new());
    }
    if source_language == target_language {
        return Ok(text.to_string());
    }

    if model_name.trim().is_empty() {
        return Err("Ollama: Model name is required".to_string());
    }

    let prompt = format!(
        "Translate the following text from {} to {}. Output ONLY the translated text, nothing else.\n\nText: {}\n\nTranslation:",
        source_language, target_language, text
    );

    let url = format!("{}/api/generate", base_url.trim_end_matches('/'));

    let payload = serde_json::json!({
        "model": model_name,
        "prompt": prompt,
        "stream": false,
        "temperature": 0.1
    });

    let resp = http()
        .post(&url)
        .header("Content-Type", "application/json")
        .json(&payload)
        .send()
        .await
        .map_err(|e| format!("Ollama request failed: {e}"))?;

    let status = resp.status();
    let body = resp.text().await.map_err(|e| e.to_string())?;

    if !status.is_success() {
        let code = status.as_u16();
        match code {
            404 => return Err(format!("Ollama: Model '{}' not found", model_name)),
            _ => return Err(format!("Ollama error ({})", code)),
        }
    }

    let parsed: serde_json::Value =
        serde_json::from_str(&body).map_err(|e| format!("Ollama JSON: {e}"))?;

    let translated = parsed
        .get("response")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim()
        .lines()
        .next() // Take first line only
        .unwrap_or("")
        .trim()
        .to_string();

    if translated.is_empty() {
        return Err("Ollama: Empty response".to_string());
    }

    Ok(translated)
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
    let llm = resolve_groq_llm(llm_model.as_deref());
    let wav = pcm_to_wav(&pcm);
    let source_text = groq_transcribe(&api_key, wav, &source_language, &stt).await?;
    // Keep Groq STT; if OpenRouter fails (e.g. free-tier 429), fall back to Groq LLM
    let translated_text = if wants_openrouter(&llm_provider) {
        let or_key = openrouter_api_key.unwrap_or_default();
        if or_key.trim().is_empty() {
            return Err("OpenRouter API key is required".into());
        }
        let or_model = resolve_model(openrouter_model.as_deref(), OPENROUTER_CHAT_MODEL);
        match openrouter_translate(
            &or_key,
            &source_language,
            &target_language,
            &source_text,
            &or_model,
        )
        .await
        {
            Ok(t) => t,
            Err(e) => {
                eprintln!("[provider] OpenRouter failed, falling back to Groq LLM: {e}");
                groq_translate(
                    &api_key,
                    &source_language,
                    &target_language,
                    &source_text,
                    &llm,
                )
                .await?
            }
        }
    } else {
        groq_translate(
            &api_key,
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
    let llm = resolve_cloudflare_llm(llm_model.as_deref());
    let wav = pcm_to_wav(&pcm);
    let source_text =
        cloudflare_transcribe(&account_id, &api_token, &wav, &source_language, &stt).await?;
    // Keep CF STT; if OpenRouter fails, fall back to Cloudflare LLM (current model)
    let translated_text = if wants_openrouter(&llm_provider) {
        let or_key = openrouter_api_key.unwrap_or_default();
        if or_key.trim().is_empty() {
            return Err("OpenRouter API key is required".into());
        }
        let or_model = resolve_model(openrouter_model.as_deref(), OPENROUTER_CHAT_MODEL);
        match openrouter_translate(
            &or_key,
            &source_language,
            &target_language,
            &source_text,
            &or_model,
        )
        .await
        {
            Ok(t) => t,
            Err(e) => {
                eprintln!("[provider] OpenRouter failed, falling back to Cloudflare LLM: {e}");
                cloudflare_translate(
                    &account_id,
                    &api_token,
                    &source_language,
                    &target_language,
                    &source_text,
                    &llm,
                )
                .await?
            }
        }
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
pub async fn groq_transcribe_only(
    pcm: Vec<u8>,
    source_language: String,
    api_key: String,
    stt_model: Option<String>,
) -> Result<ProviderResult, String> {
    if api_key.trim().is_empty() {
        return Err(provider_error_json(
            "groq",
            "stt",
            reqwest::StatusCode::UNAUTHORIZED,
            "Groq API key is required",
            None,
        ));
    }
    if pcm.is_empty() {
        return Err("Empty audio".into());
    }
    let stt = resolve_model(stt_model.as_deref(), GROQ_STT_MODEL);
    let wav = pcm_to_wav(&pcm);
    let source_text = groq_transcribe(&api_key, wav, &source_language, &stt)
        .await
        .map_err(|e| wrap_provider_error("groq", "stt", e))?;
    Ok(ProviderResult {
        source_text,
        translated_text: String::new(),
    })
}

#[tauri::command]
pub async fn cloudflare_transcribe_only(
    pcm: Vec<u8>,
    source_language: String,
    account_id: String,
    api_token: String,
    stt_model: Option<String>,
) -> Result<ProviderResult, String> {
    if account_id.trim().is_empty() || api_token.trim().is_empty() {
        return Err(provider_error_json(
            "cloudflare",
            "stt",
            reqwest::StatusCode::UNAUTHORIZED,
            "Cloudflare account ID and API token are required",
            None,
        ));
    }
    if pcm.is_empty() {
        return Err("Empty audio".into());
    }
    let stt = resolve_model(stt_model.as_deref(), CF_WHISPER_MODEL);
    let wav = pcm_to_wav(&pcm);
    let source_text = cloudflare_transcribe(&account_id, &api_token, &wav, &source_language, &stt)
        .await
        .map_err(|e| wrap_provider_error("cloudflare", "stt", e))?;
    Ok(ProviderResult {
        source_text,
        translated_text: String::new(),
    })
}

#[tauri::command]
pub async fn groq_translate_text(
    api_key: String,
    source_language: String,
    target_language: String,
    text: String,
    llm_model: Option<String>,
) -> Result<ProviderResult, String> {
    if api_key.trim().is_empty() {
        return Err(provider_error_json(
            "groq",
            "translation",
            reqwest::StatusCode::UNAUTHORIZED,
            "Groq API key is required",
            None,
        ));
    }
    let llm = resolve_groq_llm(llm_model.as_deref());
    let translated_text = groq_translate(&api_key, &source_language, &target_language, &text, &llm)
        .await
        .map_err(|e| wrap_provider_error("groq", "translation", e))?;
    Ok(ProviderResult {
        source_text: text,
        translated_text,
    })
}

#[tauri::command]
pub async fn cloudflare_translate_text(
    account_id: String,
    api_token: String,
    source_language: String,
    target_language: String,
    text: String,
    llm_model: Option<String>,
) -> Result<ProviderResult, String> {
    if account_id.trim().is_empty() || api_token.trim().is_empty() {
        return Err(provider_error_json(
            "cloudflare",
            "translation",
            reqwest::StatusCode::UNAUTHORIZED,
            "Cloudflare account ID and API token are required",
            None,
        ));
    }
    let llm = resolve_cloudflare_llm(llm_model.as_deref());
    let translated_text = cloudflare_translate(
        &account_id,
        &api_token,
        &source_language,
        &target_language,
        &text,
        &llm,
    )
    .await
    .map_err(|e| wrap_provider_error("cloudflare", "translation", e))?;
    Ok(ProviderResult {
        source_text: text,
        translated_text,
    })
}

#[tauri::command]
pub async fn openrouter_translate_text(
    api_key: String,
    source_language: String,
    target_language: String,
    text: String,
    llm_model: Option<String>,
) -> Result<ProviderResult, String> {
    if api_key.trim().is_empty() {
        return Err(provider_error_json(
            "openrouter",
            "translation",
            reqwest::StatusCode::UNAUTHORIZED,
            "OpenRouter API key is required",
            None,
        ));
    }
    let model = resolve_model(llm_model.as_deref(), OPENROUTER_CHAT_MODEL);
    let translated_text =
        openrouter_translate(&api_key, &source_language, &target_language, &text, &model)
            .await
            .map_err(|e| wrap_provider_error("openrouter", "translation", e))?;
    Ok(ProviderResult {
        source_text: text,
        translated_text,
    })
}

fn wrap_provider_error(provider: &str, capability: &str, err: String) -> String {
    if err.trim().starts_with('{') {
        return err;
    }
    let lower = err.to_ascii_lowercase();
    let code = err
        .rsplit("HTTP ")
        .next()
        .and_then(|rest| rest.chars().take(3).collect::<String>().parse::<u16>().ok())
        .or_else(|| {
            ["429", "408", "401", "403", "400", "500", "502", "503"]
                .iter()
                .find(|s| err.contains(*s))
                .and_then(|s| s.parse().ok())
        })
        .or_else(|| {
            if lower.contains("quota") || lower.contains("rate limit") {
                Some(429)
            } else {
                None
            }
        })
        .unwrap_or(500);
    let status = reqwest::StatusCode::from_u16(code).unwrap_or(reqwest::StatusCode::INTERNAL_SERVER_ERROR);
    provider_error_json(provider, capability, status, &err, None)
}

fn assemblyai_token_url(region: &str) -> &'static str {
    match region.trim().to_ascii_lowercase().as_str() {
        "us" => "https://streaming.us.assemblyai.com/v3/token",
        "eu" => "https://streaming.eu.assemblyai.com/v3/token",
        _ => "https://streaming.assemblyai.com/v3/token",
    }
}

#[derive(Serialize)]
pub struct AssemblyaiTokenResult {
    pub token: String,
}

#[tauri::command]
pub async fn assemblyai_streaming_token(
    api_key: Option<String>,
    region: Option<String>,
    state: tauri::State<'_, crate::settings::SettingsState>,
) -> Result<AssemblyaiTokenResult, String> {
    let key = match api_key.filter(|k| !k.trim().is_empty()) {
        Some(k) => k,
        None => {
            let settings = state
                .0
                .lock()
                .map_err(|e| format!("Lock error: {e}"))?;
            settings.assemblyai_api_key.clone()
        }
    };
    if key.trim().is_empty() {
        return Err(provider_error_json(
            "assemblyai",
            "stt",
            reqwest::StatusCode::UNAUTHORIZED,
            "AssemblyAI API key is required",
            None,
        ));
    }
    let region = region.unwrap_or_else(|| {
        state
            .0
            .lock()
            .ok()
            .map(|s| s.assemblyai_region.clone())
            .unwrap_or_else(|| "global".into())
    });
    mint_assemblyai_token(&key, &region).await
}

async fn mint_assemblyai_token(api_key: &str, region: &str) -> Result<AssemblyaiTokenResult, String> {
    let url = format!("{}?expires_in_seconds=60", assemblyai_token_url(region));
    let resp = http()
        .get(&url)
        .header("Authorization", api_key.trim())
        .send()
        .await
        .map_err(|e| {
            provider_error_json(
                "assemblyai",
                "stt",
                reqwest::StatusCode::REQUEST_TIMEOUT,
                &format!("AssemblyAI token request failed: {e}"),
                None,
            )
        })?;
    let status = resp.status();
    let retry = retry_after_ms(resp.headers());
    let body = resp.text().await.map_err(|e| e.to_string())?;
    if !status.is_success() {
        let message = http_error_status(status, &body);
        return Err(provider_error_json(
            "assemblyai",
            "stt",
            status,
            &message,
            retry,
        ));
    }
    let parsed: serde_json::Value =
        serde_json::from_str(&body).map_err(|e| format!("AssemblyAI token JSON: {e}"))?;
    let token = parsed
        .get("token")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim()
        .to_string();
    if token.is_empty() {
        return Err(provider_error_json(
            "assemblyai",
            "stt",
            reqwest::StatusCode::BAD_GATEWAY,
            "AssemblyAI token mint returned empty token",
            None,
        ));
    }
    Ok(AssemblyaiTokenResult { token })
}

#[tauri::command]
pub async fn assemblyai_ping(api_key: String, region: Option<String>) -> Result<bool, String> {
    if api_key.trim().is_empty() {
        return Ok(false);
    }
    mint_assemblyai_token(&api_key, region.as_deref().unwrap_or("global")).await?;
    Ok(true)
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

#[tauri::command]
pub async fn azure_translate_text(
    subscription_key: String,
    region: String,
    endpoint: Option<String>,
    source_language: String,
    target_language: String,
    text: String,
) -> Result<ProviderResult, String> {
    if subscription_key.trim().is_empty() {
        return Err("Azure Translator subscription key is required".into());
    }
    if text.trim().is_empty() {
        return Ok(ProviderResult {
            source_text: String::new(),
            translated_text: String::new(),
        });
    }

    let translated_text = azure_translate(
        &subscription_key,
        &region,
        endpoint.as_deref().unwrap_or(AZURE_TRANSLATOR_ENDPOINT),
        &source_language,
        &target_language,
        &text,
    )
    .await?;

    Ok(ProviderResult {
        source_text: text,
        translated_text,
    })
}

#[tauri::command]
pub async fn gemini_translate_text(
    api_key: String,
    source_language: String,
    target_language: String,
    text: String,
    model: Option<String>,
) -> Result<ProviderResult, String> {
    if api_key.trim().is_empty() {
        return Err("Gemini API key is required".into());
    }
    if text.trim().is_empty() {
        return Ok(ProviderResult {
            source_text: String::new(),
            translated_text: String::new(),
        });
    }

    let model_name = resolve_model(model.as_deref(), GEMINI_DEFAULT_MODEL);

    let translated_text = gemini_translate(
        &api_key,
        &source_language,
        &target_language,
        &text,
        &model_name,
    )
    .await?;

    Ok(ProviderResult {
        source_text: text,
        translated_text,
    })
}

#[tauri::command]
pub async fn ollama_translate_text(
    base_url: String,
    model_name: String,
    source_language: String,
    target_language: String,
    text: String,
) -> Result<ProviderResult, String> {
    if base_url.trim().is_empty() {
        return Err("Ollama base URL is required".into());
    }
    if model_name.trim().is_empty() {
        return Err("Ollama model name is required".into());
    }
    if text.trim().is_empty() {
        return Ok(ProviderResult {
            source_text: String::new(),
            translated_text: String::new(),
        });
    }

    let translated_text = ollama_translate(
        &base_url,
        &model_name,
        &source_language,
        &target_language,
        &text,
    )
    .await?;

    Ok(ProviderResult {
        source_text: text,
        translated_text,
    })
}

#[tauri::command]
pub async fn azure_translator_ping(
    subscription_key: String,
    region: String,
    endpoint: Option<String>,
) -> Result<bool, String> {
    if subscription_key.trim().is_empty() {
        return Err("Azure Translator subscription key is required".into());
    }
    // Must use different languages so the request actually hits Azure
    azure_translate(
        &subscription_key,
        &region,
        endpoint.as_deref().unwrap_or(AZURE_TRANSLATOR_ENDPOINT),
        "en",
        "vi",
        "Hello",
    )
    .await?;
    Ok(true)
}

async fn gemini_get(url: Url) -> Result<(reqwest::StatusCode, String), String> {
    let resp = http()
        .get(url.as_str())
        .send()
        .await
        .map_err(|_| "Gemini ping failed".to_string())?;
    let status = resp.status();
    let body = resp.text().await.unwrap_or_default();
    Ok((status, body))
}

fn gemini_error_message(status: reqwest::StatusCode, body: &str, model_id: &str) -> String {
    let code = status.as_u16();
    let api_msg = serde_json::from_str::<serde_json::Value>(body)
        .ok()
        .and_then(|v| {
            v.pointer("/error/message")
                .and_then(|m| m.as_str())
                .map(|s| s.chars().take(120).collect::<String>())
        })
        .unwrap_or_default();
    match code {
        401 | 403 => {
            if api_msg.is_empty() {
                "Gemini: Invalid API key".into()
            } else {
                format!("Gemini: {api_msg}")
            }
        }
        404 => format!(
            "Gemini: Model '{model_id}' not found — try gemini-3.1-flash-lite or gemini-flash-lite-latest"
        ),
        429 => "Gemini: Rate limit exceeded (quota exhausted)".into(),
        400 => {
            if api_msg.is_empty() {
                "Gemini: Invalid request".into()
            } else {
                format!("Gemini: {api_msg}")
            }
        }
        500..=599 => "Gemini: Service unavailable".into(),
        _ => {
            if api_msg.is_empty() {
                format!("Gemini error ({code})")
            } else {
                format!("Gemini: {api_msg}")
            }
        }
    }
}

#[tauri::command]
pub async fn gemini_ping(api_key: String, model: Option<String>) -> Result<bool, String> {
    if api_key.trim().is_empty() {
        return Err("Gemini API key is required".into());
    }

    let model_name = resolve_model(model.as_deref(), GEMINI_DEFAULT_MODEL);
    let model_id = gemini_model_id(&model_name);
    let lookup = gemini_url_with_key(&gemini_model_lookup_url(model_id), &api_key)?;
    let (status, body) = gemini_get(lookup).await?;
    if status.is_success() {
        return Ok(true);
    }
    if status.as_u16() == 404 {
        let list = gemini_url_with_key(gemini_models_list_url(), &api_key)?;
        let (list_status, _) = gemini_get(list).await?;
        if list_status.is_success() {
            return Err(format!(
                "Gemini: Model '{model_id}' not found — try gemini-flash-lite-latest"
            ));
        }
        if list_status.as_u16() == 401 || list_status.as_u16() == 403 {
            return Err("Gemini: Invalid API key".into());
        }
    }
    Err(gemini_error_message(status, &body, model_id))
}

#[tauri::command]
pub async fn ollama_health_check(base_url: String) -> Result<serde_json::Value, String> {
    if base_url.trim().is_empty() {
        return Err("Ollama base URL is required".into());
    }

    let url = format!("{}/api/tags", base_url.trim_end_matches('/'));

    let resp = http()
        .get(&url)
        .send()
        .await
        .map_err(|e| format!("Ollama health check failed: {e}"))?;

    if !resp.status().is_success() {
        return Err(format!("Ollama returned {}", resp.status().as_u16()));
    }

    let body = resp.text().await.map_err(|e| e.to_string())?;
    let parsed: serde_json::Value =
        serde_json::from_str(&body).map_err(|e| format!("Ollama health check JSON: {e}"))?;

    Ok(parsed)
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

    #[test]
    fn resolve_groq_llm_keeps_allowed_vendor_ids() {
        assert_eq!(
            resolve_groq_llm(Some("openai/gpt-oss-20b")),
            "openai/gpt-oss-20b"
        );
        assert_eq!(
            resolve_groq_llm(Some("llama-3.1-8b-instant")),
            "openai/gpt-oss-120b"
        );
        assert_eq!(
            resolve_groq_llm(Some("meta-llama/llama-prompt-guard-2-22m")),
            "openai/gpt-oss-120b"
        );
    }

    #[test]
    fn groq_qwen_payload_disables_reasoning() {
        let payload = groq_translate_payload("qwen/qwen3.6-27b", "en", "ro", "hello");
        assert_eq!(payload["reasoning_effort"], "none");
        assert_eq!(payload["reasoning_format"], "hidden");
        assert!(payload.get("temperature").is_none());
        let gpt = groq_translate_payload("openai/gpt-oss-20b", "en", "ro", "hello");
        assert_eq!(gpt["temperature"], 0.6);
        assert_eq!(gpt["reasoning_effort"], "low");
        assert_eq!(gpt["include_reasoning"], false);
        assert_eq!(gpt["messages"][0]["role"], "user");
        assert_eq!(gpt["messages"].as_array().map(|a| a.len()), Some(1));
        let gpt120 = groq_translate_payload("openai/gpt-oss-120b", "en", "ro", "hello");
        assert_eq!(gpt120["reasoning_effort"], "low");
        assert_eq!(gpt120["include_reasoning"], false);
    }

    #[test]
    fn groq_message_text_prefers_content_then_reasoning() {
        let parsed = serde_json::json!({
            "choices": [{ "message": { "content": "<think>x</think> salut" } }]
        });
        assert_eq!(groq_message_text(&parsed), "salut");
        let reasoned = serde_json::json!({
            "choices": [{ "message": { "content": "", "reasoning_content": "salut" } }]
        });
        assert_eq!(groq_message_text(&reasoned), "salut");
    }

    #[test]
    fn resolve_cloudflare_llm_keeps_allowed_chat_ids() {
        assert_eq!(
            resolve_cloudflare_llm(Some("@cf/meta/llama-3.1-8b-instruct-fp8-fast")),
            "@cf/meta/llama-3.1-8b-instruct-fp8-fast"
        );
        assert_eq!(
            resolve_cloudflare_llm(Some("@cf/qwen/qwen3-30b-a3b-fp8")),
            "@cf/qwen/qwen3-30b-a3b-fp8"
        );
        assert_eq!(
            resolve_cloudflare_llm(Some("@cf/meta/m2m100-1.2b")),
            "@cf/meta/llama-3.1-8b-instruct-fp8-fast"
        );
        assert_eq!(
            resolve_cloudflare_llm(Some("@cf/meta/llama-3.1-8b-instruct-fast")),
            "@cf/meta/llama-3.1-8b-instruct-fp8-fast"
        );
    }

    #[test]
    fn cloudflare_translate_payload_is_chat_messages() {
        let chat = cloudflare_translate_payload("en", "ro", "hello");
        assert!(chat.get("messages").is_some());
        assert!(chat.get("text").is_none());
    }

    #[test]
    fn cloudflare_translated_text_reads_m2m_and_chat_shapes() {
        let m2m = serde_json::json!({ "result": { "translated_text": "salut" } });
        assert_eq!(cloudflare_translated_text(&m2m), "salut");
        let chat = serde_json::json!({ "result": { "response": "salut" } });
        assert_eq!(cloudflare_translated_text(&chat), "salut");
    }

    #[test]
    fn map_language_to_azure_supports_common_codes() {
        assert_eq!(map_language_to_azure("vi"), Some("vi".to_string()));
        assert_eq!(map_language_to_azure("en"), Some("en".to_string()));
        assert_eq!(map_language_to_azure("zh"), Some("zh-Hans".to_string()));
        assert_eq!(map_language_to_azure("zh-tw"), Some("zh-Hant".to_string()));
        assert_eq!(map_language_to_azure("pt-br"), Some("pt-BR".to_string()));
    }

    #[test]
    fn map_language_to_azure_skips_auto() {
        assert_eq!(map_language_to_azure("auto"), None);
        assert_eq!(map_language_to_azure(""), None);
    }

    #[test]
    fn map_language_to_azure_passes_through_unknown() {
        assert_eq!(
            map_language_to_azure("unknown"),
            Some("unknown".to_string())
        );
    }

    #[test]
    fn azure_translate_url_builds_global_endpoint_query() {
        let url = azure_translate_url(AZURE_TRANSLATOR_ENDPOINT, Some("en"), "ro").unwrap();
        assert_eq!(url.path(), "/translate");
        assert_eq!(
            url.query_pairs()
                .find(|(k, _)| k == "api-version")
                .unwrap()
                .1,
            "3.0"
        );
        assert_eq!(
            url.query_pairs().find(|(k, _)| k == "from").unwrap().1,
            "en"
        );
        assert_eq!(url.query_pairs().find(|(k, _)| k == "to").unwrap().1, "ro");
    }

    #[test]
    fn azure_translate_url_supports_custom_resource_root() {
        let url =
            azure_translate_url("https://example.cognitiveservices.azure.com", None, "fr").unwrap();
        assert_eq!(url.path(), "/translator/text/v3.0/translate");
        assert!(!url.query_pairs().any(|(k, _)| k == "from"));
    }

    #[test]
    fn azure_translate_url_rejects_non_azure_hosts() {
        let error = azure_translate_url("https://example.com", Some("en"), "ro").unwrap_err();
        assert!(error.contains("not an Azure Translator host"));
    }

    #[test]
    fn azure_region_is_optional_for_global_resources() {
        assert_eq!(azure_region_header(""), None);
        assert_eq!(azure_region_header("global"), None);
        assert_eq!(azure_region_header(" eastus "), Some("eastus"));
    }

    #[test]
    fn gemini_ping_looks_up_model_without_generate_content() {
        let url = gemini_model_lookup_url("models/gemini-3.1-flash-lite");
        assert_eq!(
            url,
            "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-lite"
        );
        assert!(!url.contains("generateContent"));
        assert!(!url.contains("key="));
        assert_eq!(
            gemini_models_list_url(),
            "https://generativelanguage.googleapis.com/v1beta/models"
        );
    }

    #[test]
    fn assemblyai_token_url_uses_region_hosts() {
        assert!(assemblyai_token_url("eu").contains("streaming.eu.assemblyai.com"));
        assert!(assemblyai_token_url("us").contains("streaming.us.assemblyai.com"));
        assert_eq!(
            assemblyai_token_url("global"),
            "https://streaming.assemblyai.com/v3/token"
        );
        assert!(!assemblyai_token_url("eu").contains("token="));
    }

    #[test]
    fn wrap_provider_error_keeps_json_and_redacts_status() {
        let json = wrap_provider_error("groq", "stt", r#"{"kind":"quota","status":429}"#.into());
        assert!(json.contains("quota"));
        let wrapped = wrap_provider_error("groq", "stt", "HTTP 429".into());
        assert!(wrapped.contains("\"status\":429"));
        assert!(!wrapped.to_lowercase().contains("authorization"));
        let quota_msg = wrap_provider_error(
            "groq",
            "translation",
            "Quota exhausted: You exceeded your current quota".into(),
        );
        assert!(quota_msg.contains("\"status\":429"));
        assert!(quota_msg.contains("\"kind\":\"quota\""));
    }
}
