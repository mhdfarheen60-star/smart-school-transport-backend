import { Geofence, Route, Vehicle } from '../../models/index.js';
import { ApiError } from '../../utils/http.js';

export async function listGeofences(query = {}) {
  const filter = {};
  if (query.active != null) filter.active = String(query.active) === 'true';
  if (query.scope) filter.scope = query.scope;
  if (query.route) filter.route = query.route;
  if (query.vehicle) filter.vehicle = query.vehicle;
  const items = await Geofence.find(filter)
    .sort('-createdAt')
    .populate('route', 'name status')
    .populate('vehicle', 'busNumber registrationNumber status')
    .populate('createdBy', 'name role')
    .populate('updatedBy', 'name role')
    .lean();
  return { items };
}

export async function getGeofence(id) {
  const gf = await Geofence.findById(id)
    .populate('route', 'name status stops')
    .populate('vehicle', 'busNumber registrationNumber status')
    .populate('createdBy', 'name role')
    .populate('updatedBy', 'name role')
    .lean();
  if (!gf) throw new ApiError(404, 'Geofence not found');
  return gf;
}

function normalizePayload(body, userId, { partial = false } = {}) {
  const out = { ...body };
  if (out.description === '') out.description = undefined;
  if (!partial || body.center) {
    if (out.center && (out.center.latitude == null || out.center.longitude == null)) delete out.center;
  }
  if (out.path && Array.isArray(out.path)) {
    out.path = out.path
      .map((p) => ({ latitude: Number(p.latitude), longitude: Number(p.longitude) }))
      .filter((p) => Number.isFinite(p.latitude) && Number.isFinite(p.longitude));
    if (!out.path.length) delete out.path;
  }
  if (userId) out.updatedBy = userId;
  return out;
}

export async function createGeofence(req, body) {
  if (body.scope === 'route' && body.route) {
    const route = await Route.findById(body.route).select('_id');
    if (!route) throw new ApiError(404, 'Route not found');
  }
  if (body.scope === 'vehicle' && body.vehicle) {
    const vehicle = await Vehicle.findById(body.vehicle).select('_id');
    if (!vehicle) throw new ApiError(404, 'Vehicle not found');
  }
  const payload = normalizePayload(body, req.user?.id);
  payload.createdBy = req.user?.id;
  const gf = await Geofence.create(payload);
  return getGeofence(gf._id);
}

export async function updateGeofence(req, id, body) {
  const gf = await Geofence.findById(id);
  if (!gf) throw new ApiError(404, 'Geofence not found');
  const payload = normalizePayload(body, req.user?.id, { partial: true });
  // Validate scope refs if changed/provided
  const scope = payload.scope || gf.scope;
  const route = payload.route !== undefined ? payload.route : gf.route;
  const vehicle = payload.vehicle !== undefined ? payload.vehicle : gf.vehicle;
  if (scope === 'route' && route) {
    const r = await Route.findById(route).select('_id');
    if (!r) throw new ApiError(404, 'Route not found');
  }
  if (scope === 'vehicle' && vehicle) {
    const v = await Vehicle.findById(vehicle).select('_id');
    if (!v) throw new ApiError(404, 'Vehicle not found');
  }
  Object.assign(gf, payload);
  // Basic consistency: ensure required fields still present for type
  if ((gf.type === 'zone' || gf.type === 'stop_radius') && !(gf.center?.latitude != null && gf.center?.longitude != null && gf.radiusMeters)) {
    throw new ApiError(422, 'Zone/stop radius geofences require center and radiusMeters');
  }
  if (gf.type === 'route_corridor' && !((gf.path && gf.path.length >= 2) || (gf.center?.latitude != null && gf.radiusMeters))) {
    throw new ApiError(422, 'Route corridor geofences require a path (>=2 points) or center+radiusMeters');
  }
  await gf.save();
  return getGeofence(gf._id);
}

export async function deleteGeofence(id) {
  const gf = await Geofence.findById(id);
  if (!gf) throw new ApiError(404, 'Geofence not found');
  await gf.deleteOne();
  return { deleted: true, id };
}
