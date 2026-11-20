import { Driver, Student, TransportAssignment, Vehicle, VehicleProblemReport } from '../models/index.js';
import { audit } from '../services/audit.service.js';
import { notifyAdmins, notifyUsers } from '../services/notification.service.js';
import { ApiError, asyncHandler, ok } from '../utils/http.js';
import { paginate } from '../utils/paginate.js';

const populate = [
  { path: 'vehicle', select: 'registrationNumber busNumber status' },
  { path: 'driver', select: 'name phone' },
];

export const create = asyncHandler(async (req, res) => {
  const driver = await Driver.findOne({ user: req.user.id });
  if (!driver) throw new ApiError(404, 'Driver profile not found');
  const a = await TransportAssignment.findOne({ driver: driver._id, status: 'active' }).populate('vehicle');
  if (!a) throw new ApiError(409, 'You have no active bus assignment to report a problem for');
  const vehicle = a.vehicle;
  const p = await VehicleProblemReport.create({
    ...req.body,
    vehicle: vehicle._id,
    driver: driver._id,
    reportedBy: req.user.id,
  });
  const label = String(p.type).replace('_', ' ');
  await notifyAdmins({
    title: `Vehicle problem: ${label}`,
    message: `${driver.name} reported a ${label} (${p.severity}) on bus ${vehicle.busNumber} / ${vehicle.registrationNumber}: ${p.description}`,
    type: 'problem',
  });
  const students = await Student.find({ _id: { $in: a.riders.map((r) => r.student) } }).select('user');
  await notifyUsers(students.map((s) => s.user), {
    title: p.type === 'traffic_delay' ? 'Bus delayed' : 'Bus issue reported',
    message: `Your bus has reported a ${label}${p.delayMinutes ? ` (about ${p.delayMinutes} min delay)` : ''}. We will keep you updated.`,
    type: 'delay',
  });
  ok(res, p, undefined, 201);
});

export const list = asyncHandler(async (req, res) => {
  const q = req.query;
  const filter = {};
  if (q.status) filter.status = q.status;
  if (q.type) filter.type = q.type;
  if (req.user.role === 'driver') {
    const d = await Driver.findOne({ user: req.user.id });
    if (!d) throw new ApiError(404, 'Driver profile not found');
    filter.driver = d._id;
  }
  const { items, meta } = await paginate(VehicleProblemReport, filter, q, {
    populate,
    sortable: ['status', 'type', 'severity'],
    searchFields: ['description'],
  });
  ok(res, items, meta);
});

export const update = asyncHandler(async (req, res) => {
  const p = await VehicleProblemReport.findById(req.params.id);
  if (!p) throw new ApiError(404, 'Report not found');
  const { status, adminNotes, vehicleAction } = req.body;
  p.status = status;
  if (adminNotes !== undefined) p.adminNotes = adminNotes;
  p.reviewedBy = req.user.id;
  p.reviewedAt = new Date();
  await p.save();
  if (vehicleAction === 'mark_unavailable') {
    await Vehicle.findByIdAndUpdate(p.vehicle, { status: 'unavailable' });
  } else if (vehicleAction === 'mark_available') {
    await Vehicle.findByIdAndUpdate(p.vehicle, { status: 'available' });
  }
  const driver = await Driver.findById(p.driver).select('user');
  if (driver) {
    await notifyUsers([driver.user], {
      title: 'Problem report update',
      message: `Your ${String(p.type).replace('_', ' ')} report is now ${p.status.replace('_', ' ')}.${p.adminNotes ? ` Note: ${p.adminNotes}` : ''}`,
      type: 'problem',
    });
  }
  await audit(req, 'update', 'VehicleProblemReport', p.id, { status, vehicleAction });
  ok(res, await p.populate(populate));
});
