import { MaintenancePrediction, MaintenanceRecord, Trip, Vehicle, VehicleProblemReport } from '../../models/index.js';
import { ApiError } from '../../utils/http.js';
import { audit } from '../audit.service.js';

function daysBetween(a, b = new Date()) {
  if (!a) return null;
  const d = (new Date(b).getTime() - new Date(a).getTime()) / (1000 * 60 * 60 * 24);
  return Number.isFinite(d) ? d : null;
}

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

function priorityWeight(p) {
  return p === 'high' ? 3 : p === 'medium' ? 2 : 1;
}

async function gatherVehicleEvidence(vehicleId) {
  const [vehicle, openProblems, recentProblems, records, tripsCount, completedTrips] = await Promise.all([
    Vehicle.findById(vehicleId).lean(),
    VehicleProblemReport.find({ vehicle: vehicleId, status: { $in: ['reported', 'in_review'] } }).sort('-createdAt').lean(),
    VehicleProblemReport.find({ vehicle: vehicleId, createdAt: { $gte: new Date(Date.now() - 90 * 24 * 60 * 60 * 1000) } }).sort('-createdAt').lean(),
    MaintenanceRecord.find({ vehicle: vehicleId }).sort('-serviceDate -dueDate -createdAt').lean(),
    Trip.countDocuments({ vehicle: vehicleId }),
    Trip.countDocuments({ vehicle: vehicleId, status: 'completed' }),
  ]);
  if (!vehicle) throw new ApiError(404, 'Vehicle not found');
  return { vehicle, openProblems, recentProblems, records, tripsCount, completedTrips };
}

function computeInsights(evidence) {
  const { vehicle, openProblems, recentProblems, records, tripsCount, completedTrips } = evidence;
  const now = new Date();
  const recommendations = [];
  const reasons = [];
  let riskScore = 0;

  const lastCompletedService = records.find((r) => r.type === 'service' && r.status === 'completed' && r.serviceDate);
  const lastInspection = records.find((r) => r.type === 'inspection' && r.status === 'completed' && r.serviceDate);
  const overdueRecords = records.filter((r) => r.status === 'overdue' || (r.status === 'scheduled' && r.dueDate && new Date(r.dueDate) < now));
  const upcomingDue = records
    .filter((r) => r.status === 'scheduled' && r.dueDate && new Date(r.dueDate) >= now && daysBetween(now, r.dueDate) <= 14)
    .sort((a, b) => new Date(a.dueDate) - new Date(b.dueDate));

  const highOpen = openProblems.filter((p) => p.severity === 'high');
  const mechanicalOpen = openProblems.filter((p) => ['breakdown', 'mechanical_issue', 'accident'].includes(p.type));
  const recurringTypes = recentProblems.reduce((acc, p) => {
    acc[p.type] = (acc[p.type] || 0) + 1;
    return acc;
  }, {});
  const recurringIssues = Object.entries(recurringTypes).filter(([, c]) => c >= 2);

  const vehicleOdometerKm = vehicle?.odometerKm != null && Number.isFinite(Number(vehicle.odometerKm)) ? Number(vehicle.odometerKm) : null;
  const lastServiceOdometerKm = vehicle?.lastServiceOdometerKm != null && Number.isFinite(Number(vehicle.lastServiceOdometerKm)) ? Number(vehicle.lastServiceOdometerKm) : null;
  const latestRecordOdometer = records.map((r) => (r.odometerKm != null && Number.isFinite(Number(r.odometerKm)) ? Number(r.odometerKm) : null)).find((v) => v != null) ?? null;
  const effectiveOdometerKm = vehicleOdometerKm ?? latestRecordOdometer;
  const kmSinceService = (effectiveOdometerKm != null && lastServiceOdometerKm != null && effectiveOdometerKm >= lastServiceOdometerKm)
    ? Number((effectiveOdometerKm - lastServiceOdometerKm).toFixed(1))
    : null;

  if (vehicle.status === 'maintenance') {
    riskScore += 35;
    reasons.push('Vehicle is currently marked in maintenance status.');
    recommendations.push({ title: 'Complete maintenance before service', detail: 'Vehicle status is set to maintenance. Confirm repairs/inspection are completed and update vehicle status and maintenance records when resolved.', priority: 'high' });
  } else if (vehicle.status === 'unavailable') {
    riskScore += 20;
    reasons.push('Vehicle is currently unavailable.');
    recommendations.push({ title: 'Review availability reason', detail: 'Vehicle is unavailable. Verify whether this is due to a maintenance or safety issue and record service actions if applicable.', priority: 'medium' });
  }

  if (highOpen.length) {
    riskScore += 30 + Math.min(20, (highOpen.length - 1) * 10);
    reasons.push(`${highOpen.length} open high-severity problem report(s).`);
    recommendations.push({ title: 'Address high-severity issues', detail: `${highOpen.length} high-severity vehicle problem report(s) remain open/in review. Inspect and resolve these before regular operation where appropriate.`, priority: 'high' });
  }
  if (mechanicalOpen.length) {
    riskScore += 15 + Math.min(15, mechanicalOpen.length * 5);
    reasons.push(`${mechanicalOpen.length} open mechanical/breakdown/accident-related report(s).`);
    recommendations.push({ title: 'Inspect mechanical condition', detail: 'Open reports include mechanical/breakdown/accident issues. A maintenance inspection is recommended based on reported evidence.', priority: mechanicalOpen.some((p) => p.severity === 'high') ? 'high' : 'medium' });
  } else if (openProblems.length) {
    riskScore += 8 + Math.min(10, openProblems.length * 3);
    reasons.push(`${openProblems.length} open problem report(s).`);
    recommendations.push({ title: 'Review open problem reports', detail: 'There are open vehicle problem reports. Review and close or action them to keep maintenance status accurate.', priority: 'medium' });
  }

  if (recurringIssues.length) {
    riskScore += 10 + Math.min(10, recurringIssues.length * 4);
    const detail = recurringIssues.map(([type, count]) => `${String(type).replace(/_/g, ' ')} (${count} reports in 90 days)`).join(', ');
    reasons.push(`Recurring issues detected in last 90 days: ${detail}.`);
    recommendations.push({ title: 'Investigate recurring issues', detail: `Recurring reports in the last 90 days: ${detail}. Consider targeted inspection to address root causes.`, priority: 'medium' });
  }

  if (overdueRecords.length) {
    riskScore += 25 + Math.min(15, overdueRecords.length * 5);
    reasons.push(`${overdueRecords.length} overdue/scheduled-past-due maintenance record(s).`);
    recommendations.push({ title: 'Service overdue', detail: `${overdueRecords.length} maintenance record(s) are overdue or past due date. Schedule/complete service and update records.`, priority: 'high' });
  } else if (upcomingDue.length) {
    riskScore += 12;
    reasons.push(`${upcomingDue.length} maintenance item(s) due within 14 days.`);
    recommendations.push({ title: 'Upcoming service due', detail: `Upcoming maintenance due: ${upcomingDue.map((r) => `${r.type} by ${new Date(r.dueDate).toISOString().slice(0, 10)}`).join('; ')}.`, priority: 'medium' });
  }

  if (vehicle.insuranceExpiry) {
    const daysToExpiry = daysBetween(now, vehicle.insuranceExpiry);
    if (daysToExpiry != null && daysToExpiry < 0) {
      riskScore += 20;
      reasons.push(`Actual record: insurance expired on ${new Date(vehicle.insuranceExpiry).toISOString().slice(0, 10)}.`);
      recommendations.push({ title: 'Renew expired insurance', detail: `Insurance expired on ${new Date(vehicle.insuranceExpiry).toISOString().slice(0, 10)}. Renew before operating the vehicle.`, priority: 'high' });
    } else if (daysToExpiry != null && daysToExpiry <= 30) {
      riskScore += 8;
      reasons.push(`Actual record: insurance expires in ${Math.ceil(daysToExpiry)} day(s).`);
      recommendations.push({ title: 'Insurance renewal due soon', detail: `Insurance expires on ${new Date(vehicle.insuranceExpiry).toISOString().slice(0, 10)}. Plan renewal.`, priority: 'medium' });
    }
  }

  if (vehicle.nextServiceDate) {
    const daysToNext = daysBetween(now, vehicle.nextServiceDate);
    if (daysToNext != null && daysToNext < 0) {
      riskScore += 18;
      reasons.push(`Actual/recorded schedule: next service date ${new Date(vehicle.nextServiceDate).toISOString().slice(0, 10)} is past due.`);
      recommendations.push({ title: 'Recorded next service is past due', detail: `Vehicle next service date is recorded as ${new Date(vehicle.nextServiceDate).toISOString().slice(0, 10)}. Schedule/complete service and update records.`, priority: 'high' });
    } else if (daysToNext != null && daysToNext <= 14) {
      riskScore += 8;
      reasons.push(`Recorded schedule: next service due in ${Math.ceil(daysToNext)} day(s).`);
    }
  }

  const daysSinceService = lastCompletedService?.serviceDate ? daysBetween(lastCompletedService.serviceDate, now) : (vehicle.lastServiceDate ? daysBetween(vehicle.lastServiceDate, now) : null);
  const lastServiceDateUsed = lastCompletedService?.serviceDate || vehicle.lastServiceDate || null;
  if (!records.length) {
    reasons.push('Actual data gap: no maintenance/service records available for this vehicle.');
    recommendations.push({ title: 'Add maintenance history', detail: 'No service or inspection records are recorded. Add maintenance records (service dates, inspections, mileage/cost if known) to improve evidence-based service-due tracking.', priority: 'medium' });
  } else {
    if (daysSinceService != null && daysSinceService > 180) {
      riskScore += 12;
      reasons.push(`Estimated risk indicator (from recorded history): last completed service was about ${Math.floor(daysSinceService)} days ago (${lastServiceDateUsed ? new Date(lastServiceDateUsed).toISOString().slice(0, 10) : 'date n/a'}).`);
      recommendations.push({ title: 'Inspection/service interval check', detail: `Last recorded completed service was about ${Math.floor(daysSinceService)} days ago. This is an interval-based indicator, not a confirmed condition fault; plan inspection per your maintenance policy.`, priority: daysSinceService > 365 ? 'high' : 'medium' });
    } else if (lastServiceDateUsed) {
      reasons.push(`Actual record: last completed service recorded on ${new Date(lastServiceDateUsed).toISOString().slice(0, 10)}.`);
    }
    if (!lastInspection && completedTrips > 0) {
      recommendations.push({ title: 'Record inspections', detail: 'No completed inspection records found. Recording periodic inspections helps track vehicle condition from real evidence.', priority: 'low' });
    }
  }

  if (kmSinceService != null) {
    reasons.push(`Actual mileage records: about ${kmSinceService} km since last recorded service odometer (${lastServiceOdometerKm} km -> ${effectiveOdometerKm} km).`);
    if (kmSinceService >= 10000) {
      riskScore += 10;
      recommendations.push({ title: 'Mileage-based service review', detail: `Approximately ${kmSinceService} km recorded since last service odometer. This is a mileage-based indicator from recorded data (not a fault prediction); review against your service interval policy.`, priority: kmSinceService >= 15000 ? 'high' : 'medium' });
    }
  } else if (effectiveOdometerKm != null || lastServiceOdometerKm != null) {
    reasons.push(`Mileage data is partial (odometer: ${effectiveOdometerKm ?? 'n/a'} km, last service odometer: ${lastServiceOdometerKm ?? 'n/a'} km); mileage-based interval cannot be fully computed.`);
  } else {
    reasons.push('Actual data gap: no odometer/mileage telemetry or recorded mileage available.');
  }

  const hasEvidence = records.length > 0 || openProblems.length > 0 || recentProblems.length > 0 || vehicle.insuranceExpiry || vehicle.nextServiceDate || vehicle.lastServiceDate || effectiveOdometerKm != null || tripsCount > 0;
  riskScore = clamp(Math.round(riskScore), 0, 100);

  let riskLevel = 'low';
  if (riskScore >= 70) riskLevel = 'high';
  else if (riskScore >= 35) riskLevel = 'medium';
  if (!hasEvidence) riskLevel = 'unknown';

  let status = 'healthy';
  if (!hasEvidence || (records.length === 0 && openProblems.length === 0 && !vehicle.insuranceExpiry && !vehicle.nextServiceDate && !vehicle.lastServiceDate && effectiveOdometerKm == null)) status = 'insufficient_data';
  if (overdueRecords.length || (vehicle.insuranceExpiry && daysBetween(now, vehicle.insuranceExpiry) < 0) || (vehicle.nextServiceDate && daysBetween(now, vehicle.nextServiceDate) < 0)) status = 'service_due';
  else if (upcomingDue.length || (daysSinceService != null && daysSinceService > 180) || (kmSinceService != null && kmSinceService >= 10000)) status = 'inspection_recommended';
  if (highOpen.length || mechanicalOpen.length || vehicle.status === 'maintenance') status = 'attention_required';

  // Deduplicate recommendations by title, keep highest priority
  const recMap = new Map();
  for (const rec of recommendations) {
    const prev = recMap.get(rec.title);
    if (!prev || priorityWeight(rec.priority) > priorityWeight(prev.priority)) recMap.set(rec.title, rec);
  }
  const finalRecs = [...recMap.values()].sort((a, b) => priorityWeight(b.priority) - priorityWeight(a.priority)).slice(0, 8);

  const summaryParts = [];
  summaryParts.push(`Advisory risk indicator: ${riskLevel} (${riskScore}/100) based on available records (not a mechanical condition diagnosis or failure prediction).`);
  summaryParts.push(`${openProblems.length} open problem report(s), ${records.length} maintenance record(s), ${completedTrips} completed trip(s).`);
  if (effectiveOdometerKm != null) summaryParts.push(`Odometer: ${effectiveOdometerKm} km${kmSinceService != null ? ` (${kmSinceService} km since last service).` : '.'}`);
  if (overdueRecords.length) summaryParts.push(`${overdueRecords.length} overdue item(s).`);
  if (!reasons.length) reasons.push('No risk signals detected from available records.');

  const nextServiceDate = upcomingDue[0]?.dueDate || overdueRecords[0]?.dueDate || (vehicle.nextServiceDate && daysBetween(now, vehicle.nextServiceDate) >= 0 ? vehicle.nextServiceDate : null) || vehicle.nextServiceDate || null;

  return {
    riskLevel,
    riskScore,
    status,
    summary: summaryParts.join(' '),
    recommendations: finalRecs,
    nextServiceDate,
    evidence: {
      vehicleStatus: vehicle.status,
      insuranceExpiry: vehicle.insuranceExpiry || null,
      odometerKm: effectiveOdometerKm,
      lastServiceDate: lastServiceDateUsed || null,
      lastServiceOdometerKm,
      kmSinceLastService: kmSinceService,
      nextServiceDate: vehicle.nextServiceDate || null,
      openProblemCount: openProblems.length,
      openHighSeverityCount: highOpen.length,
      recentProblemCount90d: recentProblems.length,
      recurringIssues90d: recurringIssues.map(([type, count]) => ({ type, count })),
      maintenanceRecordCount: records.length,
      overdueRecordCount: overdueRecords.length,
      upcomingDueCount: upcomingDue.length,
      lastCompletedServiceDate: lastCompletedService?.serviceDate || null,
      lastCompletedInspectionDate: lastInspection?.serviceDate || null,
      daysSinceLastCompletedService: daysSinceService != null ? Math.floor(daysSinceService) : null,
      tripsCount,
      completedTripsCount: completedTrips,
      actualConditionSignals: {
        openProblemReports: openProblems.length,
        openHighSeverityProblemReports: highOpen.length,
        vehicleStatus: vehicle.status,
        insuranceExpired: Boolean(vehicle.insuranceExpiry && daysBetween(now, vehicle.insuranceExpiry) < 0),
        overdueMaintenanceItems: overdueRecords.length,
      },
      estimatedRiskSignals: {
        riskLevel,
        riskScore,
        advisory: true,
        basis: 'Transparent rule-based scoring from recorded vehicle/service/problem/trip data; not a sensor-based condition reading or failure prediction.',
      },
      reasons,
      dataLimitations: [
        'No live odometer/sensor/diagnostic telemetry integration; mileage and service tracking depend on recorded vehicle/maintenance data.',
        'Insights are based on vehicle records, reported problems, trip usage, and maintenance history only.',
        'Risk/status outputs are advisory indicators (estimated risk), not confirmed mechanical condition and not mechanical failure predictions.',
      ],
      generatedAt: now.toISOString(),
    },
    basedOn: 'rules',
  };
}

export async function analyzeVehicle(req, vehicleId) {
  if (req.user.role !== 'admin') throw new ApiError(403, 'Admin access required');
  const evidence = await gatherVehicleEvidence(vehicleId);
  const computed = computeInsights(evidence);
  const prediction = await MaintenancePrediction.create({
    vehicle: evidence.vehicle._id,
    analyzedAt: new Date(),
    ...computed,
    source: 'rule-based-maintenance-insights',
  });
  await audit(req, 'ai_maintenance_analyze', 'MaintenancePrediction', prediction._id, { vehicle: String(vehicleId), riskLevel: computed.riskLevel, status: computed.status });
  return { vehicle: evidence.vehicle, prediction: prediction.toObject(), evidence: computed.evidence, openProblems: evidence.openProblems.slice(0, 10), recentRecords: evidence.records.slice(0, 10) };
}

export async function analyzeAll(req) {
  if (req.user.role !== 'admin') throw new ApiError(403, 'Admin access required');
  const vehicles = await Vehicle.find().select('_id').lean();
  const results = [];
  for (const v of vehicles) {
    try {
      results.push(await analyzeVehicle(req, v._id));
    } catch (e) {
      results.push({ vehicleId: v._id, error: e.message });
    }
  }
  return { analyzed: results.length, results };
}

export async function getOverview(req) {
  if (req.user.role !== 'admin') throw new ApiError(403, 'Admin access required');
  const vehicles = await Vehicle.find().sort('busNumber').lean();
  const rows = [];
  for (const vehicle of vehicles) {
    let latest = await MaintenancePrediction.findOne({ vehicle: vehicle._id }).sort('-analyzedAt -createdAt').lean();
    let evidence;
    let openProblemsCount = 0;
    let overdueCount = 0;
    let lastServiceDate = null;
    let upcomingDueCount = 0;
    if (!latest) {
      // compute lightweight on-demand insight without persisting? better to persist for history consistency is done in analyze; but overview should be usable
      const gathered = await gatherVehicleEvidence(vehicle._id);
      const computed = computeInsights(gathered);
      latest = { ...computed, vehicle: vehicle._id, analyzedAt: new Date(), ephemeral: true };
      evidence = computed.evidence;
      openProblemsCount = gathered.openProblems.length;
      overdueCount = gathered.records.filter((r) => r.status === 'overdue' || (r.status === 'scheduled' && r.dueDate && new Date(r.dueDate) < new Date())).length;
      const lastSvc = gathered.records.find((r) => r.type === 'service' && r.status === 'completed' && r.serviceDate);
      lastServiceDate = lastSvc?.serviceDate || null;
      upcomingDueCount = gathered.records.filter((r) => r.status === 'scheduled' && r.dueDate && new Date(r.dueDate) >= new Date() && daysBetween(new Date(), r.dueDate) <= 14).length;
    } else {
      evidence = latest.evidence || {};
      openProblemsCount = evidence.openProblemCount || 0;
      overdueCount = evidence.overdueRecordCount || 0;
      lastServiceDate = evidence.lastCompletedServiceDate || null;
      upcomingDueCount = evidence.upcomingDueCount || 0;
    }
    rows.push({
      vehicle,
      latestPrediction: latest,
      indicators: {
        riskLevel: latest.riskLevel || 'unknown',
        riskScore: latest.riskScore ?? null,
        status: latest.status || 'insufficient_data',
        nextServiceDate: latest.nextServiceDate || null,
        lastServiceDate,
        openProblemsCount,
        overdueCount,
        upcomingDueCount,
        summary: latest.summary || '',
      },
    });
  }

  const counts = rows.reduce(
    (acc, r) => {
      acc.total += 1;
      acc.byRisk[r.indicators.riskLevel] = (acc.byRisk[r.indicators.riskLevel] || 0) + 1;
      acc.byStatus[r.indicators.status] = (acc.byStatus[r.indicators.status] || 0) + 1;
      if (['high', 'medium'].includes(r.indicators.riskLevel) || ['attention_required', 'service_due', 'inspection_recommended'].includes(r.indicators.status)) acc.needsAttention += 1;
      if (r.indicators.overdueCount > 0) acc.overdue += 1;
      return acc;
    },
    { total: 0, needsAttention: 0, overdue: 0, byRisk: {}, byStatus: {} }
  );

  return { generatedAt: new Date().toISOString(), counts, vehicles: rows, dataLimitations: ['Insights are rule-based and evidence-driven from available records only; no mechanical failure predictions are made.', 'Mileage/telemetry/inspection integrations may be unavailable.'] };
}

export async function getVehicleDetail(req, vehicleId) {
  if (req.user.role !== 'admin') throw new ApiError(403, 'Admin access required');
  const evidence = await gatherVehicleEvidence(vehicleId);
  const latest = await MaintenancePrediction.findOne({ vehicle: vehicleId }).sort('-analyzedAt -createdAt').lean();
  const predictionHistory = await MaintenancePrediction.find({ vehicle: vehicleId }).sort('-analyzedAt -createdAt').limit(20).lean();
  const computed = computeInsights(evidence);
  return {
    vehicle: evidence.vehicle,
    currentInsight: computed,
    latestPrediction: latest,
    predictionHistory,
    openProblems: evidence.openProblems,
    recentProblems: evidence.recentProblems,
    maintenanceRecords: evidence.records,
    usage: { tripsCount: evidence.tripsCount, completedTrips: evidence.completedTrips },
  };
}

export async function listPredictions(req, query = {}) {
  if (req.user.role !== 'admin') throw new ApiError(403, 'Admin access required');
  const filter = {};
  if (query.vehicleId) filter.vehicle = query.vehicleId;
  if (query.riskLevel) filter.riskLevel = query.riskLevel;
  if (query.status) filter.status = query.status;
  const page = Math.max(1, parseInt(String(query.page || '1'), 10) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(String(query.limit || '20'), 10) || 20));
  const [items, total] = await Promise.all([
    MaintenancePrediction.find(filter).sort('-analyzedAt -createdAt').skip((page - 1) * limit).limit(limit).populate('vehicle', 'busNumber registrationNumber model status insuranceExpiry').lean(),
    MaintenancePrediction.countDocuments(filter),
  ]);
  return { items, meta: { page, limit, total, pages: Math.max(1, Math.ceil(total / limit)) } };
}

function applyMaintenanceRecordToVehicle(vehicle, rec) {
  if (!vehicle || !rec) return false;
  let changed = false;
  const odometer = rec.odometerKm != null && Number.isFinite(Number(rec.odometerKm)) ? Number(rec.odometerKm) : null;
  if (odometer != null) {
    if (vehicle.odometerKm == null || odometer >= Number(vehicle.odometerKm)) {
      vehicle.odometerKm = odometer;
      changed = true;
    }
  }
  const serviceDate = rec.serviceDate ? new Date(rec.serviceDate) : null;
  const isCompletedServiceLike = rec.status === 'completed' && (rec.type === 'service' || rec.type === 'inspection' || rec.type === 'repair');
  if (isCompletedServiceLike && serviceDate && !Number.isNaN(serviceDate.getTime())) {
    if (!vehicle.lastServiceDate || serviceDate >= new Date(vehicle.lastServiceDate)) {
      vehicle.lastServiceDate = serviceDate;
      if (odometer != null) vehicle.lastServiceOdometerKm = odometer;
      changed = true;
    }
  }
  if (rec.dueDate) {
    const due = new Date(rec.dueDate);
    if (!Number.isNaN(due.getTime())) {
      // Track next scheduled/service-due date on the vehicle when it's in the future or most relevant upcoming.
      if (!vehicle.nextServiceDate || due <= new Date(vehicle.nextServiceDate) || new Date(vehicle.nextServiceDate) < new Date()) {
        vehicle.nextServiceDate = due;
        changed = true;
      }
    }
  }
  return changed;
}

export async function createMaintenanceRecord(req, payload) {
  if (req.user.role !== 'admin') throw new ApiError(403, 'Admin access required');
  const vehicle = await Vehicle.findById(payload.vehicle);
  if (!vehicle) throw new ApiError(404, 'Vehicle not found');
  const rec = await MaintenanceRecord.create({ ...payload, recordedBy: req.user.id });
  if (applyMaintenanceRecordToVehicle(vehicle, rec)) {
    await vehicle.save();
  }
  await audit(req, 'create_maintenance_record', 'MaintenanceRecord', rec._id, { vehicle: String(vehicle._id), type: rec.type, status: rec.status });
  return { record: rec.toObject(), vehicle: vehicle.toObject() };
}

export async function listMaintenanceRecords(req, query = {}) {
  if (req.user.role !== 'admin') throw new ApiError(403, 'Admin access required');
  const filter = {};
  if (query.vehicleId) filter.vehicle = query.vehicleId;
  if (query.type) filter.type = query.type;
  if (query.status) filter.status = query.status;
  const page = Math.max(1, parseInt(String(query.page || '1'), 10) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(String(query.limit || '20'), 10) || 20));
  const [items, total] = await Promise.all([
    MaintenanceRecord.find(filter).sort('-serviceDate -dueDate -createdAt').skip((page - 1) * limit).limit(limit).populate('vehicle', 'busNumber registrationNumber status').populate('recordedBy', 'name email').lean(),
    MaintenanceRecord.countDocuments(filter),
  ]);
  return { items, meta: { page, limit, total, pages: Math.max(1, Math.ceil(total / limit)) } };
}
