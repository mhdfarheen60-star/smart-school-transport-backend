import mongoose from 'mongoose';
import {
  Attendance,
  Parent,
  ParentLinkRequest,
  Student,
  TransportAssignment,
  TransportRequest,
  Trip,
} from '../models/index.js';
import { audit } from '../services/audit.service.js';
import { notifyAdmins, notifyUsers } from '../services/notification.service.js';
import { ApiError, asyncHandler, ok, todayStr } from '../utils/http.js';
import { paginate } from '../utils/paginate.js';

async function currentParent(req) {
  const parent = await Parent.findOne({ user: req.user.id });
  if (!parent) throw new ApiError(404, 'Parent profile not found');
  return parent;
}

function linkedStudentIds(parent) {
  return (parent.linkedStudents || []).map((id) => String(id));
}

async function requireLinkedChild(parent, studentId) {
  if (!linkedStudentIds(parent).includes(String(studentId))) {
    throw new ApiError(403, 'You can only access your linked children');
  }
}

async function transportForStudent(studentId) {
  const assignment = await TransportAssignment.findOne({ status: 'active', 'riders.student': studentId })
    .populate('vehicle', 'busNumber registrationNumber model status')
    .populate('driver', 'name')
    .populate('route', 'name stops status')
    .lean();
  if (!assignment) return null;
  const rider = (assignment.riders || []).find((r) => String(r.student) === String(studentId));
  const stop = (assignment.route?.stops || []).find((s) => s.name === rider?.stop);
  return {
    assignment: assignment._id,
    vehicle: assignment.vehicle || null,
    driver: assignment.driver ? { name: assignment.driver.name } : null,
    route: assignment.route ? { name: assignment.route.name, status: assignment.route.status } : null,
    stop: rider?.stop || null,
    pickupTime: stop?.pickupTime || null,
    dropTime: stop?.dropTime || null,
  };
}

async function attendanceSummaryFor(studentId) {
  const records = await Attendance.find({ student: studentId })
    .sort('-date')
    .limit(30)
    .select('date pickupStatus pickupAt dropStatus dropAt stop route')
    .populate('route', 'name')
    .lean();
  const summary = {
    records: records.length,
    pickedUp: records.filter((a) => a.pickupStatus === 'picked_up').length,
    absent: records.filter((a) => ['absent', 'not_available'].includes(a.pickupStatus)).length,
    dropped: records.filter((a) => a.dropStatus === 'dropped').length,
  };
  return {
    summary,
    recent: records.slice(0, 10).map((a) => ({
      date: a.date,
      pickupStatus: a.pickupStatus,
      pickupAt: a.pickupAt,
      dropStatus: a.dropStatus,
      dropAt: a.dropAt,
      stop: a.stop,
      route: a.route?.name,
    })),
  };
}

export const list = asyncHandler(async (req, res) => {
  const q = req.query;
  const filter = {};
  if (q.status) filter.status = q.status;
  const { items, meta } = await paginate(Parent, filter, q, {
    sortable: ['name', 'email', 'phone', 'status'],
    searchFields: ['name', 'email', 'phone'],
  });
  const data = items.map((p) => ({ ...p, linkedStudents: p.linkedStudents?.length ?? 0 }));
  ok(res, data, meta);
});

export const getOne = asyncHandler(async (req, res) => {
  const p = await Parent.findById(req.params.id).populate('linkedStudents', 'name studentId').lean();
  if (!p) throw new ApiError(404, 'Parent not found');
  ok(res, p);
});

export const create = asyncHandler(async (req, res) => {
  const b = req.body;
  const parent = await Parent.create({
    name: b.name,
    email: b.email,
    phone: b.phone,
    linkedStudents: b.linkedStudents,
    status: b.status,
  });
  await audit(req, 'create', 'Parent', parent.id);
  ok(res, parent, undefined, 201);
});

export const update = asyncHandler(async (req, res) => {
  const parent = await Parent.findById(req.params.id);
  if (!parent) throw new ApiError(404, 'Parent not found');
  const b = req.body;
  for (const k of ['name', 'email', 'phone', 'linkedStudents', 'status']) {
    if (b[k] !== undefined) parent[k] = b[k];
  }
  await parent.save();
  await audit(req, 'update', 'Parent', parent.id);
  ok(res, parent);
});

export const remove = asyncHandler(async (req, res) => {
  const parent = await Parent.findById(req.params.id);
  if (!parent) throw new ApiError(404, 'Parent not found');
  await parent.deleteOne();
  await audit(req, 'delete', 'Parent', parent.id);
  ok(res, { deleted: true });
});

// ---- Parent self-service (authenticated parent only)

export const myChildren = asyncHandler(async (req, res) => {
  const parent = await currentParent(req);
  const students = await Student.find({ _id: { $in: parent.linkedStudents || [] } })
    .select('name studentId className division status')
    .sort('name')
    .lean();
  const data = await Promise.all(
    students.map(async (s) => ({
      _id: s._id,
      name: s.name,
      studentId: s.studentId,
      className: s.className,
      division: s.division,
      status: s.status,
      transport: await transportForStudent(s._id),
    }))
  );
  ok(res, data);
});

export const myChildDashboard = asyncHandler(async (req, res) => {
  const parent = await currentParent(req);
  const studentId = req.params.studentId;
  if (!mongoose.isValidObjectId(studentId)) throw new ApiError(400, 'Invalid student id');
  await requireLinkedChild(parent, studentId);

  const student = await Student.findById(studentId).select('name studentId className division address status').lean();
  if (!student) throw new ApiError(404, 'Student not found');

  const today = todayStr();
  const [transport, attendance, requests, assignmentDoc] = await Promise.all([
    transportForStudent(student._id),
    attendanceSummaryFor(student._id),
    TransportRequest.find({ student: student._id })
      .sort('-createdAt')
      .limit(20)
      .select('status pickupLocation dropLocation requestedAt reviewedAt remarks')
      .lean(),
    TransportAssignment.findOne({ status: 'active', 'riders.student': student._id }).select('_id').lean(),
  ]);

  let todayTrip = null;
  if (assignmentDoc) {
    todayTrip = await Trip.findOne({ assignment: assignmentDoc._id, date: today })
      .select('status startedAt completedAt date')
      .lean();
  }

  const todayAttendance = attendance.recent.filter((a) => a.date === today);

  ok(res, {
    student,
    transport,
    todayTrip,
    todayAttendance,
    attendance,
    requests,
    date: today,
    notes: [
      'Only this linked child’s records are included.',
      'Live GPS and ETA are only shown when recorded by the transport system.',
    ],
  });
});

export const listMyLinkRequests = asyncHandler(async (req, res) => {
  const parent = await currentParent(req);
  const items = await ParentLinkRequest.find({ parent: parent._id })
    .sort('-createdAt')
    .limit(50)
    .populate('student', 'name studentId className division')
    .lean();
  ok(res, items);
});

export const createLinkRequest = asyncHandler(async (req, res) => {
  const parent = await currentParent(req);
  const student = await Student.findOne({ studentId: req.body.studentId.trim().toUpperCase() });
  if (!student) throw new ApiError(404, 'No student found with that Student ID');

  if (linkedStudentIds(parent).includes(String(student._id))) {
    throw new ApiError(409, 'This student is already linked to your account');
  }

  const pending = await ParentLinkRequest.findOne({ parent: parent._id, student: student._id, status: 'pending' });
  if (pending) throw new ApiError(409, 'A link request for this student is already awaiting approval');

  const linkRequest = await ParentLinkRequest.create({
    parent: parent._id,
    student: student._id,
    relationship: req.body.relationship,
    note: req.body.note,
    status: 'pending',
  });

  await notifyAdmins({
    title: 'Parent link request',
    message: `${parent.name} requested to link student ${student.name} (${student.studentId}). Review and approve or reject it in Parents.`,
    type: 'info',
  });
  await audit(req, 'parent_link_request', 'ParentLinkRequest', linkRequest.id, { student: String(student._id) });

  ok(res, await linkRequest.populate('student', 'name studentId className division'), undefined, 201);
});

export const cancelMyLinkRequest = asyncHandler(async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) throw new ApiError(400, 'Invalid link request id');
  const parent = await currentParent(req);
  const linkRequest = await ParentLinkRequest.findOne({
    _id: req.params.id,
    parent: parent._id,
    status: 'pending',
  });
  if (!linkRequest) throw new ApiError(404, 'Pending link request not found');
  linkRequest.status = 'cancelled';
  await linkRequest.save();
  await audit(req, 'parent_link_cancel', 'ParentLinkRequest', linkRequest.id);
  ok(res, { cancelled: true });
});

// ---- Admin link-request review

export const listLinkRequests = asyncHandler(async (req, res) => {
  const filter = {};
  if (req.query.status) filter.status = req.query.status;
  const { items, meta } = await paginate(ParentLinkRequest, filter, req.query, {
    populate: [
      { path: 'parent', select: 'name email phone' },
      { path: 'student', select: 'name studentId className division' },
      { path: 'reviewedBy', select: 'name' },
    ],
    defaultSort: '-createdAt',
  });
  ok(res, items, meta);
});

export const reviewLinkRequest = asyncHandler(async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) throw new ApiError(400, 'Invalid link request id');
  const linkRequest = await ParentLinkRequest.findById(req.params.id);
  if (!linkRequest) throw new ApiError(404, 'Link request not found');
  if (linkRequest.status !== 'pending') throw new ApiError(400, 'This link request has already been reviewed');

  const parent = await Parent.findById(linkRequest.parent);
  if (!parent) throw new ApiError(404, 'Parent not found');

  linkRequest.status = req.body.decision;
  linkRequest.reviewedBy = req.user.id;
  linkRequest.reviewedAt = new Date();
  if (req.body.decision === 'rejected') linkRequest.rejectionReason = req.body.rejectionReason;
  await linkRequest.save();

  if (req.body.decision === 'approved') {
    await Parent.updateOne({ _id: parent._id }, { $addToSet: { linkedStudents: linkRequest.student } });
  }

  if (parent.user) {
    const student = await Student.findById(linkRequest.student).select('name studentId').lean();
    await notifyUsers([parent.user], {
      title: req.body.decision === 'approved' ? 'Student link approved' : 'Student link request rejected',
      message:
        req.body.decision === 'approved'
          ? `Your account is now linked to ${student?.name || 'the student'} (${student?.studentId || ''}).`
          : `Your request to link ${student?.name || 'a student'} was not approved.${req.body.rejectionReason ? ` Reason: ${req.body.rejectionReason}` : ''}`,
      type: 'info',
    });
  }

  await audit(req, `parent_link_${req.body.decision}`, 'ParentLinkRequest', linkRequest.id, {
    student: String(linkRequest.student),
  });

  ok(res, await linkRequest.populate([
    { path: 'parent', select: 'name email phone' },
    { path: 'student', select: 'name studentId className division' },
  ]));
});
