import {
  Driver,
  Student,
  TransportAssignment,
  Trip,
  Vehicle,
  VehicleCurrentLocation,
} from '../models/index.js';
import { ApiError, asyncHandler, ok } from '../utils/http.js';
import { paginate } from '../utils/paginate.js';
import { audit } from '../services/audit.service.js';
import { cleanupExpiredLocations } from '../services/tripLocation.service.js';

function todayInTz(timezone = 'Asia/Kolkata') {
  return new Date().toLocaleDateString('en-CA', { timeZone: timezone });
}

export const fleetSummary = asyncHandler(async (req, res) => {
  const today = todayInTz();
  const activeStatuses = ['in_progress', 'delayed', 'paused', 'arrived_at_school'];

  const [totalVehicles, vehiclesByStatus, tripsToday, activeTripVehicles, notStartedVehicles, completedTrips, delayedTrips, gpsIssues] =
    await Promise.all([
      Vehicle.countDocuments(),
      Vehicle.aggregate([{ $group: { _id: '$status', count: { $sum: 1 } } }]),
      Trip.countDocuments({ date: today }),
      Trip.distinct('vehicle', { date: today, status: { $in: activeStatuses } }),
      Trip.distinct('vehicle', { date: today, status: { $in: ['scheduled', 'assigned', 'ready'] } }),
      Trip.countDocuments({ date: today, status: 'completed' }),
      Trip.countDocuments({ date: today, status: 'delayed' }),
      Trip.countDocuments({
        date: today,
        status: { $in: ['in_progress', 'delayed', 'paused'] },
        $or: [
          { lastGpsUpdateAt: { $lt: new Date(Date.now() - 5 * 60 * 1000) } },
          { lastGpsUpdateAt: null },
        ],
      }),
    ]);

  const statusMap = {};
  for (const v of vehiclesByStatus) statusMap[v._id] = v.count;

  const unavailable = (statusMap.maintenance || 0) + (statusMap.unavailable || 0);

  ok(res, {
    date: today,
    totalVehicles,
    vehiclesActiveOnTrips: activeTripVehicles.length,
    vehiclesNotStarted: notStartedVehicles.length,
    completedTripsToday: completedTrips,
    delayedTripsToday: delayedTrips,
    vehiclesWithGpsIssues: gpsIssues,
    vehiclesUnavailableOrOutOfService: unavailable,
    totalTripsToday: tripsToday,
    byStatus: statusMap,
  });
});

export const fleetVehicles = asyncHandler(async (req, res) => {
  const q = req.query;
  const filter = {};
  if (q.status) filter.status = q.status;

  const vehicles = await Vehicle.find(filter)
    .sort('busNumber')
    .lean();

  const assignments = await TransportAssignment.find({ status: 'active' })
    .populate('driver', 'name phone status')
    .populate('route', 'name status')
    .lean();

  const currentLocations = await VehicleCurrentLocation.find().lean();
  const locMap = new Map(currentLocations.map((l) => [String(l.vehicle), l]));

  const assignmentMap = new Map();
  for (const a of assignments) assignmentMap.set(String(a.vehicle), a);

  const now = Date.now();
  const staleThreshold = 5 * 60 * 1000;

  const vehicleData = await Promise.all(vehicles.map(async (v) => {
    const a = assignmentMap.get(String(v._id));
    const loc = locMap.get(String(v._id));
    const stale = loc ? (now - new Date(loc.recordedAt).getTime()) > staleThreshold : true;

    return {
      _id: v._id,
      registrationNumber: v.registrationNumber,
      busNumber: v.busNumber,
      model: v.model,
      capacity: v.capacity,
      status: v.status,
      driver: a ? { _id: a.driver._id, name: a.driver.name, phone: a.driver.phone } : null,
      route: a ? { _id: a.route._id, name: a.route.name } : null,
      studentCount: a ? a.riders.length : 0,
      assignmentId: a ? a._id : null,
      currentLocation: loc ? {
        latitude: loc.latitude,
        longitude: loc.longitude,
        speedKmh: loc.speedKmh,
        heading: loc.heading,
        recordedAt: loc.recordedAt,
        receivedAt: loc.receivedAt,
        trackingActive: loc.trackingActive,
        stale,
      } : null,
      gpsStatus: loc ? (stale ? 'stale' : 'live') : 'missing',
      tripStatus: a ? await getTripStatusForAssignment(String(a._id)) : null,
    };
  }));

  ok(res, vehicleData);
});

async function getTripStatusForAssignment(assignmentId) {
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
  const trip = await Trip.findOne({ assignment: assignmentId, date: today }).sort('-direction').lean();
  return trip ? trip.status : null;
}

export const fleetVehicleDetail = asyncHandler(async (req, res) => {
  const vehicle = await Vehicle.findById(req.params.id).lean();
  if (!vehicle) throw new ApiError(404, 'Vehicle not found');

  const assignment = await TransportAssignment.findOne({ vehicle: vehicle._id, status: 'active' })
    .populate('driver', 'name licenseNumber phone status')
    .populate('route', 'name stops status')
    .lean();

  const riders = assignment ? assignment.riders : [];
  const studentIds = riders.map((r) => r.student);
  const students = await Student.find({ _id: { $in: studentIds } }).select('name studentId className division photograph permanentPickupLocation permanentDropLocation status').lean();
  const studentMap = new Map(students.map((s) => [String(s._id), s]));

  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
  const trips = await Trip.find({ vehicle: vehicle._id, date: today }).sort({ direction: 1 }).lean();

  const currentLocation = await VehicleCurrentLocation.findOne({ vehicle: vehicle._id }).lean();

  ok(res, {
    vehicle,
    assignment: assignment ? {
      _id: assignment._id,
      driver: assignment.driver,
      route: assignment.route,
      riders: riders.map((r) => ({
        student: studentMap.get(String(r.student)),
        stop: r.stop,
      })),
    } : null,
    currentLocation,
    trips,
  });
});

export const fleetMap = asyncHandler(async (_req, res) => {
  const vehicles = await Vehicle.find({ status: 'available' }).lean();
  const assignments = await TransportAssignment.find({ status: 'active' })
    .populate('driver', 'name phone status')
    .populate('route', 'name status')
    .lean();

  const currentLocations = await VehicleCurrentLocation.find({ trackingActive: true }).lean();
  const locMap = new Map(currentLocations.map((l) => [String(l.vehicle), l]));

  const assignmentMap = new Map();
  for (const a of assignments) assignmentMap.set(String(a.vehicle), a);

  const markers = vehicles.map((v) => {
    const a = assignmentMap.get(String(v._id));
    const loc = locMap.get(String(v._id));
    if (!loc) return null;
    return {
      vehicleId: v._id,
      registrationNumber: v.registrationNumber,
      busNumber: v.busNumber,
      latitude: loc.latitude,
      longitude: loc.longitude,
      speedKmh: loc.speedKmh,
      heading: loc.heading,
      recordedAt: loc.recordedAt,
      driver: a ? { name: a.driver.name } : null,
      route: a ? { name: a.route.name } : null,
      trackingActive: loc.trackingActive,
    };
  }).filter(Boolean);

  ok(res, { markers });
});

export const tripMonitor = asyncHandler(async (req, res) => {
  const q = req.query;
  const filter = {};
  if (q.date) filter.date = q.date;
  else if (q.from || q.to) {
    filter.date = { ...(q.from ? { $gte: q.from } : {}), ...(q.to ? { $lte: q.to } : {}) };
  }
  if (q.direction) filter.direction = q.direction;
  if (q.status) filter.status = q.status;
  if (q.vehicle) filter.vehicle = q.vehicle;
  if (q.driver) filter.driver = q.driver;
  if (q.route) filter.route = q.route;

  const { items, meta } = await paginate(Trip, filter, q, {
    populate: [
      { path: 'vehicle', select: 'registrationNumber busNumber status' },
      { path: 'driver', select: 'name phone status' },
      { path: 'substituteDriver', select: 'name phone' },
      { path: 'substituteVehicle', select: 'registrationNumber busNumber' },
      { path: 'route', select: 'name status' },
    ],
    sortable: ['date', 'direction', 'status', 'createdAt'],
    defaultSort: '-date',
  });

  const now = Date.now();
  const staleThreshold = 5 * 60 * 1000;
  const locations = await VehicleCurrentLocation.find().lean();
  const locMap = new Map(locations.map((l) => [String(l.vehicle), l]));

  const data = items.map((t) => {
    const loc = locMap.get(String(t.vehicle));
    const stale = loc ? (now - new Date(loc.recordedAt).getTime()) > staleThreshold : true;

    return {
      _id: t._id,
      date: t.date,
      direction: t.direction,
      status: t.status,
      vehicle: t.vehicle,
      driver: t.driver,
      substituteDriver: t.substituteDriver,
      substituteVehicle: t.substituteVehicle,
      route: t.route,
      scheduledStart: t.startedAt,
      actualStart: t.startedAt,
      completedAt: t.completedAt,
      delayMinutes: t.delayMinutes,
      delayReason: t.delayReason,
      cancelledAt: t.cancelledAt,
      cancelledBy: t.cancelledBy,
      gpsTrackingActive: t.gpsTrackingActive,
      lastGpsUpdateAt: t.lastGpsUpdateAt,
      gpsStale: stale,
      lastGpsRecordedAt: loc?.recordedAt || null,
    };
  });

  ok(res, data, meta);
});

export const delayedTrips = asyncHandler(async (req, res) => {
  const q = req.query;
  const filter = { status: 'delayed' };
  if (q.date) filter.date = q.date;

  const { items, meta } = await paginate(Trip, filter, q, {
    populate: [
      { path: 'vehicle', select: 'registrationNumber busNumber' },
      { path: 'driver', select: 'name phone' },
      { path: 'route', select: 'name' },
    ],
    sortable: ['date', 'delayMinutes'],
    defaultSort: '-delayMinutes',
  });
  ok(res, items, meta);
});

export const gpsAlerts = asyncHandler(async (req, res) => {  const now = Date.now();
  const staleThreshold = 5 * 60 * 1000;

  const activeTrips = await Trip.find({
    status: { $in: ['in_progress', 'delayed'] },
    date: new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' }),
  }).populate('vehicle', 'registrationNumber busNumber').populate('driver', 'name').lean();

  const locations = await VehicleCurrentLocation.find().lean();
  const locMap = new Map(locations.map((l) => [String(l.vehicle), l]));

  const alerts = [];
  for (const t of activeTrips) {
    const loc = locMap.get(String(t.vehicle));
    if (!loc || !loc.trackingActive) {
      alerts.push({
        tripId: t._id,
        vehicle: t.vehicle,
        driver: t.driver,
        type: 'gps_missing',
        severity: 'high',
        message: 'No GPS location for active trip',
        lastUpdate: null,
      });
    } else if ((now - new Date(loc.recordedAt).getTime()) > staleThreshold) {
      alerts.push({
        tripId: t._id,
        vehicle: t.vehicle,
        driver: t.driver,
        type: 'gps_stale',
        severity: 'medium',
        message: 'GPS location is stale',
        lastUpdate: loc.recordedAt,
        ageSeconds: Math.round((now - new Date(loc.recordedAt).getTime()) / 1000),
      });
    }
  }

  ok(res, alerts);
});

export const cleanupGpsHistory = asyncHandler(async (req, res) => {
  const result = await cleanupExpiredLocations({ retentionDays: req.body?.retentionDays });
  await audit(req, 'gps_cleanup', 'TripLocation', undefined, result);
  ok(res, result);
});
