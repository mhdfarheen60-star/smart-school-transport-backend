import { aiConfig } from '../../../config/ai.js';

function toRad(v) {
  return (v * Math.PI) / 180;
}

export function normalizePoint(p) {
  const latitude = Number(p?.latitude ?? p?.lat);
  const longitude = Number(p?.longitude ?? p?.lng ?? p?.lon);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
  if (latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) return null;
  return { latitude, longitude };
}

export function haversineKm(a, b) {
  const p1 = normalizePoint(a);
  const p2 = normalizePoint(b);
  if (!p1 || !p2) return null;
  const R = 6371;
  const dLat = toRad(p2.latitude - p1.latitude);
  const dLon = toRad(p2.longitude - p1.longitude);
  const s1 = Math.sin(dLat / 2) ** 2;
  const s2 = Math.cos(toRad(p1.latitude)) * Math.cos(toRad(p2.latitude)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s1 + s2));
}

export function estimateDurationMinutes(distanceKm, speedKmh = 25) {
  if (!Number.isFinite(distanceKm) || distanceKm < 0) return null;
  return (distanceKm / Math.max(5, speedKmh)) * 60;
}

export function getRoutingProviderInfo() {
  const { routing } = aiConfig;
  const configured =
    routing.provider === 'google'
      ? Boolean(routing.googleMapsApiKey)
      : routing.provider === 'osrm'
      ? Boolean(routing.osrmBaseUrl)
      : false;
  return {
    provider: routing.provider || 'none',
    configured,
    mode: configured ? 'external' : 'fallback',
  };
}

async function fetchJson(url, { timeoutMs = 15000, label = 'routing request' } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal, headers: { Accept: 'application/json' } });
    let body = null;
    try { body = await res.json(); } catch { body = null; }
    if (!res.ok) {
      const err = new Error(`${label} failed (${res.status})`);
      err.status = res.status;
      err.body = body;
      throw err;
    }
    return body;
  } catch (err) {
    if (err?.name === 'AbortError') {
      const e = new Error(`${label} timed out after ${timeoutMs}ms`);
      e.timeout = true;
      throw e;
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

function decodePolyline(encoded) {
  // Google encoded polyline algorithm (precision 5)
  if (typeof encoded !== 'string' || !encoded) return [];
  let index = 0;
  let lat = 0;
  let lng = 0;
  const coordinates = [];
  while (index < encoded.length) {
    let b;
    let shift = 0;
    let result = 0;
    do {
      b = encoded.charCodeAt(index++) - 63;
      result |= (b & 0x1f) << shift;
      shift += 5;
    } while (b >= 0x20);
    const dlat = (result & 1) ? ~(result >> 1) : (result >> 1);
    lat += dlat;

    shift = 0;
    result = 0;
    do {
      b = encoded.charCodeAt(index++) - 63;
      result |= (b & 0x1f) << shift;
      shift += 5;
    } while (b >= 0x20);
    const dlng = (result & 1) ? ~(result >> 1) : (result >> 1);
    lng += dlng;

    coordinates.push({ latitude: lat / 1e5, longitude: lng / 1e5 });
  }
  return coordinates;
}

function buildFallbackMatrix(valid, reason, message) {
  const n = valid.length;
  const distancesMeters = Array.from({ length: n }, () => Array(n).fill(null));
  const durationsSeconds = Array.from({ length: n }, () => Array(n).fill(null));
  for (let i = 0; i < n; i += 1) {
    distancesMeters[i][i] = 0;
    durationsSeconds[i][i] = 0;
    for (let j = 0; j < n; j += 1) {
      if (i === j) continue;
      const km = haversineKm(valid[i], valid[j]);
      if (km == null) continue;
      distancesMeters[i][j] = Number((km * 1000).toFixed(2));
      const mins = estimateDurationMinutes(km, 25);
      durationsSeconds[i][j] = mins == null ? null : Number((mins * 60).toFixed(2));
    }
  }
  return {
    ok: true,
    unavailable: false,
    estimate: true,
    provider: 'haversine',
    mode: 'fallback',
    source: 'haversine_fallback',
    distanceSource: 'haversine',
    durationSource: 'haversine_estimate',
    fallbackReason: reason || null,
    distancesMeters,
    durationsSeconds,
    unreachablePairs: 0,
    message: message || 'Straight-line (Haversine) distance matrix estimate used.',
  };
}

function fallbackMetrics(valid, info, reason, message) {
  let totalKm = 0;
  for (let i = 1; i < valid.length; i += 1) {
    const leg = haversineKm(valid[i - 1], valid[i]);
    if (leg == null) {
      return {
        ok: false,
        unavailable: true,
        reason: 'invalid_coordinates',
        message: 'Invalid coordinates supplied.',
        provider: info.provider,
        mode: 'fallback',
        distanceSource: 'none',
        durationSource: 'none',
        geometrySource: 'none',
        isFallback: true,
        estimated: true,
      };
    }
    totalKm += leg;
  }
  const durationMinutes = estimateDurationMinutes(totalKm, 25);
  return {
    ok: true,
    unavailable: false,
    estimate: true,
    isFallback: true,
    provider: info.provider || 'haversine',
    mode: 'fallback',
    source: 'haversine_fallback',
    distanceSource: 'haversine',
    durationSource: 'haversine_estimate',
    geometrySource: 'none',
    fallbackReason: reason || null,
    distanceKm: Number(totalKm.toFixed(3)),
    durationMinutes: durationMinutes == null ? null : Number(durationMinutes.toFixed(1)),
    geometry: null,
    message: message || 'Deterministic straight-line distance estimate used (routing provider unavailable or failed).',
  };
}

async function getOsrmMetrics(valid, info, { timeoutMs } = {}) {
  const base = String(aiConfig.routing.osrmBaseUrl || '').replace(/\/+$/, '');
  const coords = valid.map((p) => `${p.longitude},${p.latitude}`).join(';');
  const url = `${base}/route/v1/driving/${coords}?overview=full&geometries=geojson&steps=false`;
  const body = await fetchJson(url, { timeoutMs: timeoutMs || aiConfig.routing.timeoutMs || 15000, label: 'OSRM routing request' });
  if (body?.code !== 'Ok' || !Array.isArray(body?.routes) || !body.routes[0]) {
    throw new Error(body?.message || body?.code || 'OSRM returned no route');
  }
  const route = body.routes[0];
  const distanceKm = Number(route.distance) / 1000;
  const durationMinutes = Number(route.duration) / 60;
  const coordsGeo = route.geometry?.coordinates;
  const geometry = Array.isArray(coordsGeo)
    ? coordsGeo.map((c) => ({ latitude: Number(c[1]), longitude: Number(c[0]) })).filter((p) => Number.isFinite(p.latitude) && Number.isFinite(p.longitude))
    : null;
  return {
    ok: true,
    unavailable: false,
    estimate: false,
    isFallback: false,
    provider: info.provider,
    mode: 'external',
    source: 'osrm',
    distanceSource: 'osrm',
    durationSource: 'osrm',
    geometrySource: geometry && geometry.length ? 'osrm' : 'none',
    distanceKm: Number(distanceKm.toFixed(3)),
    durationMinutes: Number(durationMinutes.toFixed(1)),
    geometry: geometry && geometry.length ? geometry : null,
    message: 'Road distance, duration, and route geometry retrieved from OSRM.',
  };
}

async function getGoogleMetrics(valid, info, { timeoutMs } = {}) {
  const origin = `${valid[0].latitude},${valid[0].longitude}`;
  const destination = `${valid[valid.length - 1].latitude},${valid[valid.length - 1].longitude}`;
  const waypoints = valid.slice(1, -1).map((p) => `${p.latitude},${p.longitude}`).join('|');
  const params = new URLSearchParams({ origin, destination, key: aiConfig.routing.googleMapsApiKey, mode: 'driving' });
  if (waypoints) params.set('waypoints', waypoints);
  const url = `https://maps.googleapis.com/maps/api/directions/json?${params.toString()}`;
  const body = await fetchJson(url, { timeoutMs: timeoutMs || aiConfig.routing.timeoutMs || 15000, label: 'Google routing request' });
  if (body?.status !== 'OK' || !Array.isArray(body?.routes) || !body.routes[0]) {
    throw new Error(body?.error_message || body?.status || 'Google Directions returned no route');
  }
  const route = body.routes[0];
  const legs = Array.isArray(route.legs) ? route.legs : [];
  let distanceMeters = 0;
  let durationSeconds = 0;
  for (const leg of legs) {
    distanceMeters += Number(leg?.distance?.value || 0);
    durationSeconds += Number(leg?.duration?.value || 0);
  }
  const geometry = route.overview_polyline?.points ? decodePolyline(route.overview_polyline.points) : null;
  return {
    ok: true,
    unavailable: false,
    estimate: false,
    isFallback: false,
    provider: info.provider,
    mode: 'external',
    source: 'google',
    distanceSource: 'google',
    durationSource: 'google',
    geometrySource: geometry && geometry.length ? 'google' : 'none',
    distanceKm: Number((distanceMeters / 1000).toFixed(3)),
    durationMinutes: Number((durationSeconds / 60).toFixed(1)),
    geometry: geometry && geometry.length ? geometry : null,
    message: 'Road distance, duration, and route geometry retrieved from Google Directions.',
  };
}

export async function getRouteMetrics(points = [], options = {}) {
  const info = getRoutingProviderInfo();
  const valid = points.map(normalizePoint).filter(Boolean);
  if (valid.length < 2) {
    return {
      ok: false,
      unavailable: true,
      reason: 'insufficient_coordinates',
      message: 'At least two valid coordinate points are required to compute route metrics.',
      provider: info.provider,
      mode: info.mode,
      distanceSource: 'none',
      durationSource: 'none',
      geometrySource: 'none',
      isFallback: info.mode !== 'external',
      estimated: true,
    };
  }

  if (info.configured) {
    try {
      if (info.provider === 'osrm') return await getOsrmMetrics(valid, info, options);
      if (info.provider === 'google') return await getGoogleMetrics(valid, info, options);
    } catch (err) {
      const timeout = Boolean(err?.timeout) || /timed out|timeout/i.test(String(err?.message || ''));
      const reason = timeout ? 'timeout' : 'provider_error';
      const detail = String(err?.message || 'routing provider error');
      return fallbackMetrics(
        valid,
        info,
        reason,
        `Routing provider request failed (${timeout ? 'timeout' : 'error'}: ${detail}). Deterministic straight-line distance estimate used as fallback.`
      );
    }
  }

  return fallbackMetrics(
    valid,
    info,
    info.configured ? 'provider_not_supported' : 'not_configured',
    info.configured
      ? 'Configured routing provider is not supported; deterministic straight-line distance estimate used.'
      : 'Routing provider not configured; deterministic straight-line distance estimate used. Configure AI_ROUTING_PROVIDER with OSRM_BASE_URL or GOOGLE_MAPS_API_KEY for actual road distances/geometry.'
  );
}

function maxOsrmTableSize() {
  const raw = Number(process.env.AI_OSRM_TABLE_MAX_COORDS);
  if (Number.isInteger(raw) && raw >= 2 && raw <= 200) return raw;
  // Public OSRM demo commonly limits table size (often ~100). Keep conservative default; configurable via env.
  return 100;
}

async function fetchOsrmTable(base, coords, annotations, timeoutMs) {
  const coordStr = coords.map((p) => `${p.longitude},${p.latitude}`).join(';');
  const url = `${base}/table/v1/driving/${coordStr}?annotations=${annotations}`;
  const body = await fetchJson(url, { timeoutMs, label: 'OSRM table request' });
  if (body?.code !== 'Ok') {
    throw new Error(body?.message || body?.code || 'OSRM table returned no result');
  }
  return body;
}

export async function getRouteMatrix(points = [], options = {}) {
  const info = getRoutingProviderInfo();
  const normalized = points.map(normalizePoint);
  const invalidIndexes = normalized.map((p, i) => (p ? -1 : i)).filter((i) => i >= 0);
  const validIndexes = normalized.map((p, i) => (p ? i : -1)).filter((i) => i >= 0);
  const valid = validIndexes.map((i) => normalized[i]);
  const timeoutMs = options.timeoutMs || aiConfig.routing.timeoutMs || 15000;

  if (valid.length < 2) {
    return {
      ok: false,
      unavailable: true,
      reason: 'insufficient_coordinates',
      message: 'At least two valid coordinate points are required to compute a route matrix.',
      provider: info.provider,
      mode: info.mode,
      isFallback: info.mode !== 'external',
      estimated: true,
      invalidIndexes,
    };
  }

  // OSRM table support (road distances/durations between all points)
  if (info.configured && info.provider === 'osrm') {
    try {
      const base = String(aiConfig.routing.osrmBaseUrl || '').replace(/\/+$/, '');
      const limit = maxOsrmTableSize();
      const annotations = 'duration,distance';
      const n = valid.length;
      let distancesMeters;
      let durationsSeconds;
      let unreachablePairs = 0;

      if (n <= limit) {
        const body = await fetchOsrmTable(base, valid, annotations, timeoutMs);
        distancesMeters = (body.distances || []).map((row) => row.map((v) => (v == null ? null : Number(v))));
        durationsSeconds = (body.durations || []).map((row) => row.map((v) => (v == null ? null : Number(v))));
        // ensure square
        if (distancesMeters.length !== n || durationsSeconds.length !== n) {
          throw new Error('OSRM table response shape mismatch');
        }
        // count unreachable (non-diagonal nulls)
        for (let i = 0; i < n; i += 1) {
          for (let j = 0; j < n; j += 1) {
            if (i !== j && (distancesMeters[i][j] == null || durationsSeconds[i][j] == null)) unreachablePairs += 1;
          }
        }
      } else {
        // Batch to respect OSRM table coordinate limits.
        // Strategy: request source-chunk to destination-chunk blocks with total unique coords <= limit.
        distancesMeters = Array.from({ length: n }, () => Array(n).fill(null));
        durationsSeconds = Array.from({ length: n }, () => Array(n).fill(null));
        const chunk = Math.max(1, Math.floor(limit / 2));
        for (let s = 0; s < n; s += chunk) {
          const srcIdxs = Array.from({ length: Math.min(chunk, n - s) }, (_, k) => s + k);
          for (let d = 0; d < n; d += chunk) {
            const dstIdxs = Array.from({ length: Math.min(chunk, n - d) }, (_, k) => d + k);

            // OSRM table requires >= 2 coordinates; self-only 1x1 blocks are trivial.
            if (srcIdxs.length === 1 && dstIdxs.length === 1 && srcIdxs[0] === dstIdxs[0]) {
              const i = srcIdxs[0];
              distancesMeters[i][i] = 0;
              durationsSeconds[i][i] = 0;
              continue;
            }

            const coordSet = [];
            const idxMap = new Map();
            const add = (i) => {
              if (!idxMap.has(i)) { idxMap.set(i, coordSet.length); coordSet.push(valid[i]); }
              return idxMap.get(i);
            };
            const srcParam = srcIdxs.map(add).join(';');
            const dstParam = dstIdxs.map(add).join(';');

            // Ensure at least 2 coordinates in request when needed by including a dummy distinct coordinate from src/dst union if possible.
            if (coordSet.length < 2) {
              for (const i of [...srcIdxs, ...dstIdxs]) add(i);
            }
            if (coordSet.length < 2) {
              // fallback: should not happen for n>=2, but be safe
              for (let i = 0; i < n && coordSet.length < 2; i += 1) add(i);
            }

            const coordStr = coordSet.map((p) => `${p.longitude},${p.latitude}`).join(';');
            const url = `${base}/table/v1/driving/${coordStr}?sources=${srcParam}&destinations=${dstParam}&annotations=${annotations}`;
            const body = await fetchJson(url, { timeoutMs, label: 'OSRM table request' });
            if (body?.code !== 'Ok') throw new Error(body?.message || body?.code || 'OSRM table returned no result');
            for (let r = 0; r < srcIdxs.length; r += 1) {
              for (let c = 0; c < dstIdxs.length; c += 1) {
                const i = srcIdxs[r];
                const j = dstIdxs[c];
                distancesMeters[i][j] = body.distances?.[r]?.[c] == null ? null : Number(body.distances[r][c]);
                durationsSeconds[i][j] = body.durations?.[r]?.[c] == null ? null : Number(body.durations[r][c]);
              }
            }
          }
        }
        // recompute unreachable count
        unreachablePairs = 0;
        for (let i = 0; i < n; i += 1) {
          for (let j = 0; j < n; j += 1) {
            if (i !== j && (distancesMeters[i][j] == null || durationsSeconds[i][j] == null)) unreachablePairs += 1;
          }
        }
      }

      return {
        ok: true,
        unavailable: false,
        estimate: false,
        isFallback: false,
        provider: info.provider,
        mode: 'external',
        source: 'osrm_table',
        distanceSource: 'osrm',
        durationSource: 'osrm',
        distancesMeters,
        durationsSeconds,
        unreachablePairs,
        invalidIndexes,
        message: 'Road distance/duration matrix retrieved from OSRM table service.',
      };
    } catch (err) {
      const timeout = Boolean(err?.timeout) || /timed out|timeout/i.test(String(err?.message || ''));
      const reason = timeout ? 'timeout' : 'provider_error';
      const detail = String(err?.message || 'routing provider error');
      const fb = buildFallbackMatrix(valid, reason, `OSRM table request failed (${timeout ? 'timeout' : 'error'}: ${detail}). Straight-line estimates used as fallback.`);
      fb.provider = info.provider;
      fb.invalidIndexes = invalidIndexes;
      fb.fallbackFrom = 'osrm';
      return fb;
    }
  }

  // Non-OSRM or unconfigured: deterministic haversine matrix fallback (explicit)
  const fb = buildFallbackMatrix(valid, info.configured ? 'provider_not_supported' : 'not_configured',
    info.configured
      ? 'Configured routing provider does not support road matrix; straight-line estimates used.'
      : 'Routing provider not configured; straight-line distance/time estimates used. Configure OSRM_BASE_URL for road-network matrix.');
  fb.invalidIndexes = invalidIndexes;
  return fb;
}
