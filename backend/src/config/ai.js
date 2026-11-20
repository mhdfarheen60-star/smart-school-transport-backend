import { env } from './env.js';

function read(name) {
  const value = process.env[name];
  return typeof value === 'string' ? value.trim() : '';
}

function readBool(name, fallback = false) {
  const value = read(name).toLowerCase();
  if (!value) return fallback;
  return value === '1' || value === 'true' || value === 'yes' || value === 'on';
}

function readInt(name, fallback, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
  const value = read(name);
  if (!value) return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) return fallback;
  return n;
}

function readUrl(name) {
  const value = read(name);
  if (!value) return '';
  try {
    const url = new URL(value);
    return url.toString().replace(/\/$/, '');
  } catch {
    return '';
  }
}

const llm = {
  provider: read('AI_LLM_PROVIDER') || 'openai-compatible',
  apiKey: read('AI_LLM_API_KEY') || read('OPENAI_API_KEY'),
  baseUrl: readUrl('AI_LLM_BASE_URL') || readUrl('OPENAI_BASE_URL'),
  model: read('AI_LLM_MODEL'),
  // Gemini generation latency is commonly 15-45s (observed), so a 15s default caused false
  // timeouts. Default to 60s; still configurable via AI_LLM_TIMEOUT_MS.
  timeoutMs: readInt('AI_LLM_TIMEOUT_MS', 60000, { min: 1000, max: 120000 }),
  maxRetries: readInt('AI_LLM_MAX_RETRIES', 1, { min: 0, max: 5 }),
};

const routing = {
  provider: (read('AI_ROUTING_PROVIDER') || (read('GOOGLE_MAPS_API_KEY') ? 'google' : read('OSRM_BASE_URL') ? 'osrm' : 'none')).toLowerCase(),
  googleMapsApiKey: read('GOOGLE_MAPS_API_KEY'),
  osrmBaseUrl: readUrl('OSRM_BASE_URL'),
  timeoutMs: readInt('AI_ROUTING_TIMEOUT_MS', 10000, { min: 1000, max: 120000 }),
  maxRetries: readInt('AI_ROUTING_MAX_RETRIES', 1, { min: 0, max: 5 }),
};

const optimization = {
  provider: (read('AI_OPTIMIZATION_PROVIDER') || 'heuristic').toLowerCase(),
  timeoutMs: readInt('AI_OPTIMIZATION_TIMEOUT_MS', 10000, { min: 1000, max: 120000 }),
};

const assistant = {
  enabled: readBool('AI_ASSISTANT_ENABLED', true),
  maxMessages: readInt('AI_ASSISTANT_MAX_MESSAGES', 20, { min: 4, max: 100 }),
  maxMessageChars: readInt('AI_ASSISTANT_MAX_MESSAGE_CHARS', 2000, { min: 200, max: 20000 }),
};

const tavus = {
  // Master switch for the photorealistic Tavus CVI human avatar experience.
  enabled: readBool('TAVUS_ENABLED', false),
  apiKey: read('TAVUS_API_KEY'),
  apiUrl: readUrl('TAVUS_API_URL') || 'https://tavusapi.com',
  replicaId: read('TAVUS_REPLICA_ID'),
  personaId: read('TAVUS_PERSONA_ID'),
  // Optional: public base URL of this backend for Tavus custom-LLM callbacks
  // (must be reachable by Tavus). When omitted, conversations rely on
  // conversational context/persona configuration.
  callbackBaseUrl: readUrl('TAVUS_CALLBACK_BASE_URL'),
  conversationTimeoutSeconds: readInt('TAVUS_CONVERSATION_TIMEOUT_SECONDS', 1800, { min: 60, max: 7200 }),
  // Optional presentation/behavior overrides for the selected Tavus replica/persona.
  // Visual identity, facial animation, lip sync and voice timbre are provided by
  // the Tavus replica/persona assets; these values tune session-level behavior.
  language: read('TAVUS_LANGUAGE') || 'english',
  customGreeting: read('TAVUS_CUSTOM_GREETING'),
  publicGreeting: read('TAVUS_PUBLIC_GREETING'),
};

export const aiConfig = {
  env: env.nodeEnv,
  llm,
  routing,
  optimization,
  assistant,
  tavus,
  get tavusEnabled() {
    return Boolean(this.tavus.enabled && this.tavus.apiKey && this.tavus.replicaId);
  },
};

export function aiProviderStatus() {
  const llmConfigured = Boolean(llm.apiKey && (llm.baseUrl || llm.provider !== 'custom'));
  const routingConfigured =
    routing.provider === 'google'
      ? Boolean(routing.googleMapsApiKey)
      : routing.provider === 'osrm'
      ? Boolean(routing.osrmBaseUrl)
      : false;

  return {
    llm: {
      provider: llm.provider,
      configured: llmConfigured,
      model: llm.model || null,
      mode: llmConfigured ? 'external' : 'unavailable',
      message: llmConfigured
        ? 'LLM provider configured.'
        : 'LLM provider is not configured. Set AI_LLM_API_KEY (and AI_LLM_BASE_URL/model as needed) to enable generative features.',
    },
    routing: {
      provider: routing.provider,
      configured: routingConfigured,
      mode: routingConfigured ? 'external' : 'fallback',
      message: routingConfigured
        ? 'Routing provider configured.'
        : 'No routing provider configured. Deterministic distance-based fallback will be used where possible; set GOOGLE_MAPS_API_KEY or OSRM_BASE_URL for road routing.',
    },
    optimization: {
      provider: optimization.provider,
      configured: true,
      mode: 'deterministic',
      message: 'Deterministic optimization service available.',
    },
    assistant: {
      enabled: assistant.enabled,
      configured: assistant.enabled && llmConfigured,
      mode: assistant.enabled && llmConfigured ? 'external' : 'limited',
      message:
        !assistant.enabled
          ? 'AI assistant is disabled by configuration.'
          : llmConfigured
          ? 'AI assistant enabled.'
          : 'AI assistant can answer only from available system data until an LLM provider is configured.',
    },
    avatar: {
      provider: 'tavus-cvi',
      enabled: Boolean(tavus.enabled && tavus.apiKey && tavus.replicaId),
      configured: Boolean(tavus.apiKey && tavus.replicaId),
      mode: tavus.enabled && tavus.apiKey && tavus.replicaId ? 'cvi' : 'unavailable',
      replicaId: tavus.replicaId || null,
      message:
        tavus.enabled && tavus.apiKey && tavus.replicaId
          ? 'Photorealistic Tavus CVI human avatar is configured.'
          : 'Tavus CVI avatar is not configured. Set TAVUS_ENABLED=true, TAVUS_API_KEY, and TAVUS_REPLICA_ID (and optional TAVUS_PERSONA_ID) to enable the real-time human avatar.',
    },
  };
}
