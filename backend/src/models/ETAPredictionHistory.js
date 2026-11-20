import { Schema, model } from 'mongoose';

const etaSchema = new Schema(
  {
    trip: { type: Schema.Types.ObjectId, ref: 'Trip', index: true },
    request: { type: Schema.Types.ObjectId, ref: 'TransportRequest', index: true },
    assignment: { type: Schema.Types.ObjectId, ref: 'TransportAssignment', index: true },
    student: { type: Schema.Types.ObjectId, ref: 'Student', index: true },
    vehicle: { type: Schema.Types.ObjectId, ref: 'Vehicle', index: true },
    route: { type: Schema.Types.ObjectId, ref: 'Route', index: true },
    predictedFor: { type: Date, index: true },
    predictedArrival: { type: Date },
    predictedMinutes: { type: Number, min: 0 },
    actualArrival: { type: Date },
    delayMinutes: { type: Number },
    confidence: { type: Number, min: 0, max: 1 },
    uncertaintyMinutes: { type: Number, min: 0 },
    source: {
      type: String,
      enum: ['schedule', 'historical', 'baseline', 'external', 'manual'],
      default: 'baseline',
    },
    basis: { type: Schema.Types.Mixed },
    status: { type: String, enum: ['predicted', 'updated', 'actualized', 'unavailable'], default: 'predicted', index: true },
    notes: { type: String, trim: true, maxlength: 1000 },
  },
  { timestamps: true }
);

etaSchema.index({ trip: 1, createdAt: -1 });
etaSchema.index({ student: 1, createdAt: -1 });

export const ETAPredictionHistory = model('ETAPredictionHistory', etaSchema);
