import { Schema, model } from 'mongoose';

const deviceTokenSchema = new Schema(
  {
    user: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    token: { type: String, required: true, unique: true, index: true },
    platform: { type: String, enum: ['web', 'android', 'ios'], required: true },
    deviceId: { type: String, trim: true },
    appVersion: { type: String, trim: true },
    isActive: { type: Boolean, default: true, index: true },
    lastUsedAt: { type: Date },
  },
  { timestamps: true }
);

deviceTokenSchema.index({ user: 1, platform: 1, isActive: 1 });

export const DeviceToken = model('DeviceToken', deviceTokenSchema);
