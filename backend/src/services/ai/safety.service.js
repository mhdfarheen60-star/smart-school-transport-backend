import { Attendance, Geofence, Route, SafetyAlert, Trip, TripLocation, Vehicle, Driver } from '../../models/index.js';
import { notifyAdmins } from '../notification.service.js';
import { ApiError, todayStr } from '../../utils/http.js';
import { haversineKm } from './providers/routing.js';

const MANAGE_ROLES = new Set(['admin']);

function assertAdmin(req) {
  if (!MANAGE_ROLES.has(req.user.role)) throw new ApiError(403, 'Admin access required');
}

function parseDateStr(s) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(s || '')) ? String(s) : null;
}

function parseHmToMinutes(hm) {
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(String(hm || ''))) return null;
  const [h, m] = String(hm).split(':').map(Number);
  return h * 60 + m;
}

function dateTimeFromLocal(dateStr, hm) {
  const mins = parseHmToMinutes(hm);
  if (!dateStr || mins == null) return null;
  const [y, mo, d] = dateStr.split('-').map(Number);
  const dt = new Date(y, mo - 1, d, Math.floor(mins / 60), mins % 60, 0, 0);
  return Number.isNaN(dt.getTime()) ? null : dt;
}

function earliestPickupTime(route) {
  const stops = Array.isArray(route?.stops) ? route.stops : [];
  const mins = stops.map((s) => parseHmToMinutes(s.pickupTime)).filter((v) => v != null);
  if (!mins.length) return null;
  const min = Math.min(...mins);
  return `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;
}

function toPoint(loc) {
  if (!loc) return null;
  const latitude = Number(loc.latitude ?? loc.lat);
  const longitude = Number(loc.longitude ?? loc.lng ?? loc.lon);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
  return { latitude, longitude };
}

function distanceMeters(a, b) {
  const km = haversineKm(a, b);
  return km == null ? null : km * 1000;
}

// Approximate distance from point to segment in meters using planar projection around segment midpoint.
function pointToSegmentMeters(p, a, b) {
  if (!p || !a || !b) return null;
  const latRad = ((a.latitude + b.latitude) / 2) * Math.PI / 180;
  const kx = 111320 * Math.cos(latRad);
  const ky = 110540;
  const ax = a.longitude * kx, ay = a.latitude * ky;
  const bx = b.longitude * kx, by = b.latitude * ky;
  const px = p.longitude * kx, py = p.latitude * ky;
  const abx = bx - ax, aby = by - ay;
  const apx = px - ax, apy = py - ay;
  const ab2 = abx * abx + aby * aby;
  let t = ab2 === 0 ? 0 : (apx * abx + apy * aby) / ab2;
  t = Math.max(0, Math.min(1, t));
  const cx = ax + abx * t;
  const cy = ay + aby * t;
  return Math.hypot(px - cx, py - cy);
}

function distanceToPathMeters(point, path = []) {
  if (!point || !Array.isArray(path) || path.length === 0) return null;
  const pts = path.map(toPoint).filter(Boolean);
  if (!pts.length) return null;
  if (pts.length === 1) return distanceMeters(point, pts[0]);
  let best = Infinity;
  for (let i = 1; i < pts.length; i += 1) {
    const d = pointToSegmentMeters(point, pts[i - 1], pts[i]);
    if (Number.isFinite(d) && d < best) best = d;
  }
  return Number.isFinite(best) ? best : null;
}

function isInsideCircle(point, center, radiusMeters) {
  if (!point || !center || !Number.isFinite(Number(radiusMeters))) return false;
  const d = distanceMeters(point, center);
  return d != null && d <= Number(radiusMeters);
}

async function loadTripContexts({ date, tripId }) {
  const filter = {};
  if (tripId) filter._id = tripId;
  if (date) filter.date = date;
  const trips = await Trip.find(filter)
    .populate('vehicle', 'registrationNumber busNumber status')
    .populate('driver', 'name phone status')
    .populate('route', 'name status stops')
    .populate('assignment', 'status riders')
    .lean();
  if (!trips.length) return [];

  const tripIds = trips.map((t) => t._id);
  const routeIds = trips.map((t) => t.route?._id || t.route).filter(Boolean);
  const vehicleIds = trips.map((t) => t.vehicle?._id || t.vehicle).filter(Boolean);
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);

  const [attendanceAgg, locations, geofences] = await Promise.all([
    Attendance.aggregate([
      { $match: { trip: { $in: tripIds } } },
      {
        $group: {
          _id: '$trip',
          total: { $sum: 1 },
          pickedUp: { $sum: { $cond: [{ $eq: ['$pickupStatus', 'picked_up'] }, 1, 0] } },
          absent: { $sum: { $cond: [{ $eq: ['$pickupStatus', 'absent'] }, 1, 0] } },
          notAvailable: { $sum: { $cond: [{ $eq: ['$pickupStatus', 'not_available'] }, 1, 0] } },
          pickupPending: { $sum: { $cond: [{ $eq: ['$pickupStatus', 'pending'] }, 1, 0] } },
          dropped: { $sum: { $cond: [{ $eq: ['$dropStatus', 'dropped'] }, 1, 0] } },
          dropPending: { $sum: { $cond: [{ $eq: ['$dropStatus', 'pending'] }, 1, 0] } },
          firstPickupAt: { $min: '$pickupAt' },
          lastPickupAt: { $max: '$pickupAt' },
          lastDropAt: { $max: '$dropAt' },
        },
      },
    ]),
    TripLocation.find({ trip: { $in: tripIds }, recordedAt: { $gte: since } }).sort({ trip: 1, recordedAt: 1 }).lean(),
    Geofence.find({
      active: true,
      $or: [
        { scope: 'global' },
        { scope: 'route', route: { $in: routeIds } },
        { scope: 'vehicle', vehicle: { $in: vehicleIds } },
      ],
    }).lean(),
  ]);

  const byTrip = new Map(attendanceAgg.map((a) => [String(a._id), a]));
  const locByTrip = new Map();
  for (const l of locations) {
    const k = String(l.trip);
    if (!locByTrip.has(k)) locByTrip.set(k, []);
    locByTrip.get(k).push(l);
  }
  const gfGlobal = geofences.filter((g) => g.scope === 'global');
  const gfByRoute = new Map();
  const gfByVehicle = new Map();
  for (const g of geofences) {
    if (g.scope === 'route' && g.route) {
      const k = String(g.route);
      if (!gfByRoute.has(k)) gfByRoute.set(k, []);
      gfByRoute.get(k).push(g);
    }
    if (g.scope === 'vehicle' && g.vehicle) {
      const k = String(g.vehicle);
      if (!gfByVehicle.has(k)) gfByVehicle.set(k, []);
      gfByVehicle.get(k).push(g);
    }
  }

  return trips.map((t) => {
    const rid = String(t.route?._id || t.route || '');
    const vid = String(t.vehicle?._id || t.vehicle || '');
    const applicableGeofences = [
      ...gfGlobal,
      ...(gfByRoute.get(rid) || []),
      ...(gfByVehicle.get(vid) || []),
    ];
    // de-dupe by _id
    const seen = new Set();
    const uniqueGf = applicableGeofences.filter((g) => {
      const id = String(g._id);
      if (seen.has(id)) return false;
      seen.add(id);
      return true;
    });
    return {
      trip: t,
      attendance: byTrip.get(String(t._id)) || { total: 0, pickedUp: 0, absent: 0, notAvailable: 0, pickupPending: 0, dropped: 0, dropPending: 0 },
      locations: locByTrip.get(String(t._id)) || [],
      geofences: uniqueGf,
    };
  });
}

function detectProlongedStop(locations, thresholdMinutes, now) {
  if (!Array.isArray(locations) || locations.length < 2) return null;
  const thresholdMs = thresholdMinutes * 60 * 1000;
  const radiusMeters = 60; // considered stopped within ~60m
  // Find latest stationary cluster ending at most recent points
  const pts = locations.map((l) => ({ ...l, p: toPoint(l) })).filter((l) => l.p);
  if (pts.length < 2) return null;
  let anchorIdx = pts.length - 1;
  let startIdx = anchorIdx;
  const anchor = pts[anchorIdx];
  for (let i = anchorIdx - 1; i >= 0; i -= 1) {
    const d = distanceMeters(anchor.p, pts[i].p);
    if (d != null && d <= radiusMeters) startIdx = i;
    else break;
  }
  const start = pts[startIdx];
  const end = pts[anchorIdx];
  const startAt = new Date(start.recordedAt);
  const endAt = new Date(end.recordedAt);
  if (Number.isNaN(startAt.getTime()) || Number.isNaN(endAt.getTime())) return null;
  // Consider stop ongoing if last point is recent; measure duration observed in window.
  const durationMs = endAt.getTime() - startAt.getTime();
  const lastAgeMs = now.getTime() - endAt.getTime();
  if (durationMs >= thresholdMs && lastAgeMs <= 10 * 60 * 1000) {
    return { startAt, endAt, durationMinutes: Math.round(durationMs / 60000), point: end.p, sampleCount: anchorIdx - startIdx + 1 };
  }
  return null;
}

function buildAlertsForContext(ctx, now = new Date()) {
  const { trip, attendance, locations = [], geofences = [] } = ctx;
  const alerts = [];
  const date = trip.date;
  const route = trip.route || {};
  const routeName = route.name || 'Route';
  const bus = trip.vehicle?.busNumber || trip.vehicle?.registrationNumber || 'Bus';
  const driverName = trip.driver?.name || 'Driver';
  const base = {
    trip: trip._id,
    assignment: trip.assignment?._id || trip.assignment,
    vehicle: trip.vehicle?._id || trip.vehicle,
    driver: trip.driver?._id || trip.driver,
    route: route._id || trip.route,
    detectedAt: now,
  };
  const firstPickupHm = earliestPickupTime(route);
  const scheduledStart = dateTimeFromLocal(date, firstPickupHm);
  const startDelayThresholdMin = 15;
  const prolongedTripThresholdMin = 120;
  const noProgressThresholdMin = 30;

  // --- Existing schedule/attendance-based rules ---
  if (scheduledStart && (trip.status === 'scheduled' || trip.status === 'in_progress')) {
    if (trip.startedAt) {
      const lateMin = Math.round((new Date(trip.startedAt).getTime() - scheduledStart.getTime()) / 60000);
      if (lateMin >= startDelayThresholdMin) {
        alerts.push({
          ...base,
          type: 'delay',
          severity: lateMin >= 45 ? 'high' : 'medium',
          dedupeKey: `delay_trip_start|${trip._id}|${date}`,
          title: 'Trip started later than scheduled',
          message: `${routeName} (${bus}, ${driverName}) started about ${lateMin} minutes after the earliest scheduled stop time (${firstPickupHm}) on ${date}. Schedule-based rule using recorded trip times.`,
          metadata: { rule: 'delay_trip_start', scheduledPickupTime: firstPickupHm, startedAt: trip.startedAt, lateMinutes: lateMin, basis: 'trip.startedAt vs route stop pickupTime' },
        });
      }
    } else if (trip.status === 'scheduled') {
      const overdueMin = Math.round((now.getTime() - scheduledStart.getTime()) / 60000);
      const isToday = date === todayStr(now);
      if (overdueMin >= startDelayThresholdMin && (isToday || date < todayStr(now))) {
        alerts.push({
          ...base,
          type: 'delay',
          severity: overdueMin >= 60 ? 'high' : 'medium',
          dedupeKey: `delay_not_started|${trip._id}|${date}`,
          title: isToday ? 'Trip not started past scheduled time' : 'Scheduled trip not started (recorded)',
          message: `${routeName} (${bus}, ${driverName}) has no recorded start and is about ${overdueMin} minutes past the earliest scheduled stop time (${firstPickupHm}) on ${date}. Based on available trip and route schedule records.`,
          metadata: { rule: 'delay_not_started', scheduledPickupTime: firstPickupHm, overdueMinutes: overdueMin, status: trip.status, basis: 'trip.status/startedAt vs route stop pickupTime' },
        });
      }
    }
  }

  if (trip.status === 'in_progress' && trip.startedAt) {
    const elapsedMin = Math.round((now.getTime() - new Date(trip.startedAt).getTime()) / 60000);
    if (elapsedMin >= prolongedTripThresholdMin) {
      alerts.push({
        ...base,
        type: 'delay',
        severity: elapsedMin >= 180 ? 'high' : 'medium',
        dedupeKey: `delay_prolonged_in_progress|${trip._id}|${date}`,
        title: 'Trip in progress longer than expected threshold',
        message: `${routeName} (${bus}, ${driverName}) has been in progress for about ${elapsedMin} minutes since start on ${date} without completion recorded. Rule-based indicator from trip timestamps and available data.`,
        metadata: { rule: 'delay_prolonged_in_progress', startedAt: trip.startedAt, elapsedMinutes: elapsedMin, thresholdMinutes: prolongedTripThresholdMin },
      });
    }

    const activityCount = (attendance.pickedUp || 0) + (attendance.absent || 0) + (attendance.notAvailable || 0) + (attendance.dropped || 0);
    if (elapsedMin >= noProgressThresholdMin && (attendance.total || 0) > 0 && activityCount === 0) {
      alerts.push({
        ...base,
        type: 'other',
        severity: elapsedMin >= 60 ? 'medium' : 'low',
        dedupeKey: `active_no_attendance_progress|${trip._id}|${date}`,
        title: 'Active trip with no recorded attendance updates',
        message: `${routeName} (${bus}, ${driverName}) started about ${elapsedMin} minutes ago on ${date} but no pickup/drop attendance updates have been recorded yet (${attendance.total} attendance record(s) pending). Based on trip and attendance records.`,
        metadata: { rule: 'active_no_attendance_progress', startedAt: trip.startedAt, elapsedMinutes: elapsedMin, attendance },
      });
    }
  }

  if (trip.status === 'cancelled') {
    const hadActivity = Boolean(trip.startedAt) || (attendance.pickedUp || 0) > 0 || (attendance.dropped || 0) > 0 || Boolean(attendance.firstPickupAt);
    if (hadActivity) {
      alerts.push({
        ...base,
        type: 'unexpected_trip_termination',
        severity: 'high',
        dedupeKey: `unexpected_cancellation|${trip._id}|${date}`,
        title: 'Trip cancelled after activity/start',
        message: `${routeName} (${bus}, ${driverName}) is marked cancelled on ${date} after trip start or attendance activity was recorded. Review trip and attendance records.`,
        metadata: { rule: 'unexpected_cancellation', startedAt: trip.startedAt, completedAt: trip.completedAt, attendance },
      });
    }
  }

  if (trip.status === 'completed' && (attendance.total || 0) > 0) {
    const pickedOrDropped = (attendance.pickedUp || 0) + (attendance.dropped || 0);
    if (pickedOrDropped === 0) {
      alerts.push({
        ...base,
        type: 'other',
        severity: 'medium',
        dedupeKey: `completed_without_pickups|${trip._id}|${date}`,
        title: 'Trip completed without recorded pickups/drops',
        message: `${routeName} (${bus}, ${driverName}) is completed on ${date} but no picked-up or dropped attendance records were recorded (${attendance.total} record(s)). Based on attendance records.`,
        metadata: { rule: 'completed_without_pickups', attendance },
      });
    }
  }

  // --- GPS/location-history-based rules (only when applicable data exists) ---
  const latestLoc = locations.length ? locations[locations.length - 1] : null;
  const latestPoint = toPoint(latestLoc);
  const latestAgeMin = latestLoc?.recordedAt ? (now.getTime() - new Date(latestLoc.recordedAt).getTime()) / 60000 : null;

  if (trip.status === 'in_progress') {
    // Missing location updates
    const missingThresholds = geofences.map((g) => Number(g.missingUpdateMinutes)).filter((n) => Number.isFinite(n) && n > 0);
    const missingThresholdMin = missingThresholds.length ? Math.min(...missingThresholds) : 10;
    if (!latestLoc && trip.startedAt) {
      const sinceStartMin = (now.getTime() - new Date(trip.startedAt).getTime()) / 60000;
      if (sinceStartMin >= missingThresholdMin) {
        alerts.push({
          ...base,
          type: 'missing_location_update',
          severity: sinceStartMin >= missingThresholdMin * 2 ? 'high' : 'medium',
          dedupeKey: `missing_location_update|${trip._id}|${date}`,
          title: 'No GPS location updates received for in-progress trip',
          message: `${routeName} (${bus}, ${driverName}) has been in progress for about ${Math.round(sinceStartMin)} minutes on ${date} but no GPS/location updates have been ingested. Threshold: ${missingThresholdMin} min.`,
          metadata: { rule: 'missing_location_update', startedAt: trip.startedAt, missingMinutes: Math.round(sinceStartMin), thresholdMinutes: missingThresholdMin, basis: 'trip_locations' },
        });
      }
    } else if (latestLoc && latestAgeMin != null && latestAgeMin >= missingThresholdMin) {
      alerts.push({
        ...base,
        type: 'missing_location_update',
        severity: latestAgeMin >= missingThresholdMin * 2 ? 'high' : 'medium',
        dedupeKey: `missing_location_update|${trip._id}|${date}`,
        title: 'GPS location updates are missing/stale for in-progress trip',
        message: `${routeName} (${bus}, ${driverName}) last reported a GPS/location update about ${Math.round(latestAgeMin)} minutes ago while the trip is in progress on ${date}. Threshold: ${missingThresholdMin} min.`,
        metadata: { rule: 'missing_location_update_stale', lastLocationAt: latestLoc.recordedAt, ageMinutes: Math.round(latestAgeMin), thresholdMinutes: missingThresholdMin, basis: 'trip_locations' },
      });
    }

    // Prolonged stop (use geofence/configured thresholds when present, else default)
    const stopThresholds = geofences.map((g) => Number(g.prolongedStopMinutes)).filter((n) => Number.isFinite(n) && n > 0);
    const stopThresholdMin = stopThresholds.length ? Math.min(...stopThresholds) : 10;
    const stop = detectProlongedStop(locations, stopThresholdMin, now);
    if (stop) {
      alerts.push({
        ...base,
        type: 'unexpected_stop',
        severity: stop.durationMinutes >= stopThresholdMin * 2 ? 'high' : 'medium',
        dedupeKey: `prolonged_stop|${trip._id}|${date}`,
        title: 'Prolonged stop detected from GPS history',
        message: `${routeName} (${bus}, ${driverName}) appears to have remained near the same location for about ${stop.durationMinutes} minutes on ${date} (based on ingested GPS/location history). Threshold: ${stopThresholdMin} min.`,
        metadata: { rule: 'prolonged_stop', ...stop, thresholdMinutes: stopThresholdMin, basis: 'trip_locations' },
      });
    }

    // Route deviation (only when configured geofence provides path or corridor area and GPS exists)
    if (latestPoint) {
      for (const gf of geofences) {
        const threshold = Number(gf.deviationThresholdMeters) || 500;
        if (gf.type === 'route_corridor' && Array.isArray(gf.path) && gf.path.length >= 2) {
          const d = distanceToPathMeters(latestPoint, gf.path);
          if (d != null && d > threshold) {
            alerts.push({
              ...base,
              type: 'route_deviation',
              severity: d > threshold * 2 ? 'high' : 'medium',
              dedupeKey: `route_deviation|${trip._id}|${gf._id}|${date}`,
              title: 'Possible route deviation detected',
              message: `${routeName} (${bus}, ${driverName}) latest GPS location is about ${Math.round(d)} m from configured route corridor "${gf.name}" on ${date}. Threshold: ${Math.round(threshold)} m. Indicator based on configured geofence/path and ingested GPS data.`,
              metadata: { rule: 'route_deviation_path', geofenceId: String(gf._id), geofenceName: gf.name, distanceMeters: Math.round(d), thresholdMeters: Math.round(threshold), lastLocationAt: latestLoc.recordedAt, basis: 'trip_locations+geofence_path' },
            });
          }
        } else if ((gf.type === 'route_corridor' || gf.type === 'zone' || gf.type === 'stop_radius') && gf.center && Number.isFinite(Number(gf.radiusMeters)) && gf.type === 'route_corridor') {
          // corridor defined as allowed area/circle: deviation if outside
          if (!isInsideCircle(latestPoint, gf.center, gf.radiusMeters)) {
            const d = distanceMeters(latestPoint, gf.center);
            const outsideBy = d != null ? Math.max(0, d - Number(gf.radiusMeters)) : null;
            if (outsideBy != null && outsideBy > Math.max(0, threshold - Number(gf.radiusMeters))) {
              alerts.push({
                ...base,
                type: 'route_deviation',
                severity: outsideBy > threshold ? 'high' : 'medium',
                dedupeKey: `route_deviation|${trip._id}|${gf._id}|${date}`,
                title: 'Possible route/corridor deviation detected',
                message: `${routeName} (${bus}, ${driverName}) latest GPS location is outside configured corridor/area "${gf.name}" by about ${Math.round(outsideBy)} m on ${date}. Indicator based on configured geofence and ingested GPS data.`,
                metadata: { rule: 'route_deviation_area', geofenceId: String(gf._id), geofenceName: gf.name, outsideByMeters: Math.round(outsideBy), radiusMeters: Number(gf.radiusMeters), lastLocationAt: latestLoc.recordedAt, basis: 'trip_locations+geofence_area' },
              });
            }
          }
        }
      }
    }
  }

  return alerts;
}

async function upsertAlert(alert) {
  const existing = await SafetyAlert.findOne({ dedupeKey: alert.dedupeKey, status: { $in: ['active', 'acknowledged'] } });
  if (existing) {
    const order = { low: 1, medium: 2, high: 3, critical: 4 };
    if ((order[alert.severity] || 0) > (order[existing.severity] || 0)) existing.severity = alert.severity;
    existing.title = alert.title;
    existing.message = alert.message;
    existing.metadata = { ...(existing.metadata || {}), ...(alert.metadata || {}), lastSeenAt: alert.detectedAt };
    existing.detectedAt = existing.detectedAt || alert.detectedAt;
    await existing.save();
    return { alert: existing, created: false };
  }

  const resolved = await SafetyAlert.findOne({ dedupeKey: alert.dedupeKey, status: 'resolved' }).sort('-resolvedAt');
  if (resolved) {
    return { alert: resolved, created: false, skippedResolved: true };
  }

  const created = await SafetyAlert.create({ ...alert, status: 'active' });
  return { alert: created, created: true };
}

export async function analyze(req, body = {}) {
  assertAdmin(req);
  const tripId = body.tripId && /^[a-f\d]{24}$/i.test(body.tripId) ? body.tripId : null;
  const date = tripId ? null : (parseDateStr(body.date) || todayStr());
  const contexts = await loadTripContexts({ date, tripId });
  const now = new Date();
  const proposed = contexts.flatMap((ctx) => buildAlertsForContext(ctx, now));

  let created = 0;
  let updated = 0;
  let skippedResolved = 0;
  const createdAlerts = [];
  for (const a of proposed) {
    const res = await upsertAlert(a);
    if (res.created) {
      created += 1;
      createdAlerts.push(res.alert);
    } else if (res.skippedResolved) {
      skippedResolved += 1;
    } else {
      updated += 1;
    }
  }

  const notable = createdAlerts.filter((a) => a.severity === 'high' || a.severity === 'critical');
  if (notable.length) {
    await notifyAdmins({
      title: 'Safety alerts detected',
      message: `${notable.length} new high-severity safety alert(s) detected from trip, attendance, and/or GPS/geofence rules. Review Safety Monitoring for details.`,
      type: 'problem',
    }).catch(() => {});
  }

  const hasGpsData = contexts.some((c) => (c.locations || []).length > 0);
  const hasGeofences = contexts.some((c) => (c.geofences || []).length > 0);
  const limitations = [
    'Deterministic rules use available trip, route schedule, attendance, ingested GPS/location history, and configured geofences only.',
  ];
  if (!hasGpsData) limitations.push('No ingested GPS/location history found for analyzed trips; live-location-based detections (deviation/prolonged stop/missing updates) may not trigger without GPS data.');
  if (!hasGeofences) limitations.push('No active geofences are configured; route deviation detection requires configured geofences (with path/corridor) or route geometry.');
  limitations.push('Alerts are indicators for review, not confirmed incidents.');

  return {
    analyzedAt: now.toISOString(),
    scope: { date: date || (contexts[0]?.trip?.date ?? null), tripId: tripId || null },
    tripsAnalyzed: contexts.length,
    alertsProposed: proposed.length,
    created,
    updated,
    skippedResolved,
    capabilities: {
      gpsDataAvailable: hasGpsData,
      geofencesConfigured: hasGeofences,
    },
    limitations,
  };
}

export async function listAlerts(req, query = {}) {
  assertAdmin(req);
  const filter = {};
  if (query.status) filter.status = query.status;
  if (query.severity) filter.severity = query.severity;
  if (query.type) filter.type = query.type;
  if (query.trip && /^[a-f\d]{24}$/i.test(query.trip)) filter.trip = query.trip;
  if (query.vehicle && /^[a-f\d]{24}$/i.test(query.vehicle)) filter.vehicle = query.vehicle;
  if (query.driver && /^[a-f\d]{24}$/i.test(query.driver)) filter.driver = query.driver;
  const limit = Math.min(100, Math.max(1, Number(query.limit) || 50));
  const page = Math.max(1, Number(query.page) || 1);
  const [items, total] = await Promise.all([
    SafetyAlert.find(filter)
      .sort('-detectedAt -createdAt')
      .skip((page - 1) * limit)
      .limit(limit)
      .populate('trip', 'date status startedAt completedAt')
      .populate('vehicle', 'busNumber registrationNumber')
      .populate('driver', 'name')
      .populate('route', 'name')
      .populate('acknowledgedBy', 'name role')
      .populate('resolvedBy', 'name role')
      .lean(),
    SafetyAlert.countDocuments(filter),
  ]);
  return { items, meta: { page, limit, total, pages: Math.max(1, Math.ceil(total / limit)) } };
}

export async function getAlert(req, id) {
  assertAdmin(req);
  const alert = await SafetyAlert.findById(id)
    .populate('trip', 'date status startedAt completedAt')
    .populate('assignment')
    .populate('vehicle', 'busNumber registrationNumber status')
    .populate('driver', 'name phone status')
    .populate('route', 'name status stops')
    .populate('acknowledgedBy', 'name role')
    .populate('resolvedBy', 'name role')
    .lean();
  if (!alert) throw new ApiError(404, 'Safety alert not found');
  return alert;
}

export async function acknowledge(req, id, body = {}) {
  assertAdmin(req);
  const alert = await SafetyAlert.findById(id);
  if (!alert) throw new ApiError(404, 'Safety alert not found');
  if (alert.status === 'resolved') throw new ApiError(409, 'Resolved alerts cannot be acknowledged');
  if (alert.status !== 'acknowledged') {
    alert.status = 'acknowledged';
    alert.acknowledgedBy = req.user.id;
    alert.acknowledgedAt = new Date();
    if (body.notes) alert.resolutionNotes = String(body.notes).slice(0, 1000);
    await alert.save();
  }
  return alert.toObject();
}

export async function resolve(req, id, body = {}) {
  assertAdmin(req);
  const alert = await SafetyAlert.findById(id);
  if (!alert) throw new ApiError(404, 'Safety alert not found');
  if (alert.status !== 'resolved') {
    alert.status = 'resolved';
    alert.resolvedBy = req.user.id;
    alert.resolvedAt = new Date();
  }
  if (body.notes != null) alert.resolutionNotes = String(body.notes).slice(0, 1000);
  await alert.save();
  return alert.toObject();
}

export async function overview(req) {
  assertAdmin(req);
  const [counts, bySeverity, byType, recent, today, geofenceCount, recentLocationCount] = await Promise.all([
    SafetyAlert.aggregate([{ $group: { _id: '$status', count: { $sum: 1 } } }]),
    SafetyAlert.aggregate([{ $match: { status: { $ne: 'resolved' } } }, { $group: { _id: '$severity', count: { $sum: 1 } } }]),
    SafetyAlert.aggregate([{ $match: { status: { $ne: 'resolved' } } }, { $group: { _id: '$type', count: { $sum: 1 } } }]),
    SafetyAlert.find({}).sort('-detectedAt').limit(10).populate('trip', 'date status').populate('vehicle', 'busNumber registrationNumber').populate('driver', 'name').populate('route', 'name').lean(),
    SafetyAlert.countDocuments({ detectedAt: { $gte: new Date(new Date().setHours(0, 0, 0, 0)) } }),
    Geofence.countDocuments({ active: true }),
    TripLocation.countDocuments({ recordedAt: { $gte: new Date(Date.now() - 24 * 60 * 60 * 1000) } }),
  ]);
  const statusCounts = { active: 0, acknowledged: 0, resolved: 0 };
  counts.forEach((c) => { if (c._id) statusCounts[c._id] = c.count; });
  const openBySeverity = { low: 0, medium: 0, high: 0, critical: 0 };
  bySeverity.forEach((c) => { if (c._id) openBySeverity[c._id] = c.count; });
  const openByType = byType.map((c) => ({ type: c._id, count: c.count }));

  const supportedDetections = [
    'Schedule-based trip start delays (route stop pickup times vs trip start/recorded status)',
    'Prolonged in-progress trips (elapsed time threshold)',
    'Active trips with no recorded attendance progress (threshold)',
    'Unexpected cancellation after start/activity',
    'Completed trips without recorded pickups/drops',
    'Missing/stale GPS location updates for in-progress trips (when location ingestion is active)',
    'Prolonged stops detected from ingested GPS/location history (configurable threshold)',
  ];
  const unavailableDetections = [];
  if (geofenceCount > 0) {
    supportedDetections.push('Route/corridor deviation indicators when configured geofences (path/corridor) and GPS location history are available');
  } else {
    unavailableDetections.push('Route deviation detection requires configured geofences (with route path/corridor) and/or route geometry plus GPS data');
  }
  if (recentLocationCount === 0) {
    unavailableDetections.push('No recent GPS/location updates ingested in the last 24 hours; live-location-based detections need authenticated GPS ingestion');
  }

  const limitations = [
    'Alerts are deterministic indicators derived from available trip, route schedule, attendance, ingested GPS/location history, and configured geofences only.',
    'Alerts are not confirmed incidents; operational review is required.',
  ];
  if (geofenceCount === 0) limitations.push('No active geofences configured. Configure geofences to enable route/corridor deviation checks where GPS data exists.');
  if (recentLocationCount === 0) limitations.push('No recent GPS/location data ingested. Provide authenticated GPS updates to enable missing-update, prolonged-stop, and deviation detections.');

  return {
    generatedAt: new Date().toISOString(),
    counts: { ...statusCounts, total: statusCounts.active + statusCounts.acknowledged + statusCounts.resolved, open: statusCounts.active + statusCounts.acknowledged, detectedToday: today },
    openBySeverity,
    openByType,
    recent,
    capabilities: {
      geofencesConfigured: geofenceCount > 0,
      activeGeofenceCount: geofenceCount,
      recentLocationUpdates24h: recentLocationCount,
      supportedDetections,
      unavailableDetections,
    },
    limitations,
  };
}
