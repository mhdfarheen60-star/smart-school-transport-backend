import { asyncHandler, ok } from '../../utils/http.js';
import { getAiStatus } from '../../services/ai/status.js';

export const status = asyncHandler(async (_req, res) => {
  ok(res, getAiStatus());
});
