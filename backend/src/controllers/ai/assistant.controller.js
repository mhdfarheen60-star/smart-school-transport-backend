import { asyncHandler, ok } from '../../utils/http.js';
import * as assistant from '../../services/ai/assistant.service.js';

export const listConversations = asyncHandler(async (req, res) => {
  ok(res, await assistant.listConversations(req));
});

export const createConversation = asyncHandler(async (req, res) => {
  ok(res, await assistant.createConversation(req, req.body || {}), undefined, 201);
});

export const getConversation = asyncHandler(async (req, res) => {
  ok(res, await assistant.getConversation(req, req.params.id));
});

export const sendMessage = asyncHandler(async (req, res) => {
  ok(res, await assistant.sendMessage(req, req.body || {}));
});