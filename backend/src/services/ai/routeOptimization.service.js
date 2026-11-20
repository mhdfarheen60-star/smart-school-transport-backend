import {
  Route,
  RouteOptimizationHistory,
  TransportAssignment,
} from '../../models/index.js';
import { ApiError } from '../../utils/http.js';
import { currentLocations } from '../location.service.js';
import { audit } from '../audit.service.js';
import {
  getRouteMetrics,
  getRouteMatrix,
  getRoutingProviderInfo,
  haversineKm,
  normalizePoint,
} from './providers/routing.js';
import { getOptimizationProviderInfo } from './providers/optimization.js';

function pointFrom(loc) {
  if (!loc) return null;
  const p = normalizePoint(loc);
  if (!p) return null;
  return { ...p, address: loc.address, placeId: loc.placeId };
}

function sameCoord(a, b) {
  const p1 = normalizePoint(a);
  const p2 = normalizePoint(b);
  if (!p1 || !p2) return false;
  return Math.abs(p1.latitude - p2.latitude) < 1e-7 && Math.abs(p1.longitude - p2.longitude) < 1e-7;
}

function parseDepotFromEnv() {
  const lat = Number(process.env.AI_DEPOT_LATITUDE ?? process.env.AI_DEPOT_LAT ?? process.env.SCHOOL_DEPOT_LAT ?? process.env.SCHOOL_LAT);
  const lng = Number(process.env.AI_DEPOT_LONGITUDE ?? process.env.AI_DEPOT_LNG ?? process.env.SCHOOL_DEPOT_LNG ?? process.env.SCHOOL_LNG);
  const p = normalizePoint({ latitude: lat, longitude: lng });
  if (!p) return null;
  const name = (process.env.AI_DEPOT_NAME || process.env.SCHOOL_DEPOT_NAME || 'School / Depot').trim();
  const address = (process.env.AI_DEPOT_ADDRESS || process.env.SCHOOL_DEPOT_ADDRESS || '').trim() || undefined;
  return { ...p, name, address, source: 'env' };
}

function resolveDepot(body) {
  if (body?.depot && normalizePoint(body.depot)) {
    return { ...normalizePoint(body.depot), name: body.depot.name || 'Depot', address: body.depot.address, source: 'request' };
  }
  return parseDepotFromEnv();
}

function resolveEndPoint(body, startPoint) {
  if (body?.end && normalizePoint(body.end)) {
    return { ...normalizePoint(body.end), name: body.end.name || 'Destination', address: body.end.address, source: 'request' };
  }
  if (body?.includeReturnToDepot && startPoint) {
    return { ...startPoint, name: startPoint.name || 'School / Depot', returnToDepot: true, source: startPoint.source || 'derived' };
  }
  return null;
}

function orderStopsByRoute(stops = [], routeStops = []) {
  const byName = new Map((routeStops || []).map((s) => [String(s.name).toLowerCase(), s.sequence]));
  return [...stops].sort((a, b) => {
    const sa = byName.get(String(a.stop || '').toLowerCase()) ?? 9999;
    const sb = byName.get(String(b.stop || '').toLowerCase()) ?? 9999;
    if (sa !== sb) return sa - sb;
    return String(a.name || '').localeCompare(String(b.name || ''));
  });
}

function uniqueById(items) {
  const seen = new Set();
  return items.filter((item) => {
    const id = String(item?._id || item?.id || '');
    if (!id || seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

function legCost(matrix, i, j) {
  if (i == null || j == null || !matrix) return Infinity;
  const t = matrix.durationsSeconds?.[i]?.[j];
  if (Number.isFinite(t)) return t; // optimize by travel time
  const d = matrix.distancesMeters?.[i]?.[j];
  if (Number.isFinite(d)) return d / (25 * 1000 / 3600); // pseudo-seconds at 25 km/h
  return Infinity;
}

function routeCost(order, matrix, startIdx, endIdx) {
  let total = 0;
  let prev = startIdx;
  const seq = order.slice();
  for (let k = 0; k < seq.length; k += 1) {
    const nxt = seq[k];
    const c = legCost(matrix, prev, nxt);
    if (!Number.isFinite(c)) return Infinity;
    total += c;
    prev = nxt;
  }
  if (endIdx != null) {
    const c = legCost(matrix, prev, endIdx);
    if (!Number.isFinite(c)) return Infinity;
    total += c;
  }
  return total;
}

function greedyNearestNeighbor(pickupIdxs, matrix, startIdx) {
  const remaining = pickupIdxs.slice();
  const ordered = [];
  let current = startIdx != null ? startIdx : (remaining[0] ?? null);
  if (startIdx == null && remaining.length) {
    // no explicit start: seed from first in given order
    ordered.push(current);
    remaining.shift();
  }
  while (remaining.length) {
    let bestPos = 0;
    let best = Infinity;
    for (let i = 0; i < remaining.length; i += 1) {
      const c = legCost(matrix, current, remaining[i]);
      if (c < best) {
        best = c;
        bestPos = i;
      }
    }
    if (!Number.isFinite(best)) bestPos = 0; // unreachable from current; keep deterministic order
    const [next] = remaining.splice(bestPos, 1);
    ordered.push(next);
    current = next;
  }
  return ordered;
}

function twoOptImprove(initialOrder, matrix, startIdx, endIdx, maxIterations = 200) {
  if (!Array.isArray(initialOrder) || initialOrder.length < 3) {
    return { order: (initialOrder || []).slice(), improved: false, iterations: 0 };
  }
  let best = initialOrder.slice();
  let bestCost = routeCost(best, matrix, startIdx, endIdx);
  let improved = false;
  let iterations = 0;
  let changed = true;
  while (changed && iterations < maxIterations) {
    changed = false;
    iterations += 1;
    for (let i = 0; i < best.length - 1; i += 1) {
      for (let k = i + 1; k < best.length; k += 1) {
        const candidate = best.slice(0, i).concat(best.slice(i, k + 1).reverse(), best.slice(k + 1));
        const c = routeCost(candidate, matrix, startIdx, endIdx);
        if (c + 1e-6 < bestCost) {
          best = candidate;
          bestCost = c;
          improved = true;
          changed = true;
        }
      }
      if (iterations >= maxIterations) break;
    }
  }
  return { order: best, improved, iterations };
}

function summarizePlan(planSeq, metrics, meta = {}) {
  return {
    stops: Array.isArray(planSeq) ? planSeq.length : 0,
    students: Array.isArray(planSeq) ? planSeq.filter((s) => s && (s.student || s.type === 'pickup')).length : 0,
    distanceKm: metrics?.distanceKm ?? null,
    durationMinutes: metrics?.durationMinutes ?? null,
    estimate: metrics?.estimate ?? metrics?.isFallback ?? false,
    isFallback: Boolean(metrics?.isFallback ?? metrics?.estimate ?? (metrics?.mode === 'fallback')),
    mode: metrics?.mode || (metrics?.isFallback ? 'fallback' : null),
    source: metrics?.source || metrics?.distanceSource || null,
    provider: metrics?.provider || metrics?.routingProvider || null,
    distanceSource: metrics?.distanceSource || (metrics?.source === 'osrm' ? 'osrm' : metrics?.source === 'google' ? 'google' : metrics?.source === 'haversine_fallback' ? 'haversine' : metrics?.source || null),
    durationSource: metrics?.durationSource || (metrics?.source === 'osrm' ? 'osrm' : metrics?.source === 'google' ? 'google' : metrics?.source === 'haversine_fallback' ? 'haversine_estimate' : metrics?.source || null),
    geometrySource: metrics?.geometrySource || (metrics?.geometry?.length ? (metrics?.source || 'unknown') : 'none'),
    geometryAvailable: Boolean(metrics?.geometry && metrics.geometry.length),
    message: metrics?.message || null,
    ...meta,
  };
}

function routeMetricsResponse(metrics) {
  if (!metrics) return null;
  return {
    ok: metrics.ok,
    unavailable: metrics.unavailable,
    reason: metrics.reason,
    distanceKm: metrics.distanceKm ?? null,
    durationMinutes: metrics.durationMinutes ?? null,
    estimate: metrics.estimate ?? metrics.isFallback ?? false,
    isFallback: Boolean(metrics.isFallback ?? metrics.estimate ?? metrics.mode === 'fallback'),
    mode: metrics.mode || null,
    provider: metrics.provider || null,
    source: metrics.source || null,
    distanceSource: metrics.distanceSource || metrics.source || null,
    durationSource: metrics.durationSource || metrics.source || null,
    geometrySource: metrics.geometrySource || (metrics.geometry?.length ? (metrics.source || 'unknown') : 'none'),
    geometry: metrics.geometry || null,
    message: metrics.message || null,
    fallbackReason: metrics.fallbackReason || null,
  };
}

async function buildAssignmentContext(assignmentId, routeId) {
  let assignment = null;
  if (assignmentId) {
    assignment = await TransportAssignment.findById(assignmentId)
      .populate('vehicle', 'registrationNumber busNumber capacity status model')
      .populate('driver', 'name phone licenseNumber status user')
      .populate('route', 'name stops status description')
      .populate('riders.student', 'name studentId className division address phone user status')
      .lean();
    if (!assignment) throw new ApiError(404, 'Assignment not found');
  } else if (routeId) {
    assignment = await TransportAssignment.findOne({ route: routeId, status: 'active' })
      .populate('vehicle', 'registrationNumber busNumber capacity status model')
      .populate('driver', 'name phone licenseNumber status user')
      .populate('route', 'name stops status description')
      .populate('riders.student', 'name studentId className division address phone user status')
      .lean();
    if (!assignment) throw new ApiError(404, 'No active assignment found for this route');
  }

  if (!assignment?.route) throw new ApiError(404, 'Route not found for assignment');
  if (!assignment?.vehicle) throw new ApiError(404, 'Vehicle not found for assignment');
  if (!assignment?.driver) throw new ApiError(404, 'Driver not found for assignment');
  return assignment;
}

export async function createOptimization(req, body = {}) {
  const assignment = await buildAssignmentContext(body.assignmentId, body.routeId);
  const { route, vehicle, driver } = assignment;
  const riders = (assignment.riders || [])
    .map((r) => (r.student && r.student._id ? r.student : null))
    .filter(Boolean);

  const uniqueStudents = uniqueById(riders);
  const studentIds = uniqueStudents.map((s) => s._id);
  const locs = studentIds.length ? await currentLocations(studentIds) : new Map();

  const pickupStudents = uniqueStudents
    .map((s) => {
      const loc = locs.get(String(s._id)) || null;
      const pickup = pointFrom(loc?.pickup || loc?.pickupGeo);
      const drop = pointFrom(loc?.drop || loc?.dropGeo);
      const riderMeta = (assignment.riders || []).find((r) => String(r.student?._id || r.student) === String(s._id));
      return {
        _id: String(s._id),
        name: s.name,
        studentId: s.studentId,
        className: s.className,
        division: s.division,
        status: s.status,
        pickup,
        drop,
        stop: riderMeta?.stop || null,
        requestId: loc?.requestId || null,
        hasPickupCoordinates: Boolean(pickup),
        hasDropCoordinates: Boolean(drop),
      };
    })
    .filter((s) => s.status !== 'inactive');

  const availableForOptimization = pickupStudents.filter((s) => s.pickup);
  const missingCoordinates = pickupStudents.filter((s) => !s.pickup);

  const depot = resolveDepot(body);
  const endPoint = resolveEndPoint(body, depot);
  const includeReturnToDepot = Boolean(body?.includeReturnToDepot && depot && endPoint && sameCoord(depot, endPoint));

  // Baseline/original pickup order follows route stop order when possible
  const originalOrderedPickups = orderStopsByRoute(availableForOptimization.map((s) => ({ ...s })), route.stops || []);

  const routingInfo = getRoutingProviderInfo();
  const matrixPoints = [];
  const indexMap = { start: null, end: null, pickups: [] };
  if (depot) {
    indexMap.start = matrixPoints.length;
    matrixPoints.push({ ...normalizePoint(depot), label: depot.name || 'Depot', kind: 'depot' });
  }
  originalOrderedPickups.forEach((s, i) => {
    indexMap.pickups[i] = matrixPoints.length;
    matrixPoints.push({ ...normalizePoint(s.pickup), label: s.name, kind: 'pickup', studentId: s._id });
  });
  let endIndex = null;
  if (endPoint) {
    if (indexMap.start != null && sameCoord(endPoint, matrixPoints[indexMap.start])) {
      endIndex = indexMap.start;
    } else {
      endIndex = matrixPoints.length;
      matrixPoints.push({ ...normalizePoint(endPoint), label: endPoint.name || 'Destination', kind: endPoint.returnToDepot ? 'depot_return' : 'destination' });
    }
    indexMap.end = endIndex;
  }

  let matrixResult = null;
  let roadOptimizationUsed = false;
  let optimizationMethod = 'haversine_nearest_neighbor';
  let optimizationStatus = 'completed';
  const optimizationNotes = [];
  let twoOpt = { improved: false, iterations: 0 };
  const unreachableIssues = [];

  const pickupMatrixIdxsInOriginal = originalOrderedPickups.map((_, i) => indexMap.pickups[i]);
  let optimizedPickupOrderIdxs = pickupMatrixIdxsInOriginal.slice();

  const canUseRoadOptimization = routingInfo.configured && routingInfo.provider === 'osrm' && matrixPoints.length >= 2 && pickupMatrixIdxsInOriginal.length >= 2;

  if (canUseRoadOptimization) {
    matrixResult = await getRouteMatrix(matrixPoints);
    const usableRoadMatrix = matrixResult?.ok && matrixResult?.isFallback === false && matrixResult?.distanceSource === 'osrm' && matrixResult?.durationSource === 'osrm';
    if (usableRoadMatrix) {
      const startIdx = indexMap.start;
      const greedy = greedyNearestNeighbor(pickupMatrixIdxsInOriginal.slice(), matrixResult, startIdx);
      twoOpt = twoOptImprove(greedy, matrixResult, startIdx, indexMap.end);
      optimizedPickupOrderIdxs = twoOpt.order;
      roadOptimizationUsed = true;
      optimizationMethod = twoOpt.improved ? 'osrm_table_greedy_nearest_neighbor+2opt' : 'osrm_table_greedy_nearest_neighbor';
      if ((matrixResult.unreachablePairs || 0) > 0) {
        optimizationNotes.push(`OSRM matrix reported ${matrixResult.unreachablePairs} unreachable/non-routed pair(s); affected legs may be infeasible or degraded.`);
        unreachableIssues.push({ type: 'unreachable_pairs', count: matrixResult.unreachablePairs });
      }
      if (Array.isArray(matrixResult.invalidIndexes) && matrixResult.invalidIndexes.length) {
        optimizationNotes.push(`Ignored ${matrixResult.invalidIndexes.length} invalid coordinate(s) in matrix input.`);
      }
    } else {
      optimizationNotes.push(matrixResult?.message || 'Road distance/duration matrix unavailable; using straight-line fallback optimization.');
      optimizationStatus = 'fallback';
      const remaining = originalOrderedPickups.map((s, i) => ({ s, idx: indexMap.pickups[i] }));
      const ordered = [];
      let currentPoint = indexMap.start != null ? matrixPoints[indexMap.start] : null;
      while (remaining.length) {
        let best = 0; let bestScore = Infinity;
        for (let i = 0; i < remaining.length; i += 1) {
          const score = currentPoint ? haversineKm(currentPoint, remaining[i].s.pickup) : 0;
          if ((score ?? Infinity) < bestScore) { bestScore = score ?? Infinity; best = i; }
        }
        const [next] = remaining.splice(best, 1);
        ordered.push(next.idx);
        currentPoint = next.s.pickup;
      }
      optimizedPickupOrderIdxs = ordered;
      optimizationMethod = 'haversine_nearest_neighbor_fallback';
    }
  } else if (pickupMatrixIdxsInOriginal.length >= 2) {
    // Fallback sequencing (no OSRM road matrix used)
    const remaining = originalOrderedPickups.map((s, i) => ({ s, idx: indexMap.pickups[i] }));
    const ordered = [];
    let currentPoint = indexMap.start != null ? matrixPoints[indexMap.start] : null;
    while (remaining.length) {
      let best = 0; let bestScore = Infinity;
      for (let i = 0; i < remaining.length; i += 1) {
        const score = currentPoint ? haversineKm(currentPoint, remaining[i].s.pickup) : 0;
        if ((score ?? Infinity) < bestScore) { bestScore = score ?? Infinity; best = i; }
      }
      const [next] = remaining.splice(best, 1);
      ordered.push(next.idx);
      currentPoint = next.s.pickup;
    }
    optimizedPickupOrderIdxs = ordered;
    optimizationMethod = (routingInfo.configured && routingInfo.provider === 'osrm') ? 'haversine_nearest_neighbor_fallback' : 'haversine_nearest_neighbor';
    optimizationStatus = 'fallback';
    optimizationNotes.push(routingInfo.configured
      ? 'Road-network matrix optimization was not applied (insufficient points/provider constraints); straight-line sequencing fallback used.'
      : 'Routing provider not configured; straight-line (Haversine) sequencing used as fallback.');
  } else {
    optimizedPickupOrderIdxs = pickupMatrixIdxsInOriginal.slice();
    optimizationMethod = 'preserve_current_order';
    optimizationStatus = pickupMatrixIdxsInOriginal.length < 2 ? 'insufficient_data' : optimizationStatus;
    optimizationNotes.push('Not enough geocoded pickup locations to compute an optimized sequence.');
  }

  const optimizedPickups = optimizedPickupOrderIdxs.map((mIdx, i) => {
    const origIndex = indexMap.pickups.indexOf(mIdx);
    const s = originalOrderedPickups[origIndex];
    return { ...s, suggestedSequence: i + 1 };
  });
  const originalWithSequence = originalOrderedPickups.map((s, idx) => ({ ...s, originalSequence: idx + 1 }));

  // Full route point sequences for final metrics/geometry (exact stop order including depot/end legs)
  const toPointSeq = (pickupSeq) => {
    const pts = [];
    if (depot) pts.push({ ...normalizePoint(depot), __kind: 'depot', __label: depot.name || 'Depot' });
    pickupSeq.forEach((s) => pts.push({ ...normalizePoint(s.pickup), __kind: 'pickup', __studentId: s._id }));
    if (endPoint) pts.push({ ...normalizePoint(endPoint), __kind: endPoint.returnToDepot ? 'depot_return' : 'destination', __label: endPoint.name || 'Destination' });
    return pts;
  };

  const originalRoutePoints = toPointSeq(originalWithSequence);
  const optimizedRoutePoints = toPointSeq(optimizedPickups);

  // Request final route metrics/geometry for exact sequences
  const [originalMetricsRaw, optimizedMetricsRaw] = await Promise.all([
    getRouteMetrics(originalRoutePoints),
    getRouteMetrics(optimizedRoutePoints),
  ]);

  const distanceSource = optimizedMetricsRaw?.distanceSource || originalMetricsRaw?.distanceSource || optimizedMetricsRaw?.source || originalMetricsRaw?.source || (optimizedMetricsRaw?.isFallback ? 'haversine' : 'none');
  const durationSource = optimizedMetricsRaw?.durationSource || originalMetricsRaw?.durationSource || optimizedMetricsRaw?.source || originalMetricsRaw?.source || (optimizedMetricsRaw?.isFallback ? 'haversine_estimate' : 'none');
  const geometrySource = optimizedMetricsRaw?.geometrySource || originalMetricsRaw?.geometrySource || (optimizedMetricsRaw?.geometry?.length ? (optimizedMetricsRaw?.source || 'unknown') : 'none');
  const routingProvider = optimizedMetricsRaw?.provider || originalMetricsRaw?.provider || routingInfo.provider || 'none';
  const isFallback = Boolean((optimizedMetricsRaw?.isFallback ?? optimizedMetricsRaw?.estimate ?? optimizedMetricsRaw?.mode !== 'external') && (originalMetricsRaw?.isFallback ?? originalMetricsRaw?.estimate ?? originalMetricsRaw?.mode !== 'external'));
  const estimated = Boolean((optimizedMetricsRaw?.estimate ?? optimizedMetricsRaw?.isFallback) || (originalMetricsRaw?.estimate ?? originalMetricsRaw?.isFallback));
  const actualRoadUsedForMetrics = Boolean(optimizedMetricsRaw?.mode === 'external' || originalMetricsRaw?.mode === 'external') && (distanceSource === 'osrm' || distanceSource === 'google');

  if (roadOptimizationUsed && !actualRoadUsedForMetrics) {
    optimizationNotes.push('Pickup sequencing used OSRM road matrix, but final route metrics/geometry were not retrieved from the road provider; fallback estimates may be shown.');
  }

  const capacityOk = (vehicle.capacity || 0) >= pickupStudents.length;
  const constraints = {
    vehicleAvailable: vehicle.status === 'available',
    driverActive: driver.status === 'active',
    routeActive: route.status === 'active',
    capacityOk,
    hasCoordinateData: availableForOptimization.length > 0,
  };

  const pickupSequence = optimizedPickups.map((s, idx) => ({
    sequence: idx + 1,
    type: 'pickup',
    student: { _id: s._id, name: s.name, studentId: s.studentId },
    stop: s.stop,
    pickup: s.pickup,
    requestId: s.requestId,
  }));

  const fullOptimizedSequence = [];
  if (depot) fullOptimizedSequence.push({ sequence: fullOptimizedSequence.length + 1, type: 'depot_start', name: depot.name || 'School / Depot', point: normalizePoint(depot), address: depot.address || null });
  pickupSequence.forEach((p) => fullOptimizedSequence.push({ ...p, sequence: fullOptimizedSequence.length + 1 }));
  if (endPoint) fullOptimizedSequence.push({ sequence: fullOptimizedSequence.length + 1, type: includeReturnToDepot ? 'depot_return' : 'destination', name: endPoint.name || (includeReturnToDepot ? 'Return to School / Depot' : 'Destination'), point: normalizePoint(endPoint), address: endPoint.address || null });

  const fullOriginalSequence = [];
  if (depot) fullOriginalSequence.push({ sequence: fullOriginalSequence.length + 1, type: 'depot_start', name: depot.name || 'School / Depot', point: normalizePoint(depot), address: depot.address || null });
  originalWithSequence.forEach((s) => fullOriginalSequence.push({ sequence: fullOriginalSequence.length + 1, type: 'pickup', student: { _id: s._id, name: s.name, studentId: s.studentId }, stop: s.stop, pickup: s.pickup }));
  if (endPoint) fullOriginalSequence.push({ sequence: fullOriginalSequence.length + 1, type: includeReturnToDepot ? 'depot_return' : 'destination', name: endPoint.name || (includeReturnToDepot ? 'Return to School / Depot' : 'Destination'), point: normalizePoint(endPoint), address: endPoint.address || null });

  const comparison = {
    original: summarizePlan(fullOriginalSequence, originalMetricsRaw, { pickupCount: originalWithSequence.length }),
    optimized: summarizePlan(fullOptimizedSequence, optimizedMetricsRaw, { pickupCount: pickupSequence.length }),
    delta: {
      distanceKm:
        Number.isFinite(originalMetricsRaw?.distanceKm) && Number.isFinite(optimizedMetricsRaw?.distanceKm)
          ? Number((originalMetricsRaw.distanceKm - optimizedMetricsRaw.distanceKm).toFixed(3))
          : null,
      durationMinutes:
        Number.isFinite(originalMetricsRaw?.durationMinutes) && Number.isFinite(optimizedMetricsRaw?.durationMinutes)
          ? Number((originalMetricsRaw.durationMinutes - optimizedMetricsRaw.durationMinutes).toFixed(1))
          : null,
    },
    routing: {
      provider: routingProvider,
      mode: optimizedMetricsRaw?.mode || originalMetricsRaw?.mode || routingInfo.mode || 'fallback',
      source: optimizedMetricsRaw?.source || originalMetricsRaw?.source || null,
      distanceSource,
      durationSource,
      geometrySource,
      actualRoadData: Boolean(actualRoadUsedForMetrics),
      roadOptimizationUsed,
      matrixSource: matrixResult?.distanceSource || matrixResult?.source || null,
    },
    depot: depot ? { ...normalizePoint(depot), name: depot.name, address: depot.address || null, source: depot.source || null } : null,
    endPoint: endPoint ? { ...normalizePoint(endPoint), name: endPoint.name, address: endPoint.address || null, returnToDepot: includeReturnToDepot } : null,
    includesDepotStart: Boolean(depot),
    includesReturnToDepot: Boolean(includeReturnToDepot),
    studentsConsidered: pickupStudents.length,
    studentsOptimized: availableForOptimization.length,
    missingCoordinateStudents: missingCoordinates.map((s) => ({ _id: s._id, name: s.name, studentId: s.studentId })),
    invalidCoordinates: [],
    unreachable: unreachableIssues,
  };

  const recommendations = [];
  if (availableForOptimization.length < 2) {
    recommendations.push('Not enough geocoded student pickup locations to compute an optimized sequence. Collect pickup coordinates for riders to improve results.');
  } else {
    const distDelta = comparison.delta.distanceKm;
    const timeDelta = comparison.delta.durationMinutes;
    if (roadOptimizationUsed) {
      recommendations.push(`Pickup sequencing optimized using OSRM road distance/duration matrix (greedy nearest-neighbor${twoOpt.improved ? ' + 2-opt local search' : ''}) by travel time.`);
      if (Number.isFinite(timeDelta) && timeDelta > 0.5) recommendations.push(`Suggested route reduces estimated road travel time by about ${timeDelta.toFixed(1)} min compared to the baseline order.`);
      else if (Number.isFinite(distDelta) && distDelta > 0.05) recommendations.push(`Suggested route reduces estimated road distance by about ${distDelta.toFixed(3)} km compared to the baseline order.`);
      else recommendations.push('Current/baseline pickup order is close to the road-network optimized result for the available data.');
      if (!actualRoadUsedForMetrics) recommendations.push('Final route geometry/metrics could not be retrieved from the road routing API; fallback estimates may be shown.');
    } else {
      if (Number.isFinite(distDelta) && distDelta > 0.05) recommendations.push(`Suggested pickup order reduces estimated straight-line distance by about ${distDelta.toFixed(3)} km (fallback).`);
      else recommendations.push('Current/baseline pickup order is close to the fallback straight-line estimate for available coordinates.');
      if (routingInfo.configured) recommendations.push('Road-network matrix optimization was not applied for this run; results use straight-line fallback sequencing/estimates. Verify provider availability, coordinate count/limits, and reachability.');
      else recommendations.push('Routing provider not configured; distances/durations/geometry may be straight-line fallbacks. Configure AI_ROUTING_PROVIDER with OSRM_BASE_URL for actual road metrics and geometry.');
    }
  }
  if (actualRoadUsedForMetrics && optimizedMetricsRaw?.geometry?.length) {
    recommendations.push('Actual road route geometry for the optimized stop order was retrieved and stored for map visualization.');
  } else if (optimizedRoutePoints.length >= 2) {
    recommendations.push('Road route geometry was not retrieved from the routing provider for this result; map display may show markers only or an unavailable path.');
  }
  if (depot) {
    recommendations.push(`Depot/start included in route calculations: ${depot.name || 'Depot'}${depot.address ? ` (${depot.address})` : ''}.`);
    if (includeReturnToDepot) recommendations.push('Return-to-depot leg included in route metrics.');
    else if (!endPoint) recommendations.push('No return/final destination leg included (end point not specified).');
  } else {
    recommendations.push('No school/depot coordinates configured or provided; depot/start and return legs were not included. Provide depot coordinates (request or AI_DEPOT_LAT/AI_DEPOT_LNG env) to include complete depot legs.');
  }
  if (!capacityOk) recommendations.push(`Vehicle capacity (${vehicle.capacity}) is lower than assigned students (${pickupStudents.length}). Reassign riders or use a higher-capacity bus.`);
  if (missingCoordinates.length) recommendations.push(`${missingCoordinates.length} rider(s) are missing pickup coordinates and were excluded from road-distance optimization.`);
  if (vehicle.status !== 'available') recommendations.push(`Vehicle status is ${vehicle.status}; resolve availability before applying operational changes.`);
  if (driver.status !== 'active') recommendations.push('Assigned driver is inactive; assign an active driver before applying changes.');
  if (route.status !== 'active') recommendations.push('Route is inactive; review route status before applying changes.');
  if (unreachableIssues.length) recommendations.push('Some point pairs were unreachable in the road network matrix; review coordinates and road access.');
  recommendations.push(...optimizationNotes);

  const metadata = {
    routingProvider,
    distanceSource,
    durationSource,
    geometrySource,
    optimizationMethod,
    isFallback,
    estimated,
    optimizationStatus: optimizationStatus || (roadOptimizationUsed ? 'completed' : 'fallback'),
    roadOptimizationUsed,
    actualRoadMetricsUsed: actualRoadUsedForMetrics,
    matrix: matrixResult ? {
      ok: matrixResult.ok,
      provider: matrixResult.provider,
      mode: matrixResult.mode,
      source: matrixResult.source,
      distanceSource: matrixResult.distanceSource,
      durationSource: matrixResult.durationSource,
      isFallback: matrixResult.isFallback,
      unreachablePairs: matrixResult.unreachablePairs || 0,
      invalidIndexes: matrixResult.invalidIndexes || [],
      message: matrixResult.message || null,
    } : null,
    twoOpt: { improved: Boolean(twoOpt.improved), iterations: twoOpt.iterations || 0 },
    algorithm: {
      name: optimizationMethod,
      type: roadOptimizationUsed ? 'road_matrix_greedy_2opt' : (optimizationMethod.includes('haversine') ? 'haversine_greedy' : 'preserve_order'),
      objective: 'minimize_travel_time',
      globallyOptimal: false,
      limitations: [
        'Greedy nearest-neighbor with 2-opt local search is a heuristic and does not guarantee a globally optimal solution.',
        roadOptimizationUsed ? 'Optimization uses OSRM road distance/duration matrix when available.' : 'Road matrix unavailable for this run; straight-line fallback was used.',
        'Vehicle capacity and assignment constraints are respected as existing operational constraints; multi-vehicle VRP splitting is not performed.',
      ],
    },
  };

  const input = {
    assignmentId: String(assignment._id),
    routeId: String(route._id),
    vehicleId: String(vehicle._id),
    driverId: String(driver._id),
    requestedBy: req.user?.id,
    strategy: body.strategy || (roadOptimizationUsed ? 'road_time_2opt' : 'nearest_neighbor'),
    includeDropoff: Boolean(body.includeDropoff),
    includeReturnToDepot: Boolean(body.includeReturnToDepot),
    depot: depot ? { latitude: depot.latitude, longitude: depot.longitude, name: depot.name, source: depot.source } : null,
    end: endPoint ? { latitude: endPoint.latitude, longitude: endPoint.longitude, name: endPoint.name, returnToDepot: includeReturnToDepot } : null,
    generatedAt: new Date().toISOString(),
  };

  const originalPlan = {
    assignment: { _id: assignment._id, status: assignment.status },
    route: { _id: route._id, name: route.name, status: route.status, stops: route.stops || [] },
    vehicle: { _id: vehicle._id, busNumber: vehicle.busNumber, registrationNumber: vehicle.registrationNumber, capacity: vehicle.capacity, status: vehicle.status },
    driver: { _id: driver._id, name: driver.name, phone: driver.phone, status: driver.status },
    riders: pickupStudents.map((s) => ({ _id: s._id, name: s.name, studentId: s.studentId, stop: s.stop, pickup: s.pickup })),
    depot: comparison.depot,
    endPoint: comparison.endPoint,
    pickupSequence: originalWithSequence.map((s, idx) => ({ sequence: idx + 1, type: 'pickup', student: { _id: s._id, name: s.name, studentId: s.studentId }, stop: s.stop, pickup: s.pickup })),
    fullSequence: fullOriginalSequence,
    metrics: routeMetricsResponse(originalMetricsRaw),
    geometry: originalMetricsRaw?.geometry || null,
  };

  const optimizedPlan = {
    strategy: metadata.optimizationMethod,
    requestedStrategy: body.strategy || null,
    pickupSequence,
    fullSequence: fullOptimizedSequence,
    depot: comparison.depot,
    endPoint: comparison.endPoint,
    excludedFromOptimization: missingCoordinates.map((s) => ({ student: { _id: s._id, name: s.name, studentId: s.studentId }, reason: 'missing_pickup_coordinates' })),
    constraints,
    metrics: routeMetricsResponse(optimizedMetricsRaw),
    geometry: optimizedMetricsRaw?.geometry || null,
    canApplyAutomatically: false,
    applicationNote: 'Approval stores this suggestion for administrator review. Active routes/assignments are never replaced automatically.',
  };

  const provider = getOptimizationProviderInfo();
  const record = await RouteOptimizationHistory.create({
    createdBy: req.user?.id,
    status: 'suggested',
    scope: {
      route: route._id,
      vehicle: vehicle._id,
      driver: driver._id,
      assignment: assignment._id,
    },
    input: { ...input, metadata },
    originalPlan,
    optimizedPlan: { ...optimizedPlan, metadata },
    comparison: { ...comparison, metadata },
    recommendations,
    provider: metadata.routingProvider || provider.provider,
    mode: roadOptimizationUsed ? 'external' : (isFallback ? 'fallback' : 'deterministic'),
  });

  await audit(req, 'ai_route_optimize', 'RouteOptimizationHistory', record._id, {
    route: route.name,
    assignment: String(assignment._id),
    students: pickupStudents.length,
    optimizationMethod: metadata.optimizationMethod,
    roadOptimizationUsed: metadata.roadOptimizationUsed,
  });

  return record.toObject();
}

export async function listSuggestions(query) {
  const filter = { status: 'suggested' };
  if (query.route) filter['scope.route'] = query.route;
  if (query.assignment) filter['scope.assignment'] = query.assignment;
  return paginateHistory(filter, query);
}

export async function listHistory(query) {
  const filter = {};
  if (query.status) filter.status = query.status;
  if (query.route) filter['scope.route'] = query.route;
  if (query.assignment) filter['scope.assignment'] = query.assignment;
  return paginateHistory(filter, query);
}

async function paginateHistory(filter, query) {
  const page = Math.max(1, parseInt(String(query.page || '1'), 10) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(String(query.limit || '10'), 10) || 10));
  const [items, total] = await Promise.all([
    RouteOptimizationHistory.find(filter)
      .sort('-createdAt')
      .skip((page - 1) * limit)
      .limit(limit)
      .populate('createdBy', 'name email role')
      .populate('approvedBy', 'name email role')
      .populate('scope.route', 'name stops status')
      .populate('scope.vehicle', 'busNumber registrationNumber capacity status')
      .populate('scope.driver', 'name phone status')
      .populate('scope.assignment', 'status startDate')
      .lean(),
    RouteOptimizationHistory.countDocuments(filter),
  ]);
  return { items, meta: { page, limit, total, pages: Math.max(1, Math.ceil(total / limit)) } };
}

export async function getComparison(id) {
  const record = await RouteOptimizationHistory.findById(id)
    .populate('createdBy', 'name email role')
    .populate('approvedBy', 'name email role')
    .populate('scope.route', 'name stops status')
    .populate('scope.vehicle', 'busNumber registrationNumber capacity status')
    .populate('scope.driver', 'name phone status')
    .populate('scope.assignment', 'status startDate')
    .lean();
  if (!record) throw new ApiError(404, 'Optimization suggestion not found');
  return {
    _id: record._id,
    status: record.status,
    scope: record.scope,
    comparison: record.comparison,
    originalPlan: record.originalPlan,
    optimizedPlan: record.optimizedPlan,
    recommendations: record.recommendations || [],
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    createdBy: record.createdBy,
    approvedBy: record.approvedBy,
    approvedAt: record.approvedAt,
    notes: record.notes,
    provider: record.provider,
    mode: record.mode,
    metadata: record.input?.metadata || record.optimizedPlan?.metadata || record.comparison?.metadata || null,
  };
}

export async function reviewSuggestion(req, id, decision, notes) {
  const record = await RouteOptimizationHistory.findById(id);
  if (!record) throw new ApiError(404, 'Optimization suggestion not found');
  if (!['suggested', 'approved', 'rejected'].includes(record.status)) {
    throw new ApiError(409, `Suggestion cannot be ${decision} from status ${record.status}`);
  }
  record.status = decision;
  record.notes = notes;
  if (decision === 'approved') {
    record.approvedBy = req.user?.id;
    record.approvedAt = new Date();
  } else {
    record.approvedBy = undefined;
    record.approvedAt = undefined;
  }
  await record.save();
  await audit(req, decision === 'approved' ? 'ai_route_approve' : 'ai_route_reject', 'RouteOptimizationHistory', record._id, { notes });
  return getComparison(record._id);
}
