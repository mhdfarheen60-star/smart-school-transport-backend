import { Attendance, Driver, Student, Trip } from '../models/index.js';
import { audit } from '../services/audit.service.js';
import { notifyStudentGuardians } from '../services/notification.service.js';
import { computeAttendanceSummary, changeTripStatus } from '../services/tripLifecycle.service.js';
import { recordTripEvent } from '../services/tripEvent.service.js';
import { ApiError, asyncHandler, ok } from '../utils/http.js';
import { paginate } from '../utils/paginate.js';

const populate = [
  { path: 'student', select: 'name studentId className division user' },
  { path: 'vehicle', select: 'registrationNumber busNumber' },
  { path: 'driver', select: 'name' },
  { path: 'route', select: 'name' },
];

const PICKUP_EVENT = {
  picked_up: 'student_picked_up',
  absent: 'student_absent',
  not_available: 'student_not_available',
};

function eventPoint(geo) {
  if (!geo) return {};
  const latitude = Number(geo.latitude);
  const longitude = Number(geo.longitude);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return {};
  if (latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) return {};
  return {
    latitude,
    longitude,
    accuracyMeters:
      geo.accuracyMeters != null && Number.isFinite(Number(geo.accuracyMeters))
        ? Number(geo.accuracyMeters)
        : undefined,
  };
}

export const list = asyncHandler(async (req, res) => {
  const q = req.query;
  const filter = {};
  if (q.date) filter.date = q.date;
  else if (q.from || q.to) {
    filter.date = { ...(q.from ? { $gte: q.from } : {}), ...(q.to ? { $lte: q.to } : {}) };
  }
  if (q.pickupStatus) filter.pickupStatus = q.pickupStatus;
  if (q.dropStatus) filter.dropStatus = q.dropStatus;
  if (q.vehicle) filter.vehicle = q.vehicle;
  if (q.trip) filter.trip = q.trip;
  if (q.student) filter.student = q.student;
  if (req.user.role === 'student') {
    const s = await Student.findOne({ user: req.user.id });
    if (!s) throw new ApiError(404, 'Student profile not found');
    filter.student = s._id;
  } else if (req.user.role === 'driver') {
    const d = await Driver.findOne({ user: req.user.id });
    if (!d) throw new ApiError(404, 'Driver profile not found');
    filter.driver = d._id;
  }
  const { items, meta } = await paginate(Attendance, filter, q, {
    populate,
    sortable: ['date', 'pickupStatus', 'dropStatus'],
    defaultSort: '-date',
  });
  ok(res, items, meta);
});

async function loadForDriver(req) {
  const driver = await Driver.findOne({ user: req.user.id });
  if (!driver) throw new ApiError(404, 'Driver profile not found');
  const rec = await Attendance.findById(req.params.id).populate('student', 'name studentId');
  if (!rec) throw new ApiError(404, 'Attendance record not found');
  if (String(rec.driver) !== String(driver._id)) throw new ApiError(403, 'Not your trip');
  const trip = await Trip.findById(rec.trip);
  if (!trip || trip.status === 'completed' || trip.status === 'cancelled') {
    throw new ApiError(409, 'This trip is closed; attendance can no longer be changed');
  }
  return { rec, trip, driver };
}

async function syncTripProgress(req, trip, rec, eventType, note) {
  const summary = await computeAttendanceSummary(trip._id);
  trip.attendanceSummary = summary;
  await trip.save();

  await recordTripEvent({
    trip,
    eventType,
    student: rec.student?._id || rec.student,
    actor: req.user.id,
    actorRole: req.user.role,
    source: req.user.role === 'admin' ? 'admin' : 'driver_web',
    occurredAt: new Date(),
    latitude: rec.pickupGeo?.latitude,
    longitude: rec.pickupGeo?.longitude,
    note,
    dedupeKey: `${trip._id}:${eventType}:${rec.student?._id || rec.student}`,
    meta: {
      attendanceId: String(rec._id),
      pickupStatus: rec.pickupStatus,
      dropStatus: rec.dropStatus,
      summary,
    },
  });

  // The first successful boarding starts the trip, matching driver expectations.
  if (trip.status === 'scheduled' && rec.pickupStatus === 'picked_up') {
    await changeTripStatus({ req, trip, status: 'in_progress' });
  }
}

export const markPickup = asyncHandler(async (req, res) => {
  const { rec, trip } = await loadForDriver(req);
  const status = req.body.status;

  // Idempotent: re-submitting the same outcome does not create duplicate events.
  if (rec.pickupStatus === status && rec.pickupAt) {
    return ok(res, rec);
  }

  const geo = eventPoint(req.body.geo);
  rec.pickupStatus = status;
  rec.pickupAt = new Date();
  rec.pickupSource = req.body.source || 'driver_web';
  rec.pickupNote = req.body.note ? String(req.body.note).slice(0, 500) : rec.pickupNote;
  if (geo.latitude != null) rec.pickupGeo = geo;
  rec.markedBy = req.user.id;

  if (status !== 'picked_up') {
    rec.dropStatus = 'pending';
    rec.dropAt = undefined;
    rec.dropGeo = undefined;
    rec.dropSource = undefined;
    rec.dropNote = undefined;
  }
  await rec.save();

  await syncTripProgress(req, trip, rec, PICKUP_EVENT[status], rec.pickupNote);

  const label = {
    picked_up: 'picked up',
    absent: 'marked absent',
    not_available: 'marked not available',
  }[status];
  await notifyStudentGuardians([rec.student?._id || rec.student], {
    title: 'Pickup update',
    message: `${rec.student?.name || 'Your child'} was ${label} on ${rec.date}.`,
    type: status === 'picked_up' ? 'pickup' : 'attendance',
    link: '/parent/tracking',
    meta: { tripId: String(trip._id), attendanceId: String(rec._id) },
  }).catch(() => {});

  ok(res, rec);
});

export const markDrop = asyncHandler(async (req, res) => {
  const { rec, trip } = await loadForDriver(req);
  if (rec.pickupStatus !== 'picked_up') {
    throw new ApiError(409, 'Student must be picked up before they can be dropped');
  }

  if (rec.dropStatus === 'dropped' && rec.dropAt) {
    return ok(res, rec);
  }

  const geo = eventPoint(req.body.geo);
  rec.dropStatus = 'dropped';
  rec.dropAt = new Date();
  rec.dropSource = req.body.source || 'driver_web';
  rec.dropNote = req.body.note ? String(req.body.note).slice(0, 500) : rec.dropNote;
  if (geo.latitude != null) rec.dropGeo = geo;
  rec.markedBy = req.user.id;
  await rec.save();

  const summary = await computeAttendanceSummary(trip._id);
  trip.attendanceSummary = summary;
  await trip.save();

  await recordTripEvent({
    trip,
    eventType: 'student_dropped_off',
    student: rec.student?._id || rec.student,
    actor: req.user.id,
    actorRole: req.user.role,
    source: 'driver_web',
    occurredAt: new Date(),
    latitude: rec.dropGeo?.latitude,
    longitude: rec.dropGeo?.longitude,
    note: rec.dropNote,
    dedupeKey: `${trip._id}:student_dropped_off:${rec.student?._id || rec.student}`,
    meta: { attendanceId: String(rec._id), summary },
  });

  await notifyStudentGuardians([rec.student?._id || rec.student], {
    title: 'Drop-off update',
    message: `${rec.student?.name || 'Your child'} was dropped off on ${rec.date}.`,
    type: 'drop',
    link: '/parent/tracking',
    meta: { tripId: String(trip._id), attendanceId: String(rec._id) },
  }).catch(() => {});

  ok(res, rec);
});

export const adminUpdate = asyncHandler(async (req, res) => {
  const rec = await Attendance.findById(req.params.id).populate('student', 'name studentId');
  if (!rec) throw new ApiError(404, 'Attendance record not found');
  const { pickupStatus, dropStatus, note } = req.body;

  const before = { pickupStatus: rec.pickupStatus, dropStatus: rec.dropStatus };

  if (pickupStatus) {
    rec.pickupStatus = pickupStatus;
    rec.pickupAt = pickupStatus === 'pending' ? undefined : new Date();
    rec.pickupSource = 'admin';
    if (pickupStatus === 'pending') rec.pickupGeo = undefined;
  }
  if (dropStatus) {
    rec.dropStatus = dropStatus;
    rec.dropAt = dropStatus === 'pending' ? undefined : new Date();
    rec.dropSource = 'admin';
    if (dropStatus === 'pending') rec.dropGeo = undefined;
  }
  if (note) {
    rec.pickupNote = String(note).slice(0, 500);
    rec.dropNote = String(note).slice(0, 500);
  }
  rec.markedBy = req.user.id;
  await rec.save();

  const trip = await Trip.findById(rec.trip);
  if (trip) {
    const summary = await computeAttendanceSummary(trip._id);
    trip.attendanceSummary = summary;
    await trip.save();
    await recordTripEvent({
      trip,
      eventType: 'attendance_corrected',
      student: rec.student?._id || rec.student,
      actor: req.user.id,
      actorRole: 'admin',
      source: 'admin',
      occurredAt: new Date(),
      note,
      dedupeKey: `${trip._id}:attendance_corrected:${rec._id}:${Date.now()}`,
      meta: { attendanceId: String(rec._id), before, after: { pickupStatus: rec.pickupStatus, dropStatus: rec.dropStatus } },
    });
  }

  await audit(req, 'update', 'Attendance', rec.id, { before, after: req.body });
  ok(res, rec);
});
