import { aiConfig } from '../../../config/ai.js';

function withTimeout(promise, ms, label = 'LLM request') {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function isGeminiProvider(provider) {
  const p = String(provider || '').toLowerCase();
  return p === 'gemini' || p === 'google' || p === 'google-genai';
}

export function getLlmProviderInfo() {
  const { llm } = aiConfig;
  const provider = llm.provider || 'openai-compatible';
  // OpenAI-compatible providers: API key + model required (base URL may default to OpenAI).
  // Gemini/native providers: API key + model required (base URL not required).
  const configured = Boolean(llm.apiKey && llm.model);
  return {
    provider,
    configured,
    model: llm.model || null,
  };
}

function resolveEndpoint(baseUrl) {
  if (!baseUrl) return 'https://api.openai.com/v1/chat/completions';
  const trimmed = baseUrl.replace(/\/+$/, '');
  if (/\/chat\/completions$/i.test(trimmed)) return trimmed;
  return `${trimmed}/chat/completions`;
}

function sanitizeMessages(messages = []) {
  return messages
    .filter((m) => m && (m.role === 'user' || m.role === 'assistant' || m.role === 'system'))
    .map((m) => ({ role: m.role, content: String(m.content || '').slice(0, 12000) }))
    .filter((m) => m.content.trim());
}

function extractStatus(err) {
  const candidates = [err?.status, err?.code, err?.response?.status, err?.error?.status, err?.error?.code, err?.cause?.status, err?.cause?.code];
  for (const c of candidates) {
    const n = Number(c);
    if (Number.isFinite(n) && n >= 100 && n <= 599) return n;
  }
  const msg = String(err?.message || err || '');
  const m = msg.match(/"code"\s*:\s*(\d{3})|status\s*[:=]?\s*(\d{3})|\((\d{3})\)/i);
  if (m) return Number(m[1] || m[2] || m[3]);
  return null;
}

function isTimeoutError(err) {
  if (!err) return false;
  if (err.name === 'AbortError') return true;
  return /timed out|timeout|deadline exceeded|deadline expired|operation was aborted|ETIMEDOUT/i.test(
    String(err?.message || err || '')
  );
}

function isRetryableError(err) {
  if (!err) return false;
  if (err.retryable === true) return true;
  if (err.retryable === false) return false;
  // A timeout/deadline already consumed the full request budget; retrying doubles the wait
  // for the user without improving the odds meaningfully. Treat it as terminal.
  if (isTimeoutError(err)) return false;
  const status = extractStatus(err);
  if (status === 504) return false; // gateway timeout - already waited the full budget
  if (status === 408 || status === 429 || status >= 500) return true;
  if (status >= 400 && status < 500) return false; // auth/invalid request/unsupported model etc. - do not retry
  const msg = String(err?.message || err || '');
  return (
    /network|fetch failed|ECONN|ENOTFOUND|ETIMEDOUT|ECONNRESET|EAI_AGAIN|UNAVAILABLE|RESOURCE_EXHAUSTED|temporarily unavailable/i.test(
      msg
    )
  );
}

function unavailableResult(info, reason, message) {
  return {
    ok: false,
    unavailable: true,
    reason,
    message,
    provider: info.provider,
    model: info.model,
  };
}

function buildGeminiRequest(system, messages = []) {
  const sanitized = sanitizeMessages(messages);
  const systemParts = [];
  if (system && String(system).trim()) systemParts.push(String(system).slice(0, 16000));

  const contents = [];
  for (const m of sanitized) {
    if (m.role === 'system') {
      systemParts.push(m.content);
      continue;
    }
    const role = m.role === 'assistant' ? 'model' : 'user';
    contents.push({ role, parts: [{ text: m.content }] });
  }

  // Gemini generateContent requires at least one content item in most cases.
  if (!contents.length) {
    contents.push({ role: 'user', parts: [{ text: 'Hello' }] });
  }

  return {
    systemInstruction: systemParts.length ? systemParts.join('\n\n') : undefined,
    contents,
  };
}

async function generateWithGemini({ system, messages = [] }, info) {
  let GoogleGenAI;
  try {
    ({ GoogleGenAI } = await import('@google/genai'));
  } catch (err) {
    const e = new Error('Gemini SDK (@google/genai) is not available on the backend.');
    e.cause = err;
    throw e;
  }

  // The SDK defaults to 5 internal retries with exponential backoff (up to 60s each) on
  // 408/429/5xx. That causes multi-minute hangs that look like provider outages. Disable
  // SDK retries here and let the bounded app-level retry logic handle transient failures.
  const ai = new GoogleGenAI({
    apiKey: aiConfig.llm.apiKey,
    httpOptions: {
      // SDK rejects deadlines below 10s ("Manually set deadline 1s is too short").
      // The app-level withTimeout still enforces the configured (possibly smaller) budget.
      timeout: Math.max(10000, aiConfig.llm.timeoutMs || 60000),
      retryOptions: { attempts: 1 },
    },
  });
  const { systemInstruction, contents } = buildGeminiRequest(system, messages);
  const request = {
    model: aiConfig.llm.model,
    contents,
    ...(systemInstruction ? { config: { systemInstruction, temperature: 0.2 } } : { config: { temperature: 0.2 } }),
  };

  const response = await ai.models.generateContent(request);
  let text = typeof response?.text === 'string' ? response.text : '';
  if (!text || !text.trim()) {
    // Fallback extraction for alternate response shapes
    const parts = response?.candidates?.[0]?.content?.parts;
    if (Array.isArray(parts)) {
      text = parts.map((p) => (typeof p?.text === 'string' ? p.text : '')).join('');
    }
  }

  if (typeof text !== 'string' || !text.trim()) {
    const empty = unavailableResult(info, 'empty_response', 'The AI assistant did not return a usable response. Please try again.');
    empty.model = response?.modelVersion || response?.model || info.model;
    return empty;
  }

  return {
    ok: true,
    unavailable: false,
    text: text.trim(),
    provider: info.provider,
    model: response?.modelVersion || response?.model || info.model,
    usage: response?.usageMetadata || null,
  };
}

async function generateWithOpenAICompatible({ system, messages = [] }, info) {
  const endpoint = resolveEndpoint(aiConfig.llm.baseUrl);
  const payload = {
    model: aiConfig.llm.model,
    messages: [
      ...(system ? [{ role: 'system', content: String(system).slice(0, 16000) }] : []),
      ...sanitizeMessages(messages),
    ],
    temperature: 0.2,
  };

  const res = await withTimeout(
    fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${aiConfig.llm.apiKey}`,
      },
      body: JSON.stringify(payload),
    }),
    aiConfig.llm.timeoutMs || 20000,
    'LLM request'
  );

  let body = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }

  if (!res.ok) {
    const retryable = res.status === 429 || res.status >= 500;
    const err = new Error(body?.error?.message || `LLM provider error (${res.status})`);
    err.status = res.status;
    err.retryable = retryable;
    throw err;
  }

  const text = body?.choices?.[0]?.message?.content;
  if (typeof text !== 'string' || !text.trim()) {
    return unavailableResult(info, 'empty_response', 'The AI assistant did not return a usable response. Please try again.');
  }

  return {
    ok: true,
    unavailable: false,
    text: text.trim(),
    provider: info.provider,
    model: body?.model || info.model,
    usage: body?.usage || null,
  };
}

function classifyFailure(err) {
  if (isTimeoutError(err)) return { reason: 'timeout', message: 'The AI assistant request timed out. Please try again.' };
  const status = extractStatus(err);
  const msg = String(err?.message || err || '').toLowerCase();
  if (status === 401 || status === 403 || /unauthorized|forbidden|api key|permission|authentication/i.test(msg)) {
    return { reason: 'auth_error', message: 'The AI assistant could not authenticate with the configured provider. Please check provider credentials and permissions.' };
  }
  if (status === 404 || /model.*not found|not found.*model|unsupported model|is not found/i.test(msg)) {
    return { reason: 'model_error', message: 'The configured AI model or endpoint was not found. Please verify the provider model configuration.' };
  }
  if (status === 429 || /rate limit|quota|resource_exhausted|too many requests/i.test(msg)) {
    return { reason: 'rate_limited', message: 'The AI provider rate limit or quota was exceeded. Please try again later.' };
  }
  if (/sdk.*not available|@google\/genai/i.test(String(err?.message || err || ''))) {
    return { reason: 'provider_unavailable', message: 'The configured AI provider integration is unavailable on the backend.' };
  }
  return { reason: 'provider_error', message: 'The AI assistant is temporarily unavailable. Please try again later.' };
}

export async function generateAssistantText({ system, messages = [] }) {
  const startedAt = Date.now();
  const info = getLlmProviderInfo();
  if (!aiConfig.assistant.enabled) {
    return { ...unavailableResult(info, 'disabled', 'The AI assistant is disabled by configuration.'), retryCount: 0, timings: { providerMs: 0 } };
  }
  if (!info.configured) {
    return {
      ...unavailableResult(
        info,
        'not_configured',
        'AI assistant provider is not configured. Set AI_LLM_API_KEY and AI_LLM_MODEL (and AI_LLM_PROVIDER/AI_LLM_BASE_URL as needed) on the backend to enable AI responses. I can only answer from available system records once connected.'
      ),
      retryCount: 0,
      timings: { providerMs: 0 },
    };
  }

  const maxRetries = Math.max(0, aiConfig.llm.maxRetries || 0);
  const useGemini = isGeminiProvider(info.provider);
  let lastError;
  let attempts = 0;

  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    attempts = attempt + 1;
    try {
      let result;
      if (useGemini) {
        result = await withTimeout(
          generateWithGemini({ system, messages }, info),
          aiConfig.llm.timeoutMs || 20000,
          'LLM request'
        );
      } else {
        result = await generateWithOpenAICompatible({ system, messages }, info);
      }
      return { ...result, retryCount: attempt, timings: { providerMs: Date.now() - startedAt } };
    } catch (err) {
      lastError = err;
      if (attempt >= maxRetries || !isRetryableError(err)) break;
      await sleep(300 * (attempt + 1));
    }
  }

  const failure = classifyFailure(lastError);
  const status = extractStatus(lastError);
  const logSafe = {
    event: 'ai.assistant.provider_failure',
    provider: info.provider,
    model: info.model || null,
    reason: failure.reason,
    status: status ?? null,
    retryable: isRetryableError(lastError),
    attempts,
    retryCount: Math.max(0, attempts - 1),
    timeoutMs: aiConfig.llm.timeoutMs || 60000,
    durationMs: Date.now() - startedAt,
  };
  try { console.warn(JSON.stringify(logSafe)); } catch { /* ignore */ }

  return {
    ...unavailableResult(info, failure.reason, failure.message),
    retryCount: Math.max(0, attempts - 1),
    timings: { providerMs: Date.now() - startedAt },
  };
}

export async function safeExternalCall(
  fn,
  { timeoutMs = aiConfig.llm.timeoutMs, label = 'External AI call', retries = aiConfig.llm.maxRetries } = {}
) {
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      return await withTimeout(Promise.resolve().then(fn), timeoutMs, label);
    } catch (err) {
      lastError = err;
      if (attempt >= retries) break;
      await sleep(250 * (attempt + 1));
    }
  }
  throw lastError;
}