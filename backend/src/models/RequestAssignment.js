import { Schema, model } from 'mongoose';

const requestAssignmentSchema = new Schema(
  {
    request: { type: Schema.Types.ObjectId, ref: 'TransportRequest', required: true },
    driver: { type: Schema.Types.ObjectId, ref: 'Driver', required: true },
    status: {
      type: String,
      enum: ['assigned', 'accepted', 'declined', 'completed', 'reassigned'],
      default: 'assigned',
      index: true,
    },
    tripStatus: {
      type: String,
      enum: ['scheduled', 'driver_en_route', 'arrived', 'in_progress', 'completed'],
      default: 'scheduled',
    },
    acceptedAt: { type: Date },
    declinedAt: { type: Date },
    declineReason: { type: String, trim: true, maxlength: 500 },
    completedAt: { type: Date },
  },
  { timestamps: true }
);

requestAssignmentSchema.index(
  { driver: 1 },
  { unique: true, partialFilterExpression: { status: { $in: ['assigned', 'accepted'] } } }
);
requestAssignmentSchema.index(
  { request: 1 },
  { unique: true, partialFilterExpression: { status: { $in: ['assigned', 'accepted'] } } }
);

export const RequestAssignment = model('RequestAssignment', requestAssignmentSchema);
