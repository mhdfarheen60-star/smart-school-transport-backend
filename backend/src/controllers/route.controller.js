import { Route, Trip, TransportAssignment } from '../models/index.js';
import { audit } from '../services/audit.service.js';
import { getRouteMetrics } from '../services/ai/providers/routing.js';
import { ApiError, asyncHandler, ok } from '../utils/http.js';
import { paginate } from '../utils/paginate.js';

function coord(value, min, max) {
  if (value === null || value === undefined || value === '') return undefined;
  const n = Number(value);
  if (!Number.isFinite(n) || n < min || n > max) return undefined;
  return n;
}

function normaliseGeo(geo) {
  if (!geo) return undefined;
  const latitude = coord(geo.latitude, -90, 90);
  const longitude = coord(geo.longitude, -180, 180);
  if (latitude === undefined || longitude === undefined) return undefined;
  return {
    latitude,
    longitude,
    address: geo.address ? String(geo.address).slice(0, 300) : undefined,
    landmark: geo.landmark ? String(geo.landmark).slice(0, 200) : undefined,
    ...(geo.placeId ? { placeId: String(geo.placeId).slice(0, 300) } : {}),
  };
}

function normaliseStops(stops) {
  const sorted = [...stops].sort((a, b) => a.sequence - b.sequence);
  const seen = new Set();
  for (const s of sorted) {
    if (seen.has(s.sequence)) throw new ApiError(422, `Duplicate stop sequence ${s.sequence}`);
    seen.add(s.sequence);
  }
  return sorted.map((s) => ({
    name: s.name,
    sequence: s.sequence,
    pickupTime: s.pickupTime || undefined,
    dropTime: s.dropTime || undefined,
    latitude: coord(s.latitude, -90, 90),
    longitude: coord(s.longitude, -180, 180),
    address: s.address ? String(s.address).slice(0, 300) : undefined,
    landmark: s.landmark ? String(s.landmark).slice(0, 200) : undefined,
    type: s.type || 'both',
  }));
}

export const list = asyncHandler(async (req, res) => {
  const q = req.query;
  const filter = {};
  if (q.status) filter.status = q.status;
  const { items, meta } = await paginate(Route, filter, q, {
    sortable: ['name', 'status'],
    searchFields: ['name', 'description', 'stops.name', 'stops.address'],
  });
  ok(res, items, meta);
});

export const options = asyncHandler(async (_req, res) => {
  ok(res, await Route.find({ status: 'active' }).sort('name').lean());
});

export const getOne = asyncHandler(async (req, res) => {
  const r = await Route.findById(req.params.id).lean();
  if (!r) throw new ApiError(404, 'Route not found');
  ok(res, r);
});

export const create = asyncHandler(async (req, res) => {
  const body = { ...req.body, stops: normaliseStops(req.body.stops) };
  if (req.body.schoolLocation !== undefined) body.schoolLocation = normaliseGeo(req.body.schoolLocation);
  if (req.body.startLocation !== undefined) body.startLocation = normaliseGeo(req.body.startLocation);
  if (req.body.endLocation !== undefined) body.endLocation = normaliseGeo(req.body.endLocation);
  const r = await Route.create(body);
  await audit(req, 'create', 'Route', r.id);
  ok(res, r, undefined, 201);
});

export const update = asyncHandler(async (req, res) => {
  const r = await Route.findById(req.params.id);
  if (!r) throw new ApiError(404, 'Route not found');
  const body = { ...req.body };
  if (body.stops) body.stops = normaliseStops(body.stops);
  if (body.schoolLocation !== undefined) body.schoolLocation = normaliseGeo(body.schoolLocation);
  if (body.startLocation !== undefined) body.startLocation = normaliseGeo(body.startLocation);
  if (body.endLocation !== undefined) body.endLocation = normaliseGeo(body.endLocation);
  // Editing stops invalidates previously computed geometry; force a recompute
  // instead of presenting stale road distance as current.
  if (body.stops) {
    body.geometry = [];
    body.metricsMode = 'none';
    body.metricsIsFallback = true;
    body.metricsSource = undefined;
    body.distanceKm = undefined;
    body.durationMinutes = undefined;
    body.metricsUpdatedAt = undefined;
  }
  r.set(body);
  await r.save();
  await audit(req, 'update', 'Route', r.id);
  ok(res, r);
});

/**
 * Compute and persist road-network metrics + geometry for a route.
 * The response explicitly states whether the values came from a real routing
 * provider or the deterministic straight-line fallback.
 */
export const computeMetrics = asyncHandler(async (req, res) => {
  const route = await Route.findById(req.params.id);
  if (!route) throw new ApiError(404, 'Route not found');

  const stops = [...(route.stops || [])].sort((a, b) => a.sequence - b.sequence);
  const points = [];
  const start = normaliseGeo(route.startLocation) || normaliseGeo(route.schoolLocation);
  if (start) points.push(start);
  for (const s of stops) {
    if (s.latitude != null && s.longitude != null) {
      points.push({ latitude: s.latitude, longitude: s.longitude });
    }
  }
  const end = normaliseGeo(route.endLocation) || normaliseGeo(route.schoolLocation);
  if (end) {
    const last = points[points.length - 1];
    if (!last || last.latitude !== end.latitude || last.longitude !== end.longitude) points.push(end);
  }

  if (points.length < 2) {
    throw new ApiError(
      422,
      'At least two stops with coordinates (or a start/school location) are required to compute route metrics.'
    );
  }

  const metrics = await getRouteMetrics(points, {
    timeoutMs: req.body?.timeoutMs,
  });

  if (!metrics?.ok) {
    throw new ApiError(502, metrics?.message || 'Routing provider could not compute route metrics');
  }

  route.geometry = Array.isArray(metrics.geometry)
    ? metrics.geometry
        .map((p) => ({ latitude: Number(p.latitude), longitude: Number(p.longitude) }))
        .filter((p) => Number.isFinite(p.latitude) && Number.isFinite(p.longitude))
    : [];
  route.distanceKm = metrics.distanceKm != null ? Number(metrics.distanceKm) : undefined;
  route.durationMinutes = metrics.durationMinutes != null ? Number(metrics.durationMinutes) : undefined;
  route.metricsSource = metrics.source || metrics.provider || 'unknown';
  route.metricsMode = metrics.mode === 'external' ? 'external' : 'fallback';
  route.metricsIsFallback = Boolean(metrics.isFallback || metrics.mode !== 'external');
  route.metricsUpdatedAt = new Date();
  await route.save();

  await audit(req, 'route_metrics', 'Route', route.id, {
    source: route.metricsSource,
    mode: route.metricsMode,
    isFallback: route.metricsIsFallback,
    distanceKm: route.distanceKm,
    durationMinutes: route.durationMinutes,
  });

  ok(res, {
    route,
    metrics: {
      provider: metrics.provider,
      source: metrics.source,
      mode: metrics.mode,
      isFallback: route.metricsIsFallback,
      distanceSource: metrics.distanceSource,
      durationSource: metrics.durationSource,
      geometrySource: metrics.geometrySource,
      distanceKm: route.distanceKm ?? null,
      durationMinutes: route.durationMinutes ?? null,
      message: metrics.message,
    },
  });
});

export const remove = asyncHandler(async (req, res) => {
  const r = await Route.findById(req.params.id);
  if (!r) throw new ApiError(404, 'Route not found');
  if (await TransportAssignment.exists({ route: r._id, status: 'active' })) {
    throw new ApiError(409, 'Route is used by an active assignment');
  }
  if ((await Trip.exists({ route: r._id })) || (await TransportAssignment.exists({ route: r._id }))) {
    throw new ApiError(409, 'Route has trip history and cannot be deleted. Mark it inactive instead.');
  }
  await r.deleteOne();
  await audit(req, 'delete', 'Route', r.id);
  ok(res, { deleted: true });
});
