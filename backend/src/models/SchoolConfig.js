import { Schema, model } from 'mongoose';

const geoPointSchema = new Schema(
  {
    latitude: { type: Number, required: true, min: -90, max: 90 },
    longitude: { type: Number, required: true, min: -180, max: 180 },
    address: { type: String, trim: true, maxlength: 300 },
    landmark: { type: String, trim: true, maxlength: 200 },
  },
  { _id: false }
);

const schoolConfigSchema = new Schema(
  {
    name: { type: String, trim: true, maxlength: 200 },
    address: { type: String, trim: true, maxlength: 300 },
    geo: geoPointSchema,
    timezone: { type: String, default: 'Asia/Kolkata', trim: true },
    morningStartTime: { type: String, match: /^([01]\d|2[0-3]):[0-5]\d$/, default: '07:00' },
    afternoonStartTime: { type: String, match: /^([01]\d|2[0-3]):[0-5]\d$/, default: '13:30' },
    workingDays: { type: [Number], default: [1, 2, 3, 4, 5], validate: [(v) => v.length > 0, 'At least one working day is required'] },
    gpsUpdateIntervalMovingMs: { type: Number, default: 5000, min: 1000, max: 60000 },
    gpsUpdateIntervalStationaryMs: { type: Number, default: 30000, min: 5000, max: 300000 },
    gpsStaleThresholdMs: { type: Number, default: 120000, min: 30000, max: 3600000 },
    gpsRetentionDays: { type: Number, default: 30, min: 1, max: 365 },
    proximityThresholdMeters: { type: Number, default: 100, min: 10, max: 1000 },
    etaUpdateIntervalMs: { type: Number, default: 30000, min: 10000, max: 300000 },
    updatedBy: { type: Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: { createdAt: true, updatedAt: true } }
);

schoolConfigSchema.index({ updatedAt: -1 });

export const SchoolConfig = model('SchoolConfig', schoolConfigSchema);
