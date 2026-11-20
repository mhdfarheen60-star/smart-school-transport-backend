import { Schema, model } from 'mongoose';

const vehicleCurrentLocationSchema = new Schema(
  {
    vehicle: { type: Schema.Types.ObjectId, ref: 'Vehicle', required: true, unique: true, index: true },
    driver: { type: Schema.Types.ObjectId, ref: 'Driver', index: true },
    trip: { type: Schema.Types.ObjectId, ref: 'Trip', index: true },
    latitude: { type: Number, required: true, min: -90, max: 90 },
    longitude: { type: Number, required: true, min: -180, max: 180 },
    accuracyMeters: { type: Number, min: 0 },
    speedKmh: { type: Number, min: 0 },
    heading: { type: Number, min: 0, max: 360 },
    recordedAt: { type: Date, required: true, index: true },
    receivedAt: { type: Date, default: Date.now },
    source: { type: String, enum: ['driver_app', 'device', 'manual', 'system'], default: 'driver_app' },
    trackingActive: { type: Boolean, default: false, index: true },
  },
  { timestamps: true }
);

vehicleCurrentLocationSchema.index({ trackingActive: 1, recordedAt: -1 });

export const VehicleCurrentLocation = model('VehicleCurrentLocation', vehicleCurrentLocationSchema);
