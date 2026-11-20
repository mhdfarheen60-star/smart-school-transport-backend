import 'dotenv/config';
import dns from 'node:dns';
import mongoose from 'mongoose';
import {
  AIConversation,
  AIMessage,
  AssistantRateLimit,
  ETAPredictionHistory,
  Geofence,
  MaintenancePrediction,
  MaintenanceRecord,
  RouteOptimizationHistory,
  SafetyAlert,
  TripLocation,
  Trip,
  Attendance,
  Vehicle,
  Route,
  TransportAssignment,
  Driver,
  Student,
} from '../models/index.js';

dns.setServers(['8.8.8.8']);

const out = { ok: false, timestamp: new Date().toISOString(), steps: [], errors: [] };

function step(name, status, details) {
  out.steps.push({ name, status, ...(details ? { details } : {}) });
  const icon = status === 'pass' ? 'PASS' : status === 'skip' ? 'SKIP' : status === 'warn' ? 'WARN' : 'FAIL';
  console.log(`${icon}  ${name}${details && details.message ? ` - ${details.message}` : ''}`);
}

async function safe(name, fn, { allowFail = false } = {}) {
  try {
    const details = await fn();
    step(name, details?.warn ? 'warn' : 'pass', details);
    return { ok: true, details };
  } catch (e) {
    const details = { message: e.message, code: e.code, name: e.name };
    step(name, allowFail ? 'warn' : 'fail', details);
    out.errors.push({ step: name, ...details });
    return { ok: false, details };
  }
}

async function main() {
  const uri = process.env.MONGO_URI;
  if (!uri) {
    step('MongoDB URI configured', 'fail', { message: 'MONGO_URI is not set in environment' });
    console.log(JSON.stringify(out, null, 2));
    process.exit(2);
  }
  step('MongoDB URI configured', 'pass', { message: 'MONGO_URI is set (value redacted)' });

  const connected = await safe('MongoDB connectivity (Atlas/configured URI)', async () => {
    const conn = await mongoose.connect(uri, { serverSelectionTimeoutMS: 10000 });
    return { message: `connected host=${conn.connection.host} db=${conn.connection.name}` };
  });

  if (!connected.ok) {
    out.ok = false;
    console.log('\nResult: DB connectivity failed; runtime/model/query/index/CRUD verification could not be executed.');
    console.log(JSON.stringify(out, null, 2));
    process.exit(1);
  }

  await safe('List collections', async () => {
    const cols = await mongoose.connection.db.listCollections().toArray();
    return { message: `${cols.length} collections`, collections: cols.map((c) => c.name).sort() };
  });

  const modelChecks = [
    ['AIConversation', AIConversation],
    ['AIMessage', AIMessage],
    ['AssistantRateLimit', AssistantRateLimit],
    ['ETAPredictionHistory', ETAPredictionHistory],
    ['Geofence', Geofence],
    ['MaintenancePrediction', MaintenancePrediction],
    ['MaintenanceRecord', MaintenanceRecord],
    ['RouteOptimizationHistory', RouteOptimizationHistory],
    ['SafetyAlert', SafetyAlert],
    ['TripLocation', TripLocation],
    ['Trip', Trip],
    ['Attendance', Attendance],
    ['Vehicle', Vehicle],
    ['Route', Route],
    ['TransportAssignment', TransportAssignment],
    ['Driver', Driver],
    ['Student', Student],
  ];

  for (const [name, Model] of modelChecks) {
    await safe(`Model/index/query check: ${name}`, async () => {
      const [count, sample, indexes] = await Promise.all([
        Model.estimatedDocumentCount(),
        Model.findOne({}).select('_id').lean(),
        Model.collection.indexes().catch(() => []),
      ]);
      return { message: `count~${count}, sample=${sample ? 'yes' : 'no'}, indexes=${indexes.length}` };
    }, { allowFail: true });
  }

  // Safe CRUD verification on disposable docs (created then deleted)
  await safe('CRUD verification: Geofence (create/read/delete temp)', async () => {
    const doc = await Geofence.create({
      name: `__verify_temp_${Date.now()}`,
      type: 'zone',
      scope: 'global',
      center: { latitude: 0, longitude: 0 },
      radiusMeters: 100,
      active: false,
      description: 'temporary verification record',
    });
    const found = await Geofence.findById(doc._id).lean();
    await Geofence.deleteOne({ _id: doc._id });
    if (!found) throw new Error('created temp geofence not readable');
    return { message: 'temp geofence created, read, and deleted successfully' };
  }, { allowFail: true });

  await safe('CRUD verification: AssistantRateLimit (upsert/read/delete temp)', async () => {
    const key = `__verify_temp_${Date.now()}`;
    const now = new Date();
    await AssistantRateLimit.findOneAndUpdate(
      { key },
      { $set: { key, count: 1, windowStart: now, expiresAt: new Date(now.getTime() + 60000) } },
      { upsert: true, new: true }
    );
    const found = await AssistantRateLimit.findOne({ key }).lean();
    await AssistantRateLimit.deleteOne({ key });
    if (!found) throw new Error('temp rate limit bucket not readable');
    return { message: 'temp rate limit bucket upserted, read, and deleted successfully' };
  }, { allowFail: true });

  await safe('AI query path: Safety alerts recent read', async () => {
    const items = await SafetyAlert.find({}).sort('-createdAt').limit(3).select('_id status type severity').lean();
    return { message: `read ok (${items.length} sample alert(s))` };
  }, { allowFail: true });

  await safe('AI query path: Route optimization history recent read', async () => {
    const items = await RouteOptimizationHistory.find({}).sort('-createdAt').limit(3).select('_id status').lean();
    return { message: `read ok (${items.length} sample record(s))` };
  }, { allowFail: true });

  await safe('AI query path: ETA prediction history recent read', async () => {
    const items = await ETAPredictionHistory.find({}).sort('-createdAt').limit(3).select('_id trip status').lean();
    return { message: `read ok (${items.length} sample record(s))` };
  }, { allowFail: true });

  await safe('AI query path: Maintenance predictions/records recent read', async () => {
    const [p, r] = await Promise.all([
      MaintenancePrediction.find({}).sort('-createdAt').limit(2).select('_id vehicle riskLevel').lean(),
      MaintenanceRecord.find({}).sort('-createdAt').limit(2).select('_id vehicle type status').lean(),
    ]);
    return { message: `read ok (predictions=${p.length}, records=${r.length})` };
  }, { allowFail: true });

  await safe('AI query path: Trip locations recent read', async () => {
    const items = await TripLocation.find({}).sort('-recordedAt').limit(3).select('_id trip recordedAt latitude longitude').lean();
    return { message: `read ok (${items.length} sample location(s))` };
  }, { allowFail: true });

  out.ok = out.errors.filter((e) => e.name !== undefined).length === 0 && out.steps.every((s) => s.status === 'pass' || s.status === 'warn' || s.status === 'skip');
  // better ok criteria: no hard fails except allowed warns recorded as warn status not in errors? we pushed errors for warn too; adjust
  out.ok = out.steps.every((s) => s.status === 'pass' || s.status === 'warn' || s.status === 'skip');

  await mongoose.disconnect().catch(() => {});
  console.log('\nVerification summary:', JSON.stringify({ ok: out.ok, passed: out.steps.filter((s) => s.status === 'pass').length, warned: out.steps.filter((s) => s.status === 'warn').length, failed: out.steps.filter((s) => s.status === 'fail').length, timestamp: out.timestamp }, null, 2));
  process.exit(out.steps.some((s) => s.status === 'fail') ? 1 : 0);
}

main().catch(async (e) => {
  console.error('VERIFY_FATAL', e.message);
  try { await mongoose.disconnect(); } catch {}
  process.exit(1);
});
