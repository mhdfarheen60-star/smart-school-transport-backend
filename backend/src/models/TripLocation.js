import { Schema, model } from 'mongoose';

const tripLocationSchema = new Schema(
  {
    trip: { type: Schema.Types.ObjectId, ref: 'Trip', required: true, index: true },
    vehicle: { type: Schema.Types.ObjectId, ref: 'Vehicle', index: true },
    driver: { type: Schema.Types.ObjectId, ref: 'Driver', index: true },
    route: { type: Schema.Types.ObjectId, ref: 'Route', index: true },
    recordedAt: { type: Date, required: true, index: true },
    receivedAt: { type: Date, default: Date.now },
    latitude: { type: Number, required: true, min: -90, max: 90 },
    longitude: { type: Number, required: true, min: -180, max: 180 },
    accuracyMeters: { type: Number, min: 0 },
    speedKmh: { type: Number, min: 0 },
    heading: { type: Number, min: 0, max: 360 },
    source: { type: String, enum: ['driver_app', 'device', 'manual', 'system'], default: 'driver_app' },
  },
  { timestamps: true }
);

tripLocationSchema.index({ trip: 1, recordedAt: -1 });
tripLocationSchema.index({ vehicle: 1, recordedAt: -1 });
tripLocationSchema.index({ driver: 1, recordedAt: -1 });

export const TripLocation = model('TripLocation', tripLocationSchema);