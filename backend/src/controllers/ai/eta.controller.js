import { asyncHandler, ok } from '../../utils/http.js';
import * as eta from '../../services/ai/eta.service.js';

export const predict = asyncHandler(async (req, res) => {
  ok(res, await eta.predictForTrip(req, req.body.tripId), undefined, 201);
});

export const byTrip = asyncHandler(async (req, res) => {
  ok(res, await eta.getLatestForTrip(req, req.params.tripId));
});

export const history = asyncHandler(async (req, res) => {
  const { items, meta } = await eta.listHistory(req, req.query || {});
  ok(res, items, meta);
});

export const overview = asyncHandler(async (req, res) => {
  ok(res, await eta.getOverview(req));
});
