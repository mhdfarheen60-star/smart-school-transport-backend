import { Attendance, Trip, VehicleCurrentLocation } from '../models/index.js';
import { ApiError } from '../utils/http.js';
import { audit } from './audit.service.js';
import { notifyTripGuardians } from './notification.service.js';
import { recordTripEvent } from './tripEvent.service.js';

const TRIP_STATUSES = [
  'scheduled',
  'assigned',
  'ready',
  'in_progress',
  'delayed',
  'paused',
  'arrived_at_school',
  'completed',
  'cancelled',
];

const TERMINAL = ['completed', 'cancelled'];

const EVENT_FOR_STATUS = {
  in_progress: 'trip_started',
  paused: 'trip_paused',
  delayed: 'trip_delayed',
  arrived_at_school: 'trip_arrived_school',
  completed: 'trip_completed',
  cancelled: 'trip_cancelled',
};

const NOTIFICATION_FOR_STATUS = {
  in_progress: (trip) => ({
    title: trip.direction === 'afternoon' ? 'Afternoon trip started' : 'Morning trip started',
    message:
      trip.direction === 'afternoon'
        ? 'The school bus has started the afternoon drop-off trip.'
        : 'The school bus has started the morning pickup trip.',
    type: 'trip',
    link: '/parent/tracking',
  }),
  arrived_at_school: () => ({
    title: 'Bus arrived at school',
    message: 'The school bus has arrived at the school.',
    type: 'school_arrival',
    link: '/parent/tracking',
  }),
  completed: () => ({
    title: 'Trip completed',
    message: 'The school bus trip has been completed.',
    type: 'trip',
    link: '/parent/tracking',
  }),
  cancelled: (trip) => ({
    title: 'Trip cancelled',
    message: trip.cancellationReason
      ? `The school bus trip was cancelled: ${trip.cancellationReason}`
      : 'The school bus trip was cancelled.',
    type: 'trip',
    link: '/parent/tracking',
  }),
  delayed: (trip) => ({
    title: 'Trip delayed',
    message: trip.delayMinutes
      ? `The school bus trip is delayed by about ${trip.delayMinutes} minutes.`
      : 'The school bus trip is delayed.',
    type: 'delay',
    link: '/parent/tracking',
  }),
};

export async function computeAttendanceSummary(tripId) {
  const records = await Attendance.find({ trip: tripId })
    .select('pickupStatus dropStatus')
    .lean();

  const summary = {
    total: records.length,
    pickedUp: 0,
    dropped: 0,
    absent: 0,
    pendingPickup: 0,
    pendingDrop: 0,
  };

  for (const r of records) {
    if (r.pickupStatus === 'picked_up') summary.pickedUp += 1;
    else if (r.pickupStatus === 'absent' || r.pickupStatus === 'not_available') summary.absent += 1;
    else summary.pendingPickup += 1;

    if (r.dropStatus === 'dropped') summary.dropped += 1;
    else if (r.pickupStatus === 'picked_up') summary.pendingDrop += 1;
  }

  return summary;
}

async function stopTracking(trip) {
  await Trip.updateOne({ _id: trip._id }, { $set: { gpsTrackingActive: false } }).catch(() => {});
  await VehicleCurrentLocation.updateMany(
    { trip: trip._id },
    { $set: { trackingActive: false } }
  ).catch(() => {});
}

/**
 * Central trip state machine used by both the driver trip endpoints and the
 * administrator scheduling endpoints. All transitions are audited and produce a
 * persisted TripEvent.
 */
export async function changeTripStatus({
  req,
  trip,
  status,
  delayMinutes,
  delayReason,
  cancellationReason,
  override = false,
  overrideReason,
}) {
  if (!TRIP_STATUSES.includes(status)) throw new ApiError(400, 'Invalid trip status');
  if (TERMINAL.includes(trip.status)) {
    if (trip.status === status) return trip;
    throw new ApiError(409, `Trip already ${trip.status}`);
  }

  const now = new Date();
  let summary = await computeAttendanceSummary(trip._id);

  if (status === 'completed') {
    const unresolved = summary.pendingPickup + summary.pendingDrop;
    if (unresolved > 0) {
      if (req.user?.role !== 'admin') {
        throw new ApiError(
          409,
          `Cannot complete this trip: ${summary.pendingPickup} student(s) still awaiting pickup and ${summary.pendingDrop} awaiting drop-off. Record each student's outcome first.`,
          { pendingPickup: summary.pendingPickup, pendingDrop: summary.pendingDrop, requiresOverride: false }
        );
      }
      if (!override) {
        throw new ApiError(
          409,
          `This trip still has ${summary.pendingPickup} pending pickup(s) and ${summary.pendingDrop} pending drop-off(s). An administrator override with a reason is required to close it.`,
          { pendingPickup: summary.pendingPickup, pendingDrop: summary.pendingDrop, requiresOverride: true }
        );
      }
      if (!overrideReason || !String(overrideReason).trim()) {
        throw new ApiError(422, 'An override reason is required to complete a trip with unresolved student events');
      }
      trip.completionOverride = {
        by: req.user.id,
        reason: String(overrideReason).trim().slice(0, 500),
        at: now,
      };
    }
  }

  const previous = trip.status;
  trip.status = status;

  if (status === 'in_progress' && !trip.startedAt) trip.startedAt = now;
  if (status === 'arrived_at_school') trip.arrivedAtSchoolAt = now;
  if (status === 'completed') trip.completedAt = now;
  if (status === 'cancelled') {
    trip.cancelledAt = now;
    trip.cancelledBy = req.user?.id;
    if (cancellationReason) trip.cancellationReason = String(cancellationReason).slice(0, 500);
  }
  if (delayMinutes != null) trip.delayMinutes = Number(delayMinutes);
  if (delayReason != null) trip.delayReason = String(delayReason).slice(0, 500);

  if (status === 'in_progress') trip.gpsTrackingActive = true;

  summary = await computeAttendanceSummary(trip._id);
  trip.attendanceSummary = summary;

  await trip.save();

  if (TERMINAL.includes(status)) await stopTracking(trip);

  const eventType =
    status === 'in_progress' && trip.direction === 'afternoon'
      ? 'afternoon_trip_started'
      : EVENT_FOR_STATUS[status];
  if (eventType && eventType !== previous) {
    await recordTripEvent({
      trip,
      eventType,
      actor: req.user?.id,
      actorRole: req.user?.role,
      source: req.user?.role === 'admin' ? 'admin' : req.user?.role === 'driver' ? 'driver_web' : 'system',
      occurredAt: now,
      note: delayReason || cancellationReason || overrideReason,
      dedupeKey: `${trip._id}:${eventType}:${Math.floor(now.getTime() / 1000)}`,
      meta: {
        status,
        previousStatus: previous,
        delayMinutes: trip.delayMinutes ?? null,
        summary,
        ...(trip.completionOverride?.reason && status === 'completed'
          ? { override: true, overrideReason: trip.completionOverride.reason }
          : {}),
      },
    });

    const notification = NOTIFICATION_FOR_STATUS[status];
    if (notification) {
      notifyTripGuardians(trip._id, notification(trip)).catch(() => {});
    }
  }

  await audit(req, `trip_${status}`, 'Trip', trip.id, {
    status,
    previousStatus: previous,
    delayMinutes,
    delayReason,
    override: Boolean(trip.completionOverride?.at && status === 'completed'),
    overrideReason: trip.completionOverride?.reason,
  });

  return trip;
}

export { TRIP_STATUSES };
