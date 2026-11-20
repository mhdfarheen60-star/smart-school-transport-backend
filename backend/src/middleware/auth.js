import jwt from 'jsonwebtoken';
import { env } from '../config/env.js';
import { User } from '../models/index.js';
import { ApiError, asyncHandler } from '../utils/http.js';

export function signToken(userId, role, tokenVersion = 0) {
  const options = {
    algorithm: 'HS256',
    expiresIn: env.jwtExpiresIn,
    issuer: env.jwtIssuer,
    audience: env.jwtAudience,
  };
  return jwt.sign({ sub: userId, role, ver: tokenVersion }, env.jwtSecret, options);
}

export const authenticate = asyncHandler(async (req, _res, next) => {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) throw new ApiError(401, 'Authentication required');
  if (header.length > 4096) throw new ApiError(401, 'Invalid or expired session. Please sign in again.');

  let payload;
  try {
    const decoded = jwt.verify(header.slice(7), env.jwtSecret, {
      algorithms: ['HS256'],
      issuer: env.jwtIssuer,
      audience: env.jwtAudience,
    });
    if (typeof decoded === 'string' || !decoded.sub) throw new Error('Invalid payload');
    payload = decoded;
  } catch {
    throw new ApiError(401, 'Invalid or expired session. Please sign in again.');
  }

  const user = await User.findById(payload.sub).select('name role isActive tokenVersion');
  if (!user || !user.isActive) throw new ApiError(401, 'Account not found or disabled');
  if (Number(payload.ver ?? 0) !== Number(user.tokenVersion ?? 0)) {
    throw new ApiError(401, 'Session is no longer valid. Please sign in again.');
  }
  req.user = { id: user.id, role: user.role, name: user.name };
  next();
});

export const authorize =
  (...roles) =>
  (req, _res, next) => {
    if (!req.user) return next(new ApiError(401, 'Authentication required'));
    if (!roles.includes(req.user.role)) {
      return next(new ApiError(403, 'You do not have permission to perform this action'));
    }
    next();
  };
