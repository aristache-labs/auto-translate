# Provider Fallback Architecture Implementation Plan

## Status: All Phases Completed ✅

### Completed Components

#### 1. JavaScript Provider Adapters & Orchestration
- `src/js/provider-orchestrator.js` — Core provider chain management, HTTP error classification (temporary, config, quota, unsupported), circuit breaker logic with `Retry-After` parsing, session-sticky provider selection, secret redaction & error sanitization.
- `src/js/azure-translator.js` — Azure AI Translator Text REST API adapter with language code mapping (25+ languages), validation, key protection, and connection testing.
- `src/js/gemini-translator.js` — Gemini text translation adapter enforcing structured translation-only output (removing explanations/markdown), treating quota exhaustion (429) as temporary outage, using `gemini-2.0-flash`.
- `src/js/ollama-translator.js` — Local Ollama translation adapter enforcing loopback host security (`127.0.0.1`, `localhost`, `[::1]`), health check with bounded timeout, single-line response normalization.

#### 2. Main Application Integration (`src/js/app.js`)
- Connected `provider-orchestrator.js` into `src/js/app.js` workflow.
- Wired Azure, Gemini, and Ollama settings form population, saving, and testing methods into `app.js`.
- Implemented `_updateChainUI()` to render effective STT & Translation chains dynamically based on active settings.
- Added circuit breaker reset functionality via `#btn-reset-circuit-breaker`.
- Added sanitized error toasts (suppressing duplicate toasts per outage event within 5s window) and diagnostic logging (`logProviderTransition`).
- Session cleanup resets sticky state via `clearSessionState()` upon stopping or state restoration.

#### 3. Settings UI Expansion (`src/index.html`)
- Added HTML settings sections for Azure AI Translator Text (`#section-azure-key`), Gemini (`#section-gemini-key`), Local Ollama (`#section-ollama-config`), and Provider Fallback Chains (`#section-provider-fallback`).
- Added test buttons, credential inputs, checkboxes, and endpoint fields for all providers.
- Displayed live effective STT and Translation chains.
- Added manual Circuit Breakers Reset button.
- Updated default Groq LLM model select to `openai/gpt-oss-20b` and Cloudflare LLM model select to `@cf/meta/llama-3.1-8b-instruct-fast`.

#### 4. Settings & Migrations (`src/js/settings.js`)
- Updated `DEFAULT_SETTINGS` with 10 new provider keys (`azure_translator_enabled`, `azure_translator_key`, `azure_translator_region`, `azure_translator_endpoint`, `gemini_enabled`, `gemini_api_key`, `gemini_model`, `ollama_enabled`, `ollama_base_url`, `ollama_model`, `local_stt_enabled`).
- Implemented `_migrateModelDefaults()`:
  - Groq LLM: `llama-3.1-8b-instant` → `openai/gpt-oss-20b` (via OpenRouter)
  - Cloudflare LLM: `@cf/meta/llama-3.1-8b-instruct` → `@cf/meta/llama-3.1-8b-instruct-fast`
  - Preserves custom user model selections while migrating deprecated defaults.

#### 5. Rust Backend Integration (`src-tauri/src/commands/providers.rs`)
- Added Rust backend implementations and Tauri commands:
  - `azure_translate_text` / `azure_translator_ping` with language code mapping.
  - `gemini_translate_text` / `gemini_ping` with structured translation prompt.
  - `ollama_translate_text` / `ollama_health_check`.
  - Proper HTTP error status handling and secret protection.
  - Rust compilation verified (`cargo check --lib` passes clean).

#### 6. Test Suites & Verification
- `tests/provider-orchestrator.test.js` — Unit tests for error classification, circuit breaker, error sanitization, and STT/Translation chain resolution.
- `tests/azure-translator.test.js` — Tests for Azure translation adapter, language mapping, error handling.
- `tests/gemini-translator.test.js` — Tests for Gemini translation adapter, prompt normalization, rate-limit classification.
- `tests/ollama-translator.test.js` — Tests for Ollama loopback host security, health checks, model resolution.
- `tests/app-integration.test.js` — Integration tests for deprecated model default migration, effective chain filtering, single flight fallback execution, circuit breaker reset, error sanitization, and session state cleanup.
- All 39 JavaScript unit & integration tests passing (`npm test`).

---

### Model Defaults Updated
- **Groq LLM default**: `openai/gpt-oss-20b` (via OpenRouter)
- **Groq STT default**: `whisper-large-v3-turbo` (preserved)
- **Cloudflare LLM default**: `@cf/meta/llama-3.1-8b-instruct-fast`
- **Cloudflare STT default**: `@cf/openai/whisper-large-v3-turbo` (preserved)

---

### Architecture Overview

**STT Chain:**
`Groq → Cloudflare Workers AI → Local STT`

**Text Translation Chain:**
`OpenRouter → Same as active STT engine → Azure AI Translator Text → Gemini → Local Ollama`
