import { Schema, model } from 'mongoose';

export const LINK_REQUEST_STATUS = ['pending', 'approved', 'rejected', 'cancelled'];

const parentLinkRequestSchema = new Schema(
  {
    parent: { type: Schema.Types.ObjectId, ref: 'Parent', required: true, index: true },
    student: { type: Schema.Types.ObjectId, ref: 'Student', required: true, index: true },
    relationship: { type: String, trim: true, maxlength: 60 },
    note: { type: String, trim: true, maxlength: 500 },
    status: { type: String, enum: LINK_REQUEST_STATUS, default: 'pending', index: true },
    reviewedBy: { type: Schema.Types.ObjectId, ref: 'User' },
    reviewedAt: Date,
    rejectionReason: { type: String, trim: true, maxlength: 500 },
  },
  { timestamps: true }
);

// One pending request per parent/student pair.
parentLinkRequestSchema.index(
  { parent: 1, student: 1 },
  { unique: true, partialFilterExpression: { status: 'pending' } }
);
parentLinkRequestSchema.index({ status: 1, createdAt: -1 });

export const ParentLinkRequest = model('ParentLinkRequest', parentLinkRequestSchema);
