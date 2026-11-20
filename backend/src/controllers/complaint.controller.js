import { Complaint } from '../models/index.js';
import { audit } from '../services/audit.service.js';
import { notifyAdmins, notifyUsers } from '../services/notification.service.js';
import { ApiError, asyncHandler, ok } from '../utils/http.js';
import { paginate } from '../utils/paginate.js';

export const create = asyncHandler(async (req, res) => {
  const role = req.user.role === 'driver' ? 'driver' : 'student';
  const c = await Complaint.create({ ...req.body, user: req.user.id, role });
  await notifyAdmins({
    title: 'New complaint',
    message: `${req.user.name} (${role}) submitted: ${c.subject}`,
    type: 'complaint',
  });
  ok(res, c, undefined, 201);
});

export const list = asyncHandler(async (req, res) => {
  const q = req.query;
  const filter = {};
  if (q.status) filter.status = q.status;
  if (q.category) filter.category = q.category;
  if (req.user.role !== 'admin') filter.user = req.user.id;
  else if (q.role) filter.role = q.role;
  const { items, meta } = await paginate(Complaint, filter, q, {
    populate: [{ path: 'user', select: 'name email phone' }],
    sortable: ['status', 'category', 'subject'],
    searchFields: ['subject', 'description'],
  });
  ok(res, items, meta);
});

export const update = asyncHandler(async (req, res) => {
  const c = await Complaint.findById(req.params.id);
  if (!c) throw new ApiError(404, 'Complaint not found');
  c.status = req.body.status;
  if (req.body.adminResponse !== undefined) c.adminResponse = req.body.adminResponse;
  if (c.status === 'resolved' || c.status === 'rejected') {
    c.resolvedBy = req.user.id;
    c.resolvedAt = new Date();
  }
  await c.save();
  await notifyUsers([c.user], {
    title: 'Complaint update',
    message: `Your complaint "${c.subject}" is now ${c.status.replace('_', ' ')}.${c.adminResponse ? ` Response: ${c.adminResponse}` : ''}`,
    type: 'complaint',
  });
  await audit(req, 'update', 'Complaint', c.id, { status: c.status });
  ok(res, c);
});
