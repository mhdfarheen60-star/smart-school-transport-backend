import { Schema, model } from 'mongoose';

const maintenancePredictionSchema = new Schema(
  {
    vehicle: { type: Schema.Types.ObjectId, ref: 'Vehicle', required: true, index: true },
    analyzedAt: { type: Date, default: Date.now, index: true },
    riskLevel: { type: String, enum: ['low', 'medium', 'high', 'unknown'], default: 'unknown', index: true },
    riskScore: { type: Number, min: 0, max: 100 },
    status: { type: String, enum: ['healthy', 'inspection_recommended', 'service_due', 'attention_required', 'insufficient_data'], default: 'insufficient_data', index: true },
    summary: { type: String, trim: true, maxlength: 500 },
    recommendations: [
      {
        title: { type: String, trim: true, maxlength: 200 },
        detail: { type: String, trim: true, maxlength: 1000 },
        priority: { type: String, enum: ['low', 'medium', 'high'], default: 'medium' },
      },
    ],
    evidence: { type: Schema.Types.Mixed },
    basedOn: { type: String, enum: ['rules', 'ml', 'hybrid'], default: 'rules' },
    nextServiceDate: { type: Date },
    source: { type: String, trim: true, default: 'maintenance-insights' },
  },
  { timestamps: true }
);

maintenancePredictionSchema.index({ vehicle: 1, analyzedAt: -1 });

export const MaintenancePrediction = model('MaintenancePrediction', maintenancePredictionSchema);
