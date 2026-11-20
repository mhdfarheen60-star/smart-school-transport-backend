import { Schema, model } from 'mongoose';

export const VEHICLE_STATUS = ['available', 'unavailable', 'maintenance'];

const vehicleSchema = new Schema(
  {
    registrationNumber: { type: String, required: true, unique: true, uppercase: true, trim: true },
    busNumber: { type: String, required: true, trim: true },
    model: { type: String, trim: true },
    capacity: { type: Number, required: true, min: 1, max: 200 },
    insuranceNumber: { type: String, trim: true },
    insuranceExpiry: { type: Date },
    odometerKm: { type: Number, min: 0 },
    lastServiceDate: { type: Date },
    nextServiceDate: { type: Date },
    lastServiceOdometerKm: { type: Number, min: 0 },
    status: { type: String, enum: VEHICLE_STATUS, default: 'available', index: true },
  },
  { timestamps: true }
);

export const Vehicle = model('Vehicle', vehicleSchema);
