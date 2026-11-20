import { Schema, model } from 'mongoose';

const safetyAlertSchema = new Schema(
  {
    type: {
      type: String,
      enum: ['route_deviation', 'unexpected_stop', 'delay', 'missing_location_update', 'unexpected_trip_termination', 'manual', 'other'],
      required: true,
      index: true,
    },
    severity: { type: String, enum: ['low', 'medium', 'high', 'critical'], default: 'medium', index: true },
    status: { type: String, enum: ['active', 'acknowledged', 'resolved'], default: 'active', index: true },
    title: { type: String, trim: true, maxlength: 200 },
    message: { type: String, trim: true, maxlength: 2000 },
    dedupeKey: { type: String, trim: true, maxlength: 300, index: true },
    trip: { type: Schema.Types.ObjectId, ref: 'Trip', index: true },
    assignment: { type: Schema.Types.ObjectId, ref: 'TransportAssignment', index: true },
    vehicle: { type: Schema.Types.ObjectId, ref: 'Vehicle', index: true },
    driver: { type: Schema.Types.ObjectId, ref: 'Driver', index: true },
    route: { type: Schema.Types.ObjectId, ref: 'Route', index: true },
    student: { type: Schema.Types.ObjectId, ref: 'Student', index: true },
    location: {
      latitude: { type: Number, min: -90, max: 90 },
      longitude: { type: Number, min: -180, max: 180 },
      address: { type: String, trim: true, maxlength: 300 },
    },
    detectedAt: { type: Date, default: Date.now, index: true },
    acknowledgedBy: { type: Schema.Types.ObjectId, ref: 'User' },
    acknowledgedAt: { type: Date },
    resolvedBy: { type: Schema.Types.ObjectId, ref: 'User' },
    resolvedAt: { type: Date },
    resolutionNotes: { type: String, trim: true, maxlength: 1000 },
    metadata: { type: Schema.Types.Mixed },
  },
  { timestamps: true }
);

safetyAlertSchema.index({ status: 1, severity: 1, detectedAt: -1 });
safetyAlertSchema.index({ vehicle: 1, detectedAt: -1 });

export const SafetyAlert = model('SafetyAlert', safetyAlertSchema);
