import bcrypt from 'bcryptjs';
import { signToken } from '../middleware/auth.js';
import { Driver, Parent, Student, User } from '../models/index.js';
import { audit } from '../services/audit.service.js';
import { notifyAdmins } from '../services/notification.service.js';
import { ApiError, asyncHandler, ok } from '../utils/http.js';

const BCRYPT_ROUNDS = 12;
const DUMMY_PASSWORD_HASH = '$2a$12$/UFxcM3qCHvP94RNVT3vIOxF7hK8UvfwMIIxSXU6BvWVj1Q7S9Gpu';

async function profileFor(userId, role) {
  if (role === 'student') return Student.findOne({ user: userId }).lean();
  if (role === 'driver') return Driver.findOne({ user: userId }).lean();
  if (role === 'parent') return Parent.findOne({ user: userId }).lean();
  return null;
}

export const register = asyncHandler(async (req, res) => {
  const b = req.body;
  if (await User.exists({ email: b.email })) throw new ApiError(409, 'Email is already registered');
  if (await Student.exists({ studentId: b.studentId.toUpperCase() })) {
    throw new ApiError(409, 'A student with this Student ID already exists');
  }
  const user = await User.create({
    name: b.name,
    email: b.email,
    phone: b.phone,
    role: 'student',
    password: await bcrypt.hash(b.password, BCRYPT_ROUNDS),
  });
  try {
    const student = await Student.create({
      user: user._id,
      studentId: b.studentId,
      name: b.name,
      className: b.className,
      division: b.division,
      address: b.address,
      phone: b.phone,
      parentName: b.parentName,
      parentPhone: b.parentPhone,
    });
    await notifyAdmins({
      title: 'New student registered',
      message: `${b.name} (${student.studentId}) registered for the transport system.`,
      type: 'info',
    });
    return ok(
      res,
      {
        token: signToken(user.id, 'student', user.tokenVersion ?? 0),
        user: { id: user.id, name: user.name, email: user.email, role: user.role, phone: user.phone },
        profile: student.toObject(),
      },
      undefined,
      201
    );
  } catch (e) {
    await User.findByIdAndDelete(user._id);
    throw e;
  }
});

export const registerParent = asyncHandler(async (req, res) => {
  const b = req.body;
  if (await User.exists({ email: b.email })) throw new ApiError(409, 'Email is already registered');
  if (await Parent.exists({ email: b.email })) throw new ApiError(409, 'A parent account with this email already exists');

  const user = await User.create({
    name: b.name,
    email: b.email,
    phone: b.phone,
    role: 'parent',
    password: await bcrypt.hash(b.password, BCRYPT_ROUNDS),
  });
  try {
    const parent = await Parent.create({
      user: user._id,
      name: b.name,
      email: b.email,
      phone: b.phone,
      linkedStudents: [],
    });
    await audit({ ...req, user: { id: user.id, role: 'parent', name: user.name } }, 'register', 'Parent', parent.id);
    await notifyAdmins({
      title: 'New parent account',
      message: `${b.name} created a parent account. Student linking requires administrator approval.`,
      type: 'info',
    });
    return ok(
      res,
      {
        token: signToken(user.id, 'parent', user.tokenVersion ?? 0),
        user: { id: user.id, name: user.name, email: user.email, role: user.role, phone: user.phone },
        profile: parent.toObject(),
      },
      undefined,
      201
    );
  } catch (e) {
    await User.findByIdAndDelete(user._id);
    throw e;
  }
});

export const login = asyncHandler(async (req, res) => {
  const { identifier, password } = req.body;
  let user;
  if (identifier.includes('@')) {
    user = await User.findOne({ email: identifier.toLowerCase() }).select('+password');
  } else {
    const student = await Student.findOne({ studentId: identifier.trim().toUpperCase() }).lean();
    if (!student) throw new ApiError(401, 'Invalid email or password');
    user = await User.findById(student.user).select('+password');
  }
  const valid = await bcrypt.compare(password, user?.password || DUMMY_PASSWORD_HASH);
  if (!user || !valid) throw new ApiError(401, 'Invalid email or password');
  if (!user.isActive) throw new ApiError(403, 'This account has been deactivated');
  if (bcrypt.getRounds(user.password) < BCRYPT_ROUNDS) {
    user.password = await bcrypt.hash(password, BCRYPT_ROUNDS);
    await user.save();
  }
  await audit({ ...req, user: { id: user.id, role: user.role, name: user.name } }, 'login', 'User', user.id);
  ok(res, {
    token: signToken(user.id, user.role, user.tokenVersion ?? 0),
    user: { id: user.id, name: user.name, email: user.email, role: user.role, phone: user.phone },
    profile: await profileFor(user.id, user.role),
  });
});

export const me = asyncHandler(async (req, res) => {
  const user = await User.findById(req.user.id);
  if (!user) throw new ApiError(404, 'User not found');
  ok(res, {
    user: { id: user.id, name: user.name, email: user.email, role: user.role, phone: user.phone },
    profile: await profileFor(user.id, user.role),
  });
});

export const updateProfile = asyncHandler(async (req, res) => {
  const b = req.body;
  const user = await User.findById(req.user.id);
  if (!user) throw new ApiError(404, 'User not found');
  if (b.name) user.name = b.name;
  if (b.phone) user.phone = b.phone;
  await user.save();
  let profile = null;
  if (user.role === 'student') {
    const set = {};
    for (const k of ['name', 'phone', 'address', 'parentName', 'parentPhone']) if (b[k] !== undefined) set[k] = b[k];
    profile = await Student.findOneAndUpdate({ user: user._id }, set, { new: true, runValidators: true });
  } else if (user.role === 'driver') {
    const set = {};
    for (const k of ['name', 'phone', 'address']) if (b[k] !== undefined) set[k] = b[k];
    profile = await Driver.findOneAndUpdate({ user: user._id }, set, { new: true, runValidators: true });
  } else if (user.role === 'parent') {
    const set = {};
    for (const k of ['name', 'phone']) if (b[k] !== undefined) set[k] = b[k];
    profile = await Parent.findOneAndUpdate({ user: user._id }, set, { new: true, runValidators: true });
  }
  ok(res, {
    user: { id: user.id, name: user.name, email: user.email, role: user.role, phone: user.phone },
    profile,
  });
});

export const changePassword = asyncHandler(async (req, res) => {
  const user = await User.findById(req.user.id).select('+password');
  if (!user) throw new ApiError(404, 'User not found');
  if (!(await bcrypt.compare(req.body.currentPassword, user.password))) {
    throw new ApiError(400, 'Current password is incorrect');
  }
  user.password = await bcrypt.hash(req.body.newPassword, BCRYPT_ROUNDS);
  user.tokenVersion = (user.tokenVersion ?? 0) + 1;
  await user.save();
  await audit(req, 'change_password', 'User', user.id);
  ok(res, {
    message: 'Password updated',
    token: signToken(user.id, user.role, user.tokenVersion),
  });
});
