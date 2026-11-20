import { Router } from 'express';
import { authenticate, authorize } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import * as V from '../validators/index.js';
import * as aiStatus from '../controllers/ai/status.controller.js';
import * as routeOpt from '../controllers/ai/routeOptimization.controller.js';
import * as eta from '../controllers/ai/eta.controller.js';
import * as maintenance from '../controllers/ai/maintenance.controller.js';
import * as attendanceAnalytics from '../controllers/ai/attendanceAnalytics.controller.js';
import * as assistant from '../controllers/ai/assistant.controller.js';
import * as avatar from '../controllers/ai/avatar.controller.js';
import * as safety from '../controllers/ai/safety.controller.js';
import * as geofences from '../controllers/ai/geofence.controller.js';

const ai = Router();

ai.use(authenticate);
ai.get('/status', aiStatus.status);

// Route optimization (admin)
const routes = Router();
routes.use(authorize('admin'));
routes.post('/optimize', validate(V.aiRouteOptimizeSchema), routeOpt.optimize);
routes.get('/suggestions', routeOpt.suggestions);
routes.get('/history', routeOpt.history);
routes.get('/:id/comparison', routeOpt.comparison);
routes.post('/:id/approve', validate(V.aiRouteReviewSchema), routeOpt.approve);
routes.post('/:id/reject', validate(V.aiRouteReviewSchema), routeOpt.reject);
ai.use('/routes', routes);

// ETA prediction
const etaRoutes = Router();
etaRoutes.post('/predict', validate(V.aiEtaPredictSchema), eta.predict);
etaRoutes.get('/overview', authorize('admin'), eta.overview);
etaRoutes.get('/history', eta.history);
etaRoutes.get('/:tripId', eta.byTrip);
ai.use('/eta', etaRoutes);

// Predictive maintenance (admin)
const maintenanceRoutes = Router();
maintenanceRoutes.use(authorize('admin'));
maintenanceRoutes.get('/overview', maintenance.overview);
maintenanceRoutes.get('/vehicles', maintenance.vehicles);
maintenanceRoutes.get('/vehicles/:vehicleId', maintenance.vehicleDetail);
maintenanceRoutes.post('/analyze', validate(V.aiMaintenanceAnalyzeSchema), maintenance.analyze);
maintenanceRoutes.get('/predictions', maintenance.predictions);
maintenanceRoutes.get('/records', maintenance.listRecords);
maintenanceRoutes.post('/records', validate(V.maintenanceRecordCreateSchema), maintenance.createRecord);
ai.use('/maintenance', maintenanceRoutes);

// Attendance analytics (admin)
const attendanceRoutes = Router();
attendanceRoutes.use(authorize('admin'));
attendanceRoutes.get('/analytics', attendanceAnalytics.getAnalytics);
attendanceRoutes.get('/export', attendanceAnalytics.exportAnalytics);
ai.use('/attendance', attendanceRoutes);

// AI Transport Assistant (all authenticated roles; responses are RBAC-scoped server-side)
const assistantRoutes = Router();
assistantRoutes.get('/conversations', assistant.listConversations);
assistantRoutes.post('/conversations', validate(V.aiAssistantConversationCreateSchema), assistant.createConversation);
assistantRoutes.get('/conversations/:id', assistant.getConversation);
assistantRoutes.post('/messages', validate(V.aiAssistantMessageSchema), assistant.sendMessage);
// Real-time photorealistic human avatar (Tavus CVI). Session creation and API
// keys are handled exclusively on the backend; frontend receives a join URL.
assistantRoutes.get('/avatar/status', avatar.status);
assistantRoutes.post('/avatar/conversation', avatar.createConversation);
assistantRoutes.post('/avatar/conversation/:id/end', avatar.endConversation);
ai.use('/assistant', assistantRoutes);

// Safety monitoring (admin)
const safetyRoutes = Router();
safetyRoutes.use(authorize('admin'));
safetyRoutes.get('/overview', safety.overview);
safetyRoutes.post('/analyze', validate(V.aiSafetyAnalyzeSchema), safety.analyze);
safetyRoutes.get('/geofences', geofences.list);
safetyRoutes.post('/geofences', validate(V.geofenceSchema), geofences.create);
safetyRoutes.get('/geofences/:id', geofences.get);
safetyRoutes.patch('/geofences/:id', validate(V.geofenceUpdateSchema), geofences.update);
safetyRoutes.delete('/geofences/:id', geofences.remove);
safetyRoutes.get('/alerts', safety.listAlerts);
safetyRoutes.get('/alerts/:id', safety.getAlert);
safetyRoutes.post('/alerts/:id/acknowledge', validate(V.aiSafetyActionSchema), safety.acknowledge);
safetyRoutes.post('/alerts/:id/resolve', validate(V.aiSafetyActionSchema), safety.resolve);
ai.use('/safety', safetyRoutes);

export default ai;
