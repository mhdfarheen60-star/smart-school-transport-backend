import { Attendance, Driver, TransportAssignment, Trip, Parent, Student } from '../models/index.js';
import { audit } from '../services/audit.service.js';
import { notifyUsers } from '../services/notification.service.js';
import { changeTripStatus, computeAttendanceSummary } from '../services/tripLifecycle.service.js';
import { listTripEvents, recordTripEvent } from '../services/tripEvent.service.js';
import { assertCanAccessTrip } from '../services/ai/rbac.js';
import { ApiError, asyncHandler, ok, todayStr } from '../utils/http.js';
import { paginate } from '../utils/paginate.js';

const tripPopulate = [
  { path: 'vehicle', select: 'registrationNumber busNumber capacity' },
  { path: 'driver', select: 'name phone' },
  { path: 'route', select: 'name stops distanceKm durationMinutes' },
];

async function currentDriver(req) {
  const d = await Driver.findOne({ user: req.user.id });
  if (!d) throw new ApiError(404, 'Driver profile not found');
  return d;
}

async function ensureTrip(assignmentId, date, direction, req = null) {
  const a = await TransportAssignment.findById(assignmentId).populate('route', 'distanceKm durationMinutes');
  if (!a || a.status !== 'active') throw new ApiError(404, 'Active assignment not found');
  const routeId = a.route?._id || a.route;
  const filter = direction ? { assignment: a._id, date, direction } : { assignment: a._id, date };

  let trip = await Trip.findOne(filter);
  let created = false;

  if (!trip) {
    // Snapshot the assignment at creation time so later assignment edits never
    // rewrite this trip's history.
    trip = await Trip.create({
      assignment: a._id,
      vehicle: a.vehicle,
      driver: a.driver,
      route: routeId,
      date,
      direction,
      status: 'scheduled',
      expectedStudentCount: (a.riders || []).length,
      routeDistanceKm: Number.isFinite(Number(a.route?.distanceKm)) ? Number(a.route.distanceKm) : undefined,
      routeDurationMinutes: Number.isFinite(Number(a.route?.durationMinutes))
        ? Number(a.route.durationMinutes)
        : undefined,
      attendanceSummary: {
        total: (a.riders || []).length,
        pendingPickup: direction === 'afternoon' ? 0 : (a.riders || []).length,
        pendingDrop: direction === 'afternoon' ? (a.riders || []).length : 0,
      },
    });
    created = true;
  }

  const existing = await Attendance.find({ trip: trip._id }).select('student');
  const have = new Set(existing.map((e) => String(e.student)));
  const missing = (a.riders || []).filter((r) => !have.has(String(r.student)));
  if (missing.length) {
    await Attendance.insertMany(
      missing.map((r) => ({
        trip: trip._id,
        student: r.student,
        vehicle: a.vehicle,
        driver: a.driver,
        route: routeId,
        date,
        stop: r.stop,
      })),
      { ordered: false }
    ).catch((e) => {
      if (e?.code !== 11000 && !e?.writeErrors) throw e;
    });
  }

  if (created) {
    await recordTripEvent({
      trip,
      eventType: 'trip_created',
      actor: req?.user?.id,
      actorRole: req?.user?.role,
      source: req?.user?.role === 'driver' ? 'driver_web' : req?.user?.role === 'admin' ? 'admin' : 'system',
      occurredAt: new Date(),
      dedupeKey: `${trip._id}:trip_created`,
      meta: {
        direction: direction || null,
        date,
        expectedStudentCount: trip.expectedStudentCount,
        openedBy: req?.user?.role || 'system',
      },
    }).catch(() => {});
  }

  return trip;
}

async function tripWithAttendance(tripId) {
  const trip = await Trip.findById(tripId).populate(tripPopulate).lean();
  if (!trip) throw new ApiError(404, 'Trip not found');
  const attendance = await Attendance.find({ trip: trip._id })
    .populate('student', 'name studentId className division phone parentPhone address permanentPickupLocation permanentDropLocation')
    .sort('stop')
    .lean();
  const summary = await computeAttendanceSummary(trip._id);
  return { ...trip, attendance, attendanceSummary: summary };
}

export const openToday = asyncHandler(async (req, res) => {
  const driver = await currentDriver(req);
  const a = await TransportAssignment.findOne({ driver: driver._id, status: 'active' });
  if (!a) throw new ApiError(404, 'You have no active bus assignment');
  const { direction } = req.query;
  const trip = await ensureTrip(a.id, todayStr(), direction || undefined, req);
  ok(res, await tripWithAttendance(trip._id));
});

export const getToday = asyncHandler(async (req, res) => {
  const driver = await currentDriver(req);
  const a = await TransportAssignment.findOne({ driver: driver._id, status: 'active' });
  if (!a) return ok(res, []);
  const { direction } = req.query;
  const filter = { assignment: a._id, date: todayStr() };
  if (direction) filter.direction = direction;
  const trips = await Trip.find(filter).populate(tripPopulate).lean();
  const result = await Promise.all(trips.map((t) => tripWithAttendance(t._id)));
  ok(res, result);
});

export const create = asyncHandler(async (req, res) => {
  const trip = await ensureTrip(req.body.assignment, req.body.date, undefined, req);
  await audit(req, 'create', 'Trip', trip.id);
  ok(res, await tripWithAttendance(trip._id), undefined, 201);
});

export const list = asyncHandler(async (req, res) => {
  const q = req.query;
  const filter = {};
  if (q.status) filter.status = q.status;
  if (q.date) filter.date = q.date;
  else if (q.from || q.to) {
    filter.date = { ...(q.from ? { $gte: q.from } : {}), ...(q.to ? { $lte: q.to } : {}) };
  }
  if (q.vehicle) filter.vehicle = q.vehicle;
  if (req.user.role === 'driver') filter.driver = (await currentDriver(req))._id;
  const { items, meta } = await paginate(Trip, filter, q, {
    populate: tripPopulate,
    sortable: ['date', 'status'],
    defaultSort: '-date',
  });
  const counts = await Attendance.aggregate([
    { $match: { trip: { $in: items.map((t) => t._id) } } },
    {
      $group: {
        _id: '$trip',
        total: { $sum: 1 },
        pickedUp: { $sum: { $cond: [{ $eq: ['$pickupStatus', 'picked_up'] }, 1, 0] } },
        dropped: { $sum: { $cond: [{ $eq: ['$dropStatus', 'dropped'] }, 1, 0] } },
        absent: {
          $sum: {
            $cond: [{ $in: ['$pickupStatus', ['absent', 'not_available']] }, 1, 0],
          },
        },
        pendingPickup: { $sum: { $cond: [{ $eq: ['$pickupStatus', 'pending'] }, 1, 0] } },
        pendingDrop: {
          $sum: {
            $cond: [
              { $and: [{ $eq: ['$pickupStatus', 'picked_up'] }, { $ne: ['$dropStatus', 'dropped'] }] },
              1,
              0,
            ],
          },
        },
      },
    },
  ]);
  const cm = new Map(counts.map((c) => [String(c._id), c]));
  ok(
    res,
    items.map((t) => ({
      ...t,
      summary: cm.get(String(t._id)) || {
        total: 0,
        pickedUp: 0,
        dropped: 0,
        absent: 0,
        pendingPickup: 0,
        pendingDrop: 0,
      },
    })),
    meta
  );
});

export const getOne = asyncHandler(async (req, res) => {
  const t = await tripWithAttendance(req.params.id);
  if (req.user.role === 'driver') {
    const d = await currentDriver(req);
    if (String(t.driver._id) !== String(d._id)) throw new ApiError(403, 'Not your trip');
  }
  ok(res, t);
});

export const setStatus = asyncHandler(async (req, res) => {
  const trip = await Trip.findById(req.params.id);
  if (!trip) throw new ApiError(404, 'Trip not found');
  if (req.user.role === 'driver') {
    const d = await currentDriver(req);
    if (String(trip.driver) !== String(d._id)) throw new ApiError(403, 'Not your trip');
  }

  const updated = await changeTripStatus({
    req,
    trip,
    status: req.body.status,
    delayMinutes: req.body.delayMinutes,
    delayReason: req.body.delayReason,
    cancellationReason: req.body.cancellationReason || req.body.reason,
    override: req.body.override === true,
    overrideReason: req.body.overrideReason,
  });

  if (req.body.status === 'in_progress') {
    const att = await Attendance.find({ trip: trip._id }).populate('student', 'user');
    await notifyUsers(
      att.map((x) => x.student?.user).filter(Boolean),
      { title: 'Bus is on the way', message: 'Your school bus has started its trip.', type: 'trip' }
    ).catch(() => {});
  }

  ok(res, updated);
});

function toId(value) {
  if (value == null) return null;
  if (typeof value === 'object' && value._id != null) return String(value._id);
  return String(value);
}

export const events = asyncHandler(async (req, res) => {
  await assertCanAccessTrip(req.user, req.params.id);

  let visibleStudentIds = null;
  if (req.user.role === 'parent') {
    const parent = await Parent.findOne({ user: req.user.id }).select('linkedStudents status').lean();
    if (!parent || parent.status === 'inactive') {
      visibleStudentIds = [];
    } else {
      visibleStudentIds = (parent.linkedStudents || []).map((id) => String(id));
    }
  } else if (req.user.role === 'student') {
    const student = await Student.findOne({ user: req.user.id }).select('_id').lean();
    visibleStudentIds = student ? [String(student._id)] : [];
  }

  const items = await listTripEvents(req.params.id, {
    limit: req.query.limit,
    eventType: req.query.eventType,
    student: req.query.student,
    visibleStudentIds,
  });

  if (req.user.role === 'parent' || req.user.role === 'student') {
    const sanitized = items.map((item) => {
      const { meta, dedupeKey, actor, actorRole, source, ...rest } = item;
      return rest;
    });
    return ok(res, sanitized);
  }

  ok(res, items);
});
