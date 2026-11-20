import { Schema, model } from 'mongoose';

const geoPointSchema = new Schema(
  {
    latitude: { type: Number, required: true, min: -90, max: 90 },
    longitude: { type: Number, required: true, min: -180, max: 180 },
    address: { type: String, trim: true, maxlength: 300 },
    landmark: { type: String, trim: true, maxlength: 200 },
    placeId: { type: String, trim: true },
  },
  { _id: false }
);

const locationRecordSchema = new Schema(
  {
    geo: { type: geoPointSchema, required: true },
    verified: { type: Boolean, default: false, index: true },
    lastUpdated: { type: Date },
    updatedBy: { type: Schema.Types.ObjectId, ref: 'User' },
  },
  { _id: false }
);

const studentSchema = new Schema(
  {
    user: { type: Schema.Types.ObjectId, ref: 'User', required: true, unique: true },
    studentId: { type: String, required: true, unique: true, uppercase: true, trim: true },
    name: { type: String, required: true, trim: true },
    photograph: { type: String, trim: true },
    className: { type: String, required: true, trim: true },
    division: { type: String, required: true, trim: true, uppercase: true },
    address: { type: String, required: true, trim: true, maxlength: 300 },
    phone: { type: String, required: true, trim: true },
    parentName: { type: String, trim: true },
    parentPhone: { type: String, required: true, trim: true },
    emergencyContact: { type: String, trim: true, maxlength: 300 },
    status: { type: String, enum: ['active', 'inactive', 'archived'], default: 'active', index: true },
    permanentPickupLocation: { type: locationRecordSchema },
    permanentDropLocation: { type: locationRecordSchema },
    assignedRoute: { type: Schema.Types.ObjectId, ref: 'Route', index: true },
    assignedVehicle: { type: Schema.Types.ObjectId, ref: 'Vehicle', index: true },
    assignedDriver: { type: Schema.Types.ObjectId, ref: 'Driver', index: true },
    transportStatus: {
      type: String,
      enum: ['not_assigned', 'assigned', 'suspended'],
      default: 'not_assigned',
      index: true,
    },
  },
  { timestamps: true }
);

studentSchema.index({ className: 1, division: 1 });
studentSchema.index({ name: 'text' });
studentSchema.index({ assignedRoute: 1, status: 1 });
studentSchema.index({ assignedVehicle: 1, status: 1 });

export const Student = model('Student', studentSchema);
