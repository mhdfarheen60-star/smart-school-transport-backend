import bcrypt from 'bcryptjs';
import mongoose from 'mongoose';
import {
  Attendance,
  SchoolConfig,
  Student,
  TransportAssignment,
  TransportRequest,
  User,
} from '../models/index.js';
import { audit } from '../services/audit.service.js';
import { ApiError, asyncHandler, ok } from '../utils/http.js';
import { paginate } from '../utils/paginate.js';

const studentUpdatableFields = [
  'studentId', 'name', 'className', 'division', 'address', 'phone',
  'parentName', 'parentPhone', 'status', 'photograph', 'emergencyContact',
  'assignedRoute', 'assignedVehicle', 'assignedDriver', 'transportStatus',
];

export const list = asyncHandler(async (req, res) => {
  const q = req.query;
  const filter = {};
  if (q.className) filter.className = q.className;
  if (q.division) filter.division = q.division.toUpperCase();
  if (q.status) filter.status = q.status;
  if (q.transportStatus) filter.transportStatus = q.transportStatus;
  if (q.assignedRoute) filter.assignedRoute = q.assignedRoute;
  if (q.assignedVehicle) filter.assignedVehicle = q.assignedVehicle;
  if (q.assignedDriver) filter.assignedDriver = q.assignedDriver;
  const { items, meta } = await paginate(Student, filter, q, {
    populate: [
      { path: 'user', select: 'email isActive' },
      { path: 'assignedRoute', select: 'name stops status' },
      { path: 'assignedVehicle', select: 'registrationNumber busNumber capacity status' },
      { path: 'assignedDriver', select: 'name licenseNumber phone status' },
    ],
    sortable: ['name', 'studentId', 'className', 'division', 'status', 'transportStatus'],
    searchFields: ['name', 'studentId', 'phone', 'parentPhone', 'className'],
  });
  const ids = items.map((s) => s._id);
  const assignments = await TransportAssignment.find({ status: 'active', 'riders.student': { $in: ids } })
    .populate('vehicle', 'registrationNumber busNumber')
    .populate('route', 'name')
    .lean();
  const map = new Map();
  for (const a of assignments) for (const r of a.riders) map.set(String(r.student), a);
  const data = items.map((s) => {
    const a = map.get(String(s._id));
    return {
      ...s,
      transport: a ? { vehicle: a.vehicle, route: a.route, assignment: a._id } : null,
    };
  });
  ok(res, data, meta);
});

export const getOne = asyncHandler(async (req, res) => {
  const s = await Student.findById(req.params.id)
    .populate('user', 'email isActive')
    .populate('assignedRoute', 'name stops status')
    .populate('assignedVehicle', 'registrationNumber busNumber capacity status')
    .populate('assignedDriver', 'name licenseNumber phone status')
    .lean();
  if (!s) throw new ApiError(404, 'Student not found');
  ok(res, s);
});

export const create = asyncHandler(async (req, res) => {
  const b = req.body;
  if (await User.exists({ email: b.email })) throw new ApiError(409, 'Email is already registered');
  if (await Student.exists({ studentId: b.studentId.toUpperCase() })) {
    throw new ApiError(409, 'A student with this Student ID already exists');
  }

  const session = await mongoose.startSession();
  let student;
  try {
    await session.withTransaction(async () => {
      const user = await User.create([{
        name: b.name,
        email: b.email,
        phone: b.phone,
        role: 'student',
        password: await bcrypt.hash(b.password, 12),
      }], { session });

      const studentData = {
        user: user[0]._id,
        studentId: b.studentId,
        name: b.name,
        className: b.className,
        division: b.division,
        address: b.address,
        phone: b.phone,
        parentName: b.parentName,
        parentPhone: b.parentPhone,
        photograph: b.photograph,
        emergencyContact: b.emergencyContact,
        permanentPickupLocation: b.permanentPickupLocation,
        permanentDropLocation: b.permanentDropLocation,
        assignedRoute: b.assignedRoute,
        assignedVehicle: b.assignedVehicle,
        assignedDriver: b.assignedDriver,
        transportStatus: b.transportStatus || 'not_assigned',
        status: b.status,
      };
      student = await Student.create([studentData], { session });

      await audit(req, 'create', 'Student', student[0].id);
    });
    ok(res, student[0], undefined, 201);
  } catch (e) {
    throw e;
  } finally {
    await session.endSession();
  }
});

export const update = asyncHandler(async (req, res) => {
  const student = await Student.findById(req.params.id);
  if (!student) throw new ApiError(404, 'Student not found');
  const b = req.body;
  if (b.studentId && b.studentId.toUpperCase() !== student.studentId) {
    if (await Student.exists({ studentId: b.studentId.toUpperCase(), _id: { $ne: student._id } })) {
      throw new ApiError(409, 'A student with this Student ID already exists');
    }
  }

  const session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
      const user = await User.findById(student.user).select('+password');
      if (user) {
        if (b.email && b.email !== user.email) {
          if (await User.exists({ email: b.email, _id: { $ne: user._id } })) {
            throw new ApiError(409, 'Email is already registered');
          }
          user.email = b.email;
        }
        if (b.name) user.name = b.name;
        if (b.phone) user.phone = b.phone;
        let revokeSessions = false;
        if (b.password) {
          user.password = await bcrypt.hash(b.password, 12);
          revokeSessions = true;
        }
        if (b.status !== undefined) {
          user.isActive = b.status === 'active';
          if (!user.isActive) revokeSessions = true;
        }
        if (revokeSessions) user.tokenVersion = (user.tokenVersion ?? 0) + 1;
        await user.save();
      }
      for (const k of studentUpdatableFields) {
        if (b[k] !== undefined) student[k] = b[k];
      }
      await student.save();
      await audit(req, 'update', 'Student', student.id);
    });
    ok(res, student);
  } catch (e) {
    throw e;
  } finally {
    await session.endSession();
  }
});

// Update permanent pickup/drop locations for a student (admin only)
export const updatePermanentLocations = asyncHandler(async (req, res) => {
  const student = await Student.findById(req.params.id);
  if (!student) throw new ApiError(404, 'Student not found');
  const b = req.body;
  const now = new Date();

  if (b.permanentPickupLocation !== undefined) {
    const loc = b.permanentPickupLocation;
    if (!loc || !loc.geo || loc.geo.latitude == null || loc.geo.longitude == null) {
      throw new ApiError(422, 'Permanent pickup location must include valid geo coordinates');
    }
    student.permanentPickupLocation = {
      geo: {
        latitude: Number(loc.geo.latitude),
        longitude: Number(loc.geo.longitude),
        address: loc.geo.address || '',
        landmark: loc.geo.landmark,
        placeId: loc.geo.placeId,
      },
      verified: loc.verified !== undefined ? Boolean(loc.verified) : false,
      lastUpdated: now,
      updatedBy: req.user.id,
    };
  }

  if (b.permanentDropLocation !== undefined) {
    const loc = b.permanentDropLocation;
    if (!loc || !loc.geo || loc.geo.latitude == null || loc.geo.longitude == null) {
      throw new ApiError(422, 'Permanent drop location must include valid geo coordinates');
    }
    student.permanentDropLocation = {
      geo: {
        latitude: Number(loc.geo.latitude),
        longitude: Number(loc.geo.longitude),
        address: loc.geo.address || '',
        landmark: loc.geo.landmark,
        placeId: loc.geo.placeId,
      },
      verified: loc.verified !== undefined ? Boolean(loc.verified) : false,
      lastUpdated: now,
      updatedBy: req.user.id,
    };
  }

  await student.save();
  await audit(req, 'update_permanent_locations', 'Student', student.id, {
    pickup: !!b.permanentPickupLocation,
    drop: !!b.permanentDropLocation,
  });
  ok(res, student);
});

export const remove = asyncHandler(async (req, res) => {
  const student = await Student.findById(req.params.id);
  if (!student) throw new ApiError(404, 'Student not found');
  await TransportAssignment.updateMany(
    { status: 'active', 'riders.student': student._id },
    { $pull: { riders: { student: student._id } } }
  );
  const hasHistory =
    (await Attendance.exists({ student: student._id })) ||
    (await TransportRequest.exists({ student: student._id }));
  if (hasHistory) {
    student.status = 'inactive';
    await student.save();
    await User.findByIdAndUpdate(student.user, { isActive: false });
    await audit(req, 'deactivate', 'Student', student.id);
    return ok(res, { deleted: false, deactivated: true, message: 'Student has history and was deactivated' });
  }
  await User.findByIdAndDelete(student.user);
  await student.deleteOne();
  await audit(req, 'delete', 'Student', student.id);
  ok(res, { deleted: true });
});
