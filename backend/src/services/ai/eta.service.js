import { Attendance, Driver, ETAPredictionHistory, Route, Student, TransportAssignment, Trip, TripLocation } from '../../models/index.js';
import { ApiError } from '../../utils/http.js';
import { assertCanAccessTrip, getDriverProfileForUser, getStudentProfileForUser, getParentProfileForUser } from './rbac.js';
import { audit } from '../audit.service.js';
import { haversineKm } from './providers/routing.js';

function minutesBetween(a, b) {
  if (!a || !b) return null;
  const ms = new Date(b).getTime() - new Date(a).getTime();
  if (!Number.isFinite(ms)) return null;
  return ms / 60000;
}

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

function parseTimeOnDate(dateStr, hhmm) {
  if (!dateStr || !hhmm || !/^\d{4}-\d{2}-\d{2}$/.test(dateStr) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(hhmm)) return null;
  const dt = new Date(`${dateStr}T${hhmm}:00`);
  return Number.isNaN(dt.getTime()) ? null : dt;
}

function avg(nums) {
  const valid = nums.filter((n) => Number.isFinite(n));
  if (!valid.length) return null;
  return valid.reduce((a, b) => a + b, 0) / valid.length;
}

function stddev(nums) {
  const valid = nums.filter((n) => Number.isFinite(n));
  if (valid.length < 2) return null;
  const mean = avg(valid);
  const variance = valid.reduce((acc, n) => acc + (n - mean) ** 2, 0) / valid.length;
  return Math.sqrt(variance);
}

async function getHistoricalDurations({ routeId, assignmentId, excludeTripId, limit = 30 }) {
  const filter = { status: 'completed', startedAt: { $ne: null }, completedAt: { $ne: null } };
  if (assignmentId) filter.assignment = assignmentId;
  else if (routeId) filter.route = routeId;
  if (excludeTripId) filter._id = { $ne: excludeTripId };
  const trips = await Trip.find(filter).sort('-completedAt').limit(limit).select('startedAt completedAt date assignment route').lean();
  const durations = trips
    .map((t) => minutesBetween(t.startedAt, t.completedAt))
    .filter((m) => Number.isFinite(m) && m > 0 && m < 24 * 60);
  return { durations, sampleSize: durations.length };
}

function buildStopEstimates(route, trip, basisDurationMinutes, now = new Date()) {
  const stops = Array.isArray(route?.stops) ? [...route.stops].sort((a, b) => (a.sequence || 0) - (b.sequence || 0)) : [];
  if (!stops.length) return [];
  const firstTime = stops.map((s) => parseTimeOnDate(trip.date, s.pickupTime || s.dropTime)).find(Boolean);
  const lastTime = [...stops].reverse().map((s) => parseTimeOnDate(trip.date, s.dropTime || s.pickupTime)).find(Boolean);
  const scheduledSpan = firstTime && lastTime ? Math.max(1, minutesBetween(firstTime, lastTime)) : null;
  const scale = scheduledSpan && basisDurationMinutes ? basisDurationMinutes / scheduledSpan : 1;
  const anchor = trip.startedAt ? new Date(trip.startedAt) : firstTime || now;

  return stops.map((stop) => {
    const scheduledPickup = parseTimeOnDate(trip.date, stop.pickupTime);
    const scheduledDrop = parseTimeOnDate(trip.date, stop.dropTime);
    let estimatedArrival = null;
    if (scheduledPickup && firstTime) {
      const offset = Math.max(0, minutesBetween(firstTime, scheduledPickup));
      estimatedArrival = new Date(anchor.getTime() + offset * scale * 60000);
    } else if (scheduledDrop && firstTime) {
      const offset = Math.max(0, minutesBetween(firstTime, scheduledDrop));
      estimatedArrival = new Date(anchor.getTime() + offset * scale * 60000);
    } else if (trip.startedAt && basisDurationMinutes) {
      const proportion = stops.length > 1 ? (stop.sequence - 1) / (stops.length - 1) : 1;
      estimatedArrival = new Date(new Date(trip.startedAt).getTime() + basisDurationMinutes * proportion * 60000);
    }
    return {
      sequence: stop.sequence,
      name: stop.name,
      scheduledPickup: scheduledPickup ? scheduledPickup.toISOString() : null,
      scheduledDrop: scheduledDrop ? scheduledDrop.toISOString() : null,
      estimatedArrival: estimatedArrival ? estimatedArrival.toISOString() : null,
      estimate: true,
    };
  });
}

async function resolveTripForAccess(req, tripId) {
  if (req.user.role === 'admin') {
    const trip = await Trip.findById(tripId).populate('route vehicle driver assignment').lean();
    if (!trip) throw new ApiError(404, 'Trip not found');
    return trip;
  }
  const trip = await assertCanAccessTrip(req.user, tripId);
  if (!trip) throw new ApiError(404, 'Trip not found');
  return Trip.findById(tripId).populate('route vehicle driver assignment').lean();
}

export async function predictForTrip(req, tripId) {
  const trip = await resolveTripForAccess(req, tripId);
  const [routeDoc, attendance, hist, recentLocations] = await Promise.all([
    trip.route?.stops ? Promise.resolve(trip.route) : Route.findById(trip.route).lean(),
    Attendance.find({ trip: trip._id }).select('pickupAt dropAt pickupStatus dropStatus student').lean(),
    getHistoricalDurations({ routeId: trip.route?._id || trip.route, assignmentId: trip.assignment?._id || trip.assignment, excludeTripId: trip._id }),
    TripLocation.find({ trip: trip._id }).sort('-recordedAt').limit(60).lean(),
  ]);

  const now = new Date();
  const historicalAvg = avg(hist.durations);
  const variability = stddev(hist.durations);
  const elapsed = trip.startedAt ? minutesBetween(trip.startedAt, now) : null;
  const actualDuration = trip.startedAt && trip.completedAt ? minutesBetween(trip.startedAt, trip.completedAt) : null;

  // Baseline: prefer historical average duration; fallback to scheduled span or 30 min default.
  const route = routeDoc || trip.route || {};
  const stops = Array.isArray(route.stops) ? [...route.stops].sort((a, b) => (a.sequence || 0) - (b.sequence || 0)) : [];
  const firstSched = stops.map((s) => parseTimeOnDate(trip.date, s.pickupTime || s.dropTime)).find(Boolean);
  const lastSched = [...stops].reverse().map((s) => parseTimeOnDate(trip.date, s.dropTime || s.pickupTime)).find(Boolean);
  const scheduledSpan = firstSched && lastSched ? Math.max(5, minutesBetween(firstSched, lastSched)) : null;
  const basisMinutes = historicalAvg || scheduledSpan || 30;
  let source = historicalAvg ? 'historical' : scheduledSpan ? 'schedule' : 'baseline';

  // GPS/location history signals (actual ingested data when available)
  const latestLoc = recentLocations[0] || null;
  const locationAgeMs = latestLoc?.recordedAt ? (now.getTime() - new Date(latestLoc.recordedAt).getTime()) : null;
  const gpsMissing = !latestLoc;
  const gpsStale = !gpsMissing && (locationAgeMs == null || locationAgeMs > 2 * 60 * 1000);
  const gpsLive = !gpsMissing && !gpsStale;
  const orderedLocs = [...recentLocations].reverse(); // oldest -> newest
  let recentDistanceKm = 0;
  for (let i = 1; i < orderedLocs.length; i += 1) {
    const d = haversineKm(orderedLocs[i - 1], orderedLocs[i]);
    if (Number.isFinite(d)) recentDistanceKm += d;
  }
  const locSpanMinutes = orderedLocs.length >= 2 ? minutesBetween(orderedLocs[0].recordedAt, orderedLocs[orderedLocs.length - 1].recordedAt) : null;
  const recentSpeedKmh = (Number.isFinite(locSpanMinutes) && locSpanMinutes > 0.5) ? Number((recentDistanceKm / (locSpanMinutes / 60)).toFixed(1)) : null;
  const movingRecently = recentSpeedKmh != null ? recentSpeedKmh >= 3 : false;

  let predictedArrival = null;
  let predictedMinutes = null;
  let status = 'predicted';
  let delayMinutes = null;

  if (trip.status === 'completed' && trip.completedAt) {
    predictedArrival = new Date(trip.completedAt);
    predictedMinutes = actualDuration;
    status = 'actualized';
    if (scheduledSpan && trip.startedAt) {
      const expectedEnd = new Date(new Date(trip.startedAt).getTime() + basisMinutes * 60000);
      delayMinutes = minutesBetween(expectedEnd, trip.completedAt);
    }
  } else if (trip.status === 'cancelled') {
    status = 'unavailable';
  } else if (trip.startedAt) {
    // Blend baseline duration with actual elapsed progress and GPS recency/movement when available.
    let effectiveTotal = basisMinutes;
    if (gpsLive && movingRecently && elapsed != null) {
      // If moving with live GPS, keep basis but avoid predicting in the past excessively; treat as on-track estimate.
      effectiveTotal = Math.max(basisMinutes, elapsed + Math.max(2, basisMinutes * 0.1));
      source = historicalAvg ? 'historical+gps' : 'baseline+gps';
    } else if (gpsLive && !movingRecently && elapsed != null) {
      // Live GPS but not moving recently: likely stop/delay, extend conservatively.
      effectiveTotal = Math.max(basisMinutes, elapsed + Math.max(5, basisMinutes * 0.2));
      source = 'baseline+gps';
      if (elapsed > basisMinutes) delayMinutes = elapsed - basisMinutes;
    } else if (gpsStale && elapsed != null) {
      effectiveTotal = Math.max(basisMinutes, elapsed + Math.max(5, basisMinutes * 0.25));
      if (elapsed > basisMinutes) delayMinutes = elapsed - basisMinutes;
    }
    predictedArrival = new Date(new Date(trip.startedAt).getTime() + effectiveTotal * 60000);
    // If still in past relative to now (e.g. very delayed), push forward from now.
    if (predictedArrival.getTime() < now.getTime()) {
      predictedArrival = new Date(now.getTime() + (gpsLive && movingRecently ? 5 : 10) * 60000);
    }
    predictedMinutes = minutesBetween(now, predictedArrival);
    if (elapsed != null && elapsed > basisMinutes && delayMinutes == null) delayMinutes = elapsed - basisMinutes;
  } else {
    const anchor = firstSched || now;
    predictedArrival = new Date(anchor.getTime() + basisMinutes * 60000);
    predictedMinutes = minutesBetween(now, predictedArrival);
    if (firstSched && now > firstSched && trip.status === 'scheduled') {
      delayMinutes = minutesBetween(firstSched, now);
    }
  }

  if (predictedMinutes != null && predictedMinutes < 0) predictedMinutes = 0;

  const sampleConfidence = hist.sampleSize >= 10 ? 0.8 : hist.sampleSize >= 3 ? 0.65 : hist.sampleSize >= 1 ? 0.5 : 0.35;
  let gpsAdjustment = -0.15; // default: no GPS
  if (gpsLive) gpsAdjustment = movingRecently ? 0.1 : 0.02;
  else if (gpsStale) gpsAdjustment = -0.08;
  else if (gpsMissing) gpsAdjustment = -0.15;
  const confidence = clamp(Number((sampleConfidence + gpsAdjustment).toFixed(2)), 0.2, 0.92);
  const uncertaintyMinutes = Math.max(3, Math.round((variability || basisMinutes * 0.25) + (historicalAvg ? 2 : 6) + (gpsLive ? -2 : gpsStale ? 3 : 4)));

  const stopEstimates = buildStopEstimates(route, trip, basisMinutes, now);
  const pickedUp = attendance.filter((a) => a.pickupStatus === 'picked_up').length;
  const dropped = attendance.filter((a) => a.dropStatus === 'dropped').length;
  const progress = {
    totalStudents: attendance.length,
    pickedUp,
    dropped,
    pendingPickup: Math.max(0, attendance.length - pickedUp - attendance.filter((a) => a.pickupStatus === 'absent' || a.pickupStatus === 'not_available').length),
  };

  const delayed = (delayMinutes != null && delayMinutes >= 5) || (trip.status === 'scheduled' && firstSched && now.getTime() - firstSched.getTime() > 10 * 60000);
  const notes = [];
  if (gpsLive) {
    notes.push(`Using latest ingested GPS location (${Math.round((locationAgeMs || 0) / 1000)}s ago${recentSpeedKmh != null ? `, recent speed ~${recentSpeedKmh} km/h` : ''}) combined with trip schedule/history.`);
  } else if (gpsStale) {
    notes.push(`Latest GPS location is stale (${latestLoc?.recordedAt ? new Date(latestLoc.recordedAt).toISOString() : 'unknown time'}); estimate falls back toward schedule/history until fresh updates arrive.`);
  } else {
    notes.push('No ingested GPS location history available for this trip; estimate is based on trip schedule/history/attendance only.');
  }
  notes.push(historicalAvg ? `Historical average duration from ${hist.sampleSize} completed trip(s): ${historicalAvg.toFixed(1)} min.` : 'Insufficient historical trip durations; using schedule/baseline estimate.');
  notes.push('ETA is an estimate, not a guarantee. Accuracy depends on data quality, traffic, and timely location updates.');

  const prediction = await ETAPredictionHistory.create({
    trip: trip._id,
    assignment: trip.assignment?._id || trip.assignment,
    vehicle: trip.vehicle?._id || trip.vehicle,
    route: trip.route?._id || trip.route,
    predictedFor: predictedArrival || undefined,
    predictedArrival: predictedArrival || undefined,
    predictedMinutes: predictedMinutes != null ? Number(predictedMinutes.toFixed(1)) : undefined,
    actualArrival: trip.completedAt || undefined,
    delayMinutes: delayMinutes != null ? Number(delayMinutes.toFixed(1)) : undefined,
    confidence,
    uncertaintyMinutes,
    source,
    basis: {
      historicalSampleSize: hist.sampleSize,
      historicalAverageMinutes: historicalAvg != null ? Number(historicalAvg.toFixed(1)) : null,
      scheduledSpanMinutes: scheduledSpan != null ? Number(scheduledSpan.toFixed(1)) : null,
      basisMinutes: Number(basisMinutes.toFixed(1)),
      elapsedMinutes: elapsed != null ? Number(elapsed.toFixed(1)) : null,
      gpsAvailable: gpsLive,
      gpsMissing,
      gpsStale,
      lastLocationAt: latestLoc?.recordedAt ? new Date(latestLoc.recordedAt).toISOString() : null,
      locationCount: recentLocations.length,
      recentSpeedKmh,
      movingRecently,
    },
    status,
    notes: notes.join(' '),
  });

  await audit(req, 'ai_eta_predict', 'ETAPredictionHistory', prediction._id, { trip: String(trip._id), status });

  return {
    prediction: prediction.toObject(),
    trip: {
      _id: trip._id,
      date: trip.date,
      status: trip.status,
      startedAt: trip.startedAt,
      completedAt: trip.completedAt,
      route: route?._id ? { _id: route._id, name: route.name, stops: stops } : trip.route,
      vehicle: trip.vehicle,
      driver: trip.driver,
    },
    estimate: {
      predictedArrival: predictedArrival ? predictedArrival.toISOString() : null,
      predictedMinutes: predictedMinutes != null ? Number(predictedMinutes.toFixed(1)) : null,
      actualArrival: trip.completedAt ? new Date(trip.completedAt).toISOString() : null,
      delayMinutes: delayMinutes != null ? Number(delayMinutes.toFixed(1)) : null,
      delayed,
      confidence,
      uncertaintyMinutes,
      source,
      live: gpsLive,
      gps: { available: gpsLive, missing: gpsMissing, stale: gpsStale, lastLocationAt: latestLoc?.recordedAt ? new Date(latestLoc.recordedAt).toISOString() : null, ageSeconds: locationAgeMs != null ? Math.round(locationAgeMs / 1000) : null, recentSpeedKmh, movingRecently, locationCount: recentLocations.length },
      label: trip.status === 'completed' ? 'Actualized / compared' : (gpsLive ? 'Estimated (live GPS-assisted)' : gpsStale ? 'Estimated (GPS stale)' : 'Estimated (no GPS data)'),
      stopEstimates,
      progress,
      notes,
    },
  };
}

export async function getLatestForTrip(req, tripId) {
  // Compute a fresh, RBAC-checked estimate so current GPS availability/staleness is reflected.
  await resolveTripForAccess(req, tripId);
  return predictForTrip(req, tripId);
}

export async function listHistory(req, query = {}) {
  const filter = {};
  const page = Math.max(1, parseInt(String(query.page || '1'), 10) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(String(query.limit || '20'), 10) || 20));

  if (query.tripId) filter.trip = query.tripId;
  if (query.status) filter.status = query.status;

  if (req.user.role === 'driver') {
    const driver = await getDriverProfileForUser(req.user.id);
    if (!driver) throw new ApiError(404, 'Driver profile not found');
    const tripIds = await Trip.find({ driver: driver._id }).distinct('_id');
    filter.trip = filter.trip ? filter.trip : { $in: tripIds };
    if (filter.trip && filter.trip.$in) {
      // intersect if both specified
    } else if (filter.trip) {
      // ensure requested trip is allowed
      await assertCanAccessTrip(req.user, filter.trip);
    }
  } else if (req.user.role === 'student') {
    const student = await getStudentProfileForUser(req.user.id);
    if (!student) throw new ApiError(404, 'Student profile not found');
    const assignments = await TransportAssignment.find({ status: 'active', 'riders.student': student._id }).distinct('_id');
    const tripIds = await Trip.find({ assignment: { $in: assignments } }).distinct('_id');
    filter.trip = filter.trip ? filter.trip : { $in: tripIds };
    if (filter.trip && !filter.trip.$in) await assertCanAccessTrip(req.user, filter.trip);
  } else if (req.user.role === 'parent') {
    const parent = await getParentProfileForUser(req.user);
    const linked = parent?.linkedStudents || [];
    if (!linked.length) return { items: [], meta: { page, limit, total: 0, pages: 1 } };
    const assignments = await TransportAssignment.find({ status: 'active', 'riders.student': { $in: linked } }).distinct('_id');
    const tripIds = await Trip.find({ assignment: { $in: assignments } }).distinct('_id');
    filter.trip = filter.trip ? filter.trip : { $in: tripIds };
    if (filter.trip && !filter.trip.$in) await assertCanAccessTrip(req.user, filter.trip);
  } else if (req.user.role !== 'admin') {
    throw new ApiError(403, 'Not authorized');
  }

  const [items, total] = await Promise.all([
    ETAPredictionHistory.find(filter)
      .sort('-createdAt')
      .skip((page - 1) * limit)
      .limit(limit)
      .populate({ path: 'trip', select: 'date status startedAt completedAt route vehicle driver', populate: [{ path: 'route', select: 'name' }, { path: 'vehicle', select: 'busNumber registrationNumber' }, { path: 'driver', select: 'name' }] })
      .lean(),
    ETAPredictionHistory.countDocuments(filter),
  ]);

  return { items, meta: { page, limit, total, pages: Math.max(1, Math.ceil(total / limit)) } };
}

export async function getOverview(req) {
  // Admin overview: recent/active trips with latest ETA signals
  if (req.user.role !== 'admin') throw new ApiError(403, 'Admin access required');
  const activeTrips = await Trip.find({ status: { $in: ['scheduled', 'in_progress'] } })
    .sort({ date: -1, createdAt: -1 })
    .limit(20)
    .populate('route', 'name stops')
    .populate('vehicle', 'busNumber registrationNumber')
    .populate('driver', 'name phone')
    .lean();

  const results = [];
  for (const trip of activeTrips) {
    // compute lightweight estimate without forcing persistence spam? predictForTrip persists; acceptable for admin overview refresh
    try {
      const r = await predictForTrip(req, trip._id);
      results.push(r);
    } catch (e) {
      results.push({ trip, error: e.message });
    }
  }
  const delayed = results.filter((r) => r?.estimate?.delayed);
  const liveGpsAvailable = results.some((r) => r?.estimate?.live || r?.estimate?.gps?.available);
  return {
    generatedAt: new Date().toISOString(),
    liveGpsAvailable,
    activeCount: activeTrips.length,
    delayedCount: delayed.length,
    trips: results,
  };
}
