import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { env } from '../config/env.js';
import { authenticate, authorize } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import * as V from '../validators/index.js';
import * as auth from '../controllers/auth.controller.js';
import * as student from '../controllers/student.controller.js';
import * as parent from '../controllers/parent.controller.js';
import * as driver from '../controllers/driver.controller.js';
import * as vehicle from '../controllers/vehicle.controller.js';
import * as route from '../controllers/route.controller.js';
import * as request from '../controllers/request.controller.js';
import * as assignment from '../controllers/assignment.controller.js';
import * as trip from '../controllers/trip.controller.js';
import * as tripScheduling from '../controllers/tripScheduling.controller.js';
import * as attendance from '../controllers/attendance.controller.js';
import * as notification from '../controllers/notification.controller.js';
import * as complaint from '../controllers/complaint.controller.js';
import * as problem from '../controllers/problem.controller.js';
import * as report from '../controllers/report.controller.js';
import * as dashboard from '../controllers/dashboard.controller.js';
import * as fleet from '../controllers/fleet.controller.js';
import * as location from '../controllers/location.controller.js';
import * as tripLocation from '../controllers/tripLocation.controller.js';
import * as parentTracking from '../controllers/parentTracking.controller.js';
import * as deviceToken from '../controllers/deviceToken.controller.js';
import ai from './ai.js';
import publicAi from './publicAi.js';

const api = Router();
const admin = authorize('admin');
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: env.authRateLimit,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Too many attempts. Please try again later.' },
});

// Public, narrowly scoped AI assistant (no authentication, no privileged context)
api.use('/public/ai', publicAi);

// ---- auth
const authR = Router();
authR.post('/register', authLimiter, validate(V.registerSchema), auth.register);
authR.post('/register/parent', authLimiter, validate(V.parentRegisterSchema), auth.registerParent);
authR.post('/login', authLimiter, validate(V.loginSchema), auth.login);
authR.get('/me', authenticate, auth.me);
authR.patch('/profile', authenticate, validate(V.profileSchema), auth.updateProfile);
authR.post('/change-password', authenticate, validate(V.changePasswordSchema), auth.changePassword);
api.use('/auth', authR);

// everything below needs a session
api.use(authenticate);

const students = Router();
students.use(admin);
students.get('/', student.list);
students.post('/', validate(V.studentCreateSchema), student.create);
students.get('/:id', student.getOne);
students.patch('/:id', validate(V.studentUpdateSchema), student.update);
students.patch('/:id/permanent-locations', validate(V.studentPermanentLocationsSchema), student.updatePermanentLocations);
students.delete('/:id', student.remove);
api.use('/students', students);

const parents = Router();
parents.use(admin);
parents.get('/', parent.list);
parents.post('/', validate(V.parentCreateSchema), parent.create);
parents.get('/link-requests', parent.listLinkRequests);
parents.patch('/link-requests/:id', validate(V.parentLinkReviewSchema), parent.reviewLinkRequest);
parents.get('/:id', parent.getOne);
parents.patch('/:id', validate(V.parentUpdateSchema), parent.update);
parents.delete('/:id', parent.remove);
api.use('/parents', parents);

// Parent self-service. Access is restricted to the authenticated parent and
// every child lookup is validated against the approved linked-students list.
const parentSelf = Router();
parentSelf.use(authorize('parent'));
parentSelf.get('/children', parent.myChildren);
parentSelf.get('/children/:studentId', parent.myChildDashboard);
parentSelf.get('/link-requests', parent.listMyLinkRequests);
parentSelf.post('/link-requests', validate(V.parentLinkRequestSchema), parent.createLinkRequest);
parentSelf.delete('/link-requests/:id', parent.cancelMyLinkRequest);
api.use('/parent', parentSelf);

const drivers = Router();
drivers.use(admin);
drivers.get('/', driver.list);
drivers.post('/', validate(V.driverCreateSchema), driver.create);
drivers.get('/:id', driver.getOne);
drivers.patch('/:id', validate(V.driverUpdateSchema), driver.update);
drivers.delete('/:id', driver.remove);
api.use('/drivers', drivers);

const vehicles = Router();
vehicles.use(admin);
vehicles.get('/', vehicle.list);
vehicles.post('/', validate(V.vehicleSchema), vehicle.create);
vehicles.get('/:id', vehicle.getOne);
vehicles.patch('/:id', validate(V.vehicleUpdateSchema), vehicle.update);
vehicles.delete('/:id', vehicle.remove);
api.use('/vehicles', vehicles);

const routes = Router();
routes.get('/options', route.options);
routes.get('/', admin, route.list);
routes.post('/', admin, validate(V.routeSchema), route.create);
routes.post('/:id/metrics', admin, route.computeMetrics);
routes.get('/:id', admin, route.getOne);
routes.patch('/:id', admin, validate(V.routeUpdateSchema), route.update);
routes.delete('/:id', admin, route.remove);
api.use('/routes', routes);

const requests = Router();
requests.post('/', authorize('student'), validate(V.requestCreateSchema), request.create);
requests.get('/', authorize('student', 'admin'), request.list);
requests.post('/:id/assign', admin, validate(V.requestAssignSchema), request.assign);
requests.patch('/:id/review', admin, validate(V.requestReviewSchema), request.review);
requests.patch('/:id', authorize('student'), validate(V.requestUpdateSchema), request.update);
requests.patch('/:id/cancel', authorize('student'), request.cancel);
api.use('/transport-requests', requests);

const locationChanges = Router();
locationChanges.get('/current', authorize('student'), location.mine);
locationChanges.post('/', authorize('student'), validate(V.locationChangeCreateSchema), location.create);
locationChanges.get('/', authorize('student', 'admin'), location.list);
locationChanges.patch('/:id/cancel', authorize('student'), location.cancel);
locationChanges.patch('/:id/review', admin, validate(V.locationChangeReviewSchema), location.review);
api.use('/location-changes', locationChanges);

const assignments = Router();
assignments.get('/mine', authorize('student', 'driver'), assignment.mine);
assignments.get('/', admin, assignment.list);
assignments.post('/', admin, validate(V.assignmentCreateSchema), assignment.create);
assignments.get('/:id', authorize('admin', 'driver', 'student'), assignment.getOne);
assignments.patch('/:id', admin, validate(V.assignmentUpdateSchema), assignment.update);
assignments.post('/:id/end', admin, assignment.end);
assignments.post('/:id/riders', admin, validate(V.riderSchema), assignment.addRider);
assignments.delete('/:id/riders/:studentId', admin, assignment.removeRider);
assignments.post('/:id/accept', authorize('driver'), assignment.accept);
assignments.post('/:id/decline', authorize('driver'), validate(V.assignmentDeclineSchema), assignment.decline);
assignments.patch('/:id/trip-status', authorize('driver'), validate(V.tripDriverStatusSchema), assignment.updateTripStatus);
api.use('/assignments', assignments);

const trips = Router();
trips.post('/today', authorize('driver'), trip.openToday);
trips.get('/today', authorize('driver'), trip.getToday);
trips.get('/', authorize('admin', 'driver'), trip.list);
trips.post('/', admin, validate(V.tripCreateSchema), trip.create);
trips.post('/:id/locations', authorize('admin', 'driver'), validate(V.tripLocationIngestSchema), tripLocation.ingest);
trips.get('/:id/locations', tripLocation.list);
trips.get('/:id/locations/latest', tripLocation.latest);
trips.get('/:id/events', authorize('admin', 'driver', 'student', 'parent'), trip.events);
trips.get('/:id', authorize('admin', 'driver'), trip.getOne);
trips.patch('/:id/status', authorize('admin', 'driver'), validate(V.tripStatusSchema), trip.setStatus);
api.use('/trips', trips);

// ---- Trip scheduling (admin)
const scheduling = Router();
scheduling.use(admin);
scheduling.post('/generate', tripScheduling.generateDailyTrips);
scheduling.post('/generate/today', tripScheduling.generateTodayTrips);
scheduling.post('/generate/range', tripScheduling.generateTripsRange);
scheduling.get('/', tripScheduling.listTrips);
scheduling.get('/pending', tripScheduling.pendingTrips);
scheduling.get('/working-day', tripScheduling.isWorkingDayEndpoint);
scheduling.get('/calendar', tripScheduling.schoolCalendar);
scheduling.patch('/calendar', tripScheduling.upsertSchoolCalendarDay);
scheduling.get('/config', tripScheduling.schoolConfig);
scheduling.patch('/config', tripScheduling.updateSchoolConfig);
scheduling.get('/exceptions', tripScheduling.transportExceptions);
scheduling.post('/exceptions', validate(V.transportExceptionCreateSchema), tripScheduling.createTransportException);
scheduling.patch('/exceptions/:id/review', validate(V.transportExceptionReviewSchema), tripScheduling.reviewTransportException);
scheduling.get('/:id', tripScheduling.getTripDetail);
scheduling.patch('/:id/status', validate(V.tripStatusSchema), tripScheduling.setTripStatus);
scheduling.post('/:id/cancel', tripScheduling.cancelTrip);
api.use('/scheduling', scheduling);

const att = Router();
att.get('/', attendance.list);
att.patch('/:id/pickup', authorize('driver'), validate(V.pickupSchema), attendance.markPickup);
att.patch('/:id/drop', authorize('driver'), validate(V.dropSchema), attendance.markDrop);
att.patch('/:id', admin, validate(V.attendanceAdminSchema), attendance.adminUpdate);
api.use('/attendance', att);

const notifications = Router();
notifications.get('/', notification.list);
notifications.get('/push-status', notification.pushStatus);
notifications.patch('/read-all', notification.markAllRead);
notifications.post('/', admin, validate(V.notificationCreateSchema), notification.broadcast);
notifications.patch('/:id/read', notification.markRead);
notifications.delete('/:id', notification.remove);
api.use('/notifications', notifications);

// ---- Parent live tracking (authenticated parent only)
const parentTrack = Router();
parentTrack.use(authorize('parent'));
parentTrack.get('/trips/active', parentTracking.parentActiveTrips);
parentTrack.get('/children/transport', parentTracking.parentChildrenTransport);
parentTrack.get('/trips/:tripId/location', parentTracking.parentTripLocation);
parentTrack.get('/trips/:tripId/eta', parentTracking.parentTripETA);
api.use('/parent/tracking', parentTrack);

// ---- Device tokens (push notification registration)
const deviceTokens = Router();
deviceTokens.post('/', deviceToken.registerDeviceToken);
deviceTokens.get('/', deviceToken.listDeviceTokens);
deviceTokens.delete('/:id', deviceToken.removeDeviceToken);
deviceTokens.patch('/:id/deactivate', deviceToken.deactivateDeviceToken);
api.use('/device-tokens', deviceTokens);

const adminDeviceTokens = Router();
adminDeviceTokens.use(admin);
adminDeviceTokens.get('/', deviceToken.listAllDeviceTokens);
api.use('/admin/device-tokens', adminDeviceTokens);

// ---- Admin fleet operations
const fleetR = Router();
fleetR.use(admin);
fleetR.get('/summary', fleet.fleetSummary);
fleetR.get('/vehicles', fleet.fleetVehicles);
fleetR.get('/vehicles/:id', fleet.fleetVehicleDetail);
fleetR.get('/map', fleet.fleetMap);
fleetR.get('/monitor', fleet.tripMonitor);
fleetR.get('/delayed', fleet.delayedTrips);
fleetR.get('/gps-alerts', fleet.gpsAlerts);
fleetR.post('/gps-cleanup', fleet.cleanupGpsHistory);
api.use('/fleet', fleetR);

const complaints = Router();
complaints.post('/', authorize('student', 'driver'), validate(V.complaintCreateSchema), complaint.create);
complaints.get('/', complaint.list);
complaints.patch('/:id', admin, validate(V.complaintUpdateSchema), complaint.update);
api.use('/complaints', complaints);

const problems = Router();
problems.post('/', authorize('driver'), validate(V.problemCreateSchema), problem.create);
problems.get('/', authorize('admin', 'driver'), problem.list);
problems.patch('/:id', admin, validate(V.problemUpdateSchema), problem.update);
api.use('/vehicle-problems', problems);

api.get('/reports', admin, (_req, res) => res.json({ success: true, data: report.types }));
api.get('/reports/:type', admin, report.generate);

const dash = Router();
dash.get('/admin', admin, dashboard.admin);
dash.get('/student', authorize('student'), dashboard.student);
dash.get('/driver', authorize('driver'), dashboard.driver);
dash.get('/audit-logs', admin, dashboard.auditLogs);
api.use('/dashboard', dash);

api.use('/ai', ai);

export default api;
