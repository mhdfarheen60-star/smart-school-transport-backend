import { aiConfig } from '../../config/ai.js';
import { ApiError } from '../../utils/http.js';
import { getLlmProviderInfo } from './providers/llm.js';
import {
  buildSystemPrompt,
  getScopedContext,
  resolveScope,
} from './assistant.service.js';
import { buildPublicSystemPrompt, APPROVED_PLATFORM_CONTEXT } from './publicAssistant.service.js';

function ensureTavusConfigured() {
  if (!aiConfig.tavusEnabled) {
    throw new ApiError(
      503,
      'Photorealistic human avatar is not configured. Set TAVUS_ENABLED=true with TAVUS_API_KEY and TAVUS_REPLICA_ID on the backend.'
    );
  }
}

function tavusHeaders() {
  return {
    'Content-Type': 'application/json',
    'x-api-key': aiConfig.tavus.apiKey,
  };
}

function tavusUrl(path) {
  const base = String(aiConfig.tavus.apiUrl || 'https://tavusapi.com').replace(/\/$/, '');
  const p = String(path || '').startsWith('/') ? path : `/${path}`;
  return `${base}${p}`;
}

async function tavusRequest(path, { method = 'POST', body } = {}) {
  const res = await fetch(tavusUrl(path), {
    method,
    headers: tavusHeaders(),
    body: body == null ? undefined : JSON.stringify(body),
  });

  let data = null;
  const text = await res.text().catch(() => '');
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text ? { raw: text } : null;
  }

  if (!res.ok) {
    const message =
      data?.message ||
      data?.error ||
      data?.detail ||
      `Tavus request failed with status ${res.status}`;
    const status = res.status >= 400 && res.status < 500 ? 502 : 502;
    throw new ApiError(status, `Avatar service error: ${message}`);
  }
  return data;
}

function compactContext(ctx) {
  try {
    const json = JSON.stringify(ctx);
    // Keep conversational context bounded for the provider request.
    return json.length > 12000 ? `${json.slice(0, 12000)}…` : json;
  } catch {
    return '{}';
  }
}

function buildAuthenticatedConversationalContext({ systemPrompt, context, user }) {
  return [
    'SMART SCHOOL TRANSPORT — REAL-TIME PHOTOREALISTIC HUMAN AVATAR SESSION',
    'You are a photorealistic young adult male digital human assistant (approximately 20–23 years old) for Smart School Transport, participating in a live, face-to-face video conversation.',
    'Personality and delivery: intelligent, polite, confident, friendly, and conversational. Speak with a warm, natural young-adult tone, clear pronunciation, and a helpful, approachable manner. Maintain natural eye contact and expressive, human-like presence in your delivery.',
    'Maintain the same assistant identity and character consistently throughout the conversation. Follow the system instructions and use only the authorized context provided. Preserve the existing Smart School Transport assistant behavior, knowledge boundaries, and safety rules.',
    'This is a live voice conversation: keep spoken responses concise, friendly, and easy to follow. Use short sentences. When listing steps, speak them in order. Listen attentively and respond naturally to interruptions and follow-ups.',
    '',
    'SYSTEM INSTRUCTIONS AND AUTHORIZED CONTEXT (authoritative):',
    systemPrompt,
    '',
    'SESSION METADATA (non-sensitive):',
    JSON.stringify({
      role: user?.role || null,
      scopedStudentId: context?.selectedChild?.studentId || context?.student?.studentId || null,
      contextGeneratedAt: context?.generatedAt || null,
      contextRole: context?.role || null,
    }),
    '',
    'NOTE: Authorized context is a point-in-time snapshot for this live session. If the user asks for something not present or time-sensitive beyond this snapshot, explain clearly and direct them to the appropriate in-app page.',
  ].join('\n');
}

function buildPublicConversationalContext() {
  const systemPrompt = buildPublicSystemPrompt();
  return [
    'SMART SCHOOL TRANSPORT — PUBLIC REAL-TIME PHOTOREALISTIC HUMAN AVATAR SESSION',
    'You are a photorealistic young adult male digital human assistant (approximately 20–23 years old) on the Smart School Transport public website, participating in a live, face-to-face video conversation.',
    'Personality and delivery: intelligent, polite, confident, friendly, and conversational. Speak with a warm, natural young-adult tone, clear pronunciation, and a helpful, approachable manner. Maintain natural eye contact and expressive, human-like presence in your delivery.',
    'Maintain the same assistant identity and character consistently throughout the conversation. Follow the public system instructions and approved information exactly. This is an unauthenticated public session.',
    'This is a live voice conversation: keep responses concise, friendly, and easy to follow. Listen attentively and respond naturally to interruptions and follow-ups.',
    '',
    'SYSTEM INSTRUCTIONS AND APPROVED PUBLIC INFORMATION (authoritative):',
    systemPrompt,
    '',
    'LIMITATIONS REMINDER:',
    JSON.stringify(APPROVED_PLATFORM_CONTEXT.limitations || []),
  ].join('\n');
}

function extractConversation(result) {
  if (!result || typeof result !== 'object') return null;
  const conversationId = result.conversation_id || result.conversationId || result.id || null;
  const conversationUrl =
    result.conversation_url ||
    result.conversationUrl ||
    result.url ||
    result.join_url ||
    result.joinUrl ||
    null;
  return {
    conversationId,
    conversationUrl,
    status: result.status || 'created',
    raw: undefined,
  };
}

export function getAvatarStatus() {
  const llm = getLlmProviderInfo();
  const enabled = aiConfig.tavusEnabled;
  return {
    avatar: {
      provider: 'tavus-cvi',
      available: enabled,
      enabled: Boolean(aiConfig.tavus.enabled),
      configured: Boolean(aiConfig.tavus.apiKey && aiConfig.tavus.replicaId),
      mode: enabled ? 'cvi' : 'unavailable',
      replicaId: aiConfig.tavus.replicaId || null,
      personaConfigured: Boolean(aiConfig.tavus.personaId),
      llm: {
        provider: llm.provider || null,
        configured: Boolean(llm.configured),
        model: llm.model || null,
      },
      message: enabled
        ? 'Real-time photorealistic human avatar is available.'
        : 'Real-time photorealistic human avatar is not configured on the server.',
    },
  };
}

export async function createAuthenticatedAvatarConversation(req, body = {}) {
  ensureTavusConfigured();

  // Enforce the same role-based scoping as the existing text assistant.
  const scope = await resolveScope(req.user, body.studentId);
  const context = await getScopedContext(req.user, scope);
  const systemPrompt = buildSystemPrompt(context);
  const conversationalContext = buildAuthenticatedConversationalContext({
    systemPrompt,
    context,
    user: req.user,
  });

  const defaultGreeting =
    req.user.role === 'parent'
      ? "Hi, I'm your Smart School Transport assistant. It's great to see you — how can I help with your child's transport today?"
      : req.user.role === 'driver'
      ? "Hi, I'm your Smart School Transport assistant. It's good to see you — how can I help with your route or trip today?"
      : req.user.role === 'admin'
      ? "Hi, I'm your Smart School Transport assistant. Great to connect with you — how can I help with transport operations today?"
      : "Hi, I'm your Smart School Transport assistant. It's great to see you — how can I help you today?";

  const payload = {
    replica_id: aiConfig.tavus.replicaId,
    conversation_name: `sst-${req.user.role}-${Date.now()}`,
    conversational_context: conversationalContext,
    custom_greeting: aiConfig.tavus.customGreeting || defaultGreeting,
    properties: {
      max_call_duration: aiConfig.tavus.conversationTimeoutSeconds,
      participant_left_timeout: 60,
      participant_absent_timeout: 120,
      enable_recording: false,
      apply_greenscreen: false,
      language: aiConfig.tavus.language || 'english',
    },
  };

  if (aiConfig.tavus.personaId) payload.persona_id = aiConfig.tavus.personaId;

  // Carry non-sensitive metadata for tracing; do not include PII or secrets.
  payload.conversation_metadata = {
    platform: 'smart-school-transport',
    role: req.user.role,
    scoped: Boolean(scope?.studentId),
  };

  const result = await tavusRequest('/v2/conversations', { method: 'POST', body: payload });
  const convo = extractConversation(result) || {};

  if (!convo.conversationUrl) {
    throw new ApiError(502, 'Avatar service did not return a conversation URL.');
  }

  return {
    conversationId: convo.conversationId,
    conversationUrl: convo.conversationUrl,
    status: convo.status || 'created',
    provider: 'tavus-cvi',
    scope: scope?.studentId ? { studentId: String(scope.studentId) } : {},
  };
}

export async function createPublicAvatarConversation(_req, _body = {}) {
  ensureTavusConfigured();

  const conversationalContext = buildPublicConversationalContext();
  const payload = {
    replica_id: aiConfig.tavus.replicaId,
    conversation_name: `sst-public-${Date.now()}`,
    conversational_context: conversationalContext,
    custom_greeting:
      aiConfig.tavus.publicGreeting ||
      aiConfig.tavus.customGreeting ||
      "Hi, welcome to Smart School Transport. I'm your digital assistant — it's great to meet you. How can I help you today?",
    properties: {
      max_call_duration: Math.min(aiConfig.tavus.conversationTimeoutSeconds, 900),
      participant_left_timeout: 60,
      participant_absent_timeout: 120,
      enable_recording: false,
      apply_greenscreen: false,
      language: aiConfig.tavus.language || 'english',
    },
  };

  if (aiConfig.tavus.personaId) payload.persona_id = aiConfig.tavus.personaId;
  payload.conversation_metadata = { platform: 'smart-school-transport', role: 'public' };

  const result = await tavusRequest('/v2/conversations', { method: 'POST', body: payload });
  const convo = extractConversation(result) || {};

  if (!convo.conversationUrl) {
    throw new ApiError(502, 'Avatar service did not return a conversation URL.');
  }

  return {
    conversationId: convo.conversationId,
    conversationUrl: convo.conversationUrl,
    status: convo.status || 'created',
    provider: 'tavus-cvi',
  };
}

export async function endAvatarConversation(conversationId) {
  ensureTavusConfigured();
  if (!conversationId) throw new ApiError(400, 'conversationId is required');
  // Best-effort: Tavus conversations also end when the room is left, but we
  // provide an explicit server-side end for cleanup.
  try {
    await tavusRequest(`/v2/conversations/${encodeURIComponent(conversationId)}/end`, {
      method: 'POST',
      body: {},
    });
  } catch (err) {
    // If it's already ended/not found, treat as success to avoid blocking UI.
    const msg = String(err?.message || '').toLowerCase();
    if (msg.includes('not found') || msg.includes('already')) return { ended: true };
    throw err;
  }
  return { ended: true };
}
