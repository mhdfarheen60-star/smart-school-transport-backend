import { Driver, LocationChangeRequest, Student, TransportAssignment, TransportRequest } from '../models/index.js';
import { audit } from '../services/audit.service.js';
import { currentLocations, serializeRequest } from '../services/location.service.js';
import { notifyAdmins, notifyUsers } from '../services/notification.service.js';
import { ApiError, asyncHandler, ok } from '../utils/http.js';
import { paginate } from '../utils/paginate.js';

async function currentStudent(req) {
  const s = await Student.findOne({ user: req.user.id });
  if (!s) throw new ApiError(404, 'Student profile not found');
  return s;
}

export const mine = asyncHandler(async (req, res) => {
  const s = await currentStudent(req);
  const loc = (await currentLocations([s._id])).get(String(s._id));
  ok(res, loc || null);
});

export const create = asyncHandler(async (req, res) => {
  const student = await currentStudent(req);
  const { target, location, reason } = req.body;
  const base = await TransportRequest.findOne({ student: student._id, status: 'approved' }).sort('-createdAt');
  if (!base) {
    throw new ApiError(409, 'You need an approved transport request before you can change a location');
  }
  if (await LocationChangeRequest.exists({ student: student._id, target, status: 'pending' })) {
    throw new ApiError(409, `You already have a pending ${target} location change`);
  }
  const current = serializeRequest(base)[target === 'pickup' ? 'pickup' : 'drop'];
  const unchanged =
    current.latitude !== undefined &&
    current.longitude !== undefined &&
    Math.abs(current.latitude - location.latitude) < 1e-6 &&
    Math.abs(current.longitude - location.longitude) < 1e-6;
  if (unchanged) throw new ApiError(422, 'The selected location is the same as your current one');

  const change = await LocationChangeRequest.create({
    student: student._id,
    transportRequest: base._id,
    target,
    previous: {
      address: current.address,
      latitude: current.latitude,
      longitude: current.longitude,
      placeId: current.placeId,
    },
    proposed: location,
    reason,
  });
  await notifyAdmins({
    title: 'Location change requested',
    message: `${student.name} (${student.studentId}) asked to change their ${target} location.`,
    type: 'request',
  });
  ok(res, change, undefined, 201);
});

export const list = asyncHandler(async (req, res) => {
  const q = req.query;
  const filter = {};
  if (q.status) filter.status = q.status;
  if (req.user.role === 'student') filter.student = (await currentStudent(req))._id;
  const { items, meta } = await paginate(LocationChangeRequest, filter, q, {
    populate: [
      { path: 'student', select: 'name studentId className division' },
      { path: 'reviewedBy', select: 'name' },
    ],
    sortable: ['status', 'createdAt', 'target'],
    defaultSort: '-createdAt',
  });
  ok(res, items, meta);
});

export const cancel = asyncHandler(async (req, res) => {
  const student = await currentStudent(req);
  const c = await LocationChangeRequest.findOne({ _id: req.params.id, student: student._id });
  if (!c) throw new ApiError(404, 'Location change not found');
  if (c.status !== 'pending') throw new ApiError(409, 'Only pending changes can be cancelled');
  c.status = 'cancelled';
  await c.save();
  ok(res, c);
});

export const review = asyncHandler(async (req, res) => {
  const c = await LocationChangeRequest.findById(req.params.id);
  if (!c) throw new ApiError(404, 'Location change not found');
  if (c.status !== 'pending') throw new ApiError(409, `Change is already ${c.status}`);
  const { decision, rejectionReason, stop } = req.body;
  const student = await Student.findById(c.student);
  if (!student) throw new ApiError(404, 'Student not found');

  const assignment = await TransportAssignment.findOne({ status: 'active', 'riders.student': student._id });

  if (decision === 'approved') {
    const base = await TransportRequest.findById(c.transportRequest);
    if (!base) throw new ApiError(404, 'Original transport request no longer exists');
    const p = c.proposed;
    const geo = { latitude: p.latitude, longitude: p.longitude, placeId: p.placeId };
    if (c.target === 'pickup') {
      base.pickupLocation = p.address;
      base.pickupGeo = geo;
    } else {
      base.dropLocation = p.address;
      base.dropGeo = geo;
    }
    await base.save();

    if (assignment && stop) {
      const rider = assignment.riders.find((r) => String(r.student) === String(student._id));
      if (rider) {
        rider.stop = stop;
        await assignment.save();
      }
    }
  }

  c.status = decision;
  c.rejectionReason = decision === 'rejected' ? rejectionReason : undefined;
  c.reviewedBy = req.user.id;
  c.reviewedAt = new Date();
  await c.save();

  await notifyUsers([student.user], {
    title: decision === 'approved' ? 'Location change approved' : 'Location change rejected',
    message:
      decision === 'approved'
        ? `Your new ${c.target} location was approved: ${c.proposed.address}`
        : `Your ${c.target} location change was rejected.${rejectionReason ? ` Reason: ${rejectionReason}` : ''}`,
    type: 'route_change',
  });
  if (decision === 'approved' && assignment) {
    const driver = await Driver.findById(assignment.driver).select('user');
    if (driver) {
      await notifyUsers([driver.user], {
        title: 'Student location updated',
        message: `${student.name} (${student.studentId}) has a new ${c.target} location: ${c.proposed.address}`,
        type: 'route_change',
      });
    }
  }
  await audit(req, `location_${decision}`, 'LocationChangeRequest', c.id, { target: c.target });
  ok(res, c);
});
