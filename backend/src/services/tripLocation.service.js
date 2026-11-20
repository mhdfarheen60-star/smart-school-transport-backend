import { Driver, SchoolConfig, Trip, TripLocation, VehicleCurrentLocation } from '../models/index.js';
import { ApiError } from '../utils/http.js';
import { assertCanAccessTrip } from './ai/rbac.js';
import { emitToFleet, emitToTrip } from './realtime.service.js';

const MIN_UPDATE_INTERVAL_MS = 10 * 1000; // server-side throttling: min 10s between accepted points per trip
const MAX_FUTURE_SKEW_MS = 5 * 60 * 1000; // allow 5 min clock skew
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // reject points older than 7 days as ingestion timestamps
const STALE_LOCATION_MS = 2 * 60 * 1000; // >2 min considered stale for "latest live" use
const DEFAULT_RETENTION_DAYS = 30;
const TRACKING_STATUSES = new Set(['in_progress', 'delayed', 'paused', 'arrived_at_school']);
const TERMINAL_STATUSES = new Set(['completed', 'cancelled']);

function normalizePoint(lat, lng) {
  const latitude = Number(lat);
  const longitude = Number(lng);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
  if (latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) return null;
  return { latitude, longitude };
}

async function getDriverProfileForUser(userId) {
  const d = await Driver.findOne({ user: userId });
  if (!d) throw new ApiError(404, 'Driver profile not found');
  return d;
}

export async function ingestTripLocation(req, tripId, payload) {
  const trip = await Trip.findById(tripId).lean();
  if (!trip) throw new ApiError(404, 'Trip not found');

  // RBAC: driver can ingest only for their own trip; admin can ingest for operational needs.
  if (req.user.role === 'driver') {
    const driver = await getDriverProfileForUser(req.user.id);
    if (String(trip.driver) !== String(driver._id)) {
      throw new ApiError(403, 'You can only submit location for your own trip');
    }
  } else if (req.user.role !== 'admin') {
    throw new ApiError(403, 'Not authorized to submit trip locations');
  }

  if (TERMINAL_STATUSES.has(trip.status)) {
    throw new ApiError(409, `Cannot ingest location for a ${trip.status} trip`);
  }
  if (!TRACKING_STATUSES.has(trip.status)) {
    throw new ApiError(409, `Cannot ingest location for a ${trip.status} trip`);
  }

  const point = normalizePoint(payload.latitude, payload.longitude);
  if (!point) throw new ApiError(422, 'Invalid coordinates');

  const recordedAt = payload.recordedAt ? new Date(payload.recordedAt) : null;
  if (!recordedAt || Number.isNaN(recordedAt.getTime())) throw new ApiError(422, 'Invalid recordedAt timestamp');
  const now = Date.now();
  if (recordedAt.getTime() > now + MAX_FUTURE_SKEW_MS) {
    throw new ApiError(422, 'recordedAt is too far in the future');
  }
  if (now - recordedAt.getTime() > MAX_AGE_MS) {
    throw new ApiError(422, 'recordedAt is too old to ingest');
  }

  const latest = await TripLocation.findOne({ trip: trip._id }).sort('-recordedAt').select('recordedAt receivedAt').lean();

  // Duplicate suppression: the same device timestamp re-sent after a network
  // retry must not create a second telemetry row.
  const duplicate = await TripLocation.findOne({ trip: trip._id, recordedAt }).lean();
  if (duplicate) {
    return {
      location: duplicate,
      duplicate: true,
      accepted: true,
      currentUpdated: false,
      throttling: { minIntervalSeconds: MIN_UPDATE_INTERVAL_MS / 1000 },
    };
  }

  // Out-of-order protection: a buffered point older than the newest stored
  // point must never move the live vehicle position backwards.
  if (latest && recordedAt.getTime() < new Date(latest.recordedAt).getTime()) {
    throw new ApiError(409, 'This location update is older than the latest recorded position and was not applied.');
  }

  // Server-side throttling/update interval per trip
  if (latest) {
    const latestMs = new Date(latest.recordedAt || latest.receivedAt || 0).getTime();
    if (
      Number.isFinite(latestMs) &&
      now - latestMs < MIN_UPDATE_INTERVAL_MS &&
      recordedAt.getTime() - latestMs < MIN_UPDATE_INTERVAL_MS
    ) {
      throw new ApiError(
        429,
        `Location updates are throttled. Please wait at least ${Math.ceil(MIN_UPDATE_INTERVAL_MS / 1000)} seconds between updates.`
      );
    }
  }

  let doc;
  try {
    doc = await TripLocation.create({
      trip: trip._id,
      vehicle: trip.vehicle,
      driver: trip.driver,
      route: trip.route,
      recordedAt,
      receivedAt: new Date(),
      latitude: point.latitude,
      longitude: point.longitude,
      accuracyMeters: payload.accuracyMeters != null ? Number(payload.accuracyMeters) : undefined,
      speedKmh: payload.speedKmh != null ? Number(payload.speedKmh) : undefined,
      heading: payload.heading != null ? Number(payload.heading) : undefined,
      source: payload.source || (req.user.role === 'driver' ? 'driver_app' : 'system'),
    });
  } catch (err) {
    if (err?.code === 11000) {
      const existing = await TripLocation.findOne({ trip: trip._id, recordedAt }).lean();
      return { location: existing, duplicate: true, accepted: true, currentUpdated: false };
    }
    throw err;
  }

  // Only advance the current position when this point is at least as recent as
  // the stored one. A late packet cannot overwrite newer live data.
  const current = await VehicleCurrentLocation.findOne({ vehicle: trip.vehicle }).select('recordedAt').lean();
  const shouldUpdateCurrent =
    !current || !current.recordedAt || recordedAt.getTime() >= new Date(current.recordedAt).getTime();

  let savedCurrent = null;
  if (shouldUpdateCurrent) {
    savedCurrent = await VehicleCurrentLocation.findOneAndUpdate(
      { vehicle: trip.vehicle },
      {
        $set: {
          driver: trip.driver,
          trip: trip._id,
          latitude: point.latitude,
          longitude: point.longitude,
          accuracyMeters: payload.accuracyMeters != null ? Number(payload.accuracyMeters) : undefined,
          speedKmh: payload.speedKmh != null ? Number(payload.speedKmh) : undefined,
          heading: payload.heading != null ? Number(payload.heading) : undefined,
          recordedAt,
          receivedAt: doc.receivedAt,
          source: payload.source || (req.user.role === 'driver' ? 'driver_app' : 'system'),
          trackingActive: true,
        },
      },
      { upsert: true, new: true }
    ).lean();
  }

  await Trip.updateOne(
    { _id: trip._id },
    { $set: { lastGpsUpdateAt: new Date(), gpsTrackingActive: true } }
  );

  if (shouldUpdateCurrent) {
    const payloadOut = {
      tripId: String(trip._id),
      vehicle: trip.vehicle ? String(trip.vehicle) : null,
      driver: trip.driver ? String(trip.driver) : null,
      latitude: point.latitude,
      longitude: point.longitude,
      accuracyMeters: payload.accuracyMeters != null ? Number(payload.accuracyMeters) : undefined,
      speedKmh: payload.speedKmh != null ? Number(payload.speedKmh) : undefined,
      heading: payload.heading != null ? Number(payload.heading) : undefined,
      recordedAt,
      receivedAt: savedCurrent?.receivedAt || doc.receivedAt,
    };
    emitToTrip(trip._id, 'location_updated', payloadOut);
    emitToFleet('location_updated', payloadOut);
  }

  return {
    location: doc.toObject ? doc.toObject() : doc,
    accepted: true,
    currentUpdated: shouldUpdateCurrent,
    throttling: { minIntervalSeconds: MIN_UPDATE_INTERVAL_MS / 1000 },
  };
}

export async function listTripLocations(req, tripId, query = {}) {
  // Reuse trip access rules so only authorized roles (admin, assigned driver, linked student/parent) can read.
  const trip = await assertCanAccessTrip(req.user, tripId);
  if ((req.user.role === 'parent' || req.user.role === 'student') && TERMINAL_STATUSES.has(trip?.status)) {
    throw new ApiError(403, 'Trip location history is not available for finished trips');
  }
  const limit = Math.min(500, Math.max(1, parseInt(String(query.limit || '100'), 10) || 100));
  const since = query.since ? new Date(query.since) : null;
  const until = query.until ? new Date(query.until) : null;
  const filter = { trip: tripId };
  if (since && !Number.isNaN(since.getTime())) filter.recordedAt = { ...(filter.recordedAt || {}), $gte: since };
  if (until && !Number.isNaN(until.getTime())) filter.recordedAt = { ...(filter.recordedAt || {}), $lte: until };
  const items = await TripLocation.find(filter).sort({ recordedAt: -1 }).limit(limit).lean();
  return { items: items.reverse(), count: items.length, limit };
}

export async function getLatestTripLocation(tripId, { maxAgeMs = STALE_LOCATION_MS } = {}) {
  const latest = await TripLocation.findOne({ trip: tripId }).sort('-recordedAt').lean();
  if (!latest) return { location: null, stale: true, missing: true };
  const ageMs = Date.now() - new Date(latest.recordedAt).getTime();
  const stale = !Number.isFinite(ageMs) || ageMs > maxAgeMs;
  return { location: latest, stale, missing: false, ageMs: Number.isFinite(ageMs) ? ageMs : null };
}

export async function getTripLocationSummary(tripId, opts = {}) {
  const latest = await getLatestTripLocation(tripId, opts);
  const count = await TripLocation.countDocuments({ trip: tripId });
  const first = count ? await TripLocation.findOne({ trip: tripId }).sort('recordedAt').select('recordedAt').lean() : null;
  return { ...latest, count, firstRecordedAt: first?.recordedAt || null };
}

/**
 * Delete raw telemetry older than the configured retention window.
 * Trip events, attendance and trip summaries are stored separately and are not
 * affected by GPS retention.
 */
export async function cleanupExpiredLocations({ retentionDays } = {}) {
  let days = Number(retentionDays);
  if (!Number.isFinite(days) || days < 1) {
    const config = await SchoolConfig.findOne().select('gpsRetentionDays').lean();
    days = Number(config?.gpsRetentionDays) || DEFAULT_RETENTION_DAYS;
  }
  days = Math.min(365, Math.max(1, Math.round(days)));

  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const result = await TripLocation.deleteMany({ recordedAt: { $lt: cutoff } });
  return { deleted: result.deletedCount || 0, retentionDays: days, cutoff };
}
