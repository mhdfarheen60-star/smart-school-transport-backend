import {
  Attendance,
  Driver,
  SchoolCalendar,
  SchoolConfig,
  Student,
  TransportAssignment,
  TransportException,
  Trip,
} from '../models/index.js';
import { audit } from '../services/audit.service.js';
import { notifyUsers } from '../services/notification.service.js';
import { changeTripStatus, computeAttendanceSummary } from '../services/tripLifecycle.service.js';
import { listTripEvents } from '../services/tripEvent.service.js';
import {
  generateTripsForDate,
  generateTripsForDateRange,
  generateTripsToday,
  getPendingTrips,
  isWorkingDay,
} from '../services/tripScheduling.service.js';
import { ApiError, asyncHandler, ok } from '../utils/http.js';
import { paginate } from '../utils/paginate.js';

export const generateDailyTrips = asyncHandler(async (req, res) => {
  const { date, dryRun, force, timezone } = req.body;
  const targetDate = date || new Date().toLocaleDateString('en-CA', { timeZone: timezone || 'Asia/Kolkata' });

  const result = await generateTripsForDate(targetDate, {
    timezone: timezone || 'Asia/Kolkata',
    dryRun: dryRun === true,
    force: force === true,
  });

  if (!result.workingDay) {
    return ok(res, result);
  }

  await audit(req, 'generate_trips', 'Trip', null, { date: targetDate, dryRun: result.dryRun, count: result.trips.length });

  ok(res, result);
});

export const generateTripsRange = asyncHandler(async (req, res) => {
  const { from, to, timezone } = req.body;
  if (!from || !to) throw new ApiError(400, 'from and to dates are required');

  const results = await generateTripsForDateRange(from, to, { timezone: timezone || 'Asia/Kolkata' });

  await audit(req, 'generate_trips_range', 'Trip', null, { from, to, count: results.length });

  ok(res, { from, to, results });
});

export const generateTodayTrips = asyncHandler(async (req, res) => {
  const { timezone, dryRun, force } = req.body;
  const result = await generateTripsToday({ timezone: timezone || 'Asia/Kolkata', dryRun: dryRun === true, force: force === true });
  await audit(req, 'generate_today_trips', 'Trip', null, { date: result.date, count: result.trips.length });
  ok(res, result);
});

export const listTrips = asyncHandler(async (req, res) => {
  const q = req.query;
  const filter = {};
  if (q.status) filter.status = q.status;
  if (q.direction) filter.direction = q.direction;
  if (q.date) filter.date = q.date;
  else if (q.from || q.to) {
    filter.date = { ...(q.from ? { $gte: q.from } : {}), ...(q.to ? { $lte: q.to } : {}) };
  }
  if (q.vehicle) filter.vehicle = q.vehicle;
  if (q.driver) filter.driver = q.driver;
  if (q.route) filter.route = q.route;
  if (req.user.role === 'driver') {
    const driver = await Driver.findOne({ user: req.user.id });
    if (!driver) throw new ApiError(404, 'Driver profile not found');
    filter.driver = driver._id;
  }

  const { items, meta } = await paginate(Trip, filter, q, {
    populate: [
      { path: 'vehicle', select: 'registrationNumber busNumber capacity status' },
      { path: 'driver', select: 'name licenseNumber phone status' },
      { path: 'route', select: 'name stops status' },
      { path: 'substituteDriver', select: 'name licenseNumber phone' },
      { path: 'substituteVehicle', select: 'registrationNumber busNumber' },
    ],
    sortable: ['date', 'direction', 'status', 'createdAt'],
    defaultSort: '-date',
  });

  ok(res, items, meta);
});

export const getTripDetail = asyncHandler(async (req, res) => {
  const trip = await Trip.findById(req.params.id)
    .populate('vehicle', 'registrationNumber busNumber capacity status')
    .populate('driver', 'name licenseNumber phone status')
    .populate('substituteDriver', 'name licenseNumber phone')
    .populate('substituteVehicle', 'registrationNumber busNumber')
    .populate('route', 'name stops status distanceKm durationMinutes geometry schoolLocation')
    .lean();
  if (!trip) throw new ApiError(404, 'Trip not found');

  if (req.user.role === 'driver') {
    const driver = await Driver.findOne({ user: req.user.id });
    if (!driver || String(trip.driver) !== String(driver._id)) {
      throw new ApiError(403, 'Not your trip');
    }
  }

  const [attendance, events] = await Promise.all([
    Attendance.find({ trip: trip._id })
      .populate('student', 'name studentId className division photograph')
      .sort('stop')
      .lean(),
    listTripEvents(trip._id, { limit: 200 }),
  ]);

  ok(res, {
    ...trip,
    attendance,
    attendanceSummary: await computeAttendanceSummary(trip._id),
    events,
  });
});

export const setTripStatus = asyncHandler(async (req, res) => {
  const trip = await Trip.findById(req.params.id);
  if (!trip) throw new ApiError(404, 'Trip not found');

  if (req.user.role === 'driver') {
    const driver = await Driver.findOne({ user: req.user.id });
    if (!driver || String(trip.driver) !== String(driver._id)) {
      throw new ApiError(403, 'Not your trip');
    }
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

  ok(res, updated);
});

export const cancelTrip = asyncHandler(async (req, res) => {
  const trip = await Trip.findById(req.params.id);
  if (!trip) throw new ApiError(404, 'Trip not found');

  if (req.user.role === 'driver') {
    const driver = await Driver.findOne({ user: req.user.id });
    if (!driver || String(trip.driver) !== String(driver._id)) {
      throw new ApiError(403, 'Not your trip');
    }
  }

  const updated = await changeTripStatus({
    req,
    trip,
    status: 'cancelled',
    cancellationReason: req.body.reason || 'Cancelled by administrator',
  });

  ok(res, updated);
});

export const schoolCalendar = asyncHandler(async (req, res) => {
  const q = req.query;
  const filter = {};
  if (q.isWorkingDay !== undefined) filter.isWorkingDay = q.isWorkingDay === 'true';
  if (q.from || q.to) {
    filter.date = { ...(q.from ? { $gte: q.from } : {}), ...(q.to ? { $lte: q.to } : {}) };
  }

  const { items, meta } = await paginate(SchoolCalendar, filter, q, {
    sortable: ['date'],
    defaultSort: 'date',
  });
  ok(res, items, meta);
});

export const upsertSchoolCalendarDay = asyncHandler(async (req, res) => {
  const { date, isWorkingDay: isWorking, reason, morningTrips, afternoonTrips } = req.body;
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new ApiError(400, 'Valid date (YYYY-MM-DD) is required');

  const calendar = await SchoolCalendar.findOneAndUpdate(
    { date },
    {
      $set: {
        isWorkingDay: isWorking !== undefined ? isWorking : true,
        reason: reason || null,
        morningTrips: morningTrips !== undefined ? morningTrips : true,
        afternoonTrips: afternoonTrips !== undefined ? afternoonTrips : true,
        updatedBy: req.user.id,
        dayName: new Date(date).toLocaleDateString('en-US', { weekday: 'long' }),
      },
    },
    { upsert: true, new: true }
  );

  await audit(req, 'calendar_upsert', 'SchoolCalendar', calendar.id, { date, isWorking: calendar.isWorkingDay });
  ok(res, calendar);
});

export const schoolConfig = asyncHandler(async (req, res) => {
  let config = await SchoolConfig.findOne().lean();
  if (!config) {
    config = await SchoolConfig.create({
      name: 'School',
      timezone: 'Asia/Kolkata',
      morningStartTime: '07:00',
      afternoonStartTime: '13:30',
      workingDays: [1, 2, 3, 4, 5],
    });
  }
  ok(res, config);
});

export const updateSchoolConfig = asyncHandler(async (req, res) => {
  const b = req.body;
  let config = await SchoolConfig.findOne();
  if (!config) {
    config = await SchoolConfig.create({
      name: 'School',
      timezone: 'Asia/Kolkata',
      morningStartTime: '07:00',
      afternoonStartTime: '13:30',
      workingDays: [1, 2, 3, 4, 5],
      ...b,
      updatedBy: req.user.id,
    });
  } else {
    for (const k of ['name', 'address', 'timezone', 'morningStartTime', 'afternoonStartTime', 'workingDays', 'gpsUpdateIntervalMovingMs', 'gpsUpdateIntervalStationaryMs', 'gpsStaleThresholdMs', 'gpsRetentionDays', 'proximityThresholdMeters', 'etaUpdateIntervalMs']) {
      if (b[k] !== undefined) config[k] = b[k];
    }
    config.updatedBy = req.user.id;
    await config.save();
  }
  await audit(req, 'update_school_config', 'SchoolConfig', config.id, b);
  ok(res, config);
});

export const transportExceptions = asyncHandler(async (req, res) => {
  const q = req.query;
  const filter = {};
  if (q.status) filter.status = q.status;
  if (q.date) filter.date = q.date;
  if (q.direction) filter.direction = q.direction;
  if (q.student) filter.student = q.student;
  if (q.target) filter.target = q.target;

  const { items, meta } = await paginate(TransportException, filter, q, {
    populate: [
      { path: 'student', select: 'name studentId className division' },
      { path: 'trip', select: 'date direction status' },
      { path: 'reviewedBy', select: 'name' },
    ],
    sortable: ['date', 'direction', 'target', 'status'],
    defaultSort: '-date',
  });
  ok(res, items, meta);
});

export const createTransportException = asyncHandler(async (req, res) => {
  const b = req.body;
  const student = await Student.findById(b.student);
  if (!student) throw new ApiError(404, 'Student not found');

  const existing = await TransportException.findOne({
    student: b.student,
    date: b.date,
    direction: b.direction,
    target: b.target,
    status: { $in: ['pending', 'approved'] },
  });
  if (existing) throw new ApiError(409, 'An exception already exists for this student, date, direction and target');

  const exception = await TransportException.create({
    student: b.student,
    trip: b.trip || null,
    date: b.date,
    direction: b.direction,
    target: b.target,
    geo: b.geo,
    reason: b.reason,
    status: 'pending',
    appliesToAllDays: b.appliesToAllDays || false,
  });

  await audit(req, 'create_exception', 'TransportException', exception.id, { student: b.student, date: b.date, direction: b.direction });
  ok(res, exception, undefined, 201);
});

export const reviewTransportException = asyncHandler(async (req, res) => {
  const exception = await TransportException.findById(req.params.id);
  if (!exception) throw new ApiError(404, 'Exception not found');
  if (exception.status !== 'pending') throw new ApiError(409, `Exception already ${exception.status}`);

  const { decision, rejectionReason } = req.body;
  exception.status = decision;
  exception.reviewedBy = req.user.id;
  exception.reviewedAt = new Date();
  if (decision === 'rejected') exception.rejectionReason = rejectionReason;
  await exception.save();

  await audit(req, `exception_${decision}`, 'TransportException', exception.id, { decision });
  ok(res, exception);
});

export const pendingTrips = asyncHandler(async (req, res) => {
  const { date } = req.query;
  if (!date) throw new ApiError(400, 'date query parameter is required');
  const trips = await getPendingTrips(date);
  ok(res, trips);
});

export const isWorkingDayEndpoint = asyncHandler(async (req, res) => {
  const { date, timezone } = req.query;
  if (!date) throw new ApiError(400, 'date query parameter is required');
  const working = await isWorkingDay(date, timezone || 'Asia/Kolkata');
  ok(res, { date, workingDay: working, timezone: timezone || 'Asia/Kolkata' });
});

