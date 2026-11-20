import { asyncHandler, ok } from '../../utils/http.js';
import * as geofences from '../../services/ai/geofence.service.js';

export const list = asyncHandler(async (req, res) => {
  ok(res, await geofences.listGeofences(req.query || {}));
});

export const get = asyncHandler(async (req, res) => {
  ok(res, await geofences.getGeofence(req.params.id));
});

export const create = asyncHandler(async (req, res) => {
  ok(res, await geofences.createGeofence(req, req.body || {}), undefined, 201);
});

export const update = asyncHandler(async (req, res) => {
  ok(res, await geofences.updateGeofence(req, req.params.id, req.body || {}));
});

export const remove = asyncHandler(async (req, res) => {
  ok(res, await geofences.deleteGeofence(req.params.id));
});
