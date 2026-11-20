import mongoose from 'mongoose';
import { ApiError } from '../utils/http.js';
import {
  Driver,
  Parent,
  TransportAssignment,
  Trip,
  VehicleCurrentLocation,
} from '../models/index.js';

export const STALE_LOCATION_MS = 2 * 60 * 1000;

export function isTerminal(status) {
  return status === 'completed' || status === 'cancelled';
}

export function isTracking(status) {
  return ['in_progress', 'delayed', 'paused', 'arrived_at_school'].includes(status);
}

function toId(value) {
  if (!value) return null;
  if (typeof value === 'object' && value._id) return String(value._id);
  return String(value);
}

function sameId(a, b) {
  if (!a || !b) return false;
  return String(a) === String(b);
}

function riderStudentIds(assignment) {
  return (assignment?.riders || [])
    .map((r) => toId(r.student))
    .filter(Boolean);
}

const defaultDeps = {
  isValidObjectId: (id) => mongoose.isValidObjectId(id),
  findDriverByUser: (userId) => Driver.findOne({ user: userId }).select('_id').lean(),
  findParentByUser: (userId) =>
    Parent.findOne({ user: userId }).select('_id linkedStudents status').lean(),
  findTripById: (tripId) =>
    Trip.findById(tripId)
      .select('_id assignment driver substituteDriver vehicle status direction date gpsTrackingActive lastGpsUpdateAt')
      .lean(),
  findAssignmentById: (assignmentId) =>
    TransportAssignment.findById(assignmentId).select('_id riders status').lean(),
  findDriverTrips: (driverId) =>
    Trip.find({ $or: [{ driver: driverId }, { substituteDriver: driverId }], status: { $nin: ['completed', 'cancelled'] } })
      .select('_id assignment driver substituteDriver vehicle status direction date gpsTrackingActive lastGpsUpdateAt')
      .lean(),
  findAssignmentsByStudents: (studentIds) =>
    TransportAssignment.find({ status: 'active', 'riders.student': { $in: studentIds } })
      .select('_id riders')
      .lean(),
  findTripsByAssignments: (assignmentIds) =>
    Trip.find({ assignment: { $in: assignmentIds }, status: { $nin: ['completed', 'cancelled'] } })
      .select('_id assignment driver substituteDriver vehicle status direction date gpsTrackingActive lastGpsUpdateAt')
      .lean(),
  findCurrentLocationByVehicle: (vehicleId) =>
    VehicleCurrentLocation.findOne({ vehicle: vehicleId }).lean(),
};

export function createSocketAccess(overrides = {}) {
  const deps = { ...defaultDeps, ...overrides };
  const FORBIDDEN_TRIP = 'You are not authorized to access this trip';

  async function loadIdentity(user) {
    if (!user || !user.id) return null;
    if (user.role === 'admin') {
      return { role: 'admin', userId: String(user.id) };
    }
    if (user.role === 'driver') {
      const driver = await deps.findDriverByUser(user.id);
      if (!driver) return null;
      return { role: 'driver', userId: String(user.id), driverId: toId(driver._id) };
    }
    if (user.role === 'parent') {
      const parent = await deps.findParentByUser(user.id);
      if (!parent || parent.status === 'inactive') {
        return { role: 'parent', userId: String(user.id), parentId: null, linkedStudentIds: [] };
      }
      const linkedStudentIds = (parent.linkedStudents || []).map((id) => toId(id)).filter(Boolean);
      return {
        role: 'parent',
        userId: String(user.id),
        parentId: toId(parent._id),
        linkedStudentIds,
      };
    }
    return null;
  }

  async function authorizeTrip(identity, tripId) {
    if (!deps.isValidObjectId(tripId)) {
      throw new ApiError(400, 'Invalid trip id');
    }
    if (!identity) throw new ApiError(403, FORBIDDEN_TRIP);

    const trip = await deps.findTripById(tripId);
    if (!trip) throw new ApiError(403, FORBIDDEN_TRIP);

    if (identity.role === 'admin') {
      return { trip, studentIds: null };
    }

    if (identity.role === 'driver') {
      const ok =
        identity.driverId &&
        (sameId(trip.driver, identity.driverId) || sameId(trip.substituteDriver, identity.driverId));
      if (!ok) throw new ApiError(403, FORBIDDEN_TRIP);
      return { trip, studentIds: null };
    }

    if (identity.role === 'parent') {
      if (isTerminal(trip.status)) throw new ApiError(403, FORBIDDEN_TRIP);
      const linked = new Set((identity.linkedStudentIds || []).map(String));
      if (!linked.size || !trip.assignment) throw new ApiError(403, FORBIDDEN_TRIP);
      const assignment = await deps.findAssignmentById(trip.assignment);
      if (!assignment) throw new ApiError(403, FORBIDDEN_TRIP);
      const studentIds = riderStudentIds(assignment).filter((id) => linked.has(id));
      if (!studentIds.length) throw new ApiError(403, FORBIDDEN_TRIP);
      return { trip, studentIds };
    }

    throw new ApiError(403, FORBIDDEN_TRIP);
  }

  async function listAutoJoinTrips(identity) {
    if (!identity) return [];
    if (identity.role === 'driver') {
      if (!identity.driverId) return [];
      const trips = await deps.findDriverTrips(identity.driverId);
      return (trips || []).map((trip) => ({ trip, studentIds: null }));
    }
    if (identity.role === 'parent') {
      const linked = (identity.linkedStudentIds || []).map(String).filter(Boolean);
      if (!linked.length) return [];
      const assignments = await deps.findAssignmentsByStudents(linked);
      if (!assignments.length) return [];
      const linkedSet = new Set(linked);
      const byAssignment = new Map();
      for (const a of assignments) {
        const own = riderStudentIds(a).filter((id) => linkedSet.has(id));
        if (own.length) byAssignment.set(toId(a._id), own);
      }
      const assignmentIds = [...byAssignment.keys()];
      if (!assignmentIds.length) return [];
      const trips = await deps.findTripsByAssignments(assignmentIds);
      return (trips || [])
        .map((trip) => {
          const studentIds = byAssignment.get(toId(trip.assignment)) || [];
          if (!studentIds.length) return null;
          return { trip, studentIds };
        })
        .filter(Boolean);
    }
    return [];
  }

  async function getTripSnapshot(trip) {
    const base = {
      tripId: toId(trip?._id),
      status: trip?.status || null,
      direction: trip?.direction || null,
      date: trip?.date || null,
      serverTime: new Date().toISOString(),
      location: null,
      locationStale: true,
    };
    if (!trip || !isTracking(trip.status) || !trip.gpsTrackingActive || !trip.vehicle) {
      return base;
    }
    const current = await deps.findCurrentLocationByVehicle(trip.vehicle);
    if (!current) return base;
    const recordedAt = current.recordedAt ? new Date(current.recordedAt) : null;
    const ageMs = recordedAt ? Date.now() - recordedAt.getTime() : Infinity;
    const locationStale = !Number.isFinite(ageMs) || ageMs > STALE_LOCATION_MS;
    return {
      ...base,
      location: {
        latitude: current.latitude,
        longitude: current.longitude,
        accuracyMeters: current.accuracyMeters,
        speedKmh: current.speedKmh,
        heading: current.heading,
        recordedAt: current.recordedAt || null,
        receivedAt: current.receivedAt || null,
      },
      locationStale,
    };
  }

  return {
    loadIdentity,
    authorizeTrip,
    listAutoJoinTrips,
    getTripSnapshot,
    isTerminal,
    isTracking,
  };
}

export default createSocketAccess;