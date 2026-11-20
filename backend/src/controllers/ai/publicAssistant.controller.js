import { asyncHandler, ok } from '../../utils/http.js';
import * as publicAssistant from '../../services/ai/publicAssistant.service.js';

export const status = asyncHandler(async (_req, res) => {
  ok(res, publicAssistant.getPublicAssistantStatus());
});

export const sendMessage = asyncHandler(async (req, res) => {
  ok(res, await publicAssistant.sendPublicMessage(req, req.body || {}));
});
