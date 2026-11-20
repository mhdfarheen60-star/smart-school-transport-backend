import crypto from 'node:crypto';
import { DeviceToken } from '../models/index.js';

const FCM_SCOPE = 'https://www.googleapis.com/auth/firebase.messaging';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';

let cachedToken = null;
let cachedTokenExpiresAt = 0;

function normalizePrivateKey(value) {
  if (!value) return '';
  // Environment variables commonly store the key with literal \n sequences.
  return String(value).replace(/\\n/g, '\n').trim();
}

function readServiceAccount() {
  const raw = process.env.FCM_SERVICE_ACCOUNT_JSON;
  if (raw && raw.trim()) {
    try {
      const parsed = JSON.parse(raw);
      if (parsed.project_id && parsed.client_email && parsed.private_key) {
        return {
          projectId: parsed.project_id,
          clientEmail: parsed.client_email,
          privateKey: normalizePrivateKey(parsed.private_key),
          source: 'FCM_SERVICE_ACCOUNT_JSON',
        };
      }
    } catch {
      // Fall through to individual variables and report the parse problem.
      return {
        projectId: '',
        clientEmail: '',
        privateKey: '',
        source: 'FCM_SERVICE_ACCOUNT_JSON',
        parseError: 'FCM_SERVICE_ACCOUNT_JSON is not valid JSON',
      };
    }
  }

  const projectId = (process.env.FCM_PROJECT_ID || '').trim();
  const clientEmail = (process.env.FCM_CLIENT_EMAIL || '').trim();
  const privateKey = normalizePrivateKey(process.env.FCM_PRIVATE_KEY);
  if (projectId && clientEmail && privateKey) {
    return { projectId, clientEmail, privateKey, source: 'FCM_*' };
  }
  return { projectId, clientEmail, privateKey, source: null };
}

export function getPushStatus() {
  const account = readServiceAccount();
  const configured = Boolean(account.projectId && account.clientEmail && account.privateKey);
  return {
    provider: 'fcm',
    transport: 'firebase_cloud_messaging_v1',
    configured,
    mode: configured ? 'external' : 'unconfigured',
    source: account.source,
    reason: configured
      ? null
      : account.parseError ||
        'Push notifications are not configured. Set FCM_PROJECT_ID, FCM_CLIENT_EMAIL and FCM_PRIVATE_KEY (or FCM_SERVICE_ACCOUNT_JSON) to enable Firebase Cloud Messaging. In-app notifications remain available.',
  };
}

async function getAccessToken() {
  const account = readServiceAccount();
  if (!account.projectId || !account.clientEmail || !account.privateKey) {
    throw new Error('FCM credentials are not configured');
  }

  const now = Math.floor(Date.now() / 1000);
  if (cachedToken && cachedTokenExpiresAt - 60 > now) return cachedToken;

  const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
  const claims = Buffer.from(
    JSON.stringify({
      iss: account.clientEmail,
      scope: FCM_SCOPE,
      aud: TOKEN_URL,
      iat: now,
      exp: now + 3600,
    })
  ).toString('base64url');

  const signer = crypto.createSign('RSA-SHA256');
  signer.update(`${header}.${claims}`);
  const signature = signer.sign(account.privateKey).toString('base64url');
  const assertion = `${header}.${claims}.${signature}`;

  const body = new URLSearchParams({
    grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
    assertion,
  });

  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });

  const json = await res.json().catch(() => null);
  if (!res.ok || !json?.access_token) {
    const detail = json?.error_description || json?.error || `HTTP ${res.status}`;
    throw new Error(`FCM OAuth token request failed: ${detail}`);
  }

  cachedToken = json.access_token;
  cachedTokenExpiresAt = now + Number(json.expires_in || 3600);
  return cachedToken;
}

async function sendToToken({ projectId, accessToken, token, title, body, data }) {
  const message = {
    message: {
      token,
      notification: { title, body },
      data: Object.fromEntries(
        Object.entries(data || {}).map(([k, v]) => [k, v == null ? '' : String(v)])
      ),
      android: {
        priority: 'high',
        notification: { channel_id: 'trip_updates', sound: 'default' },
      },
      apns: {
        payload: { aps: { sound: 'default', 'content-available': 1 } },
      },
    },
  };

  const res = await fetch(`https://fcm.googleapis.com/v1/projects/${projectId}/messages:send`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(message),
  });

  if (res.ok) return { ok: true };

  const json = await res.json().catch(() => null);
  const errorCode =
    json?.error?.details?.find((d) => d['@type']?.includes('FcmError'))?.errorCode ||
    json?.error?.status ||
    `HTTP_${res.status}`;
  return {
    ok: false,
    status: res.status,
    errorCode,
    message: json?.error?.message || `FCM send failed (${res.status})`,
    invalidToken:
      res.status === 404 ||
      errorCode === 'UNREGISTERED' ||
      errorCode === 'INVALID_ARGUMENT' ||
      errorCode === 'SENDER_ID_MISMATCH',
  };
}

/**
 * Send a push notification to every active device token for the given users.
 * Never throws: callers use this from notification fan-out where in-app delivery
 * must succeed even when the push provider is unavailable.
 */
export async function sendPushToUsers(userIds, { title, body, data } = {}) {
  const status = getPushStatus();
  const uniqueUsers = [...new Set((userIds || []).map(String).filter(Boolean))];
  if (!uniqueUsers.length) {
    return { configured: status.configured, attempted: 0, sent: 0, failed: 0, invalidated: 0 };
  }

  const tokens = await DeviceToken.find({ user: { $in: uniqueUsers }, isActive: true }).lean();
  if (!tokens.length) {
    return { configured: status.configured, attempted: 0, sent: 0, failed: 0, invalidated: 0, reason: 'no_registered_devices' };
  }
  if (!status.configured) {
    return {
      configured: false,
      attempted: 0,
      sent: 0,
      failed: 0,
      invalidated: 0,
      skipped: tokens.length,
      reason: status.reason,
    };
  }

  const account = readServiceAccount();
  let accessToken;
  try {
    accessToken = await getAccessToken();
  } catch (err) {
    return {
      configured: true,
      attempted: tokens.length,
      sent: 0,
      failed: tokens.length,
      invalidated: 0,
      error: err.message,
    };
  }

  let sent = 0;
  let failed = 0;
  let invalidated = 0;
  const invalidIds = [];

  for (const t of tokens) {
    try {
      const result = await sendToToken({
        projectId: account.projectId,
        accessToken,
        token: t.token,
        title: title || 'Smart School Transport',
        body: body || '',
        data,
      });
      if (result.ok) {
        sent += 1;
        await DeviceToken.updateOne({ _id: t._id }, { $set: { lastUsedAt: new Date() } }).catch(() => {});
      } else {
        failed += 1;
        if (result.invalidToken) {
          invalidated += 1;
          invalidIds.push(t._id);
        }
      }
    } catch {
      failed += 1;
    }
  }

  if (invalidIds.length) {
    await DeviceToken.updateMany({ _id: { $in: invalidIds } }, { $set: { isActive: false } }).catch(() => {});
  }

  return { configured: true, attempted: tokens.length, sent, failed, invalidated };
}
