import {
  Attendance,
  Parent,
  Route,
  SchoolConfig,
  Student,
  TransportAssignment,
  Trip,
  TripLocation,
  VehicleCurrentLocation,
} from '../models/index.js';
import { ApiError, asyncHandler, ok } from '../utils/http.js';
import { predictForTrip } from '../services/ai/eta.service.js';
import { haversineKm } from '../services/ai/providers/routing.js';

async function currentParent(req) {
  const parent = await Parent.findOne({ user: req.user.id });
  if (!parent) throw new ApiError(404, 'Parent profile not found');
  return parent;
}

function linkedStudentIds(parent) {
  return (parent.linkedStudents || []).map((id) => String(id));
}

function todayInTz(timezone = 'Asia/Kolkata') {
  return new Date().toLocaleDateString('en-CA', { timeZone: timezone });
}

async function getSchoolContext() {
  const config = await SchoolConfig.findOne().lean();
  return {
    timezone: config?.timezone || 'Asia/Kolkata',
    staleMs: Number(config?.gpsStaleThresholdMs) || 120000,
    geo: config?.geo || null,
  };
}

function normalizeLoc(loc) {
  if (!loc) return null;
  const latitude = Number(loc.latitude);
  const longitude = Number(loc.longitude);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
  if (latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) return null;
  return {
    latitude,
    longitude,
    address: loc.address,
    landmark: loc.landmark,
    recordedAt: loc.recordedAt,
    receivedAt: loc.receivedAt,
    speedKmh: loc.speedKmh,
    heading: loc.heading,
    accuracyMeters: loc.accuracyMeters,
    trackingActive: loc.trackingActive,
  };
}

function journeyStatusLabel(trip, attendance, direction) {
  if (!attendance) return direction === 'morning' ? 'Awaiting pickup' : 'Awaiting drop-off';
  if (direction === 'morning') {
    if (attendance.pickupStatus === 'picked_up') {
      if (trip.status === 'arrived_at_school' || trip.status === 'completed') return 'Arrived at school';
      return 'On the bus to school';
    }
    if (attendance.pickupStatus === 'absent') return 'Marked absent';
    if (attendance.pickupStatus === 'not_available') return 'Not available today';
    return 'Awaiting pickup';
  }
  if (attendance.dropStatus === 'dropped') return 'Dropped off';
  if (attendance.pickupStatus === 'picked_up') return 'On board';
  if (attendance.pickupStatus === 'absent') return 'Marked absent';
  return 'Awaiting drop-off';
}

function studentStopLocation(student, direction) {
  const record = direction === 'morning' ? student.permanentPickupLocation : student.permanentDropLocation;
  return record?.geo || null;
}

function summarizeStops({ route, assignment, attendanceByStudent, direction }) {
  const stops = Array.isArray(route?.stops)
    ? [...route.stops].sort((a, b) => (a.sequence || 0) - (b.sequence || 0))
    : [];

  const riderStopByStudent = new Map(
    (assignment?.riders || []).map((r) => [String(r.student?._id || r.student), r.stop || ''])
  );

  const enriched = stops.map((stop) => {
    const riders = (assignment?.riders || []).filter((r) => {
      const studentId = String(r.student?._id || r.student);
      if (!attendanceByStudent.has(studentId)) return false;
      return (r.stop || '') === (stop.name || '');
    });
    const studentIds = riders.map((r) => String(r.student?._id || r.student));
    const done =
      studentIds.length > 0 &&
      studentIds.every((id) => {
        const a = attendanceByStudent.get(id);
        if (!a) return false;
        return direction === 'morning'
          ? a.pickupStatus !== 'pending'
          : a.dropStatus === 'dropped';
      });
    return {
      name: stop.name,
      sequence: stop.sequence,
      pickupTime: stop.pickupTime,
      dropTime: stop.dropTime,
      latitude: stop.latitude,
      longitude: stop.longitude,
      address: stop.address,
      landmark: stop.landmark,
      studentIds,
      completed: done,
    };
  });

  const nextStop = enriched.find((s) => !s.completed) || null;
  return {
    stops: enriched,
    nextStop,
    remainingStops: enriched.filter((s) => !s.completed).length,
    completedStops: enriched.filter((s) => s.completed).length,
    riderStopByStudent,
  };
}

function computeDistanceTravelled(historyAscending) {
  let km = 0;
  for (let i = 1; i < historyAscending.length; i += 1) {
    const d = haversineKm(historyAscending[i - 1], historyAscending[i]);
    if (Number.isFinite(d)) km += d;
  }
  return Number(km.toFixed(2));
}

function estimateRemainingDistance({ current, nextStop, stops, schoolGeo }) {
  if (!current) return null;
  const ordered = [...stops].sort((a, b) => (a.sequence || 0) - (b.sequence || 0));
  const nextIndex = nextStop ? ordered.findIndex((s) => s.name === nextStop.name) : ordered.length;
  const points = [{ latitude: current.latitude, longitude: current.longitude }];
  for (let i = Math.max(0, nextIndex); i < ordered.length; i += 1) {
    const s = ordered[i];
    if (s.latitude != null && s.longitude != null) points.push({ latitude: s.latitude, longitude: s.longitude });
  }
  if (schoolGeo?.latitude != null && schoolGeo?.longitude != null) points.push(schoolGeo);
  let km = 0;
  for (let i = 1; i < points.length; i += 1) {
    const d = haversineKm(points[i - 1], points[i]);
    if (Number.isFinite(d)) km += d;
  }
  return Number(km.toFixed(2));
}

async function buildJourney({ trip, assignment, linkedIds, school }) {
  const route = assignment?.route || (await Route.findById(trip.route).lean());
  const [attendanceDocs, history, latestDoc] = await Promise.all([
    Attendance.find({ trip: trip._id })
      .populate('student', 'name studentId className division photograph permanentPickupLocation permanentDropLocation')
      .lean(),
    TripLocation.find({ trip: trip._id }).sort('recordedAt').limit(400).lean(),
    VehicleCurrentLocation.findOne({ vehicle: trip.vehicle }).lean(),
  ]);

  const linkedSet = new Set(linkedIds.map(String));
  const attendanceByStudent = new Map(attendanceDocs.map((a) => [String(a.student?._id || a.student), a]));
  const linkedAttendance = attendanceDocs.filter((a) => linkedSet.has(String(a.student?._id || a.student)));
  const latestLocation = normalizeLoc(latestDoc);
  const locationAgeMs = latestLocation?.recordedAt
    ? Date.now() - new Date(latestLocation.recordedAt).getTime()
    : null;
  const trackingStatus =
    !latestLocation ? 'unavailable' : locationAgeMs != null && locationAgeMs > school.staleMs ? 'stale' : 'live';

  const { stops, nextStop, remainingStops, completedStops } = summarizeStops({
    route,
    assignment,
    attendanceByStudent,
    direction: trip.direction,
  });

  const schoolGeo =
    route?.schoolLocation?.latitude != null
      ? {
          latitude: Number(route.schoolLocation.latitude),
          longitude: Number(route.schoolLocation.longitude),
          address: route.schoolLocation.address,
          landmark: route.schoolLocation.landmark,
        }
      : school.geo
      ? {
          latitude: Number(school.geo.latitude),
          longitude: Number(school.geo.longitude),
          address: school.geo.address,
          landmark: school.geo.landmark,
        }
      : null;

  const students = linkedAttendance
    .map((a) => {
      const s = a.student;
      if (!s) return null;
      return {
        student: {
          _id: s._id,
          name: s.name,
          studentId: s.studentId,
          className: s.className,
          division: s.division,
          photograph: s.photograph,
        },
        stop: a.stop || '',
        stopLocation: studentStopLocation(s, trip.direction),
        direction: trip.direction,
        attendance: {
          pickupStatus: a.pickupStatus,
          pickupAt: a.pickupAt || null,
          dropStatus: a.dropStatus,
          dropAt: a.dropAt || null,
          note: a.pickupNote || a.dropNote || null,
          exception: Boolean(a.exception),
        },
        statusLabel: journeyStatusLabel(trip, a, trip.direction),
      };
    })
    .filter(Boolean);

  const eta = await predictForTrip({ user: { id: null, role: 'admin' } }, trip._id).catch(() => null);
  const nextStopEta =
    eta?.estimate?.stopEstimates?.find((s) => s.name === nextStop?.name) || null;

  return {
    tripId: trip._id,
    assignmentId: assignment?._id || trip.assignment,
    direction: trip.direction,
    status: trip.status,
    date: trip.date,
    scheduledStartAt: trip.scheduledStartAt || null,
    startedAt: trip.startedAt || null,
    arrivedAtSchoolAt: trip.arrivedAtSchoolAt || null,
    completedAt: trip.completedAt || null,
    delayMinutes: trip.delayMinutes ?? null,
    delayReason: trip.delayReason || null,
    vehicle: assignment?.vehicle || null,
    driver: assignment?.driver || null,
    route: route
      ? {
          _id: route._id,
          name: route.name,
          stops,
          geometry: Array.isArray(route.geometry) ? route.geometry : [],
          distanceKm: route.distanceKm ?? null,
          durationMinutes: route.durationMinutes ?? null,
          metricsSource: route.metricsSource || null,
          metricsIsFallback: route.metricsIsFallback !== false,
          schoolLocation: route.schoolLocation || null,
        }
      : null,
    schoolLocation: schoolGeo,
    currentLocation: latestLocation,
    tracking: {
      status: trackingStatus,
      stale: trackingStatus === 'stale',
      ageSeconds: locationAgeMs != null ? Math.round(locationAgeMs / 1000) : null,
      lastUpdate: latestLocation?.recordedAt || null,
      gpsTrackingActive: Boolean(trip.gpsTrackingActive),
    },
    progress: {
      totalStops: stops.length,
      completedStops,
      remainingStops,
      nextStop,
      distanceTravelledKm: history.length >= 2 ? computeDistanceTravelled(history) : null,
      distanceSource: 'gps_track',
      remainingDistanceKm: estimateRemainingDistance({
        current: latestLocation,
        nextStop,
        stops,
        schoolGeo,
      }),
      remainingDistanceSource: 'straight_line_estimate',
    },
    eta: eta?.estimate
      ? {
          ...eta.estimate,
          nextStopEta: nextStopEta
            ? { stop: nextStop?.name, estimatedArrival: nextStopEta.estimatedArrival }
            : null,
        }
      : null,
    students,
  };
}

export const parentActiveTrips = asyncHandler(async (req, res) => {
  const parent = await currentParent(req);
  const linked = linkedStudentIds(parent);
  if (!linked.length) return ok(res, []);

  const school = await getSchoolContext();
  const today = todayInTz(school.timezone);

  const assignments = await TransportAssignment.find({ status: 'active', 'riders.student': { $in: linked } })
    .populate('vehicle', 'registrationNumber busNumber capacity status model')
    .populate('driver', 'name licenseNumber phone status')
    .populate('route', 'name stops status geometry distanceKm durationMinutes schoolLocation metricsSource metricsIsFallback')
    .lean();

  const journeys = [];
  for (const assignment of assignments) {
    const riders = (assignment.riders || []).filter((r) => linked.includes(String(r.student)));
    if (!riders.length) continue;

    const trips = await Trip.find({ assignment: assignment._id, date: today })
      .sort({ direction: 1 })
      .lean();

    for (const trip of trips) {
      const journey = await buildJourney({ trip, assignment, linkedIds: linked, school });
      if (journey.students.length) journeys.push(journey);
    }
  }

  // Active trips first, then most recent completed trip for each direction.
  journeys.sort((a, b) => {
    const aActive = !['completed', 'cancelled'].includes(a.status) ? 0 : 1;
    const bActive = !['completed', 'cancelled'].includes(b.status) ? 0 : 1;
    if (aActive !== bActive) return aActive - bActive;
    return String(b.startedAt || '').localeCompare(String(a.startedAt || ''));
  });

  ok(res, journeys);
});

export const parentTripLocation = asyncHandler(async (req, res) => {
  const parent = await currentParent(req);
  const linked = linkedStudentIds(parent);
  const school = await getSchoolContext();

  const trip = await Trip.findById(req.params.tripId).lean();
  if (!trip) throw new ApiError(404, 'Trip not found');

  const assignment = await TransportAssignment.findById(trip.assignment)
    .populate('vehicle', 'registrationNumber busNumber capacity status model')
    .populate('driver', 'name licenseNumber phone status')
    .populate('route', 'name stops status geometry distanceKm durationMinutes schoolLocation metricsSource metricsIsFallback')
    .lean();
  if (!assignment) throw new ApiError(404, 'Assignment not found');

  const riders = (assignment.riders || []).filter((r) => linked.includes(String(r.student)));
  if (!riders.length) throw new ApiError(403, 'You can only track trips for your linked children');

  const journey = await buildJourney({ trip, assignment, linkedIds: linked, school });
  ok(res, journey);
});

export const parentTripETA = asyncHandler(async (req, res) => {
  const parent = await currentParent(req);
  const linked = linkedStudentIds(parent);

  const trip = await Trip.findById(req.params.tripId).lean();
  if (!trip) throw new ApiError(404, 'Trip not found');

  const assignment = await TransportAssignment.findById(trip.assignment).lean();
  if (!assignment) throw new ApiError(404, 'Assignment not found');

  const riders = (assignment.riders || []).filter((r) => linked.includes(String(r.student)));
  if (!riders.length) throw new ApiError(403, 'You can only view ETA for your linked children');

  const eta = await predictForTrip({ user: req.user, role: req.user.role }, trip._id).catch((e) => {
    throw new ApiError(502, `ETA calculation unavailable: ${e.message}`);
  });

  ok(res, {
    tripId: trip._id,
    direction: trip.direction,
    status: trip.status,
    estimate: eta.estimate,
  });
});

export const parentChildrenTransport = asyncHandler(async (req, res) => {
  const parent = await currentParent(req);
  const school = await getSchoolContext();
  const today = todayInTz(school.timezone);
  const students = await Student.find({ _id: { $in: parent.linkedStudents || [] } })
    .select('name studentId className division status photograph permanentPickupLocation permanentDropLocation address phone')
    .sort('name')
    .lean();

  const data = await Promise.all(
    students.map(async (s) => {
      const assignment = await TransportAssignment.findOne({ status: 'active', 'riders.student': s._id })
        .populate('vehicle', 'registrationNumber busNumber capacity status model')
        .populate('driver', 'name licenseNumber phone status')
        .populate('route', 'name stops status geometry distanceKm durationMinutes schoolLocation metricsSource metricsIsFallback')
        .lean();

      const rider = assignment
        ? (assignment.riders || []).find((r) => String(r.student) === String(s._id))
        : null;

      const trips = assignment
        ? await Trip.find({ assignment: assignment._id, date: today }).sort({ direction: 1 }).lean()
        : [];

      const tripSummaries = [];
      for (const trip of trips) {
        const attendance = await Attendance.findOne({ trip: trip._id, student: s._id }).lean();
        const latest = await VehicleCurrentLocation.findOne({ vehicle: trip.vehicle }).lean();
        const location = normalizeLoc(latest);
        tripSummaries.push({
          tripId: trip._id,
          direction: trip.direction,
          status: trip.status,
          startedAt: trip.startedAt,
          completedAt: trip.completedAt,
          arrivedAtSchoolAt: trip.arrivedAtSchoolAt,
          delayMinutes: trip.delayMinutes,
          trackingStatus: !location
            ? 'unavailable'
            : Date.now() - new Date(location.recordedAt).getTime() > school.staleMs
            ? 'stale'
            : 'live',
          currentLocation: location,
          attendance: attendance
            ? {
                pickupStatus: attendance.pickupStatus,
                pickupAt: attendance.pickupAt,
                dropStatus: attendance.dropStatus,
                dropAt: attendance.dropAt,
              }
            : null,
          statusLabel: journeyStatusLabel(trip, attendance, trip.direction),
        });
      }

      return {
        _id: s._id,
        name: s.name,
        studentId: s.studentId,
        className: s.className,
        division: s.division,
        status: s.status,
        photograph: s.photograph,
        permanentPickupLocation: s.permanentPickupLocation,
        permanentDropLocation: s.permanentDropLocation,
        transport: assignment
          ? {
              assignment: assignment._id,
              vehicle: assignment.vehicle,
              driver: assignment.driver,
              route: assignment.route,
              stop: rider?.stop || null,
            }
          : null,
        todayTrips: tripSummaries,
        activeTrip: tripSummaries.find((t) => !['completed', 'cancelled'].includes(t.status)) || null,
      };
    })
  );

  ok(res, data);
});
