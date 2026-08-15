/**
 * Provider Orchestrator — manages translation provider chains with fallback logic
 * 
 * Handles:
 * - Provider chain sequencing (OpenRouter → STT engine → Azure → Gemini → Ollama)
 * - Circuit breaker for quota exhaustion (HTTP 429)
 * - Retry logic for temporary failures
 * - Error classification and sanitization
 * - Session-sticky provider selection
 */

const PROVIDER_CHAINS = {
  stt: ['groq', 'cloudflare', 'local'],
  translation: ['openrouter', 'stt-engine', 'azure', 'gemini', 'ollama'],
};

// Error classification
const ERROR_TYPES = {
  TEMPORARY: 'temporary',      // Retry-able: 408, 429, 5xx, timeout
  CONFIG: 'config',            // Not retry-able: 400, 401, 403, invalid key
  QUOTA: 'quota',              // Circuit breaker: 429 with Retry-After
  UNSUPPORTED: 'unsupported',  // Provider unavailable on this platform
};

// Circuit breaker state per provider
const circuitBreakers = new Map();

// Session-sticky provider selection
let sessionStickyProvider = null;

/**
 * Classify an error from a provider response
 */
export function classifyError(status, body, provider) {
  if (status === 429) return ERROR_TYPES.QUOTA;
  if (status === 408 || (status >= 500 && status < 600)) return ERROR_TYPES.TEMPORARY;
  if (status === 400 || status === 401 || status === 403) return ERROR_TYPES.CONFIG;
  if (provider === 'local' && status === null) return ERROR_TYPES.UNSUPPORTED;
  return ERROR_TYPES.TEMPORARY;
}

/**
 * Extract Retry-After header or calculate reset time for quota exhaustion
 */
export function getRetryAfter(headers, status) {
  if (status !== 429) return null;
  
  const retryAfter = headers?.['retry-after'] || headers?.['x-ratelimit-reset'];
  if (!retryAfter) return Date.now() + 60000; // Default: 1 minute
  
  // Try parsing as seconds
  const seconds = parseInt(retryAfter, 10);
  if (!isNaN(seconds)) {
    return Date.now() + seconds * 1000;
  }
  
  // Try parsing as HTTP date
  const resetTime = new Date(retryAfter).getTime();
  return !isNaN(resetTime) ? resetTime : Date.now() + 60000;
}

/**
 * Check if a provider is currently blocked by circuit breaker
 */
export function isCircuitBreakerOpen(provider) {
  const state = circuitBreakers.get(provider);
  if (!state) return false;
  
  if (state.resetTime && Date.now() < state.resetTime) {
    return true;
  }
  
  circuitBreakers.delete(provider);
  return false;
}

/**
 * Open the circuit breaker for a provider until resetTime
 */
export function openCircuitBreaker(provider, resetTime) {
  circuitBreakers.set(provider, { resetTime });
}

/**
 * Reset circuit breaker state (manual reset button)
 */
export function resetCircuitBreaker(provider) {
  circuitBreakers.delete(provider);
}

/**
 * Sanitize error message for UI display (redact provider response details)
 */
export function sanitizeErrorMessage(error, provider) {
  if (!error) return 'Unknown error';
  
  const msg = typeof error === 'string' ? error : error.message || String(error);
  
  // Redact API keys, full responses, account identifiers
  return msg
    .replace(/key['\"]?\s*[:=]\s*['\"][^'\"]*['\"]/gi, 'key="***"')
    .replace(/token['\"]?\s*[:=]\s*['\"][^'\"]*['\"]/gi, 'token="***"')
    .replace(/authorization['\"]?\s*[:=]\s*bearer\s+\S+/gi, 'authorization="***"')
    .substring(0, 200);
}

/**
 * Format a user-facing error notification
 */
export function formatErrorNotification(provider, errorType, isRetrying = false) {
  const messages = {
    [ERROR_TYPES.QUOTA]: {
      openrouter: 'OpenRouter daily quota exhausted',
      gemini: 'Gemini API quota exhausted',
      groq: 'Groq rate limit exceeded',
      cloudflare: 'Cloudflare quota exceeded',
    },
    [ERROR_TYPES.CONFIG]: {
      openrouter: 'OpenRouter API key is invalid or missing',
      gemini: 'Gemini API key is invalid or missing',
      groq: 'Groq API key is invalid or missing',
      cloudflare: 'Cloudflare credentials are invalid or missing',
      azure: 'Azure Translator key is invalid or missing',
    },
    [ERROR_TYPES.UNSUPPORTED]: {
      local: 'Local STT not available on this platform',
      ollama: 'Ollama is not running or not reachable',
    },
  };
  
  const base = messages[errorType]?.[provider] || `${provider} is temporarily unavailable`;
  return isRetrying ? `${base}. Retrying...` : base;
}

/**
 * Get effective translation chain based on settings
 */
export function getEffectiveTranslationChain(settings, sttProvider) {
  const chain = [];
  
  // OpenRouter (if enabled and has key)
  if (settings.openrouter_enabled !== false && settings.openrouter_api_key) {
    chain.push('openrouter');
  }
  
  // Same as STT engine
  if (sttProvider === 'groq' && settings.groq_llm_model) {
    chain.push('groq-llm');
  } else if (sttProvider === 'cloudflare' && settings.cloudflare_llm_model) {
    chain.push('cloudflare-llm');
  }
  
  // Azure Translator (if enabled and has key)
  if (settings.azure_translator_enabled && settings.azure_translator_key) {
    chain.push('azure');
  }
  
  // Gemini (if enabled and has key)
  if (settings.gemini_enabled && settings.gemini_api_key) {
    chain.push('gemini');
  }
  
  // Ollama (if enabled and configured)
  if (settings.ollama_enabled && settings.ollama_model) {
    chain.push('ollama');
  }
  
  return chain;
}

/**
 * Get effective STT chain based on settings
 */
export function getEffectiveSTTChain(settings) {
  const chain = [];
  
  if (settings.groq_enabled !== false && settings.groq_api_key) {
    chain.push('groq');
  }
  
  if (settings.cloudflare_enabled !== false && settings.cloudflare_account_id && settings.cloudflare_api_token) {
    chain.push('cloudflare');
  }
  
  if (settings.local_stt_enabled) {
    chain.push('local');
  }
  
  return chain;
}

/**
 * Set session-sticky provider (remains until session ends)
 */
export function setSessionStickyProvider(provider) {
  sessionStickyProvider = provider;
}

/**
 * Get session-sticky provider
 */
export function getSessionStickyProvider() {
  return sessionStickyProvider;
}

/**
 * Clear session-sticky provider when session ends
 */
export function clearSessionState() {
  sessionStickyProvider = null;
}

/**
 * Log provider transition (internal diagnostics, no secrets)
 */
export function logProviderTransition(from, to, reason) {
  const timestamp = new Date().toISOString();
  console.debug(`[Provider] ${timestamp} transitioning from ${from} to ${to}: ${reason}`);
}

export { ERROR_TYPES, PROVIDER_CHAINS };

export default {
  classifyError,
  getRetryAfter,
  isCircuitBreakerOpen,
  openCircuitBreaker,
  resetCircuitBreaker,
  sanitizeErrorMessage,
  formatErrorNotification,
  getEffectiveTranslationChain,
  getEffectiveSTTChain,
  setSessionStickyProvider,
  getSessionStickyProvider,
  clearSessionState,
  logProviderTransition,
  ERROR_TYPES,
  PROVIDER_CHAINS,
};
