import { Schema, model } from 'mongoose';

const schoolCalendarSchema = new Schema(
  {
    date: { type: String, required: true, match: /^\d{4}-\d{2}-\d{2}$/, index: true, unique: true },
    dayName: { type: String, trim: true },
    isWorkingDay: { type: Boolean, default: true, index: true },
    reason: { type: String, trim: true, maxlength: 200 },
    morningTrips: { type: Boolean, default: true },
    afternoonTrips: { type: Boolean, default: true },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User' },
    updatedBy: { type: Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

schoolCalendarSchema.index({ isWorkingDay: 1, date: 1 });

export const SchoolCalendar = model('SchoolCalendar', schoolCalendarSchema);
