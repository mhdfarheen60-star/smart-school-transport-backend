import { Notification, User } from '../models/index.js';
import { audit } from '../services/audit.service.js';
import { notifyUsers } from '../services/notification.service.js';
import { getPushStatus } from '../services/push.service.js';
import { ApiError, asyncHandler, ok } from '../utils/http.js';
import { paginate } from '../utils/paginate.js';

export const list = asyncHandler(async (req, res) => {
  const q = req.query;
  const filter = { user: req.user.id };
  if (q.unread === 'true') filter.read = false;
  const { items, meta } = await paginate(Notification, filter, q, {
    searchFields: ['title', 'message'],
    defaultSort: '-createdAt',
  });
  const unread = await Notification.countDocuments({ user: req.user.id, read: false });
  ok(res, items, { ...meta, unread });
});

export const markRead = asyncHandler(async (req, res) => {
  const n = await Notification.findOneAndUpdate(
    { _id: req.params.id, user: req.user.id },
    { read: true },
    { new: true }
  );
  if (!n) throw new ApiError(404, 'Notification not found');
  ok(res, n);
});

export const markAllRead = asyncHandler(async (req, res) => {
  const r = await Notification.updateMany({ user: req.user.id, read: false }, { read: true });
  ok(res, { updated: r.modifiedCount });
});

export const remove = asyncHandler(async (req, res) => {
  const r = await Notification.deleteOne({ _id: req.params.id, user: req.user.id });
  if (!r.deletedCount) throw new ApiError(404, 'Notification not found');
  ok(res, { deleted: true });
});

export const broadcast = asyncHandler(async (req, res) => {
  const { title, message, type, audience, user } = req.body;
  let ids = [];
  if (audience === 'user') {
    if (!user) throw new ApiError(422, 'Select a user');
    ids = [user];
  } else {
    const roleFilter =
      audience === 'students' ? { role: 'student' } : audience === 'drivers' ? { role: 'driver' } : { role: { $in: ['student', 'driver'] } };
    ids = (await User.find({ ...roleFilter, isActive: true }).select('_id')).map((u) => u._id);
  }
  await notifyUsers(ids, { title, message, type });
  await audit(req, 'broadcast', 'Notification', undefined, { audience, recipients: ids.length });
  ok(res, { sent: ids.length }, undefined, 201);
});

/**
 * Report the real push provider configuration. This lets the UI tell users the
 * truth instead of implying push delivery is active when credentials are absent.
 */
export const pushStatus = asyncHandler(async (_req, res) => {
  ok(res, getPushStatus());
});
