import { asyncHandler, ok } from '../utils/http.js';
import * as tripLocationService from '../services/tripLocation.service.js';

export const ingest = asyncHandler(async (req, res) => {
  const result = await tripLocationService.ingestTripLocation(req, req.params.id, req.body);
  ok(res, result, undefined, 201);
});

export const list = asyncHandler(async (req, res) => {
  const result = await tripLocationService.listTripLocations(req, req.params.id, req.query);
  ok(res, result.items, { count: result.count, limit: result.limit });
});

export const latest = asyncHandler(async (req, res) => {
  // authorized read; reuse list access via service? latest exposed separately for convenience
  await tripLocationService.listTripLocations(req, req.params.id, { limit: 1 });
  const result = await tripLocationService.getTripLocationSummary(req.params.id);
  ok(res, result);
});
