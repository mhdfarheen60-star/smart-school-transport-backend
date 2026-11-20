import { asyncHandler, ok } from '../../utils/http.js';
import * as safety from '../../services/ai/safety.service.js';

export const overview = asyncHandler(async (req, res) => {
  ok(res, await safety.overview(req));
});

export const analyze = asyncHandler(async (req, res) => {
  ok(res, await safety.analyze(req, req.body || {}));
});

export const listAlerts = asyncHandler(async (req, res) => {
  ok(res, await safety.listAlerts(req, req.query || {}));
});

export const getAlert = asyncHandler(async (req, res) => {
  ok(res, await safety.getAlert(req, req.params.id));
});

export const acknowledge = asyncHandler(async (req, res) => {
  ok(res, await safety.acknowledge(req, req.params.id, req.body || {}));
});

export const resolve = asyncHandler(async (req, res) => {
  ok(res, await safety.resolve(req, req.params.id, req.body || {}));
});