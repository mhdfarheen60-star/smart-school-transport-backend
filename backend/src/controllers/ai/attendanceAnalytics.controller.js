import { asyncHandler, ok } from '../../utils/http.js';
import * as analytics from '../../services/ai/attendanceAnalytics.service.js';

export const getAnalytics = asyncHandler(async (req, res) => {
  ok(res, await analytics.getAnalytics(req, req.query || {}));
});

export const exportAnalytics = asyncHandler(async (req, res) => {
  const format = String(req.query.format || 'json').toLowerCase();
  const result = await analytics.exportAnalytics(req, req.query || {});
  if (format === 'csv') {
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="attendance-analytics-${new Date().toISOString().slice(0, 10)}.csv"`);
    return void res.send(result);
  }
  ok(res, result);
});
