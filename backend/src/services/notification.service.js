import { Attendance, Notification, Parent, Student, User } from '../models/index.js';
import { getPushStatus, sendPushToUsers } from './push.service.js';

function uniqueIds(values) {
  return [...new Set(values.map(String).filter(Boolean))];
}

async function deliverPush(userIds, payload) {
  try {
    const result = await sendPushToUsers(userIds, {
      title: payload.title,
      body: payload.message,
      data: {
        type: payload.type || 'info',
        link: payload.link || '',
        ...(payload.data || {}),
      },
    });

    const status = !result.configured
      ? 'unconfigured'
      : result.sent > 0
      ? 'sent'
      : result.failed > 0
      ? 'failed'
      : 'skipped';

    await Notification.updateMany(
      { user: { $in: userIds }, createdAt: { $gte: new Date(Date.now() - 60 * 1000) } },
      {
        $set: {
          pushStatus: status,
          ...(result.error ? { pushError: String(result.error).slice(0, 500) } : {}),
        },
      }
    ).catch(() => {});
    return result;
  } catch (err) {
    return { configured: getPushStatus().configured, error: err.message };
  }
}

/**
 * Persist in-app notifications for users and, when configured, fan out push
 * notifications. Push failures never block in-app delivery.
 */
export async function notifyUsers(userIds, payload) {
  const unique = uniqueIds(userIds || []);
  if (!unique.length) return [];

  const docs = await Notification.insertMany(
    unique.map((user) => ({
      user,
      type: 'info',
      channel: 'both',
      ...payload,
    }))
  );

  // Fire-and-forget: the API response must not wait on an external push provider.
  deliverPush(unique, payload).catch(() => {});

  return docs;
}

export async function notifyAdmins(payload) {
  const admins = await User.find({ role: 'admin', isActive: true }).select('_id').lean();
  return notifyUsers(
    admins.map((a) => a._id),
    payload
  );
}

/**
 * Notify every authorized guardian (and the student account) for a set of
 * students. Guardianship is resolved from the approved Parent.linkedStudents
 * relationship, not from client input.
 */
export async function notifyStudentGuardians(studentIds, payload) {
  const ids = uniqueIds(studentIds || []);
  if (!ids.length) return [];

  const [students, parents] = await Promise.all([
    Student.find({ _id: { $in: ids } }).select('user').lean(),
    Parent.find({ linkedStudents: { $in: ids }, status: 'active' }).select('user').lean(),
  ]);

  const recipients = uniqueIds([
    ...students.map((s) => s.user),
    ...parents.map((p) => p.user),
  ]);

  return notifyUsers(recipients, payload);
}

/**
 * Notify guardians of every student expected on a trip.
 */
export async function notifyTripGuardians(tripId, payload) {
  const records = await Attendance.find({ trip: tripId }).select('student').lean();
  return notifyStudentGuardians(
    records.map((r) => r.student),
    payload
  );
}
