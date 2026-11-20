import { Schema, model } from 'mongoose';

const geoPointSchema = new Schema(
  {
    latitude: { type: Number, min: -90, max: 90 },
    longitude: { type: Number, min: -180, max: 180 },
    address: { type: String, trim: true, maxlength: 300 },
    landmark: { type: String, trim: true, maxlength: 200 },
    placeId: { type: String, trim: true, maxlength: 300 },
  },
  { _id: false }
);

const stopSchema = new Schema(
  {
    name: { type: String, required: true, trim: true },
    sequence: { type: Number, required: true, min: 1 },
    pickupTime: { type: String, match: /^([01]\d|2[0-3]):[0-5]\d$/ },
    dropTime: { type: String, match: /^([01]\d|2[0-3]):[0-5]\d$/ },
    // Geographic data is optional for backward compatibility with routes created
    // before coordinates were captured. Trips use it for maps, ETA and navigation.
    latitude: { type: Number, min: -90, max: 90 },
    longitude: { type: Number, min: -180, max: 180 },
    address: { type: String, trim: true, maxlength: 300 },
    landmark: { type: String, trim: true, maxlength: 200 },
    type: { type: String, enum: ['pickup', 'drop', 'both'], default: 'both' },
  },
  { _id: false }
);

const routeSchema = new Schema(
  {
    name: { type: String, required: true, unique: true, trim: true },
    description: { type: String, trim: true, maxlength: 500 },
    stops: {
      type: [stopSchema],
      validate: [(v) => v.length >= 1, 'A route needs at least one stop'],
    },
    status: { type: String, enum: ['active', 'inactive'], default: 'active', index: true },
    // Fixed operational geometry. The school location is authoritative for the
    // morning destination / afternoon origin.
    schoolLocation: geoPointSchema,
    startLocation: geoPointSchema,
    endLocation: geoPointSchema,
    geometry: [
      {
        latitude: { type: Number, required: true, min: -90, max: 90 },
        longitude: { type: Number, required: true, min: -180, max: 180 },
        _id: false,
      },
    ],
    distanceKm: { type: Number, min: 0 },
    durationMinutes: { type: Number, min: 0 },
    metricsSource: { type: String, trim: true },
    metricsMode: { type: String, enum: ['external', 'fallback', 'none'], default: 'none' },
    metricsIsFallback: { type: Boolean, default: true },
    metricsUpdatedAt: { type: Date },
  },
  { timestamps: true }
);

routeSchema.index({ status: 1, name: 1 });

export const Route = model('Route', routeSchema);
