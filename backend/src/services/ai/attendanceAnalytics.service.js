import { Attendance, Route, Student } from '../../models/index.js';
import { ApiError } from '../../utils/http.js';

function parseDateStr(s) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(s || '')) ? String(s) : null;
}

function buildMatch(query = {}) {
  const match = {};
  const from = parseDateStr(query.from);
  const to = parseDateStr(query.to);
  if (from || to) {
    match.date = { ...(from ? { $gte: from } : {}), ...(to ? { $lte: to } : {}) };
  }
  if (query.route && /^[a-f\d]{24}$/i.test(query.route)) match.route = new (Attendance.db.base.Types.ObjectId)(query.route);
  if (query.student && /^[a-f\d]{24}$/i.test(query.student)) match.student = new (Attendance.db.base.Types.ObjectId)(query.student);
  return { match, from, to };
}

function pct(part, total) {
  if (!total) return 0;
  return Number(((part / total) * 100).toFixed(1));
}

function toObjectId(id) {
  try { return new (Attendance.db.base.Types.ObjectId)(id); } catch { return null; }
}

async function computeAnalytics(req, query = {}) {
  if (req.user.role !== 'admin') throw new ApiError(403, 'Admin access required');
  const { match, from, to } = buildMatch(query);
  const className = typeof query.className === 'string' && query.className.trim() ? query.className.trim() : '';
  const division = typeof query.division === 'string' && query.division.trim() ? query.division.trim() : '';

  // Join student for class filters and labels
  const basePipeline = [
    { $match: match },
    { $lookup: { from: 'students', localField: 'student', foreignField: '_id', as: 'studentDoc' } },
    { $unwind: { path: '$studentDoc', preserveNullAndEmptyArrays: true } },
  ];
  const studentMatch = {};
  if (className) studentMatch['studentDoc.className'] = className;
  if (division) studentMatch['studentDoc.division'] = division;
  if (Object.keys(studentMatch).length) basePipeline.push({ $match: studentMatch });

  const [
    totalsAgg,
    byDate,
    byMonth,
    byRoute,
    byClass,
    byStudent,
    statusTrend,
  ] = await Promise.all([
    Attendance.aggregate([
      ...basePipeline,
      {
        $group: {
          _id: null,
          totalRecords: { $sum: 1 },
          uniqueStudents: { $addToSet: '$student' },
          uniqueDays: { $addToSet: '$date' },
          uniqueRoutes: { $addToSet: '$route' },
          pickedUp: { $sum: { $cond: [{ $eq: ['$pickupStatus', 'picked_up'] }, 1, 0] } },
          absent: { $sum: { $cond: [{ $eq: ['$pickupStatus', 'absent'] }, 1, 0] } },
          notAvailable: { $sum: { $cond: [{ $eq: ['$pickupStatus', 'not_available'] }, 1, 0] } },
          pickupPending: { $sum: { $cond: [{ $eq: ['$pickupStatus', 'pending'] }, 1, 0] } },
          dropped: { $sum: { $cond: [{ $eq: ['$dropStatus', 'dropped'] }, 1, 0] } },
          dropPending: { $sum: { $cond: [{ $eq: ['$dropStatus', 'pending'] }, 1, 0] } },
        },
      },
      {
        $project: {
          _id: 0,
          totalRecords: 1,
          uniqueStudents: { $size: '$uniqueStudents' },
          uniqueDays: { $size: '$uniqueDays' },
          uniqueRoutes: { $size: '$uniqueRoutes' },
          pickedUp: 1,
          absent: 1,
          notAvailable: 1,
          pickupPending: 1,
          dropped: 1,
          dropPending: 1,
        },
      },
    ]),
    Attendance.aggregate([
      ...basePipeline,
      {
        $group: {
          _id: '$date',
          total: { $sum: 1 },
          pickedUp: { $sum: { $cond: [{ $eq: ['$pickupStatus', 'picked_up'] }, 1, 0] } },
          absent: { $sum: { $cond: [{ $eq: ['$pickupStatus', 'absent'] }, 1, 0] } },
          notAvailable: { $sum: { $cond: [{ $eq: ['$pickupStatus', 'not_available'] }, 1, 0] } },
          pending: { $sum: { $cond: [{ $eq: ['$pickupStatus', 'pending'] }, 1, 0] } },
          dropped: { $sum: { $cond: [{ $eq: ['$dropStatus', 'dropped'] }, 1, 0] } },
        },
      },
      { $sort: { _id: 1 } },
    ]),
    Attendance.aggregate([
      ...basePipeline,
      { $addFields: { month: { $substrBytes: ['$date', 0, 7] } } },
      {
        $group: {
          _id: '$month',
          total: { $sum: 1 },
          pickedUp: { $sum: { $cond: [{ $eq: ['$pickupStatus', 'picked_up'] }, 1, 0] } },
          absent: { $sum: { $cond: [{ $eq: ['$pickupStatus', 'absent'] }, 1, 0] } },
          notAvailable: { $sum: { $cond: [{ $eq: ['$pickupStatus', 'not_available'] }, 1, 0] } },
          pending: { $sum: { $cond: [{ $eq: ['$pickupStatus', 'pending'] }, 1, 0] } },
          dropped: { $sum: { $cond: [{ $eq: ['$dropStatus', 'dropped'] }, 1, 0] } },
        },
      },
      { $sort: { _id: 1 } },
    ]),
    Attendance.aggregate([
      ...basePipeline,
      {
        $group: {
          _id: '$route',
          total: { $sum: 1 },
          pickedUp: { $sum: { $cond: [{ $eq: ['$pickupStatus', 'picked_up'] }, 1, 0] } },
          absent: { $sum: { $cond: [{ $eq: ['$pickupStatus', 'absent'] }, 1, 0] } },
          notAvailable: { $sum: { $cond: [{ $eq: ['$pickupStatus', 'not_available'] }, 1, 0] } },
          pending: { $sum: { $cond: [{ $eq: ['$pickupStatus', 'pending'] }, 1, 0] } },
          dropped: { $sum: { $cond: [{ $eq: ['$dropStatus', 'dropped'] }, 1, 0] } },
          uniqueStudents: { $addToSet: '$student' },
        },
      },
      { $lookup: { from: 'routes', localField: '_id', foreignField: '_id', as: 'routeDoc' } },
      { $unwind: { path: '$routeDoc', preserveNullAndEmptyArrays: true } },
      { $project: { routeId: '$_id', routeName: '$routeDoc.name', total: 1, pickedUp: 1, absent: 1, notAvailable: 1, pending: 1, dropped: 1, uniqueStudents: { $size: '$uniqueStudents' } } },
      { $sort: { total: -1 } },
      { $limit: 50 },
    ]),
    Attendance.aggregate([
      ...basePipeline,
      {
        $group: {
          _id: { className: '$studentDoc.className', division: '$studentDoc.division' },
          total: { $sum: 1 },
          pickedUp: { $sum: { $cond: [{ $eq: ['$pickupStatus', 'picked_up'] }, 1, 0] } },
          absent: { $sum: { $cond: [{ $eq: ['$pickupStatus', 'absent'] }, 1, 0] } },
          notAvailable: { $sum: { $cond: [{ $eq: ['$pickupStatus', 'not_available'] }, 1, 0] } },
          pending: { $sum: { $cond: [{ $eq: ['$pickupStatus', 'pending'] }, 1, 0] } },
          dropped: { $sum: { $cond: [{ $eq: ['$dropStatus', 'dropped'] }, 1, 0] } },
          uniqueStudents: { $addToSet: '$student' },
        },
      },
      { $project: { className: '$_id.className', division: '$_id.division', total: 1, pickedUp: 1, absent: 1, notAvailable: 1, pending: 1, dropped: 1, uniqueStudents: { $size: '$uniqueStudents' } } },
      { $sort: { className: 1, division: 1 } },
      { $limit: 100 },
    ]),
    Attendance.aggregate([
      ...basePipeline,
      {
        $group: {
          _id: '$student',
          total: { $sum: 1 },
          pickedUp: { $sum: { $cond: [{ $eq: ['$pickupStatus', 'picked_up'] }, 1, 0] } },
          absent: { $sum: { $cond: [{ $eq: ['$pickupStatus', 'absent'] }, 1, 0] } },
          notAvailable: { $sum: { $cond: [{ $eq: ['$pickupStatus', 'not_available'] }, 1, 0] } },
          pending: { $sum: { $cond: [{ $eq: ['$pickupStatus', 'pending'] }, 1, 0] } },
          dropped: { $sum: { $cond: [{ $eq: ['$dropStatus', 'dropped'] }, 1, 0] } },
          studentName: { $first: '$studentDoc.name' },
          studentIdCode: { $first: '$studentDoc.studentId' },
          className: { $first: '$studentDoc.className' },
          division: { $first: '$studentDoc.division' },
        },
      },
      {
        $addFields: {
          attendanceRate: {
            $cond: [{ $gt: ['$total', 0] }, { $multiply: [{ $divide: ['$pickedUp', '$total'] }, 100] }, 0],
          },
          absenceCount: { $add: ['$absent', '$notAvailable'] },
        },
      },
      { $sort: { absenceCount: -1, total: -1 } },
      { $limit: 100 },
    ]),
    Attendance.aggregate([
      ...basePipeline,
      {
        $group: {
          _id: '$pickupStatus',
          count: { $sum: 1 },
        },
      },
    ]),
  ]);

  const totals = totalsAgg[0] || {
    totalRecords: 0, uniqueStudents: 0, uniqueDays: 0, uniqueRoutes: 0,
    pickedUp: 0, absent: 0, notAvailable: 0, pickupPending: 0, dropped: 0, dropPending: 0,
  };
  const presentEquivalent = totals.pickedUp; // picked up is the clearest attendance marker
  const recordedAbsences = totals.absent + totals.notAvailable;
  const rates = {
    pickupRate: pct(totals.pickedUp, totals.totalRecords),
    absenceRate: pct(totals.absent, totals.totalRecords),
    notAvailableRate: pct(totals.notAvailable, totals.totalRecords),
    pendingRate: pct(totals.pickupPending, totals.totalRecords),
    dropRate: pct(totals.dropped, totals.totalRecords),
  };

  const daily = byDate.map((d) => ({
    date: d._id,
    total: d.total,
    pickedUp: d.pickedUp,
    absent: d.absent,
    notAvailable: d.notAvailable,
    pending: d.pending,
    dropped: d.dropped,
    pickupRate: pct(d.pickedUp, d.total),
  }));
  const monthly = byMonth.map((d) => ({
    month: d._id,
    total: d.total,
    pickedUp: d.pickedUp,
    absent: d.absent,
    notAvailable: d.notAvailable,
    pending: d.pending,
    dropped: d.dropped,
    pickupRate: pct(d.pickedUp, d.total),
  }));
  const routes = byRoute.map((r) => ({ ...r, pickupRate: pct(r.pickedUp, r.total), absenceRate: pct(r.absent + r.notAvailable, r.total) }));
  const classes = byClass.map((c) => ({ ...c, pickupRate: pct(c.pickedUp, c.total), absenceRate: pct(c.absent + c.notAvailable, c.total) }));
  const students = byStudent.map((s) => ({
    studentId: s._id,
    name: s.studentName || 'Unknown',
    studentIdCode: s.studentIdCode || '',
    className: s.className || '',
    division: s.division || '',
    total: s.total,
    pickedUp: s.pickedUp,
    absent: s.absent,
    notAvailable: s.notAvailable,
    pending: s.pending,
    dropped: s.dropped,
    attendanceRate: Number((s.attendanceRate || 0).toFixed(1)),
    absenceCount: s.absenceCount || 0,
  }));

  const pickupBreakdown = statusTrend.map((s) => ({ status: s._id || 'unknown', count: s.count }));

  // Grounded deterministic explanations (no LLM, no fabricated claims)
  const insights = [];
  if (totals.totalRecords === 0) {
    insights.push('No attendance records match the selected filters. Analytics are based only on recorded attendance data.');
  } else {
    insights.push(`Analyzed ${totals.totalRecords} attendance record(s) across ${totals.uniqueStudents} student(s), ${totals.uniqueRoutes} route(s), and ${totals.uniqueDays} day(s).`);
    insights.push(`Pickup outcomes: ${totals.pickedUp} picked up (${rates.pickupRate}%), ${totals.absent} absent (${rates.absenceRate}%), ${totals.notAvailable} not available (${rates.notAvailableRate}%), ${totals.pickupPending} pending (${rates.pendingRate}%).`);
    insights.push(`Drop-off recorded for ${totals.dropped} record(s) (${rates.dropRate}% of records).`);
    if (daily.length >= 2) {
      const first = daily[0];
      const last = daily[daily.length - 1];
      const delta = Number((last.pickupRate - first.pickupRate).toFixed(1));
      insights.push(`Daily pickup rate moved from ${first.pickupRate}% (${first.date}) to ${last.pickupRate}% (${last.date}) across the selected range (${delta >= 0 ? '+' : ''}${delta} pp).`);
    }
    const highestAbsenceRoute = [...routes].sort((a, b) => (b.absenceRate - a.absenceRate) || (b.total - a.total))[0];
    if (highestAbsenceRoute && highestAbsenceRoute.total > 0) {
      insights.push(`Highest absence/not-available rate by route (in results): ${highestAbsenceRoute.routeName || 'Unknown route'} at ${highestAbsenceRoute.absenceRate}% over ${highestAbsenceRoute.total} record(s).`);
    }
    const highestAbsenceClass = [...classes].sort((a, b) => (b.absenceRate - a.absenceRate) || (b.total - a.total))[0];
    if (highestAbsenceClass && highestAbsenceClass.total > 0) {
      const label = [highestAbsenceClass.className, highestAbsenceClass.division].filter(Boolean).join('-') || 'Unspecified class';
      insights.push(`Highest absence/not-available rate by class (in results): ${label} at ${highestAbsenceClass.absenceRate}% over ${highestAbsenceClass.total} record(s).`);
    }
    const topAbsentee = students.find((s) => s.total >= 1);
    if (topAbsentee && topAbsentee.absenceCount > 0) {
      insights.push(`Most absence/not-available records in results: ${topAbsentee.name}${topAbsentee.studentIdCode ? ` (${topAbsentee.studentIdCode})` : ''} with ${topAbsentee.absenceCount} absence-related record(s) out of ${topAbsentee.total}.`);
    }
  }
  insights.push('Insights are computed from recorded attendance data only (no estimates, no external data).');

  const [routesList, classList] = await Promise.all([
    Route.find({}).sort('name').select('_id name').lean(),
    Student.aggregate([{ $group: { _id: { className: '$className', division: '$division' } } }, { $sort: { '_id.className': 1, '_id.division': 1 } }]),
  ]);

  return {
    generatedAt: new Date().toISOString(),
    filters: { from: from || null, to: to || null, route: query.route || null, student: query.student || null, className: className || null, division: division || null },
    totals: { ...totals, recordedAbsences },
    rates,
    breakdown: { pickup: pickupBreakdown },
    trends: { daily, monthly },
    byRoute: routes,
    byClass: classes,
    byStudent: students,
    insights,
    filterOptions: {
      routes: routesList.map((r) => ({ _id: r._id, name: r.name })),
      classes: classList.map((c) => ({ className: c._id?.className || '', division: c._id?.division || '' })).filter((c) => c.className || c.division),
    },
  };
}

export async function getAnalytics(req, query = {}) {
  return computeAnalytics(req, query);
}

function csvCell(v) {
  let s = String(v ?? '');
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return `"${s.replace(/"/g, '""')}"`;
}

export async function exportAnalytics(req, query = {}) {
  const data = await computeAnalytics(req, query);
  const format = String(query.format || 'json').toLowerCase();
  if (format === 'json') return data;
  if (format !== 'csv') throw new ApiError(400, 'Unsupported export format');

  const lines = [];
  const push = (title, cols, rows) => {
    lines.push(csvCell(title));
    lines.push(cols.map(csvCell).join(','));
    for (const row of rows) lines.push(cols.map((c) => csvCell(row[c.key])).join(','));
    lines.push('');
  };
  push('Totals', [
    { key: 'totalRecords', label: 'totalRecords' }, { key: 'uniqueStudents', label: 'uniqueStudents' }, { key: 'uniqueDays', label: 'uniqueDays' },
    { key: 'pickedUp', label: 'pickedUp' }, { key: 'absent', label: 'absent' }, { key: 'notAvailable', label: 'notAvailable' }, { key: 'pickupPending', label: 'pickupPending' }, { key: 'dropped', label: 'dropped' },
  ], [data.totals]);
  push('Daily trend', [
    { key: 'date', label: 'date' }, { key: 'total', label: 'total' }, { key: 'pickedUp', label: 'pickedUp' }, { key: 'absent', label: 'absent' }, { key: 'notAvailable', label: 'notAvailable' }, { key: 'pending', label: 'pending' }, { key: 'dropped', label: 'dropped' }, { key: 'pickupRate', label: 'pickupRate' },
  ], data.trends.daily);
  push('Monthly trend', [
    { key: 'month', label: 'month' }, { key: 'total', label: 'total' }, { key: 'pickedUp', label: 'pickedUp' }, { key: 'absent', label: 'absent' }, { key: 'notAvailable', label: 'notAvailable' }, { key: 'pending', label: 'pending' }, { key: 'dropped', label: 'dropped' }, { key: 'pickupRate', label: 'pickupRate' },
  ], data.trends.monthly);
  push('By route', [
    { key: 'routeName', label: 'routeName' }, { key: 'total', label: 'total' }, { key: 'pickedUp', label: 'pickedUp' }, { key: 'absent', label: 'absent' }, { key: 'notAvailable', label: 'notAvailable' }, { key: 'pickupRate', label: 'pickupRate' }, { key: 'absenceRate', label: 'absenceRate' },
  ], data.byRoute);
  push('By class', [
    { key: 'className', label: 'className' }, { key: 'division', label: 'division' }, { key: 'total', label: 'total' }, { key: 'pickedUp', label: 'pickedUp' }, { key: 'absent', label: 'absent' }, { key: 'notAvailable', label: 'notAvailable' }, { key: 'pickupRate', label: 'pickupRate' }, { key: 'absenceRate', label: 'absenceRate' },
  ], data.byClass);
  push('By student', [
    { key: 'studentIdCode', label: 'studentId' }, { key: 'name', label: 'name' }, { key: 'className', label: 'className' }, { key: 'division', label: 'division' }, { key: 'total', label: 'total' }, { key: 'pickedUp', label: 'pickedUp' }, { key: 'absent', label: 'absent' }, { key: 'notAvailable', label: 'notAvailable' }, { key: 'attendanceRate', label: 'attendanceRate' }, { key: 'absenceCount', label: 'absenceCount' },
  ], data.byStudent);
  lines.push(csvCell('Insights'));
  data.insights.forEach((i) => lines.push(csvCell(i)));
  return `\ufeff${lines.join('\n')}`;
}
