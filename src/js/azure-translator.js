/**
 * Azure AI Translator Text adapter — machine translation (not LLM-based)
 * 
 * Official Azure Translator REST API
 * Maps application language codes to Azure-supported codes
 * Never logs or exposes subscription keys
 */

import { getProviderInvoke } from './provider-client.js';

const DEFAULT_ENDPOINT = 'https://api.cognitive.microsofttranslator.com';

// Language code mapping: application → Azure Translator
const LANGUAGE_MAP = {
  'auto': null,           // Azure doesn't support auto-detection in batch
  'vi': 'vi',
  'en': 'en',
  'es': 'es',
  'fr': 'fr',
  'de': 'de',
  'zh': 'zh-Hans',        // Simplified Chinese
  'zh-CN': 'zh-Hans',
  'zh-TW': 'zh-Hant',     // Traditional Chinese
  'ja': 'ja',
  'ko': 'ko',
  'pt': 'pt-PT',
  'pt-BR': 'pt-BR',
  'ru': 'ru',
  'ar': 'ar',
  'hi': 'hi',
  'th': 'th',
  'id': 'id',
  'tr': 'tr',
  'pl': 'pl',
  'nl': 'nl',
  'it': 'it',
  'sv': 'sv',
  'no': 'nb',
  'da': 'da',
  'fi': 'fi',
  'cs': 'cs',
  'uk': 'uk',
  'he': 'he',
  'fa': 'fa',
  'el': 'el',
};

/**
 * Map application language code to Azure Translator code
 */
function mapLanguageToAzure(langCode) {
  if (!langCode || langCode === 'auto') return null;
  return LANGUAGE_MAP[langCode] || langCode;
}

/**
 * Validate that both source and target languages are supported
 */
function validateLanguages(sourceLanguage, targetLanguage) {
  const src = mapLanguageToAzure(sourceLanguage);
  const tgt = mapLanguageToAzure(targetLanguage);
  
  if (!tgt) {
    return {
      ok: false,
      error: `Target language not supported: ${targetLanguage}`
    };
  }
  
  return { ok: true, source: src, target: tgt };
}

/**
 * Translate text using Azure Translator REST API
 * 
 * @param {string} subscriptionKey - Azure Translator subscription key
 * @param {string} region - Azure region (e.g., 'eastus', 'westeurope')
 * @param {string} sourceLanguage - Source language code (auto-detected if 'auto')
 * @param {string} targetLanguage - Target language code
 * @param {string} text - Text to translate
 * @param {string} endpoint - Optional custom endpoint (defaults to official Azure)
 * @returns {Promise<{translatedText: string, provider: string, model: string}>}
 */
export async function azureTranslate(
  subscriptionKey,
  region,
  sourceLanguage,
  targetLanguage,
  text,
  endpoint = DEFAULT_ENDPOINT
) {
  if (!subscriptionKey || !subscriptionKey.trim()) {
    throw new Error('Azure Translator subscription key is required');
  }
  
  if (!text || !text.trim()) {
    return { translatedText: '', provider: 'azure', model: 'text-translator' };
  }
  
  if (sourceLanguage === targetLanguage) {
    return { translatedText: text, provider: 'azure', model: 'text-translator' };
  }
  
  const validation = validateLanguages(sourceLanguage, targetLanguage);
  if (!validation.ok) {
    throw new Error(validation.error);
  }
  
  try {
    const invoke = getProviderInvoke();
    const result = await invoke('azure_translate_text', {
      subscriptionKey: subscriptionKey.trim(),
      region: region?.trim() || '',
      endpoint: endpoint?.trim() || DEFAULT_ENDPOINT,
      sourceLanguage: validation.source || 'auto',
      targetLanguage: validation.target,
      text,
    });

    const translated = result?.translated_text ?? result?.translatedText;
    
    if (!translated) {
      throw new Error('Azure Translator: Empty response');
    }
    
    return {
      translatedText: translated,
      provider: 'azure',
      model: 'text-translator',
    };
  } catch (err) {
    const message = typeof err === 'string'
      ? err
      : err?.message || 'Azure Translator request failed';
    // Don't expose subscription keys if a lower layer includes an argument name.
    if (message.includes('subscriptionKey')) {
      throw new Error('Azure Translator: Authentication failed');
    }
    throw new Error(message);
  }
}

/**
 * Test Azure Translator connection (explicit manual test only)
 * Does NOT make requests unless user explicitly presses test button
 */
export async function testAzureTranslatorConnection(
  subscriptionKey,
  region,
  endpoint = DEFAULT_ENDPOINT,
) {
  if (!subscriptionKey || !subscriptionKey.trim()) {
    return { ok: false, error: 'Subscription key is required' };
  }
  
  try {
    const invoke = getProviderInvoke();
    const ok = await invoke('azure_translator_ping', {
      subscriptionKey: subscriptionKey.trim(),
      region: region?.trim() || '',
      endpoint: endpoint?.trim() || DEFAULT_ENDPOINT,
    });
    return ok
      ? { ok: true }
      : { ok: false, error: 'Azure Translator rejected the credentials' };
  } catch (err) {
    return {
      ok: false,
      error: typeof err === 'string' ? err : err?.message || 'Azure Translator test failed',
    };
  }
}

export const azureTranslator = {
  translate: azureTranslate,
  test: testAzureTranslatorConnection,
  mapLanguage: mapLanguageToAzure,
  validateLanguages,
};
