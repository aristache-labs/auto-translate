/**
 * Provider orchestrator — STT and translation chains, circuit breakers, structured errors.
 */

export const STT_CHAIN_DEFAULT = ['assemblyai', 'groq', 'cloudflare', 'local-stt'];

export const ERROR_TYPES = {
  TEMPORARY: 'temporary',
  CONFIG: 'config',
  QUOTA: 'quota',
  UNSUPPORTED: 'unsupported',
  INTENTIONAL: 'intentional',
};

export const ERROR_KINDS = ERROR_TYPES;

export const PROVIDER_CHAINS = {
  stt: STT_CHAIN_DEFAULT,
  translation: ['openrouter', 'stt-engine', 'azure', 'gemini', 'ollama'],
};

const MIN_DWELL_MS = 8000;
const DEFAULT_QUOTA_MS = 60_000;
const CONFIG_UNAVAILABLE_MS = 24 * 60 * 60 * 1000;

const circuitBreakers = new Map();
let sessionStickyProvider = null;
let lastSttTransitionAt = 0;
let nowFn = () => Date.now();

export function setNowFn(fn) {
  nowFn = typeof fn === 'function' ? fn : () => Date.now();
}

function now() {
  return nowFn();
}

export function breakerKey(capability, provider) {
  const id = String(provider || '')
    .replace(/-llm$/, '')
    .replace(/^local-stt$/, 'local');
  return `${capability}:${id}`;
}

export function classifyError(status, body, provider) {
  if (status === 429) return ERROR_TYPES.QUOTA;
  if (status === 408 || (status >= 500 && status < 600)) return ERROR_TYPES.TEMPORARY;
  if (status === 400 || status === 401 || status === 403) return ERROR_TYPES.CONFIG;
  if ((provider === 'local' || provider === 'local-stt') && status === null) {
    return ERROR_TYPES.UNSUPPORTED;
  }
  const text = typeof body === 'string' ? body : '';
  if (/intentional|terminated by user/i.test(text)) return ERROR_TYPES.INTENTIONAL;
  return ERROR_TYPES.TEMPORARY;
}

export function getRetryAfter(headers, status) {
  if (status !== 429) return null;
  const retryAfter = headers?.['retry-after'] || headers?.['x-ratelimit-reset'] || headers?.retryAfter;
  if (!retryAfter) return now() + DEFAULT_QUOTA_MS;
  const seconds = parseInt(retryAfter, 10);
  if (!Number.isNaN(seconds)) return now() + seconds * 1000;
  const resetTime = new Date(retryAfter).getTime();
  return !Number.isNaN(resetTime) ? resetTime : now() + DEFAULT_QUOTA_MS;
}

export function parseProviderError(error, defaults = {}) {
  let parsed = null;
  if (error && typeof error === 'object' && !Array.isArray(error)) {
    parsed = error;
  }
  const raw = typeof error === 'string'
    ? error
    : (error?.payload || error?.message || String(error || 'Unknown error'));
  if (!parsed && typeof raw === 'string') {
    const trimmed = raw.trim();
    if (trimmed.startsWith('{')) {
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        parsed = null;
      }
    }
  }

  const statusFromText = (() => {
    const match = String(raw).match(/\bHTTP\s+(\d{3})\b/i) || String(raw).match(/\b(429|408|401|403|400|500|502|503)\b/);
    return match ? Number(match[1] || match[0]) : null;
  })();

  const status = parsed?.status ?? parsed?.httpStatus ?? defaults.status ?? statusFromText;
  const provider = parsed?.provider || defaults.provider || 'unknown';
  const capability = parsed?.capability || defaults.capability || 'stt';
  const kind = parsed?.kind || classifyError(status, raw, provider);
  const retryAfterMs = parsed?.retryAfterMs ?? parsed?.retry_after_ms ?? null;
  const closeCode = parsed?.closeCode ?? parsed?.close_code ?? null;
  return {
    provider,
    capability,
    kind,
    status: status == null ? null : Number(status),
    retryAfterMs: retryAfterMs == null ? null : Number(retryAfterMs),
    closeCode,
    message: sanitizeErrorMessage(parsed?.message || raw, provider),
  };
}

export function createProviderError({
  provider,
  capability,
  kind,
  status = null,
  retryAfterMs = null,
  closeCode = null,
  message,
} = {}) {
  return {
    provider: provider || 'unknown',
    capability: capability || 'stt',
    kind: kind || ERROR_TYPES.TEMPORARY,
    status,
    retryAfterMs,
    closeCode,
    message: sanitizeErrorMessage(message, provider),
  };
}

function breakerState(key) {
  return circuitBreakers.get(key);
}

export function isCircuitBreakerOpen(providerOrKey) {
  const key = providerOrKey.includes(':') ? providerOrKey : providerOrKey;
  const state = breakerState(key);
  if (!state) return false;
  if (state.unavailable) return true;
  if (state.state === 'open' && now() < state.resetTime) return true;
  if (state.state === 'open' && now() >= state.resetTime) {
    state.state = 'half-open';
    state.probeUsed = false;
    return false;
  }
  if (state.state === 'half-open' && state.probeUsed) return true;
  return false;
}

export function openCircuitBreaker(providerOrKey, resetTime, options = {}) {
  const key = providerOrKey;
  circuitBreakers.set(key, {
    state: 'open',
    resetTime: resetTime || now() + DEFAULT_QUOTA_MS,
    probeUsed: false,
    unavailable: !!options.unavailable,
  });
}

export function isCircuitBreakerHalfOpen(providerOrKey) {
  const state = breakerState(providerOrKey);
  return state?.state === 'half-open' && !state.probeUsed;
}

export function noteHalfOpenProbe(providerOrKey) {
  const state = breakerState(providerOrKey);
  if (state?.state === 'half-open') state.probeUsed = true;
}

export function noteProviderSuccess(providerOrKey) {
  circuitBreakers.delete(providerOrKey);
}

export function applyProviderError(error) {
  const parsed = parseProviderError(error);
  const key = breakerKey(parsed.capability, parsed.provider);
  if (parsed.kind === ERROR_TYPES.INTENTIONAL) return parsed;
  if (parsed.kind === ERROR_TYPES.QUOTA) {
    const reset = parsed.retryAfterMs ? now() + parsed.retryAfterMs : now() + DEFAULT_QUOTA_MS;
    openCircuitBreaker(key, reset);
  } else if (parsed.kind === ERROR_TYPES.CONFIG || parsed.kind === ERROR_TYPES.UNSUPPORTED) {
    openCircuitBreaker(key, now() + CONFIG_UNAVAILABLE_MS, { unavailable: true });
  }
  return parsed;
}

export function resetCircuitBreaker(providerOrKey) {
  if (!providerOrKey) {
    resetAllCircuitBreakers();
    return;
  }
  circuitBreakers.delete(providerOrKey);
  if (!providerOrKey.includes(':')) {
    for (const prefix of ['stt', 'translation']) {
      circuitBreakers.delete(`${prefix}:${providerOrKey}`);
    }
  }
}

export function resetAllCircuitBreakers() {
  circuitBreakers.clear();
}

export function getCircuitBreakerStatuses() {
  const out = [];
  for (const [key, state] of circuitBreakers.entries()) {
    const remaining = state.unavailable
      ? null
      : Math.max(0, (state.resetTime || 0) - now());
    if (state.state === 'open' && !state.unavailable && remaining === 0) continue;
    out.push({
      key,
      state: state.unavailable ? 'unavailable' : state.state,
      remainingMs: remaining,
    });
  }
  return out;
}

export function sanitizeErrorMessage(error, _provider) {
  if (!error) return 'Unknown error';
  const msg = typeof error === 'string' ? error : error.message || String(error);
  return msg
    .replace(/key['"]?\s*[:=]\s*['"][^'"]*['"]/gi, 'key="***"')
    .replace(/token['"]?\s*[:=]\s*['"][^'"]*['"]/gi, 'token="***"')
    .replace(/authorization['"]?\s*[:=]\s*bearer\s+\S+/gi, 'authorization="***"')
    .replace(/Bearer\s+[A-Za-z0-9._\-]+/gi, 'Bearer ***')
    .replace(/sk-[A-Za-z0-9\-]+/g, '[redacted]')
    .replace(/gsk_[A-Za-z0-9]+/g, '[redacted]')
    .replace(/wss:\/\/[^\s"']+/gi, 'wss://***')
    .substring(0, 200);
}

export function formatErrorNotification(provider, errorType, isRetrying = false) {
  const messages = {
    [ERROR_TYPES.QUOTA]: {
      openrouter: 'OpenRouter daily quota exhausted',
      gemini: 'Gemini API quota exhausted',
      groq: 'Groq rate limit exceeded',
      cloudflare: 'Cloudflare quota exceeded',
      assemblyai: 'AssemblyAI rate limit exceeded',
    },
    [ERROR_TYPES.CONFIG]: {
      openrouter: 'OpenRouter API key is invalid or missing',
      gemini: 'Gemini API key is invalid or missing',
      groq: 'Groq API key is invalid or missing',
      cloudflare: 'Cloudflare credentials are invalid or missing',
      azure: 'Azure Translator key is invalid or missing',
      assemblyai: 'AssemblyAI API key is invalid or missing',
    },
    [ERROR_TYPES.UNSUPPORTED]: {
      local: 'Local STT not available on this platform',
      'local-stt': 'Local STT not available on this platform',
      ollama: 'Ollama is not running or not reachable',
    },
  };
  const base = messages[errorType]?.[provider] || `${provider} is temporarily unavailable`;
  return isRetrying ? `${base}. Retrying...` : base;
}

export function isLocalSttSupported(platform = {}) {
  if (platform.isAppleSilicon === true) return true;
  if (platform.os === 'windows' || platform.os === 'linux') return false;
  if (platform.os === 'macos' && platform.isAppleSilicon === false) return false;
  if (platform.supported === false) return false;
  return platform.isAppleSilicon === true;
}

function hasText(value) {
  return !!(value && String(value).trim());
}

function isSttConfigured(settings, id, platform) {
  switch (id) {
    case 'assemblyai':
      return settings.assemblyai_enabled !== false && hasText(settings.assemblyai_api_key);
    case 'groq':
      return settings.groq_enabled !== false && hasText(settings.groq_api_key);
    case 'cloudflare':
      return settings.cloudflare_enabled !== false
        && hasText(settings.cloudflare_account_id)
        && hasText(settings.cloudflare_api_token);
    case 'local-stt':
      return !!settings.local_stt_enabled && isLocalSttSupported(platform);
    default:
      return false;
  }
}

function isTranslationConfigured(settings, id) {
  switch (id) {
    case 'openrouter':
      return settings.openrouter_enabled !== false && hasText(settings.openrouter_api_key);
    case 'groq-llm':
      return settings.groq_enabled !== false && hasText(settings.groq_api_key);
    case 'cloudflare-llm':
      return settings.cloudflare_enabled !== false
        && hasText(settings.cloudflare_account_id)
        && hasText(settings.cloudflare_api_token);
    case 'azure':
      return !!settings.azure_translator_enabled && hasText(settings.azure_translator_key);
    case 'gemini':
      return !!settings.gemini_enabled && hasText(settings.gemini_api_key);
    case 'ollama':
      return !!settings.ollama_enabled && hasText(settings.ollama_model);
    default:
      return false;
  }
}

export function getEffectiveSTTChain(settings = {}, platform = {}) {
  return STT_CHAIN_DEFAULT.filter((id) => {
    if (!isSttConfigured(settings, id, platform)) return false;
    return !isCircuitBreakerOpen(breakerKey('stt', id));
  });
}

function translationOrderForStt(activeStt) {
  if (activeStt === 'cloudflare') {
    return ['openrouter', 'cloudflare-llm', 'groq-llm', 'azure', 'gemini', 'ollama'];
  }
  if (activeStt === 'local-stt' || activeStt === 'local') {
    return ['openrouter', 'groq-llm', 'cloudflare-llm', 'azure', 'gemini', 'ollama'];
  }
  return ['openrouter', 'groq-llm', 'cloudflare-llm', 'azure', 'gemini', 'ollama'];
}

export function getEffectiveTranslationChain(settings = {}, sttProvider = 'groq') {
  let order = translationOrderForStt(sttProvider);
  const llm = settings.llm_provider || 'automatic';
  if (llm === 'engine') {
    order = order.filter((id) => id !== 'openrouter');
  }
  return order.filter((id) => {
    if (!isTranslationConfigured(settings, id)) return false;
    return !isCircuitBreakerOpen(breakerKey('translation', id));
  });
}

export function getSttStartOrder(settings = {}, platform = {}) {
  const chain = getEffectiveSTTChain(settings, platform);
  const mode = settings.translation_mode || 'automatic';
  if (mode === 'automatic') return chain;
  const mapped = mode === 'local' ? 'local-stt' : mode;
  const idx = chain.indexOf(mapped);
  if (idx < 0) return chain;
  return chain.slice(idx);
}

export function nextSttProvider(settings, platform, currentProvider) {
  const order = getSttStartOrder(settings, platform);
  const idx = order.indexOf(currentProvider);
  if (idx < 0) return order[0] || null;
  return order[idx + 1] || null;
}

export function preferredRecoveryStt(settings, platform, currentProvider) {
  const chain = getEffectiveSTTChain(settings, platform);
  if (!chain.length) return null;
  const currentIdx = chain.indexOf(currentProvider);
  if (currentIdx <= 0) return null;
  return chain[0];
}

export function canTransitionStt(at = now()) {
  return at - lastSttTransitionAt >= MIN_DWELL_MS;
}

export function markSttTransition(at = now()) {
  lastSttTransitionAt = at;
}

export function setSessionStickyProvider(provider) {
  sessionStickyProvider = provider;
}

export function getSessionStickyProvider() {
  return sessionStickyProvider;
}

export function clearSessionState() {
  sessionStickyProvider = null;
  lastSttTransitionAt = 0;
}

export function logProviderTransition(from, to, reason) {
  const timestamp = new Date(now()).toISOString();
  console.debug(`[Provider] ${timestamp} transitioning from ${from} to ${to}: ${sanitizeErrorMessage(reason)}`);
}

export function allocateSegmentId() {
  return `seg_${now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

async function invokeTranslation(invoke, provider, settings, text, sourceLanguage, targetLanguage) {
  switch (provider) {
    case 'openrouter':
      return invoke('openrouter_translate_text', {
        apiKey: settings.openrouter_api_key,
        sourceLanguage,
        targetLanguage,
        text,
        llmModel: settings.openrouter_llm_model || '',
      });
    case 'groq-llm':
      return invoke('groq_translate_text', {
        apiKey: settings.groq_api_key,
        sourceLanguage,
        targetLanguage,
        text,
        llmModel: settings.groq_llm_model || '',
      });
    case 'cloudflare-llm':
      return invoke('cloudflare_translate_text', {
        accountId: settings.cloudflare_account_id,
        apiToken: settings.cloudflare_api_token,
        sourceLanguage,
        targetLanguage,
        text,
        llmModel: settings.cloudflare_llm_model || '',
      });
    case 'azure':
      return invoke('azure_translate_text', {
        subscriptionKey: settings.azure_translator_key,
        region: settings.azure_translator_region || '',
        endpoint: settings.azure_translator_endpoint || '',
        sourceLanguage,
        targetLanguage,
        text,
      });
    case 'gemini':
      return invoke('gemini_translate_text', {
        apiKey: settings.gemini_api_key,
        sourceLanguage,
        targetLanguage,
        text,
        model: settings.gemini_model || '',
      });
    case 'ollama':
      return invoke('ollama_translate_text', {
        baseUrl: settings.ollama_base_url || 'http://127.0.0.1:11434',
        modelName: settings.ollama_model,
        sourceLanguage,
        targetLanguage,
        text,
      });
    default:
      throw createProviderError({
        provider,
        capability: 'translation',
        kind: ERROR_TYPES.CONFIG,
        message: `Unknown translation provider: ${provider}`,
      });
  }
}

function translatedFromResult(result) {
  return (result?.translated_text || result?.translatedText || '').trim();
}

export async function translateWithChain({
  settings,
  activeStt,
  text,
  sourceLanguage,
  targetLanguage,
  segmentId,
  generation,
  isCurrent,
  invoke,
} = {}) {
  const source = (text || '').trim();
  if (!source) return { translatedText: '', provider: null, segmentId };
  const chain = getEffectiveTranslationChain(settings, activeStt);
  let lastError = null;

  for (const provider of chain) {
    if (typeof isCurrent === 'function' && !isCurrent(segmentId, generation)) {
      return { ignored: true, segmentId, generation };
    }
    const key = breakerKey('translation', provider);
    if (isCircuitBreakerOpen(key)) continue;
    const state = breakerState(key);
    if (state?.state === 'half-open') noteHalfOpenProbe(key);

    try {
      const result = await invokeTranslation(invoke, provider, settings, source, sourceLanguage, targetLanguage);
      if (typeof isCurrent === 'function' && !isCurrent(segmentId, generation)) {
        return { ignored: true, segmentId, generation };
      }
      const translatedText = translatedFromResult(result) || source;
      noteProviderSuccess(key);
      return { translatedText, provider, segmentId, generation };
    } catch (err) {
      const parsed = applyProviderError({
        ...parseProviderError(err, { provider, capability: 'translation' }),
        provider,
        capability: 'translation',
      });
      lastError = parsed;
      if (parsed.kind === ERROR_TYPES.TEMPORARY) {
        try {
          const retry = await invokeTranslation(invoke, provider, settings, source, sourceLanguage, targetLanguage);
          if (typeof isCurrent === 'function' && !isCurrent(segmentId, generation)) {
            return { ignored: true, segmentId, generation };
          }
          noteProviderSuccess(key);
          return { translatedText: translatedFromResult(retry) || source, provider, segmentId, generation };
        } catch (retryErr) {
          applyProviderError({
            ...parseProviderError(retryErr, { provider, capability: 'translation' }),
            provider,
            capability: 'translation',
          });
        }
      }
    }
  }

  throw lastError || createProviderError({
    provider: 'translation',
    capability: 'translation',
    kind: ERROR_TYPES.CONFIG,
    message: 'No translation providers available',
  });
}

export default {
  classifyError,
  getRetryAfter,
  isCircuitBreakerOpen,
  openCircuitBreaker,
  resetCircuitBreaker,
  resetAllCircuitBreakers,
  sanitizeErrorMessage,
  formatErrorNotification,
  getEffectiveTranslationChain,
  getEffectiveSTTChain,
  setSessionStickyProvider,
  getSessionStickyProvider,
  clearSessionState,
  logProviderTransition,
  parseProviderError,
  createProviderError,
  translateWithChain,
  isCircuitBreakerHalfOpen,
  noteHalfOpenProbe,
  ERROR_TYPES,
  PROVIDER_CHAINS,
};
