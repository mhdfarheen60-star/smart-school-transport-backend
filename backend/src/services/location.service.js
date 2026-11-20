import { TransportRequest } from '../models/index.js';

export function serializeRequest(r) {
  const plain = typeof r.toObject === 'function' ? r.toObject() : r;
  const point = (address, geo) => ({
    address,
    latitude: geo && geo.latitude,
    longitude: geo && geo.longitude,
    placeId: geo && geo.placeId,
  });
  return {
    ...plain,
    pickup: point(plain.pickupLocation, plain.pickupGeo),
    drop: point(plain.dropLocation, plain.dropGeo),
  };
}

export async function currentLocations(studentIds) {
  const reqs = await TransportRequest.find({ student: { $in: studentIds }, status: 'approved' })
    .sort('-createdAt')
    .lean();
  const out = new Map();
  for (const r of reqs) {
    const key = String(r.student);
    if (out.has(key)) continue;
    const s = serializeRequest(r);
    out.set(key, { requestId: String(r._id), pickup: s.pickup, drop: s.drop });
  }
  return out;
}
