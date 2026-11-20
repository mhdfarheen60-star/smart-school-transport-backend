import dns from 'node:dns';
import mongoose from 'mongoose';
import { env } from './env.js';

export async function connectDB() {
  dns.setServers(['8.8.8.8', '8.8.4.4']);
  mongoose.set('strictQuery', true);
  await mongoose.connect(env.mongoUri, { serverSelectionTimeoutMS: 10000 });
  console.log(`MongoDB connected: ${mongoose.connection.host}/${mongoose.connection.name}`);
}

export async function disconnectDB() {
  await mongoose.disconnect();
}
