import dotenv from 'dotenv';

dotenv.config();

const nodeEnv = (process.env.NODE_ENV || 'development').trim();
const isProd = nodeEnv === 'production';

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing required environment variable ${name}`);
  return value;
}

function parseTrustProxy(value) {
  if (!value) return false;
  const trimmed = value.trim();
  if (trimmed === '' || trimmed === 'false' || trimmed === '0') return false;
  if (trimmed === 'true') return true;
  if (/^\d+$/.test(trimmed)) return Number(trimmed);
  return trimmed;
}

const KNOWN_WEAK_JWT_SECRETS = new Set([
  'secret',
  'jwt_secret',
  'changeme',
  'change_me',
  'change_me_please',
  'your_strong_secret',
  'change_this_to_a_strong_secret_at_least_32_chars_long',
  'replace_with_a_long_random_secret',
]);

const jwtSecret = required('JWT_SECRET');
if (jwtSecret.length < 32) {
  throw new Error('JWT_SECRET must be at least 32 characters long');
}
if (KNOWN_WEAK_JWT_SECRETS.has(jwtSecret.toLowerCase())) {
  throw new Error('JWT_SECRET is a known placeholder. Generate a random secret before starting the API.');
}

const normalizeOrigin = (origin) => origin.replace(/\/+$/, '');
const clientUrls = (process.env.CLIENT_URL || 'http://localhost:5173')
  .split(',')
  .map((origin) => normalizeOrigin(origin.trim()))
  .filter(Boolean);

if (!clientUrls.length) throw new Error('CLIENT_URL must contain at least one allowed origin');

for (const origin of clientUrls) {
  if (origin === '*') throw new Error('CLIENT_URL cannot be "*" when credentials are enabled');
  try {
    new URL(origin);
  } catch {
    throw new Error(`CLIENT_URL contains an invalid origin: ${origin}`);
  }
}

if (isProd && clientUrls.some((origin) => !origin.startsWith('https://'))) {
  throw new Error('CLIENT_URL must use https:// in production');
}

const port = Number(process.env.PORT || 5000);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error('PORT must be an integer between 1 and 65535');
}

const authRateLimit = Number(process.env.AUTH_RATE_LIMIT || 30);
if (!Number.isInteger(authRateLimit) || authRateLimit < 1 || authRateLimit > 10000) {
  throw new Error('AUTH_RATE_LIMIT must be an integer between 1 and 10000');
}

export const env = {
  port,
  mongoUri: required('MONGO_URI'),
  jwtSecret,
  jwtIssuer: (process.env.JWT_ISSUER || 'smart-school-transport').trim(),
  jwtAudience: (process.env.JWT_AUDIENCE || 'smart-school-transport-api').trim(),
  jwtExpiresIn: (process.env.JWT_EXPIRES_IN || '1d').trim(),
  clientUrls,
  clientUrl: clientUrls[0],
  nodeEnv,
  isProd,
  trustProxy: parseTrustProxy(process.env.TRUST_PROXY),
  authRateLimit,
};
