import { Schema, model } from 'mongoose';

export const ROLES = ['student', 'parent', 'driver', 'admin'];

const userSchema = new Schema(
  {
    name: { type: String, required: true, trim: true, minlength: 2, maxlength: 100 },
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    password: { type: String, required: true, select: false },
    role: { type: String, enum: ROLES, required: true, index: true },
    phone: { type: String, trim: true },
    isActive: { type: Boolean, default: true },
    tokenVersion: { type: Number, default: 0 },
  },
  { timestamps: true }
);

export const User = model('User', userSchema);
