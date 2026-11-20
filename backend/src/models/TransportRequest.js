import { Schema, model } from 'mongoose';

export const geoSchema = new Schema(
  {
    latitude: { type: Number, required: true, min: -90, max: 90 },
    longitude: { type: Number, required: true, min: -180, max: 180 },
    placeId: { type: String, trim: true },
  },
  { _id: false }
);

const requestSchema = new Schema(
  {
    student: { type: Schema.Types.ObjectId, ref: 'Student', required: true, index: true },
    pickupLocation: { type: String, required: true, trim: true, maxlength: 300 },
    dropLocation: { type: String, required: true, trim: true, maxlength: 300 },
    pickupGeo: { type: geoSchema },
    dropGeo: { type: geoSchema },
    requestedAt: { type: Date },
    preferredStop: { type: String, trim: true },
    notes: { type: String, trim: true, maxlength: 500 },
    status: {
      type: String,
      enum: [
        'pending',
        'approved',
        'rejected',
        'cancelled',
        'assigned',
        'accepted',
        'driver_en_route',
        'arrived',
        'in_progress',
        'completed',
        'reassignment_required',
      ],
      default: 'pending',
      index: true,
    },
    remarks: { type: String, trim: true, maxlength: 500 },
    reviewedBy: { type: Schema.Types.ObjectId, ref: 'User' },
    reviewedAt: { type: Date },
    assignment: { type: Schema.Types.ObjectId, ref: 'TransportAssignment' },
    assignedDriver: { type: Schema.Types.ObjectId, ref: 'Driver', index: true },
    assignedVehicle: { type: Schema.Types.ObjectId, ref: 'Vehicle', index: true },
    assignedAt: { type: Date },
  },
  { timestamps: true }
);

export const TransportRequest = model('TransportRequest', requestSchema);
