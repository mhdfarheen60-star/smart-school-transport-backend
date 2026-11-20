import { Driver, Route, Student, TransportAssignment, TransportRequest, RequestAssignment, Vehicle } from '../models/index.js';
import { audit } from '../services/audit.service.js';
import { currentLocations } from '../services/location.service.js';
import { enrollStudent } from '../services/assignment.service.js';
import { notifyAdmins, notifyUsers } from '../services/notification.service.js';
import { ApiError, asyncHandler, ok } from '../utils/http.js';
import { paginate } from '../utils/paginate.js';
import { runInTransaction } from '../utils/transaction.js';

const populate = [
  { path: 'vehicle', select: 'registrationNumber busNumber capacity status model' },
  { path: 'driver', select: 'name phone licenseNumber user' },
  { path: 'route', select: 'name stops status' },
  { path: 'riders.student', select: 'name studentId className division phone parentPhone user' },
];

async function validateParts(vehicleId, driverId, routeId, excludeId) {
  const [vehicle, driver, route] = await Promise.all([
    Vehicle.findById(vehicleId),
    Driver.findById(driverId),
    Route.findById(routeId),
  ]);
  if (!vehicle) throw new ApiError(404, 'Vehicle not found');
  if (!driver) throw new ApiError(404, 'Driver not found');
  if (!route) throw new ApiError(404, 'Route not found');
  if (vehicle.status !== 'available') {
    throw new ApiError(409, `Vehicle ${vehicle.registrationNumber} is ${vehicle.status} and cannot be assigned`);
  }
  if (driver.status !== 'active') throw new ApiError(409, 'Driver is inactive');
  if (route.status !== 'active') throw new ApiError(409, 'Route is inactive');
  const ne = excludeId ? { _id: { $ne: excludeId } } : {};
  if (await TransportAssignment.exists({ vehicle: vehicle._id, status: 'active', ...ne })) {
    throw new ApiError(409, 'Vehicle already has an active assignment');
  }
  if (await TransportAssignment.exists({ driver: driver._id, status: 'active', ...ne })) {
    throw new ApiError(409, 'Driver is already assigned to another bus');
  }
  return { vehicle, driver, route };
}

export const list = asyncHandler(async (req, res) => {
  const q = req.query;
  const filter = {};
  if (q.status) filter.status = q.status;
  const { items, meta } = await paginate(TransportAssignment, filter, q, {
    populate,
    sortable: ['status', 'startDate'],
    defaultSort: '-createdAt',
  });
  ok(res, items, meta);
});

export const getOne = asyncHandler(async (req, res) => {
  const [ra, ta] = await Promise.all([
    RequestAssignment.findById(req.params.id)
      .populate('request', 'student pickupLocation dropLocation pickupGeo dropGeo requestedAt status assignedDriver assignedAt createdAt')
      .populate('driver', 'name phone licenseNumber')
      .lean(),
    TransportAssignment.findById(req.params.id).populate(populate).lean(),
  ]);
  const isRequestAssignment = Boolean(ra);
  const a = ra || ta;
  if (!a) throw new ApiError(404, 'Assignment not found');
  const idOf = (value) => String(value?._id ?? value);
  if (req.user.role === 'driver') {
    const d = await Driver.findOne({ user: req.user.id });
    if (!d) throw new ApiError(404, 'Driver profile not found');
    const id = isRequestAssignment ? idOf(ra.driver) : idOf(ta.driver);
    if (id !== String(d._id)) throw new ApiError(403, 'Not your assignment');
  }
  if (req.user.role === 'student') {
    const s = await Student.findOne({ user: req.user.id });
    if (!s) throw new ApiError(404, 'Student profile not found');
    if (isRequestAssignment) {
      if (idOf(ra.request.student) !== String(s._id)) throw new ApiError(403, 'Not your request');
    } else {
      const riders = (ta.riders || []).map((r) => idOf(r.student));
      if (!riders.includes(String(s._id))) throw new ApiError(403, 'Not your assignment');
    }
  }
  ok(res, a);
});

export const create = asyncHandler(async (req, res) => {
  const { vehicle, driver, route } = req.body;
  const parts = await validateParts(vehicle, driver, route);
  const a = await TransportAssignment.create({ vehicle, driver, route });
  await notifyUsers([parts.driver.user], {
    title: 'New bus assignment',
    message: `You have been assigned to bus ${parts.vehicle.busNumber} (${parts.vehicle.registrationNumber}) on route "${parts.route.name}".`,
    type: 'assignment',
  });
  await audit(req, 'create', 'TransportAssignment', a.id);
  ok(res, await a.populate(populate), undefined, 201);
});

export const update = asyncHandler(async (req, res) => {
  const a = await TransportAssignment.findById(req.params.id);
  if (!a) throw new ApiError(404, 'Assignment not found');
  if (a.status !== 'active') throw new ApiError(409, 'Ended assignments cannot be modified');
  const vehicleId = req.body.vehicle || String(a.vehicle);
  const driverId = req.body.driver || String(a.driver);
  const routeId = req.body.route || String(a.route);
  const parts = await validateParts(vehicleId, driverId, routeId, a.id);
  if (parts.vehicle.capacity < a.riders.length) {
    throw new ApiError(409, `Vehicle capacity (${parts.vehicle.capacity}) is lower than assigned students (${a.riders.length})`);
  }
  const driverChanged = String(a.driver) !== driverId;
  const routeChanged = String(a.route) !== routeId;
  a.vehicle = parts.vehicle._id;
  a.driver = parts.driver._id;
  a.route = parts.route._id;
  await a.save();
  if (driverChanged) {
    await notifyUsers([parts.driver.user], {
      title: 'New bus assignment',
      message: `You have been assigned to bus ${parts.vehicle.busNumber} on route "${parts.route.name}".`,
      type: 'assignment',
    });
  }
  if (routeChanged || driverChanged) {
    const students = await Student.find({ _id: { $in: a.riders.map((r) => r.student) } }).select('user');
    await notifyUsers(students.map((s) => s.user), {
      title: 'Route / driver updated',
      message: `Your transport details changed. Driver: ${parts.driver.name}, route: ${parts.route.name}.`,
      type: 'route_change',
    });
  }
  await audit(req, 'update', 'TransportAssignment', a.id);
  ok(res, await a.populate(populate));
});

export const end = asyncHandler(async (req, res) => {
  const a = await TransportAssignment.findById(req.params.id);
  if (!a) throw new ApiError(404, 'Assignment not found');
  if (a.status === 'ended') throw new ApiError(409, 'Assignment already ended');
  a.status = 'ended';
  a.endDate = new Date();
  await a.save();
  await audit(req, 'end', 'TransportAssignment', a.id);
  ok(res, a);
});

export const addRider = asyncHandler(async (req, res) => {
  const a = await enrollStudent(req.params.id, req.body.student, req.body.stop);
  await audit(req, 'add_rider', 'TransportAssignment', a.id, { student: req.body.student });
  ok(res, await a.populate(populate));
});

export const removeRider = asyncHandler(async (req, res) => {
  const a = await TransportAssignment.findById(req.params.id);
  if (!a) throw new ApiError(404, 'Assignment not found');
  const before = a.riders.length;
  a.riders = a.riders.filter((r) => String(r.student) !== req.params.studentId);
  if (a.riders.length === before) throw new ApiError(404, 'Student is not on this bus');
  await a.save();
  const s = await Student.findById(req.params.studentId).select('user');
  if (s) {
    await notifyUsers([s.user], {
      title: 'Transport removed',
      message: 'You have been removed from your bus assignment. Contact the school office for details.',
      type: 'assignment',
    });
  }
  await audit(req, 'remove_rider', 'TransportAssignment', a.id, { student: req.params.studentId });
  ok(res, await a.populate(populate));
});

export const mine = asyncHandler(async (req, res) => {
  if (req.user.role === 'student') {
    const s = await Student.findOne({ user: req.user.id });
    if (!s) throw new ApiError(404, 'Student profile not found');
    const a = await TransportAssignment.findOne({ status: 'active', 'riders.student': s._id })
      .populate('vehicle', 'registrationNumber busNumber model capacity')
      .populate('driver', 'name phone')
      .populate('route', 'name stops')
      .lean();
    if (!a) return ok(res, null);
    const locations = (await currentLocations([s._id])).get(String(s._id)) || null;
    const rider = a.riders.find((r) => String(r.student) === String(s._id));
    const stop = a.route.stops.find((x) => x.name === rider?.stop);
    ok(res, {
      _id: a._id,
      vehicle: a.vehicle,
      driver: a.driver,
      route: a.route,
      stop: rider?.stop,
      pickupTime: stop?.pickupTime,
      dropTime: stop?.dropTime,
      locations,
    });
  } else {
    const d = await Driver.findOne({ user: req.user.id });
    if (!d) throw new ApiError(404, 'Driver profile not found');
    const a = await TransportAssignment.findOne({ status: 'active', driver: d._id })
      .populate('vehicle', 'registrationNumber busNumber model capacity status')
      .populate('route', 'name stops')
      .populate('riders.student', 'name studentId className division phone parentPhone address')
      .lean();
    if (!a) return ok(res, null);
    const locs = await currentLocations(a.riders.map((r) => r.student._id));
    const requestAssignments = await RequestAssignment.find({
      driver: d._id,
      status: { $in: ['assigned', 'accepted'] },
    })
      .populate('request', 'pickupLocation dropLocation pickupGeo dropGeo requestedAt status student assignedAt createdAt')
      .populate('driver', 'name phone')
      .sort('-createdAt')
      .lean();
    ok(res, {
      ...a,
      riders: a.riders.map((r) => ({ ...r, locations: locs.get(String(r.student._id)) || null })),
      requestAssignments,
    });
  }
});

const TRIP_NEXT = {
  scheduled: 'driver_en_route',
  driver_en_route: 'arrived',
  arrived: 'in_progress',
  in_progress: 'completed',
};
const REQUEST_FOR_TRIP = {
  scheduled: 'accepted',
  driver_en_route: 'driver_en_route',
  arrived: 'arrived',
  in_progress: 'in_progress',
  completed: 'completed',
};
const TRIP_TITLES = {
  driver_en_route: 'Driver is on the way',
  arrived: 'Driver has arrived at pickup',
  in_progress: 'Trip started',
  completed: 'Trip completed',
};

export const accept = asyncHandler(async (req, res) => {
  let saved;
  await runInTransaction(async (session) => {
    const a = await RequestAssignment.findById(req.params.id).session(session);
    if (!a) throw new ApiError(404, 'Assignment not found');
    const driver = await Driver.findOne({ user: req.user.id }).session(session);
    if (!driver || String(a.driver) !== String(driver._id)) throw new ApiError(403, 'Not your assignment');
    if (a.status !== 'assigned') throw new ApiError(409, `Assignment is already ${a.status}`);
    const r = await TransportRequest.findById(a.request).session(session);
    if (!r || r.status !== 'assigned') throw new ApiError(409, 'Request is no longer assigned');
    a.status = 'accepted';
    a.acceptedAt = new Date();
    r.status = 'accepted';
    await a.save({ session });
    await r.save({ session });
    saved = a;
    const student = await Student.findById(r.student).select('user name studentId').session(session);
    await notifyAdmins({
      title: 'Transport request accepted',
      message: `Driver ${driver.name} accepted transport request ${r._id}.`,
      type: 'assignment',
    });
    if (student?.user) {
      await notifyUsers([student.user], {
        title: 'Transport request accepted',
        message: 'The driver has accepted your transport request.',
        type: 'assignment',
      });
    }
    await audit(req, 'accept', 'RequestAssignment', a.id, { driver: driver.name });
  });
  const assignment = await RequestAssignment.findById(saved._id)
    .populate('driver', 'name phone')
    .populate('request', 'pickupLocation dropLocation pickupGeo dropGeo requestedAt status')
    .lean();
  ok(res, assignment);
});

export const decline = asyncHandler(async (req, res) => {
  const { reason } = req.body;
  let saved;
  await runInTransaction(async (session) => {
    const a = await RequestAssignment.findById(req.params.id).session(session);
    if (!a) throw new ApiError(404, 'Assignment not found');
    const driver = await Driver.findOne({ user: req.user.id }).session(session);
    if (!driver || String(a.driver) !== String(driver._id)) throw new ApiError(403, 'Not your assignment');
    if (a.status !== 'assigned') throw new ApiError(409, `Assignment is already ${a.status}`);
    const r = await TransportRequest.findById(a.request).session(session);
    if (!r) throw new ApiError(404, 'Request not found');
    a.status = 'declined';
    a.declinedAt = new Date();
    a.declineReason = reason;
    r.status = 'reassignment_required';
    await a.save({ session });
    await r.save({ session });
    saved = a;
    await notifyAdmins({
      title: 'Driver declined transport request',
      message: `Driver ${driver.name} declined request ${r._id}. Reason: ${reason}. The request is ready for reassignment.`,
      type: 'request',
    });
    await audit(req, 'decline', 'RequestAssignment', a.id, { driver: driver.name, reason });
  });
  ok(res, { _id: saved._id, status: saved.status, declineReason: saved.declineReason, request: saved.request });
});

export const updateTripStatus = asyncHandler(async (req, res) => {
  const { status } = req.body;
  let saved;
  await runInTransaction(async (session) => {
    const a = await RequestAssignment.findById(req.params.id).session(session);
    if (!a) throw new ApiError(404, 'Assignment not found');
    const driver = await Driver.findOne({ user: req.user.id }).session(session);
    if (!driver || String(a.driver) !== String(driver._id)) throw new ApiError(403, 'Not your assignment');
    if (a.tripStatus === 'completed') throw new ApiError(409, `Trip already ${a.tripStatus}`);
    const next = TRIP_NEXT[a.tripStatus];
    if (!next || status !== next) throw new ApiError(409, `Cannot move from ${a.tripStatus} to ${status}`);
    const r = await TransportRequest.findById(a.request).session(session);
    if (!r || r.status !== REQUEST_FOR_TRIP[a.tripStatus]) {
      throw new ApiError(409, 'Request and assignment status are out of sync');
    }
    a.tripStatus = status;
    if (status === 'completed') a.completedAt = new Date();
    r.status = status;
    await a.save({ session });
    await r.save({ session });
    saved = a;
    const student = await Student.findById(r.student).select('user name').session(session);
    await notifyAdmins({
      title: TRIP_TITLES[status],
      message: `${driver.name}: ${TRIP_TITLES[status]} for request ${r._id}.`,
      type: 'info',
    });
    if (student?.user) {
      await notifyUsers([student.user], {
        title: TRIP_TITLES[status],
        message: `Your transport request (${r._id}): ${TRIP_TITLES[status]}.`,
        type: 'info',
      });
    }
    await audit(req, `trip_${status}`, 'RequestAssignment', a.id);
  });
  ok(res, { _id: saved._id, tripStatus: saved.tripStatus, status: saved.status });
});
