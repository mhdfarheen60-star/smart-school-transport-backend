import { Schema, model } from 'mongoose';

const historySchema = new Schema(
  {
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', index: true },
    status: {
      type: String,
      enum: ['suggested', 'approved', 'rejected', 'applied', 'failed'],
      default: 'suggested',
      index: true,
    },
    scope: {
      route: { type: Schema.Types.ObjectId, ref: 'Route' },
      vehicle: { type: Schema.Types.ObjectId, ref: 'Vehicle' },
      driver: { type: Schema.Types.ObjectId, ref: 'Driver' },
      assignment: { type: Schema.Types.ObjectId, ref: 'TransportAssignment' },
    },
    input: { type: Schema.Types.Mixed },
    originalPlan: { type: Schema.Types.Mixed },
    optimizedPlan: { type: Schema.Types.Mixed },
    comparison: { type: Schema.Types.Mixed },
    recommendations: [{ type: String, trim: true, maxlength: 500 }],
    provider: { type: String, trim: true },
    mode: { type: String, enum: ['deterministic', 'external', 'fallback'], default: 'deterministic' },
    error: { type: String, trim: true, maxlength: 1000 },
    approvedBy: { type: Schema.Types.ObjectId, ref: 'User' },
    approvedAt: { type: Date },
    notes: { type: String, trim: true, maxlength: 1000 },
  },
  { timestamps: true }
);

historySchema.index({ 'scope.route': 1, createdAt: -1 });
historySchema.index({ status: 1, createdAt: -1 });

export const RouteOptimizationHistory = model('RouteOptimizationHistory', historySchema);
