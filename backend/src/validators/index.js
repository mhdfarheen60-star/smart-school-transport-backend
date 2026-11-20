import { z } from 'zod';

export const objectId = z.string().regex(/^[a-f\d]{24}$/i, 'Invalid id');
const phone = z.string().trim().regex(/^[0-9+\-\s()]{7,15}$/, 'Enter a valid phone number');
const name = z.string().trim().min(2).max(100);
const password = z
  .string()
  .min(8, 'Password must be at least 8 characters')
  .max(72)
  .regex(/[A-Za-z]/, 'Password needs a letter')
  .regex(/\d/, 'Password needs a number');
const time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use HH:mm');
const email = z.string().trim().toLowerCase().email().max(254);

const studentFields = {
  name,
  studentId: z.string().trim().min(2).max(30),
  className: z.string().trim().min(1).max(20),
  division: z.string().trim().min(1).max(5),
  address: z.string().trim().min(5).max(300),
  phone,
  parentName: z.string().trim().max(100).optional(),
  parentPhone: phone,
};

export const registerSchema = z.object({ ...studentFields, email, password });
export const loginSchema = z.object({
  identifier: z.string().trim().min(1, 'Email or Student ID is required').max(254),
  password: z.string().min(1, 'Password is required').max(72),
});
export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: password,
});
export const profileSchema = z.object({
  name: name.optional(),
  phone: phone.optional(),
  address: z.string().trim().min(5).max(300).optional(),
  parentName: z.string().trim().max(100).optional(),
  parentPhone: phone.optional(),
});

export const parentCreateSchema = z.object({
  name,
  email,
  phone: phone.optional(),
  linkedStudents: z.array(objectId).max(50).optional(),
  status: z.enum(['active', 'inactive']).optional(),
});
export const parentUpdateSchema = parentCreateSchema.partial();

export const parentRegisterSchema = z.object({
  name,
  email,
  password,
  phone: phone.optional(),
});

export const parentLinkRequestSchema = z.object({
  studentId: z.string().trim().min(2).max(30),
  relationship: z.string().trim().max(60).optional(),
  note: z.string().trim().max(500).optional(),
});

export const parentLinkReviewSchema = z.object({
  decision: z.enum(['approved', 'rejected']),
  rejectionReason: z.string().trim().max(500).optional(),
});

export const studentCreateSchema = z.object({
  ...studentFields,
  email,
  password,
  status: z.enum(['active', 'inactive']).optional(),
});
export const studentUpdateSchema = z.object({
  ...studentFields,
  email,
  password: password.optional().or(z.literal('')),
  status: z.enum(['active', 'inactive']).optional(),
}).partial();

export const studentPermanentLocationsSchema = z.object({
  permanentPickupLocation: z.object({
    geo: z.object({
      latitude: z.coerce.number().finite().min(-90).max(90),
      longitude: z.coerce.number().finite().min(-180).max(180),
      address: z.string().trim().max(300).optional(),
      landmark: z.string().trim().max(200).optional(),
      placeId: z.string().trim().max(300).optional(),
    }),
    verified: z.boolean().optional(),
  }).optional(),
  permanentDropLocation: z.object({
    geo: z.object({
      latitude: z.coerce.number().finite().min(-90).max(90),
      longitude: z.coerce.number().finite().min(-180).max(180),
      address: z.string().trim().max(300).optional(),
      landmark: z.string().trim().max(200).optional(),
      placeId: z.string().trim().max(300).optional(),
    }),
    verified: z.boolean().optional(),
  }).optional(),
});

export const driverCreateSchema = z.object({
  name,
  email,
  password,
  phone,
  licenseNumber: z.string().trim().min(4).max(30),
  address: z.string().trim().max(300).optional(),
  status: z.enum(['active', 'inactive']).optional(),
});
export const driverUpdateSchema = driverCreateSchema
  .omit({ password: true })
  .extend({ password: password.optional().or(z.literal('')) })
  .partial();

export const vehicleSchema = z.object({
  registrationNumber: z.string().trim().min(4).max(20),
  busNumber: z.string().trim().min(1).max(20),
  model: z.string().trim().max(50).optional(),
  capacity: z.coerce.number().int().min(1).max(200),
  insuranceNumber: z.string().trim().max(50).optional(),
  insuranceExpiry: z.coerce.date().optional(),
  status: z.enum(['available', 'unavailable', 'maintenance']).optional(),
});
export const vehicleUpdateSchema = vehicleSchema.partial();

const routeGeoPointSchema = z.object({
  latitude: z.coerce.number().finite().min(-90).max(90),
  longitude: z.coerce.number().finite().min(-180).max(180),
  address: z.string().trim().max(300).optional().or(z.literal('')),
  landmark: z.string().trim().max(200).optional().or(z.literal('')),
  placeId: z.string().trim().max(300).optional().or(z.literal('')),
});

export const routeSchema = z.object({
  name: z.string().trim().min(2).max(100),
  description: z.string().trim().max(500).optional(),
  stops: z
    .array(
      z.object({
        name: z.string().trim().min(1).max(100),
        sequence: z.coerce.number().int().min(1),
        pickupTime: time.optional().or(z.literal('')),
        dropTime: time.optional().or(z.literal('')),
        latitude: z.coerce.number().finite().min(-90).max(90).optional(),
        longitude: z.coerce.number().finite().min(-180).max(180).optional(),
        address: z.string().trim().max(300).optional().or(z.literal('')),
        landmark: z.string().trim().max(200).optional().or(z.literal('')),
        type: z.enum(['pickup', 'drop', 'both']).optional(),
      })
    )
    .min(1, 'Add at least one stop'),
  status: z.enum(['active', 'inactive']).optional(),
  schoolLocation: routeGeoPointSchema.optional(),
  startLocation: routeGeoPointSchema.optional(),
  endLocation: routeGeoPointSchema.optional(),
});
export const routeUpdateSchema = routeSchema.partial();

export const geoPointSchema = z.object({
  address: z.string().trim().min(3, 'Address is required').max(300),
  latitude: z.coerce.number().finite().min(-90, 'Latitude must be between -90 and 90').max(90, 'Latitude must be between -90 and 90'),
  longitude: z.coerce.number().finite().min(-180, 'Longitude must be between -180 and 180').max(180, 'Longitude must be between -180 and 180'),
  placeId: z.string().trim().max(300).optional(),
});

export const requestCreateSchema = z.object({
  pickupLocation: geoPointSchema,
  dropLocation: geoPointSchema,
  requestedAt: z.coerce.date(),
  notes: z.string().trim().max(500).optional(),
});
export const requestUpdateSchema = requestCreateSchema.partial();

export const requestAssignSchema = z.object({
  driver: objectId,
  vehicle: objectId,
});

export const locationChangeCreateSchema = z.object({
  target: z.enum(['pickup', 'drop']),
  location: geoPointSchema,
  reason: z.string().trim().max(500).optional(),
});
export const locationChangeReviewSchema = z.object({
  decision: z.enum(['approved', 'rejected']),
  rejectionReason: z.string().trim().max(500).optional(),
  stop: z.string().trim().max(100).optional(),
});
export const requestReviewSchema = z.object({
  decision: z.enum(['approved', 'rejected']),
  remarks: z.string().trim().max(500).optional(),
  assignment: objectId.optional(),
  stop: z.string().trim().max(100).optional(),
});

export const assignmentCreateSchema = z.object({
  vehicle: objectId,
  driver: objectId,
  route: objectId,
});
export const assignmentUpdateSchema = assignmentCreateSchema.partial();
export const riderSchema = z.object({ student: objectId, stop: z.string().trim().max(100).optional() });
export const assignmentDeclineSchema = z.object({
  reason: z.string().trim().min(1, 'A decline reason is required').max(500),
});

export const tripCreateSchema = z.object({
  assignment: objectId,
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});
export const tripStatusSchema = z.object({
  status: z.enum([
    'scheduled',
    'assigned',
    'ready',
    'in_progress',
    'delayed',
    'paused',
    'arrived_at_school',
    'completed',
    'cancelled',
  ]),
  delayMinutes: z.coerce.number().int().min(0).max(1440).optional(),
  delayReason: z.string().trim().max(500).optional(),
  cancellationReason: z.string().trim().max(500).optional(),
  reason: z.string().trim().max(500).optional(),
  override: z.boolean().optional(),
  overrideReason: z.string().trim().max(500).optional(),
});
export const tripDriverStatusSchema = z.object({
  status: z.enum(['driver_en_route', 'arrived', 'in_progress', 'completed']),
});

const journeyGeo = z
  .object({
    latitude: z.coerce.number().finite().min(-90).max(90),
    longitude: z.coerce.number().finite().min(-180).max(180),
    accuracyMeters: z.coerce.number().min(0).max(100000).optional(),
  })
  .optional();

export const pickupSchema = z.object({
  status: z.enum(['picked_up', 'absent', 'not_available']),
  geo: journeyGeo,
  note: z.string().trim().max(500).optional(),
  source: z.enum(['driver_app', 'driver_web', 'admin', 'system']).optional(),
});
export const dropSchema = z.object({
  status: z.literal('dropped'),
  geo: journeyGeo,
  note: z.string().trim().max(500).optional(),
  source: z.enum(['driver_app', 'driver_web', 'admin', 'system']).optional(),
});
export const attendanceAdminSchema = z.object({
  pickupStatus: z.enum(['pending', 'picked_up', 'absent', 'not_available']).optional(),
  dropStatus: z.enum(['pending', 'dropped']).optional(),
  note: z.string().trim().max(500).optional(),
});

export const notificationCreateSchema = z.object({
  title: z.string().trim().min(2).max(150),
  message: z.string().trim().min(2).max(1000),
  type: z.enum(['info', 'delay', 'holiday', 'route_change']).default('info'),
  audience: z.enum(['all', 'students', 'drivers', 'user']).default('all'),
  user: objectId.optional(),
});

export const complaintCreateSchema = z.object({
  subject: z.string().trim().min(3).max(150),
  description: z.string().trim().min(10).max(2000),
  category: z.enum(['driver', 'vehicle', 'route', 'timing', 'safety', 'other']).default('other'),
});
export const complaintUpdateSchema = z.object({
  status: z.enum(['open', 'in_review', 'resolved', 'rejected']),
  adminResponse: z.string().trim().max(1000).optional(),
});

export const problemCreateSchema = z.object({
  type: z.enum(['breakdown', 'traffic_delay', 'accident', 'mechanical_issue', 'other']),
  severity: z.enum(['low', 'medium', 'high']).default('medium'),
  description: z.string().trim().min(5).max(1000),
  delayMinutes: z.coerce.number().int().min(0).max(600).optional(),
});
export const problemUpdateSchema = z.object({
  status: z.enum(['reported', 'in_review', 'resolved', 'dismissed']),
  adminNotes: z.string().trim().max(1000).optional(),
  vehicleAction: z.enum(['none', 'mark_unavailable', 'mark_available']).default('none'),
});

const depotPointSchema = z.object({
  latitude: z.coerce.number().min(-90).max(90),
  longitude: z.coerce.number().min(-180).max(180),
  name: z.string().trim().max(120).optional(),
  address: z.string().trim().max(300).optional(),
});

export const aiRouteOptimizeSchema = z
  .object({
    assignmentId: objectId.optional(),
    routeId: objectId.optional(),
    includeDropoff: z.boolean().optional(),
    strategy: z.enum(['nearest_neighbor', 'current', 'road_time_2opt']).optional(),
    depot: depotPointSchema.optional(),
    end: depotPointSchema.optional(),
    includeReturnToDepot: z.boolean().optional(),
  })
  .refine((v) => v.assignmentId || v.routeId, { message: 'Provide assignmentId or routeId' });

export const aiRouteReviewSchema = z.object({
  notes: z.string().trim().max(1000).optional(),
});

export const aiEtaPredictSchema = z.object({
  tripId: objectId,
});

export const aiMaintenanceAnalyzeSchema = z.object({
  vehicleId: objectId.optional(),
});

export const maintenanceRecordCreateSchema = z.object({
  vehicle: objectId,
  type: z.enum(['service', 'inspection', 'repair', 'other']).default('service'),
  status: z.enum(['scheduled', 'completed', 'overdue', 'cancelled']).default('completed'),
  serviceDate: z.coerce.date().optional(),
  dueDate: z.coerce.date().optional(),
  odometerKm: z.coerce.number().min(0).optional(),
  cost: z.coerce.number().min(0).optional(),
  notes: z.string().trim().max(2000).optional(),
  performedBy: z.string().trim().max(200).optional(),
}).refine((v) => v.serviceDate || v.dueDate || v.notes || v.type, { message: 'Provide service details' });

export const aiAssistantConversationCreateSchema = z.object({
  title: z.string().trim().max(160).optional(),
  studentId: objectId.optional(),
});

export const aiAssistantMessageSchema = z.object({
  message: z.string().trim().min(1, 'Message is required').max(4000, 'Message is too long'),
  conversationId: objectId.optional(),
  studentId: objectId.optional(),
});

const aiPublicHistoryItemSchema = z.object({
  role: z.enum(['user', 'assistant']),
  content: z.string().trim().min(1).max(1000),
});

export const aiPublicAssistantMessageSchema = z.object({
  message: z.string().trim().min(1, 'Message is required').max(1000, 'Message is too long'),
  history: z.array(aiPublicHistoryItemSchema).max(8).optional(),
});

export const aiSafetyAnalyzeSchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  tripId: objectId.optional(),
});

export const aiSafetyActionSchema = z.object({
  notes: z.string().trim().max(1000).optional(),
});

export const transportExceptionCreateSchema = z.object({
  student: objectId,
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  direction: z.enum(['morning', 'afternoon']),
  target: z.enum(['pickup', 'drop']),
  geo: z.object({
    latitude: z.coerce.number().finite().min(-90).max(90),
    longitude: z.coerce.number().finite().min(-180).max(180),
    address: z.string().trim().max(300).optional(),
    landmark: z.string().trim().max(200).optional(),
  }).optional(),
  reason: z.string().trim().max(500).optional(),
  appliesToAllDays: z.boolean().optional(),
});

export const transportExceptionReviewSchema = z.object({
  decision: z.enum(['approved', 'rejected']),
  rejectionReason: z.string().trim().max(500).optional(),
});

export const tripLocationIngestSchema = z.object({
  latitude: z.coerce.number().finite().min(-90).max(90),
  longitude: z.coerce.number().finite().min(-180).max(180),
  recordedAt: z.coerce.date(),
  accuracyMeters: z.coerce.number().min(0).max(100000).optional(),
  speedKmh: z.coerce.number().min(0).max(400).optional(),
  heading: z.coerce.number().min(0).max(360).optional(),
  source: z.enum(['driver_app', 'device', 'manual', 'system']).optional(),
});

const geofenceBaseSchema = z.object({
  name: z.string().trim().min(2).max(120),
  description: z.string().trim().max(500).optional().or(z.literal('')),
  type: z.enum(['route_corridor', 'stop_radius', 'zone']).default('zone'),
  scope: z.enum(['global', 'route', 'vehicle']).default('global'),
  route: objectId.optional(),
  vehicle: objectId.optional(),
  center: z.object({
    latitude: z.coerce.number().finite().min(-90).max(90),
    longitude: z.coerce.number().finite().min(-180).max(180),
  }).optional(),
  radiusMeters: z.coerce.number().min(10).max(100000).optional(),
  path: z.array(z.object({
    latitude: z.coerce.number().finite().min(-90).max(90),
    longitude: z.coerce.number().finite().min(-180).max(180),
  })).max(500).optional(),
  deviationThresholdMeters: z.coerce.number().min(50).max(10000).optional(),
  prolongedStopMinutes: z.coerce.number().int().min(1).max(240).optional(),
  missingUpdateMinutes: z.coerce.number().int().min(1).max(240).optional(),
  active: z.boolean().optional(),
});

export const geofenceSchema = geofenceBaseSchema.refine((v) => {
  if (v.type === 'stop_radius' || v.type === 'zone') return Boolean(v.center && Number.isFinite(v.center.latitude) && Number.isFinite(v.center.longitude) && v.radiusMeters);
  if (v.type === 'route_corridor') return Boolean((v.path && v.path.length >= 2) || (v.center && v.radiusMeters));
  return true;
}, { message: 'Provide center+radiusMeters for zone/stop_radius geofences, or a path (>=2 points) / center+radius for route_corridor geofences' }).refine((v) => {
  if (v.scope === 'route') return Boolean(v.route);
  if (v.scope === 'vehicle') return Boolean(v.vehicle);
  return true;
}, { message: 'Route-scoped geofences require route; vehicle-scoped geofences require vehicle' });

// Partial updates are validated structurally here; merged-entity consistency is enforced in service/controller.
export const geofenceUpdateSchema = geofenceBaseSchema.partial();
