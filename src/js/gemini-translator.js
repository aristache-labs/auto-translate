/**
 * Gemini translation adapter — text-only translation via Google Gemini API
 * 
 * Forces translation-only output (no explanations, markdown, or commentary)
 * Treats free-tier quota exhaustion as temporary provider outage
 * Never logs or exposes API keys
 */

const GEMINI_API_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';

// Conservative supported default model
const DEFAULT_MODEL = 'gemini-3.1-flash-lite';

/**
 * Translate text using Gemini API
 * 
 * Forces translation-only output with structured prompt
 * 
 * @param {string} apiKey - Gemini API key
 * @param {string} sourceLanguage - Source language code
 * @param {string} targetLanguage - Target language code  
 * @param {string} text - Text to translate
 * @param {string} model - Model name (default: gemini-3.1-flash-lite)
 * @returns {Promise<{translatedText: string, provider: string, model: string}>}
 */
export async function geminiTranslate(
  apiKey,
  sourceLanguage,
  targetLanguage,
  text,
  model = DEFAULT_MODEL
) {
  if (!apiKey || !apiKey.trim()) {
    throw new Error('Gemini API key is required');
  }
  
  if (!text || !text.trim()) {
    return { translatedText: '', provider: 'gemini', model };
  }
  
  if (sourceLanguage === targetLanguage) {
    return { translatedText: text, provider: 'gemini', model };
  }
  
  // Force translation-only output with structured prompt
  const systemPrompt = `You are a precise translator. 
Your task is to translate text from ${sourceLanguage} to ${targetLanguage}.
Output ONLY the translated text, nothing else.
Do not include:
- Explanations
- Markdown formatting
- Commentary
- Original text
- "Translation:" prefix
Just the translated text.`;

  const userPrompt = text;

  const payload = {
    contents: [
      {
        parts: [
          { text: userPrompt }
        ]
      }
    ],
    systemInstruction: {
      parts: [{ text: systemPrompt }]
    },
    generationConfig: {
      temperature: 0.1,
      topP: 0.95,
      maxOutputTokens: 1000,
    }
  };

  try {
    const modelId = (model || DEFAULT_MODEL).trim() || DEFAULT_MODEL;
    const url = `${GEMINI_API_BASE}/${encodeURIComponent(modelId)}:generateContent?key=${encodeURIComponent(apiKey)}`;
    
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });

    const status = response.status;
    let data;
    
    try {
      data = await response.json();
    } catch {
      data = null;
    }

    if (!response.ok) {
      // Classify errors without exposing details
      if (status === 401 || status === 403) {
        throw new Error('Gemini: Invalid API key');
      }
      
      if (status === 429) {
        // Free-tier quota exhaustion — treat as temporary outage
        throw new Error('Gemini: Rate limit exceeded (quota exhausted)');
      }
      
      if (status >= 500) {
        throw new Error('Gemini: Service unavailable');
      }
      
      if (status === 400) {
        // Could be invalid model or other config error
        const errorMsg = data?.error?.message || 'Invalid request';
        throw new Error(`Gemini: ${errorMsg}`);
      }
      
      throw new Error(`Gemini error (${status})`);
    }

    // Extract translated text from response
    const translatedText = data?.candidates?.[0]?.content?.parts?.[0]?.text;
    
    if (!translatedText) {
      throw new Error('Gemini: Empty response');
    }

    // Normalize response — strip any remaining markdown or explanations
    const normalized = translatedText
      .trim()
      .replace(/^#+\s*/gm, '')           // Remove markdown headers
      .replace(/^\*\*.*?\*\*\s*/gm, '')  // Remove markdown bold
      .replace(/^\*\s*/gm, '')           // Remove markdown bullets
      .replace(/^-\s+Translation:\s*/gm, '')  // Remove "Translation:" prefix
      .trim();

    if (!normalized) {
      throw new Error('Gemini: Response contained no translation');
    }

    return {
      translatedText: normalized,
      provider: 'gemini',
      model,
    };
  } catch (err) {
    // Don't expose API key in error messages
    if (err.message.includes('apiKey')) {
      throw new Error('Gemini: Authentication failed');
    }
    throw err;
  }
}

/**
 * Test Gemini connection (explicit manual test only)
 * Does NOT make requests unless user explicitly presses test button
 */
export async function testGeminiConnection(apiKey, model = DEFAULT_MODEL) {
  if (!apiKey || !apiKey.trim()) {
    return { ok: false, error: 'API key is required' };
  }

  try {
    const result = await geminiTranslate(
      apiKey,
      'en',
      'vi',
      'Hello',
      model
    );
    return { ok: true, result };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/**
 * Get list of supported Gemini models (conservative defaults)
 */
export function getSupportedModels() {
  return [
    { id: 'gemini-3.1-flash-lite', label: 'Gemini 3.1 Flash Lite (Recommended · translation)' },
    { id: 'gemini-3.5-flash-lite', label: 'Gemini 3.5 Flash Lite' },
    { id: 'gemini-3.7-flash', label: 'Gemini 3.7 Flash' },
    { id: 'gemini-3.6-flash', label: 'Gemini 3.6 Flash' },
    { id: 'gemini-3.5-flash', label: 'Gemini 3.5 Flash' },
    { id: 'gemini-flash-lite-latest', label: 'Gemini Flash-Lite Latest (alias)' },
    { id: 'gemini-flash-latest', label: 'Gemini Flash Latest (alias)' },
  ];
}

export const geminiTranslator = {
  translate: geminiTranslate,
  test: testGeminiConnection,
  getSupportedModels,
  defaultModel: DEFAULT_MODEL,
};
