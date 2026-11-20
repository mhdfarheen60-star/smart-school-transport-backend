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

const transportExceptionSchema = new Schema(
  {
    student: { type: Schema.Types.ObjectId, ref: 'Student', required: true, index: true },
    trip: { type: Schema.Types.ObjectId, ref: 'Trip', index: true },
    date: { type: String, required: true, match: /^\d{4}-\d{2}-\d{2}$/, index: true },
    direction: { type: String, enum: ['morning', 'afternoon'], required: true, index: true },
    target: { type: String, enum: ['pickup', 'drop'], required: true },
    geo: geoPointSchema,
    reason: { type: String, trim: true, maxlength: 500 },
    status: {
      type: String,
      enum: ['pending', 'approved', 'rejected', 'cancelled'],
      default: 'pending',
      index: true,
    },
    reviewedBy: { type: Schema.Types.ObjectId, ref: 'User' },
    reviewedAt: Date,
    rejectionReason: { type: String, trim: true, maxlength: 500 },
    appliesToAllDays: { type: Boolean, default: false },
  },
  { timestamps: true }
);

transportExceptionSchema.index({ student: 1, date: 1, direction: 1, target: 1 }, { unique: true, partialFilterExpression: { status: { $in: ['pending', 'approved'] } } });

export const TransportException = model('TransportException', transportExceptionSchema);
