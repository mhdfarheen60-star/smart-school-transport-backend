import { Schema, model } from 'mongoose';

const parentSchema = new Schema(
  {
    user: { type: Schema.Types.ObjectId, ref: 'User', unique: true, sparse: true },
    name: { type: String, required: true, trim: true, minlength: 2, maxlength: 100 },
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    phone: { type: String, trim: true },
    linkedStudents: [{ type: Schema.Types.ObjectId, ref: 'Student' }],
    status: { type: String, enum: ['active', 'inactive'], default: 'active', index: true },
  },
  { timestamps: true }
);

export const Parent = model('Parent', parentSchema);
