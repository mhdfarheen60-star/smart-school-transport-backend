import { Schema, model } from 'mongoose';

const geofenceSchema = new Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 120 },
    description: { type: String, trim: true, maxlength: 500 },
    type: { type: String, enum: ['route_corridor', 'stop_radius', 'zone'], default: 'zone', index: true },
    scope: { type: String, enum: ['global', 'route', 'vehicle'], default: 'global', index: true },
    route: { type: Schema.Types.ObjectId, ref: 'Route', index: true },
    vehicle: { type: Schema.Types.ObjectId, ref: 'Vehicle', index: true },
    // Circle geofence (simple, configurable)
    center: {
      latitude: { type: Number, min: -90, max: 90 },
      longitude: { type: Number, min: -180, max: 180 },
    },
    radiusMeters: { type: Number, min: 10, max: 100000 },
    // Optional expected route path as ordered coordinates for deviation checks (when available)
    path: [
      {
        latitude: { type: Number, min: -90, max: 90 },
        longitude: { type: Number, min: -180, max: 180 },
        _id: false,
      },
    ],
    deviationThresholdMeters: { type: Number, min: 50, max: 10000, default: 500 },
    prolongedStopMinutes: { type: Number, min: 1, max: 240, default: 10 },
    missingUpdateMinutes: { type: Number, min: 1, max: 240, default: 10 },
    active: { type: Boolean, default: true, index: true },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User' },
    updatedBy: { type: Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

geofenceSchema.index({ scope: 1, route: 1, vehicle: 1, active: 1 });

export const Geofence = model('Geofence', geofenceSchema);