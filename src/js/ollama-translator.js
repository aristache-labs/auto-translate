/**
 * Ollama local translation adapter — optional offline text translation
 * 
 * Security:
 * - Accepts only loopback hosts by default (127.0.0.1, localhost, [::1])
 * - Does not start Ollama automatically
 * - Does not install Ollama or download models
 * - Does not send API keys
 * - Does not silently fall back to remote services
 * 
 * Defaults:
 * - Base URL: http://127.0.0.1:11434
 * - Disabled until explicitly enabled
 * - Short bounded health check
 */

const DEFAULT_BASE_URL = 'http://127.0.0.1:11434';
const LOOPBACK_HOSTS = ['127.0.0.1', 'localhost', '[::1]', '::1'];

/**
 * Validate that URL is loopback-only (security constraint)
 */
export function isLoopbackUrl(urlString) {
  try {
    const url = new URL(urlString);
    const hostname = url.hostname || url.host;
    return LOOPBACK_HOSTS.includes(hostname);
  } catch {
    return false;
  }
}

/**
 * Check if Ollama is reachable at the given endpoint
 * Short bounded health check (2s timeout)
 */
export async function checkOllamaHealth(baseUrl = DEFAULT_BASE_URL) {
  if (!isLoopbackUrl(baseUrl)) {
    return { ok: false, error: 'Ollama URL must use loopback address (localhost/127.0.0.1)' };
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 2000);

  try {
    const response = await fetch(`${baseUrl}/api/tags`, {
      method: 'GET',
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      return { ok: false, error: `Ollama returned ${response.status}` };
    }

    const data = await response.json();
    const models = data?.models || [];

    return {
      ok: true,
      modelsAvailable: models.length,
      models: models.map(m => m.name),
    };
  } catch (err) {
    clearTimeout(timeoutId);

    if (err.name === 'AbortError') {
      return { ok: false, error: 'Ollama not reachable (timeout)' };
    }

    return {
      ok: false,
      error: err.message || 'Ollama connection failed',
    };
  }
}

/**
 * Translate text using local Ollama model
 * 
 * @param {string} baseUrl - Ollama base URL (must be loopback)
 * @param {string} modelName - Ollama model name (must be available)
 * @param {string} sourceLanguage - Source language code
 * @param {string} targetLanguage - Target language code
 * @param {string} text - Text to translate
 * @returns {Promise<{translatedText: string, provider: string, model: string}>}
 */
export async function ollamaTranslate(
  baseUrl,
  modelName,
  sourceLanguage,
  targetLanguage,
  text
) {
  if (!baseUrl) baseUrl = DEFAULT_BASE_URL;

  if (!isLoopbackUrl(baseUrl)) {
    throw new Error('Ollama URL must use loopback address (localhost/127.0.0.1)');
  }

  if (!modelName || !modelName.trim()) {
    throw new Error('Ollama model name is required');
  }

  if (!text || !text.trim()) {
    return { translatedText: '', provider: 'ollama', model: modelName };
  }

  if (sourceLanguage === targetLanguage) {
    return { translatedText: text, provider: 'ollama', model: modelName };
  }

  const prompt = `Translate the following text from ${sourceLanguage} to ${targetLanguage}.
Output ONLY the translated text, nothing else.

Text to translate: ${text}

Translation:`;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 30000); // 30s timeout for translation

  try {
    const response = await fetch(`${baseUrl}/api/generate`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      signal: controller.signal,
      body: JSON.stringify({
        model: modelName,
        prompt: prompt,
        stream: false,
        temperature: 0.1,
      }),
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      const status = response.status;
      if (status === 404) {
        throw new Error(`Ollama: Model '${modelName}' not found`);
      }
      throw new Error(`Ollama error (${status})`);
    }

    const data = await response.json();
    const translatedText = (data?.response || '').trim();

    if (!translatedText) {
      throw new Error('Ollama: Empty response');
    }

    // Clean up any prompt echoing or instruction leakage
    const cleaned = translatedText
      .replace(/^Translation:\s*/i, '')
      .replace(/^Text to translate:[\s\S]*?Translation:\s*/i, '')
      .split('\n')[0] // Take first line only
      .trim();

    if (!cleaned) {
      throw new Error('Ollama: Response contained no translation');
    }

    return {
      translatedText: cleaned,
      provider: 'ollama',
      model: modelName,
    };
  } catch (err) {
    clearTimeout(timeoutId);

    if (err.name === 'AbortError') {
      throw new Error('Ollama: Translation request timeout');
    }

    throw err;
  }
}

/**
 * Test Ollama connection (explicit manual test only)
 * Does NOT make requests unless user explicitly enables and configures
 */
export async function testOllamaConnection(baseUrl, modelName) {
  if (!baseUrl) baseUrl = DEFAULT_BASE_URL;

  // First check health
  const health = await checkOllamaHealth(baseUrl);
  if (!health.ok) {
    return { ok: false, error: health.error };
  }

  // Check if model is available
  if (modelName && !health.models?.includes(modelName)) {
    return { 
      ok: false, 
      error: `Model '${modelName}' not found. Available: ${health.models?.join(', ') || 'none'}` 
    };
  }

  if (!modelName) {
    return {
      ok: true,
      message: 'Ollama is reachable. Configure a model name to use.',
      availableModels: health.models,
    };
  }

  try {
    const result = await ollamaTranslate(
      baseUrl,
      modelName,
      'en',
      'vi',
      'Hello'
    );
    return { ok: true, result };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

export const ollamaTranslator = {
  translate: ollamaTranslate,
  checkHealth: checkOllamaHealth,
  test: testOllamaConnection,
  isLoopbackUrl,
  defaultUrl: DEFAULT_BASE_URL,
};
