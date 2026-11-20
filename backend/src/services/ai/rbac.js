import { Driver, Parent, Student, TransportAssignment, Trip, RequestAssignment } from '../../models/index.js';
import { ApiError } from '../../utils/http.js';

export async function getStudentProfileForUser(userId) {
  const student = await Student.findOne({ user: userId });
  return student;
}

export async function getDriverProfileForUser(userId) {
  const driver = await Driver.findOne({ user: userId });
  return driver;
}

export async function getParentProfileForUser(user) {
  if (!user) return null;
  if (user.id) {
    const linked = await Parent.findOne({ user: user.id });
    if (linked) return linked;
  }
  if (user.parentId) return Parent.findById(user.parentId);
  if (user.email) return Parent.findOne({ email: String(user.email).toLowerCase().trim() });
  return null;
}

export async function assertCanAccessStudent(reqUser, studentId) {
  if (!reqUser) throw new ApiError(401, 'Authentication required');
  if (reqUser.role === 'admin') return true;

  if (reqUser.role === 'student') {
    const student = await getStudentProfileForUser(reqUser.id);
    if (!student || String(student._id) !== String(studentId)) {
      throw new ApiError(403, 'You can only access your own student information');
    }
    return true;
  }

  if (reqUser.role === 'parent') {
    const parent = await getParentProfileForUser(reqUser);
    const linked = (parent?.linkedStudents || []).map((id) => String(id));
    if (!linked.includes(String(studentId))) {
      throw new ApiError(403, 'You can only access your linked students');
    }
    return true;
  }

  throw new ApiError(403, 'Not authorized to access this student');
}

export async function assertCanAccessTrip(reqUser, tripId) {
  if (!reqUser) throw new ApiError(401, 'Authentication required');
  if (reqUser.role === 'admin') return Trip.findById(tripId).lean();

  const trip = await Trip.findById(tripId).lean();
  if (!trip) throw new ApiError(404, 'Trip not found');

  if (reqUser.role === 'driver') {
    const driver = await getDriverProfileForUser(reqUser.id);
    if (!driver || String(trip.driver) !== String(driver._id)) {
      throw new ApiError(403, 'You can only access your assigned trips');
    }
    return trip;
  }

  if (reqUser.role === 'student') {
    const student = await getStudentProfileForUser(reqUser.id);
    if (!student) throw new ApiError(404, 'Student profile not found');
    const assigned = await TransportAssignment.exists({
      status: 'active',
      route: trip.route,
      vehicle: trip.vehicle,
      driver: trip.driver,
      'riders.student': student._id,
    });
    if (!assigned) throw new ApiError(403, 'You can only access trips for your assignment');
    return trip;
  }

  if (reqUser.role === 'parent') {
    const parent = await getParentProfileForUser(reqUser);
    const linked = parent?.linkedStudents || [];
    if (!linked.length) throw new ApiError(403, 'No linked students found');
    const assigned = await TransportAssignment.exists({
      status: 'active',
      route: trip.route,
      vehicle: trip.vehicle,
      driver: trip.driver,
      'riders.student': { $in: linked },
    });
    if (!assigned) throw new ApiError(403, 'You can only access trips for your linked students');
    return trip;
  }

  throw new ApiError(403, 'Not authorized to access this trip');
}

export async function assertCanAccessRequestAssignment(reqUser, requestAssignmentId) {
  const ra = await RequestAssignment.findById(requestAssignmentId).populate('request').lean();
  if (!ra) throw new ApiError(404, 'Assignment not found');
  if (reqUser.role === 'admin') return ra;

  if (reqUser.role === 'driver') {
    const driver = await getDriverProfileForUser(reqUser.id);
    if (!driver || String(ra.driver) !== String(driver._id)) {
      throw new ApiError(403, 'You can only access your assigned requests');
    }
    return ra;
  }

  if (reqUser.role === 'student') {
    const student = await getStudentProfileForUser(reqUser.id);
    if (!student || String(ra.request?.student) !== String(student._id)) {
      throw new ApiError(403, 'You can only access your own transport requests');
    }
    return ra;
  }

  if (reqUser.role === 'parent') {
    const parent = await getParentProfileForUser(reqUser);
    const linked = (parent?.linkedStudents || []).map((id) => String(id));
    if (!linked.includes(String(ra.request?.student))) {
      throw new ApiError(403, 'You can only access your linked students');
    }
    return ra;
  }

  throw new ApiError(403, 'Not authorized');
}
