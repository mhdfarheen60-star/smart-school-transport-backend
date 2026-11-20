import { asyncHandler, ok } from '../../utils/http.js';
import * as routeOpt from '../../services/ai/routeOptimization.service.js';

export const optimize = asyncHandler(async (req, res) => {
  const data = await routeOpt.createOptimization(req, req.body || {});
  ok(res, data, undefined, 201);
});

export const suggestions = asyncHandler(async (req, res) => {
  const { items, meta } = await routeOpt.listSuggestions(req.query || {});
  ok(res, items, meta);
});

export const history = asyncHandler(async (req, res) => {
  const { items, meta } = await routeOpt.listHistory(req.query || {});
  ok(res, items, meta);
});

export const comparison = asyncHandler(async (req, res) => {
  ok(res, await routeOpt.getComparison(req.params.id));
});

export const approve = asyncHandler(async (req, res) => {
  ok(res, await routeOpt.reviewSuggestion(req, req.params.id, 'approved', req.body?.notes));
});

export const reject = asyncHandler(async (req, res) => {
  ok(res, await routeOpt.reviewSuggestion(req, req.params.id, 'rejected', req.body?.notes));
});
