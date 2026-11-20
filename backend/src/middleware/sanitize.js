import { ApiError } from '../utils/http.js';

const MAX_DEPTH = 8;
const MAX_QUERY_VALUE_LENGTH = 500;
const MAX_ARRAY_LENGTH = 1000;
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function isPlainObject(value) {
  if (!value || typeof value !== 'object') return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function sanitizeBody(value, depth) {
  if (depth > MAX_DEPTH) throw new ApiError(400, 'Request body is too deeply nested');
  if (Array.isArray(value)) {
    if (value.length > MAX_ARRAY_LENGTH) throw new ApiError(400, 'Request body contains too many items');
    return value.map((item) => sanitizeBody(item, depth + 1));
  }
  if (isPlainObject(value)) {
    const clean = {};
    for (const [key, item] of Object.entries(value)) {
      if (key.includes('$') || key.includes('.') || key.includes('[') || key.includes(']') || FORBIDDEN_KEYS.has(key)) {
        throw new ApiError(400, 'Request contains an invalid field name');
      }
      clean[key] = sanitizeBody(item, depth + 1);
    }
    return clean;
  }
  return value;
}

export function sanitizeRequest(req, _res, next) {
  try {
    if (req.body && typeof req.body === 'object') {
      req.body = sanitizeBody(req.body, 0);
    }

    for (const [key, value] of Object.entries(req.query)) {
      if (typeof value !== 'string') throw new ApiError(400, `Invalid query parameter: ${key}`);
      if (key.length > 100 || value.length > MAX_QUERY_VALUE_LENGTH) {
        throw new ApiError(400, `Query parameter is too long: ${key}`);
      }
      if (key.includes('$') || key.includes('.') || key.includes('[') || key.includes(']') || FORBIDDEN_KEYS.has(key)) {
        throw new ApiError(400, `Invalid query parameter: ${key}`);
      }
    }

    next();
  } catch (err) {
    next(err);
  }
}
