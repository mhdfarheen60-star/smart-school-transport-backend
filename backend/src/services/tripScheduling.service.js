import {
  TransportAssignment,
  TransportException,
  Trip,
  Attendance,
} from '../models/index.js';
import { ApiError } from '../utils/http.js';
import { recordTripEvent } from './tripEvent.service.js';

const DIRECTIONS = ['morning', 'afternoon'];

function dateInTz(date, timezone = 'Asia/Kolkata') {
  return new Date(date).toLocaleDateString('en-CA', { timeZone: timezone });
}

function combineDateTime(dateStr, hhmm, timezone = 'Asia/Kolkata') {
  if (!dateStr || !/^\d{4}-\d{2}-\d{2}$/.test(dateStr) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(hhmm || '')) {
    return undefined;
  }
  // Asia/Kolkata has no daylight saving; other zones fall back to the server
  // local interpretation rather than silently applying the wrong fixed offset.
  const offset = timezone === 'Asia/Kolkata' ? '+05:30' : '';
  const d = new Date(`${dateStr}T${hhmm}:00${offset}`);
  return Number.isNaN(d.getTime()) ? undefined : d;
}

async function getSchoolConfig() {
  const { SchoolConfig } = await import('../models/index.js');
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
  return config;
}

export async function isWorkingDay(dateStr, timezone) {
  const { SchoolCalendar } = await import('../models/index.js');
  const calendar = await SchoolCalendar.findOne({ date: dateStr }).lean();
  if (calendar) return calendar.isWorkingDay;
  const config = await getSchoolConfig();
  const d = new Date(`${dateStr}T00:00:00`);
  const local = new Date(d.toLocaleString('en-US', { timeZone: timezone }));
  const dayIndex = local.getDay();
  return config.workingDays.includes(dayIndex);
}

async function getActiveAssignments() {
  return TransportAssignment.find({ status: 'active' })
    .populate('vehicle', 'registrationNumber busNumber capacity status')
    .populate('driver', 'name licenseNumber phone status')
    .populate('route', 'name stops status distanceKm durationMinutes')
    .populate('riders.student', 'name studentId className division status permanentPickupLocation permanentDropLocation')
    .lean();
}

async function getApprovedException(studentId, date, direction, target) {
  return TransportException.findOne({
    student: studentId,
    date,
    direction,
    target,
    status: 'approved',
  }).lean();
}

function geoFromStudent(student, target) {
  const loc = target === 'pickup' ? student.permanentPickupLocation : student.permanentDropLocation;
  if (!loc || !loc.geo) return null;
  return {
    latitude: loc.geo.latitude,
    longitude: loc.geo.longitude,
    address: loc.geo.address,
    landmark: loc.geo.landmark,
    placeId: loc.geo.placeId,
    verified: loc.verified,
  };
}

async function resolveSubstitute(assignment) {
  let vehicle = assignment.vehicle;
  let driver = assignment.driver;
  let substituteDriverId = null;
  let substituteVehicleId = null;

  if (driver && driver.status !== 'active') {
    substituteDriverId = driver._id;
    driver = null;
  }
  if (vehicle && vehicle.status !== 'available') {
    substituteVehicleId = vehicle._id;
    vehicle = null;
  }

  return { vehicle, driver, substituteDriverId, substituteVehicleId };
}

export async function generateTripsForDate(dateStr, { timezone = 'Asia/Kolkata', dryRun = false, force = false } = {}) {
  const config = await getSchoolConfig();
  const tz = timezone || config.timezone || 'Asia/Kolkata';

  if (!(await isWorkingDay(dateStr, tz))) {
    return { date: dateStr, workingDay: false, trips: [], message: 'Non-working day (holiday or weekend)' };
  }

  const assignments = await getActiveAssignments();
  const results = [];

  for (const assignment of assignments) {
    if (!assignment.route || !assignment.vehicle || !assignment.driver) continue;

    const { vehicle, driver, substituteDriverId, substituteVehicleId } = await resolveSubstitute(assignment);

    if (!driver || !vehicle) continue;

    for (const direction of DIRECTIONS) {
      const existing = await Trip.findOne({ assignment: assignment._id, date: dateStr, direction }).lean();
      if (existing && !force) {
        results.push({ assignment: assignment._id, date: dateStr, direction, status: 'skipped', reason: 'already exists' });
        continue;
      }

      if (dryRun) {
        results.push({ assignment: assignment._id, date: dateStr, direction, status: 'would_create' });
        continue;
      }

      try {
        const startTime = direction === 'morning' ? config.morningStartTime : config.afternoonStartTime;
        const scheduledStartAt = combineDateTime(dateStr, startTime, tz);
        const routeDuration = Number(assignment.route?.durationMinutes);
        const scheduledEndAt = scheduledStartAt
          ? new Date(
              scheduledStartAt.getTime() +
                (Number.isFinite(routeDuration) && routeDuration > 0 ? routeDuration : 45) * 60000
            )
          : undefined;

        const trip = await Trip.create({
          assignment: assignment._id,
          vehicle: vehicle._id,
          driver: driver._id,
          route: assignment.route._id,
          date: dateStr,
          direction,
          status: 'scheduled',
          substituteDriver: substituteDriverId || undefined,
          substituteVehicle: substituteVehicleId || undefined,
          autoGenerated: true,
          scheduledStartAt,
          scheduledEndAt,
          expectedStudentCount: (assignment.riders || []).length,
          routeDistanceKm: Number.isFinite(Number(assignment.route?.distanceKm))
            ? Number(assignment.route.distanceKm)
            : undefined,
          routeDurationMinutes: Number.isFinite(routeDuration) ? routeDuration : undefined,
          attendanceSummary: {
            total: (assignment.riders || []).length,
            pendingPickup: direction === 'morning' ? (assignment.riders || []).length : 0,
            pendingDrop: direction === 'afternoon' ? (assignment.riders || []).length : 0,
          },
        });

        await recordTripEvent({
          trip,
          eventType: 'trip_created',
          source: 'system',
          occurredAt: new Date(),
          dedupeKey: `${trip._id}:trip_created`,
          meta: { autoGenerated: true, direction, date: dateStr, scheduledStartAt },
        }).catch(() => {});

        const attendanceDocs = (assignment.riders || []).map((r) => ({
          trip: trip._id,
          student: r.student._id || r.student,
          vehicle: vehicle._id,
          driver: driver._id,
          route: assignment.route._id,
          date: dateStr,
          stop: r.stop || '',
        }));

        if (attendanceDocs.length) {
          await Attendance.insertMany(attendanceDocs, { ordered: false }).catch((e) => {
            if (e?.code !== 11000 && !e?.writeErrors) throw e;
          });
        }

        results.push({ trip: trip._id, assignment: assignment._id, date: dateStr, direction, status: 'created' });
      } catch (e) {
        if (e?.code === 11000) {
          results.push({ assignment: assignment._id, date: dateStr, direction, status: 'skipped', reason: 'duplicate' });
        } else {
          throw e;
        }
      }
    }
  }

  return { date: dateStr, workingDay: true, trips: results };
}

export async function generateTripsForDateRange(fromDate, toDate, { timezone = 'Asia/Kolkata' } = {}) {
  const config = await getSchoolConfig();
  const tz = timezone || config.timezone || 'Asia/Kolkata';

  const from = new Date(fromDate);
  const to = new Date(toDate);
  const dates = [];
  for (let d = new Date(from); d <= to; d.setDate(d.getDate() + 1)) {
    dates.push(dateInTz(d, tz));
  }

  const results = [];
  for (const dateStr of dates) {
    const result = await generateTripsForDate(dateStr, { timezone: tz });
    results.push(result);
  }
  return results;
}

export async function generateTripsToday({ timezone = 'Asia/Kolkata', dryRun = false, force = false } = {}) {
  return generateTripsForDate(todayInTz(timezone), { timezone, dryRun, force });
}

function todayInTz(timezone = 'Asia/Kolkata') {
  return new Date().toLocaleDateString('en-CA', { timeZone: timezone });
}

export async function getPendingTrips(dateStr) {
  return Trip.find({ date: dateStr, status: 'scheduled' })
    .populate('vehicle', 'registrationNumber busNumber')
    .populate('driver', 'name phone')
    .populate('route', 'name')
    .sort({ direction: 1, createdAt: 1 })
    .lean();
}

export async function applyExceptionToTrip(studentId, date, direction, target, exceptionGeo) {
  const exception = await getApprovedException(studentId, date, direction, target);
  if (!exception) return null;
  return exception.geo || exceptionGeo;
}
