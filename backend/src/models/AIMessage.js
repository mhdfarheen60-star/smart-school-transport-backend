import { Schema, model } from 'mongoose';

const messageSchema = new Schema(
  {
    conversation: { type: Schema.Types.ObjectId, ref: 'AIConversation', required: true, index: true },
    user: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    role: { type: String, enum: ['user', 'assistant', 'system'], required: true },
    content: { type: String, required: true, trim: true, maxlength: 20000 },
    source: { type: String, enum: ['user', 'assistant', 'system', 'tool'], default: 'user' },
    toolName: { type: String, trim: true },
    toolInput: { type: Schema.Types.Mixed },
    toolOutput: { type: Schema.Types.Mixed },
    unavailable: { type: Boolean, default: false },
    metadata: { type: Schema.Types.Mixed },
  },
  { timestamps: true }
);

messageSchema.index({ conversation: 1, createdAt: 1 });

export const AIMessage = model('AIMessage', messageSchema);
