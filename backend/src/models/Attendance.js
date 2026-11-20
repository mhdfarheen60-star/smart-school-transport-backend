import { Schema, model } from 'mongoose';

export const PICKUP_STATUS = ['pending', 'picked_up', 'absent', 'not_available'];
export const DROP_STATUS = ['pending', 'dropped'];
export const EVENT_SOURCE = ['driver_app', 'driver_web', 'admin', 'system'];

const eventPointSchema = new Schema(
  {
    latitude: { type: Number, required: true, min: -90, max: 90 },
    longitude: { type: Number, required: true, min: -180, max: 180 },
    accuracyMeters: { type: Number, min: 0 },
  },
  { _id: false }
);

const attendanceSchema = new Schema(
  {
    trip: { type: Schema.Types.ObjectId, ref: 'Trip', required: true, index: true },
    student: { type: Schema.Types.ObjectId, ref: 'Student', required: true, index: true },
    vehicle: { type: Schema.Types.ObjectId, ref: 'Vehicle', required: true },
    driver: { type: Schema.Types.ObjectId, ref: 'Driver', required: true, index: true },
    route: { type: Schema.Types.ObjectId, ref: 'Route', required: true },
    date: { type: String, required: true, index: true },
    stop: { type: String },
    pickupStatus: { type: String, enum: PICKUP_STATUS, default: 'pending', index: true },
    pickupAt: Date,
    pickupGeo: eventPointSchema,
    pickupSource: { type: String, enum: EVENT_SOURCE },
    pickupNote: { type: String, trim: true, maxlength: 500 },
    dropStatus: { type: String, enum: DROP_STATUS, default: 'pending', index: true },
    dropAt: Date,
    dropGeo: eventPointSchema,
    dropSource: { type: String, enum: EVENT_SOURCE },
    dropNote: { type: String, trim: true, maxlength: 500 },
    // An approved temporary exception (different stop for one day) is recorded
    // here; it never mutates the student's permanent location.
    exception: { type: Boolean, default: false },
    exceptionReason: { type: String, trim: true, maxlength: 500 },
    markedBy: { type: Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

attendanceSchema.index({ trip: 1, student: 1 }, { unique: true });
attendanceSchema.index({ student: 1, date: -1 });
attendanceSchema.index({ trip: 1, pickupStatus: 1 });
attendanceSchema.index({ trip: 1, dropStatus: 1 });

export const Attendance = model('Attendance', attendanceSchema);
