import { Schema, model } from 'mongoose';

export const NOTIFICATION_TYPES = [
  'info',
  'request',
  'assignment',
  'attendance',
  'complaint',
  'problem',
  'delay',
  'holiday',
  'route_change',
  'trip',
  'pickup',
  'drop',
  'school_arrival',
  'gps',
  'exception',
  'system',
];

const notificationSchema = new Schema(
  {
    user: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    title: { type: String, required: true, trim: true, maxlength: 150 },
    message: { type: String, required: true, trim: true, maxlength: 1000 },
    type: { type: String, enum: NOTIFICATION_TYPES, default: 'info', index: true },
    read: { type: Boolean, default: false, index: true },
    // Delivery metadata. In-app delivery is always attempted; push depends on provider configuration.
    channel: { type: String, enum: ['in_app', 'push', 'both'], default: 'in_app' },
    pushStatus: {
      type: String,
      enum: ['not_attempted', 'sent', 'failed', 'skipped', 'unconfigured'],
      default: 'not_attempted',
    },
    pushError: { type: String, trim: true, maxlength: 500 },
    link: { type: String, trim: true, maxlength: 300 },
    meta: { type: Schema.Types.Mixed },
  },
  { timestamps: true }
);

notificationSchema.index({ user: 1, createdAt: -1 });
notificationSchema.index({ user: 1, read: 1, createdAt: -1 });
notificationSchema.index({ type: 1, createdAt: -1 });

export const Notification = model('Notification', notificationSchema);
