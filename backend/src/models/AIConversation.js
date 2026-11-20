import { Schema, model } from 'mongoose';

const conversationSchema = new Schema(
  {
    user: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    role: { type: String, enum: ['student', 'parent', 'driver', 'admin'], required: true, index: true },
    title: { type: String, trim: true, maxlength: 160 },
    status: { type: String, enum: ['active', 'archived'], default: 'active', index: true },
    provider: { type: String, trim: true },
    model: { type: String, trim: true },
    lastMessageAt: { type: Date, default: Date.now, index: true },
    messageCount: { type: Number, default: 0, min: 0 },
    metadata: { type: Schema.Types.Mixed },
  },
  { timestamps: true }
);

conversationSchema.index({ user: 1, updatedAt: -1 });

export const AIConversation = model('AIConversation', conversationSchema);
