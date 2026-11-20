import { asyncHandler, ok } from '../../utils/http.js';
import * as maintenance from '../../services/ai/maintenance.service.js';

export const overview = asyncHandler(async (req, res) => {
  ok(res, await maintenance.getOverview(req));
});

export const vehicles = asyncHandler(async (req, res) => {
  const data = await maintenance.getOverview(req);
  ok(res, data.vehicles, { counts: data.counts, generatedAt: data.generatedAt, dataLimitations: data.dataLimitations });
});

export const vehicleDetail = asyncHandler(async (req, res) => {
  ok(res, await maintenance.getVehicleDetail(req, req.params.vehicleId));
});

export const analyze = asyncHandler(async (req, res) => {
  if (req.body?.vehicleId) {
    ok(res, await maintenance.analyzeVehicle(req, req.body.vehicleId));
  } else {
    ok(res, await maintenance.analyzeAll(req));
  }
});

export const predictions = asyncHandler(async (req, res) => {
  const { items, meta } = await maintenance.listPredictions(req, req.query || {});
  ok(res, items, meta);
});

export const createRecord = asyncHandler(async (req, res) => {
  ok(res, await maintenance.createMaintenanceRecord(req, req.body), undefined, 201);
});

export const listRecords = asyncHandler(async (req, res) => {
  const { items, meta } = await maintenance.listMaintenanceRecords(req, req.query || {});
  ok(res, items, meta);
});
