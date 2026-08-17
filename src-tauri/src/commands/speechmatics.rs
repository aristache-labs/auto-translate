use super::http_client;
use serde::{Deserialize, Serialize};

const TOKEN_URL: &str = "https://mp.speechmatics.com/v1/api_keys?type=rt";
const DEFAULT_TTL: u32 = 3600;

#[derive(Debug, Serialize, Deserialize)]
pub struct SpeechmaticsTokenResult {
    pub token: String,
}

fn provider_error_json(
    capability: &str,
    status: reqwest::StatusCode,
    message: &str,
) -> String {
    let code = status.as_u16();
    let kind = match code {
        429 => "quota",
        400 | 401 | 403 | 404 | 410 => "config",
        408 | 500..=599 => "temporary",
        _ => "temporary",
    };
    serde_json::json!({
        "provider": "speechmatics",
        "capability": capability,
        "kind": kind,
        "status": code,
        "message": message,
    })
    .to_string()
}

async fn mint_speechmatics_token(api_key: &str, ttl: u32) -> Result<SpeechmaticsTokenResult, String> {
    let ttl = ttl.clamp(60, 3600);
    let resp = http_client::shared()
        .post(TOKEN_URL)
        .bearer_auth(api_key.trim())
        .header("Content-Type", "application/json")
        .json(&serde_json::json!({ "ttl": ttl }))
        .send()
        .await
        .map_err(|e| {
            provider_error_json(
                "stt",
                reqwest::StatusCode::REQUEST_TIMEOUT,
                &format!("Speechmatics token request failed: {e}"),
            )
        })?;
    let status = resp.status();
    let body = resp.text().await.map_err(|e| e.to_string())?;
    if !status.is_success() {
        let short: String = body.chars().take(140).collect();
        return Err(provider_error_json(
            "stt",
            status,
            &format!("Speechmatics token mint failed (HTTP {}): {short}", status.as_u16()),
        ));
    }
    let parsed: serde_json::Value =
        serde_json::from_str(&body).map_err(|e| format!("Speechmatics token JSON: {e}"))?;
    let token = parsed
        .get("key_value")
        .or_else(|| parsed.get("token"))
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim()
        .to_string();
    if token.is_empty() {
        return Err(provider_error_json(
            "stt",
            reqwest::StatusCode::BAD_GATEWAY,
            "Speechmatics token mint returned empty token",
        ));
    }
    Ok(SpeechmaticsTokenResult { token })
}

fn key_from_state(
    api_key: Option<String>,
    state: &tauri::State<'_, crate::settings::SettingsState>,
) -> Result<String, String> {
    if let Some(k) = api_key.filter(|k| !k.trim().is_empty()) {
        return Ok(k);
    }
    let settings = state
        .0
        .lock()
        .map_err(|e| format!("Lock error: {e}"))?;
    Ok(settings.speechmatics_api_key.clone())
}

#[tauri::command]
pub async fn speechmatics_rt_token(
    api_key: Option<String>,
    ttl: Option<u32>,
    state: tauri::State<'_, crate::settings::SettingsState>,
) -> Result<SpeechmaticsTokenResult, String> {
    let key = key_from_state(api_key, &state)?;
    if key.trim().is_empty() {
        return Err(provider_error_json(
            "stt",
            reqwest::StatusCode::UNAUTHORIZED,
            "Speechmatics API key is required",
        ));
    }
    mint_speechmatics_token(&key, ttl.unwrap_or(DEFAULT_TTL)).await
}

#[tauri::command]
pub async fn speechmatics_ping(api_key: String) -> Result<bool, String> {
    if api_key.trim().is_empty() {
        return Ok(false);
    }
    mint_speechmatics_token(&api_key, 60).await?;
    Ok(true)
}
