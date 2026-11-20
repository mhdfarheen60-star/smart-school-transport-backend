import { Schema, model } from 'mongoose';

// Shared (DB-backed) rate-limit bucket for AI assistant usage across instances.
// TTL index on expiresAt cleans up old windows automatically.
const assistantRateLimitSchema = new Schema(
  {
    key: { type: String, required: true, unique: true, index: true },
    count: { type: Number, required: true, default: 0, min: 0 },
    windowStart: { type: Date, required: true },
    expiresAt: { type: Date, required: true },
  },
  { timestamps: true }
);

assistantRateLimitSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const AssistantRateLimit = model('AssistantRateLimit', assistantRateLimitSchema);