import { Student, TransportRequest, RequestAssignment, Driver, Vehicle } from '../models/index.js';
import { audit } from '../services/audit.service.js';
import { enrollStudent } from '../services/assignment.service.js';
import { serializeRequest } from '../services/location.service.js';
import { notifyAdmins, notifyUsers } from '../services/notification.service.js';
import { ApiError, asyncHandler, ok } from '../utils/http.js';
import { paginate } from '../utils/paginate.js';
import { escapeRegex } from '../utils/http.js';
import { runInTransaction } from '../utils/transaction.js';

async function currentStudent(req) {
  const s = await Student.findOne({ user: req.user.id });
  if (!s) throw new ApiError(404, 'Student profile not found');
  return s;
}

export const create = asyncHandler(async (req, res) => {
  const student = await currentStudent(req);
  if (student.status !== 'active') throw new ApiError(403, 'Your student account is inactive');
  if (await TransportRequest.exists({ student: student._id, status: 'pending' })) {
    throw new ApiError(409, 'You already have a pending transport request');
  }
  const { pickupLocation, dropLocation, requestedAt, notes } = req.body;
  const r = await TransportRequest.create({
    student: student._id,
    pickupLocation: pickupLocation.address,
    pickupGeo: { latitude: pickupLocation.latitude, longitude: pickupLocation.longitude, placeId: pickupLocation.placeId },
    dropLocation: dropLocation.address,
    dropGeo: { latitude: dropLocation.latitude, longitude: dropLocation.longitude, placeId: dropLocation.placeId },
    requestedAt,
    notes,
  });
  await notifyAdmins({
    title: 'New transport request',
    message: `${student.name} (${student.studentId}) requested school transport.`,
    type: 'request',
  });
  ok(res, serializeRequest(r), undefined, 201);
});

export const list = asyncHandler(async (req, res) => {
  const q = req.query;
  const filter = {};
  const search = typeof q.search === 'string' ? q.search.trim() : '';
  if (search) {
    const or = [];
    if (/^[a-f\d]{24}$/i.test(search)) or.push({ _id: search });
    const rx = new RegExp(escapeRegex(search), 'i');
    const students = await Student.find({ $or: [{ name: rx }, { studentId: rx }] }).select('_id').lean();
    or.push({ student: { $in: students.map((s) => s._id) } });
    or.push({ pickupLocation: rx }, { dropLocation: rx });
    filter.$or = or;
  }
  if (q.status) filter.status = q.status;
  if (req.user.role === 'student') {
    filter.student = (await currentStudent(req))._id;
  }
  const { items, meta } = await paginate(TransportRequest, filter, { ...q, search: '' }, {
    populate: [
      { path: 'student', select: 'name studentId className division address phone' },
      { path: 'assignedDriver', select: 'name phone licenseNumber' },
      { path: 'reviewedBy', select: 'name' },
    ],
    sortable: ['status', 'createdAt', 'requestedAt'],
    searchFields: ['pickupLocation', 'dropLocation'],
  });
  ok(res, items.map(serializeRequest), meta);
});

export const review = asyncHandler(async (req, res) => {
  const r = await TransportRequest.findById(req.params.id).populate('student');
  if (!r) throw new ApiError(404, 'Request not found');
  if (r.status !== 'pending') throw new ApiError(409, `Request is already ${r.status}`);
  const { decision, remarks, assignment, stop } = req.body;
  const student = r.student;

  if (decision === 'approved' && assignment) {
    await enrollStudent(assignment, student._id, stop || undefined);
    r.assignment = assignment;
  }
  r.status = decision;
  r.remarks = remarks;
  r.reviewedBy = req.user.id;
  r.reviewedAt = new Date();
  await r.save();

  await notifyUsers([student.user], {
    title: decision === 'approved' ? 'Transport request approved' : 'Transport request rejected',
    message:
      decision === 'approved'
        ? `Your transport request was approved.${assignment ? ' A bus has been assigned.' : ' A bus will be assigned shortly.'}${remarks ? ` Note: ${remarks}` : ''}`
        : `Your transport request was rejected.${remarks ? ` Reason: ${remarks}` : ''}`,
    type: 'request',
  });
  await audit(req, decision, 'TransportRequest', r.id);
  ok(res, serializeRequest(r));
});

export const assign = asyncHandler(async (req, res) => {
  const { driver: driverId, vehicle: vehicleId } = req.body;
  let savedRequest;
  let savedAssignment;
  await runInTransaction(async (session) => {
    const r = await TransportRequest.findById(req.params.id).session(session);
    if (!r) throw new ApiError(404, 'Request not found');
    const assignable = ['pending', 'approved', 'reassignment_required'];
    if (!assignable.includes(r.status)) {
      throw new ApiError(409, `Request is ${r.status} and cannot be assigned`);
    }
    const d = await Driver.findById(driverId).session(session);
    if (!d) throw new ApiError(404, 'Driver not found');
    if (d.status !== 'active') throw new ApiError(409, `Driver ${d.name} is inactive and cannot be assigned`);
    if (await RequestAssignment.exists({ driver: driverId, status: { $in: ['assigned', 'accepted'] } }).session(session)) {
      throw new ApiError(409, 'Driver already has an active transport assignment');
    }
    const v = await Vehicle.findById(vehicleId).session(session);
    if (!v) throw new ApiError(404, 'Vehicle not found');
    if (v.status !== 'available') throw new ApiError(409, `Bus ${v.registrationNumber} is ${v.status} and cannot be assigned`);
    if (await TransportRequest.exists({ assignedVehicle: vehicleId, status: { $in: ['assigned', 'accepted'] } }).session(session)) {
      throw new ApiError(409, `Bus ${v.registrationNumber} is already assigned to another active request`);
    }
    savedAssignment = await new RequestAssignment({ request: r._id, driver: driverId, status: 'assigned' }).save({ session });
    r.status = 'assigned';
    r.assignedDriver = driverId;
    r.assignedVehicle = vehicleId;
    r.assignedAt = new Date();
    await r.save({ session });
    savedRequest = r;
    await notifyUsers([d.user], {
      title: 'New transport request',
      message: `You have been assigned a new transport request. Student: ${savedRequest.student?.name || '—'} (${savedRequest.student?.studentId || '—'}). Pickup: ${r.pickupLocation}. Bus: ${v.registrationNumber} (${v.busNumber}). Open "Requests" to accept or decline.`,
      type: 'assignment',
    });
    await audit(req, 'assign_driver', 'TransportRequest', r.id, { driver: driverId, vehicle: vehicleId });
  });
  const assignment = await RequestAssignment.findById(savedAssignment._id)
    .populate('driver', 'name phone licenseNumber')
    .populate('request', 'pickupLocation dropLocation pickupGeo dropGeo requestedAt status student assignedAt createdAt')
    .lean();
  ok(res, { assignment, request: serializeRequest(savedRequest) }, undefined, 201);
});

export const cancel = asyncHandler(async (req, res) => {
  const student = await currentStudent(req);
  const r = await TransportRequest.findOne({ _id: req.params.id, student: student._id });
  if (!r) throw new ApiError(404, 'Request not found');
  if (r.status !== 'pending') throw new ApiError(409, 'Only pending requests can be cancelled');
  r.status = 'cancelled';
  await r.save();
  ok(res, serializeRequest(r));
});

export const update = asyncHandler(async (req, res) => {
  const student = await currentStudent(req);
  const r = await TransportRequest.findOne({ _id: req.params.id, student: student._id });
  if (!r) throw new ApiError(404, 'Request not found');
  if (r.status !== 'pending') {
    throw new ApiError(409, 'Only pending requests can be edited. Use a location change request instead.');
  }
  const { pickupLocation, dropLocation, notes, requestedAt } = req.body;
  if (pickupLocation) {
    r.pickupLocation = pickupLocation.address;
    r.pickupGeo = { latitude: pickupLocation.latitude, longitude: pickupLocation.longitude, placeId: pickupLocation.placeId };
  }
  if (dropLocation) {
    r.dropLocation = dropLocation.address;
    r.dropGeo = { latitude: dropLocation.latitude, longitude: dropLocation.longitude, placeId: dropLocation.placeId };
  }
  if (requestedAt !== undefined) r.requestedAt = requestedAt;
  if (notes !== undefined) r.notes = notes;
  await r.save();
  ok(res, serializeRequest(r));
});
