import { Schema, model } from 'mongoose';

const maintenanceRecordSchema = new Schema(
  {
    vehicle: { type: Schema.Types.ObjectId, ref: 'Vehicle', required: true, index: true },
    type: { type: String, enum: ['service', 'inspection', 'repair', 'other'], default: 'service', index: true },
    status: { type: String, enum: ['scheduled', 'completed', 'overdue', 'cancelled'], default: 'completed', index: true },
    serviceDate: { type: Date },
    dueDate: { type: Date },
    odometerKm: { type: Number, min: 0 },
    cost: { type: Number, min: 0 },
    notes: { type: String, trim: true, maxlength: 2000 },
    performedBy: { type: String, trim: true, maxlength: 200 },
    recordedBy: { type: Schema.Types.ObjectId, ref: 'User' },
    attachments: [{ type: String, trim: true, maxlength: 500 }],
  },
  { timestamps: true }
);

maintenanceRecordSchema.index({ vehicle: 1, serviceDate: -1, createdAt: -1 });

export const MaintenanceRecord = model('MaintenanceRecord', maintenanceRecordSchema);
