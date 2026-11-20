import { Schema, model } from 'mongoose';

export const TRIP_EVENT_TYPES = [
  'trip_created',
  'trip_assigned',
  'trip_started',
  'afternoon_trip_started',
  'trip_paused',
  'trip_resumed',
  'trip_delayed',
  'trip_arrived_school',
  'bus_arrived_at_school',
  'trip_departed_school',
  'trip_completed',
  'trip_cancelled',
  'student_picked_up',
  'student_absent',
  'student_not_available',
  'student_dropped_off',
  'student_exception',
  'gps_connection_lost',
  'gps_connection_restored',
  'attendance_corrected',
  'driver_changed',
  'vehicle_changed',
  'route_changed',
];

const tripEventSchema = new Schema(
  {
    trip: { type: Schema.Types.ObjectId, ref: 'Trip', required: true, index: true },
    eventType: { type: String, enum: TRIP_EVENT_TYPES, required: true, index: true },
    student: { type: Schema.Types.ObjectId, ref: 'Student', index: true },
    vehicle: { type: Schema.Types.ObjectId, ref: 'Vehicle', index: true },
    driver: { type: Schema.Types.ObjectId, ref: 'Driver', index: true },
    actor: { type: Schema.Types.ObjectId, ref: 'User' },
    actorRole: { type: String, trim: true },
    source: {
      type: String,
      enum: ['driver_app', 'driver_web', 'admin', 'system', 'socket'],
      default: 'system',
      index: true,
    },
    occurredAt: { type: Date, required: true, index: true },
    recordedAt: { type: Date, default: Date.now },
    latitude: { type: Number, min: -90, max: 90 },
    longitude: { type: Number, min: -180, max: 180 },
    accuracyMeters: { type: Number, min: 0 },
    note: { type: String, trim: true, maxlength: 500 },
    meta: { type: Schema.Types.Mixed },
    // Idempotency key: repeated submissions of the same physical event collapse into one record.
    dedupeKey: { type: String, trim: true },
  },
  { timestamps: true }
);

tripEventSchema.index({ trip: 1, occurredAt: -1 });
tripEventSchema.index({ trip: 1, eventType: 1, occurredAt: -1 });
tripEventSchema.index({ trip: 1, student: 1, eventType: 1, occurredAt: -1 });
tripEventSchema.index(
  { dedupeKey: 1 },
  { unique: true, partialFilterExpression: { dedupeKey: { $type: 'string' } } }
);

export const TripEvent = model('TripEvent', tripEventSchema);
