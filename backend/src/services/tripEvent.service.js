import { TripEvent } from '../models/index.js';
import { emitToDriver, emitToFleet, emitToTrip, emitToTripStudent } from './realtime.service.js';

const EVENT_ALIASES = {
  trip_arrived_school: ['bus_arrived_at_school'],
  afternoon_trip_started: ['trip_started'],
};

function toId(value) {
  if (value == null) return undefined;
  if (typeof value === 'object' && value._id != null) return value._id;
  return value;
}

function emitRouted(tripId, eventName, payload, { studentId, driverIds = [] } = {}) {
  if (studentId) {
    emitToTripStudent(tripId, studentId, eventName, payload);
    for (const driverId of driverIds) emitToDriver(driverId, eventName, payload);
    emitToFleet(eventName, payload);
  } else {
    emitToTrip(tripId, eventName, payload);
    emitToFleet(eventName, payload);
  }
}

/**
 * Persist a trip event and publish it to the authorized realtime rooms.
 *
 * Events are idempotent: callers may pass an explicit `dedupeKey` (for example
 * `trip:<id>:student_picked_up:<studentId>:<minute>`), otherwise a key derived
 * from trip, event, student and the occurrence second is used. A duplicate
 * insert is treated as success and the existing record is returned.
 */
export async function recordTripEvent({
  trip,
  eventType,
  student = null,
  actor = null,
  actorRole = null,
  source = 'system',
  occurredAt = new Date(),
  latitude,
  longitude,
  accuracyMeters,
  note,
  meta,
  dedupeKey,
} = {}) {
  const tripId = toId(trip);
  if (!tripId || !eventType) return null;

  const at = occurredAt instanceof Date ? occurredAt : new Date(occurredAt);
  const safeAt = Number.isNaN(at.getTime()) ? new Date() : at;
  const vehicle = toId(trip?.vehicle);
  const driver = toId(trip?.driver);
  const substituteDriver = toId(trip?.substituteDriver);
  const studentId = toId(student);

  const key =
    dedupeKey ||
    `${tripId}:${eventType}:${studentId ? String(studentId) : ''}:${Math.floor(safeAt.getTime() / 1000)}`;

  let doc;
  try {
    doc = await TripEvent.create({
      trip: tripId,
      eventType,
      student: studentId,
      vehicle,
      driver,
      actor: toId(actor),
      actorRole: actorRole || undefined,
      source,
      occurredAt: safeAt,
      recordedAt: new Date(),
      latitude: latitude != null && Number.isFinite(Number(latitude)) ? Number(latitude) : undefined,
      longitude: longitude != null && Number.isFinite(Number(longitude)) ? Number(longitude) : undefined,
      accuracyMeters:
        accuracyMeters != null && Number.isFinite(Number(accuracyMeters)) ? Number(accuracyMeters) : undefined,
      note: note ? String(note).slice(0, 500) : undefined,
      meta,
      dedupeKey: key,
    });
  } catch (err) {
    if (err?.code === 11000) {
      return TripEvent.findOne({ dedupeKey: key }).lean();
    }
    throw err;
  }

  const payload = {
    ...(meta && typeof meta === 'object' ? meta : {}),
    tripId: String(tripId),
    event: eventType,
    eventType,
    student: doc.student ? String(doc.student) : null,
    vehicle: doc.vehicle ? String(doc.vehicle) : null,
    driver: doc.driver ? String(doc.driver) : null,
    timestamp: doc.occurredAt,
    occurredAt: doc.occurredAt,
    latitude: doc.latitude,
    longitude: doc.longitude,
    note: doc.note,
  };

  const driverIds = [driver, substituteDriver].filter(Boolean).map((id) => String(id));
  const uniqueDrivers = [...new Set(driverIds)];
  const routeOpts = { studentId: doc.student ? String(doc.student) : null, driverIds: uniqueDrivers };

  // `trip_event` is the stable channel; the named event keeps older clients working.
  emitRouted(tripId, 'trip_event', payload, routeOpts);
  emitRouted(tripId, eventType, payload, routeOpts);

  const aliases = EVENT_ALIASES[eventType] || [];
  for (const alias of aliases) {
    emitRouted(tripId, alias, payload, routeOpts);
  }

  return doc.toObject ? doc.toObject() : doc;
}

export async function listTripEvents(
  tripId,
  { limit = 200, eventType, student, visibleStudentIds = null } = {}
) {
  if (Array.isArray(visibleStudentIds)) {
    const allowed = new Set(visibleStudentIds.filter(Boolean).map((id) => String(id)));
    if (student && !allowed.has(String(student))) {
      return [];
    }
    const filter = { trip: tripId };
    if (eventType) filter.eventType = eventType;
    if (student) {
      filter.student = student;
    } else {
      filter.$or = [{ student: { $exists: false } }, { student: null }, { student: { $in: [...allowed] } }];
    }
    const safeLimit = Math.min(500, Math.max(1, Number(limit) || 200));
    return TripEvent.find(filter)
      .sort({ occurredAt: -1, createdAt: -1 })
      .limit(safeLimit)
      .populate('student', 'name studentId className division')
      .populate('actor', 'name role')
      .lean();
  }

  const filter = { trip: tripId };
  if (eventType) filter.eventType = eventType;
  if (student) filter.student = student;
  const safeLimit = Math.min(500, Math.max(1, Number(limit) || 200));
  return TripEvent.find(filter)
    .sort({ occurredAt: -1, createdAt: -1 })
    .limit(safeLimit)
    .populate('student', 'name studentId className division')
    .populate('actor', 'name role')
    .lean();
}
