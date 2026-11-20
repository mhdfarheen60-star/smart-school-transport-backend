import { asyncHandler, ok } from '../../utils/http.js';
import * as tavus from '../../services/ai/tavus.service.js';

export const status = asyncHandler(async (_req, res) => {
  ok(res, tavus.getAvatarStatus());
});

export const createConversation = asyncHandler(async (req, res) => {
  ok(res, await tavus.createAuthenticatedAvatarConversation(req, req.body || {}), undefined, 201);
});

export const endConversation = asyncHandler(async (req, res) => {
  ok(res, await tavus.endAvatarConversation(req.params.id));
});

export const publicStatus = asyncHandler(async (_req, res) => {
  ok(res, tavus.getAvatarStatus());
});

export const createPublicConversation = asyncHandler(async (req, res) => {
  ok(res, await tavus.createPublicAvatarConversation(req, req.body || {}), undefined, 201);
});
