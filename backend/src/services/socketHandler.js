import { Server } from 'socket.io';
import jwt from 'jsonwebtoken';
import { env } from '../config/env.js';
import { User } from '../models/index.js';
import { ApiError } from '../utils/http.js';
import { audit } from './audit.service.js';
import { rooms, setIO } from './realtime.service.js';
import { createSocketAccess, isTerminal } from './socketAccess.js';
import { recordTripEvent as defaultRecordTripEvent } from './tripEvent.service.js';
import { ingestTripLocation as defaultIngestTripLocation } from './tripLocation.service.js';

const ALLOWED_SOCKET_TRIP_EVENTS = new Set(['gps_connection_lost', 'gps_connection_restored']);
const RATE_LIMIT_WINDOW_MS = 10_000;
const RATE_LIMIT_MAX = 40;
const MAX_AUTO_JOIN_TRIPS = 25;

function safeClientMessage(err, fallback = 'Request failed') {
  if (err instanceof ApiError && Number(err.status) < 500) {
    return err.message || fallback;
  }
  if (err && typeof err.status === 'number' && err.status < 500 && typeof err.message === 'string') {
    return err.message;
  }
  return fallback;
}

function extractToken(socket) {
  const authToken = socket?.handshake?.auth?.token;
  if (authToken) return authToken;
  const header = socket?.handshake?.headers?.authorization;
  if (!header) return null;
  return String(header).replace(/^Bearer\s+/i, '');
}

function createDefaultAuthenticateSocket({ UserModel = User, jwtLib = jwt, envConfig = env } = {}) {
  return async function authenticateSocket(token) {
    if (!token) throw new ApiError(401, 'Authentication required');
    let payload;
    try {
      payload = jwtLib.verify(token, envConfig.jwtSecret, {
        algorithms: ['HS256'],
        issuer: envConfig.jwtIssuer,
        audience: envConfig.jwtAudience,
      });
    } catch {
      throw new ApiError(401, 'Invalid or expired session');
    }
    const user = await UserModel.findById(payload.sub).select('name role isActive tokenVersion').lean();
    const id = user?._id || user?.id || payload.sub;
    if (!user || !user.isActive) throw new ApiError(401, 'Account not found or disabled');
    if (Number(payload.ver ?? 0) !== Number(user.tokenVersion ?? 0)) {
      throw new ApiError(401, 'Session is no longer valid. Please sign in again.');
    }
    return { id: String(id), role: user.role, name: user.name };
  };
}

function parseTripId(input) {
  if (typeof input === 'string') return input;
  if (input && typeof input === 'object' && typeof input.tripId === 'string') return input.tripId;
  return null;
}

function ackCallback(maybeAck) {
  return typeof maybeAck === 'function' ? maybeAck : null;
}

function createRateLimiter() {
  const state = { count: 0, resetAt: Date.now() + RATE_LIMIT_WINDOW_MS };
  return () => {
    const now = Date.now();
    if (now >= state.resetAt) {
      state.count = 0;
      state.resetAt = now + RATE_LIMIT_WINDOW_MS;
    }
    state.count += 1;
    return state.count <= RATE_LIMIT_MAX;
  };
}

function joinTripRooms(socket, tripId, studentIds) {
  socket.join(rooms.trip(tripId));
  if (Array.isArray(studentIds)) {
    for (const studentId of studentIds) {
      if (studentId) socket.join(rooms.tripStudent(tripId, studentId));
    }
  }
}

function leaveTripRooms(socket, tripId) {
  const tripRoom = rooms.trip(tripId);
  const prefix = `${tripRoom}:student:`;
  socket.leave(tripRoom);
  for (const room of socket.rooms) {
    if (typeof room === 'string' && room.startsWith(prefix)) {
      socket.leave(room);
    }
  }
}

export function initSocketIO(httpServer, overrides = {}) {
  const access = overrides.access || createSocketAccess(overrides.accessDeps || {});
  const ingestTripLocation = overrides.ingestTripLocation || defaultIngestTripLocation;
  const recordTripEvent = overrides.recordTripEvent || defaultRecordTripEvent;
  const auditService = overrides.audit || audit;
  const authenticateSocket =
    overrides.authenticateSocket ||
    createDefaultAuthenticateSocket({
      UserModel: overrides.UserModel || User,
      jwtLib: overrides.jwt || jwt,
      envConfig: overrides.env || env,
    });
  const ioOptions = overrides.ioOptions || {};

  const io = new Server(httpServer, {
    maxHttpBufferSize: 16 * 1024,
    cors: {
      origin: env.clientUrls,
      credentials: true,
      methods: ['GET', 'POST'],
    },
    pingTimeout: 20000,
    pingInterval: 10000,
    ...ioOptions,
  });
  setIO(io);

  io.use(async (socket, next) => {
    try {
      const token = extractToken(socket);
      const user = await authenticateSocket(token);
      const identity = await access.loadIdentity(user);
      if (!identity) {
        next(new ApiError(403, 'Not authorized for realtime access'));
        return;
      }
      socket.user = user;
      socket.identity = identity;
      next();
    } catch (err) {
      next(err instanceof Error ? err : new Error('Authentication failed'));
    }
  });

  io.on('connection', (socket) => {
    const { user, identity } = socket;
    const allowEvent = createRateLimiter();

    const guarded = (handler) => async (...args) => {
      try {
        if (!allowEvent()) {
          socket.emit('rate_limited', { message: 'Too many realtime events. Please slow down.' });
          const maybeAck = ackCallback(args[args.length - 1]);
          if (maybeAck) maybeAck({ ok: false, message: 'Too many realtime events. Please slow down.' });
          return;
        }
        await handler(...args);
      } catch (err) {
        const message = safeClientMessage(err);
        // Best-effort: handlers emit specific error events; this is a last resort.
        try {
          socket.emit('error', { message });
        } catch {
          /* ignore */
        }
      }
    };

    (async () => {
      try {
        if (identity.role === 'admin') {
          socket.join(rooms.fleet());
        } else if (identity.role === 'driver' && identity.driverId) {
          socket.join(rooms.driver(identity.driverId));
        }

        const autoTrips = await access.listAutoJoinTrips(identity);
        const limited = Array.isArray(autoTrips) ? autoTrips.slice(0, MAX_AUTO_JOIN_TRIPS) : [];
        for (const item of limited) {
          if (!item?.trip?._id) continue;
          joinTripRooms(socket, item.trip._id, item.studentIds);
          try {
            const snapshot = await access.getTripSnapshot(item.trip);
            socket.emit('trip_snapshot', snapshot);
          } catch {
            /* snapshot failure must not break connection */
          }
        }
      } catch {
        /* connection setup must not throw */
      }
    })();

    socket.on(
      'join_trip',
      guarded(async (input, maybeAck) => {
        const ack = ackCallback(maybeAck);
        const tripId = parseTripId(input);
        if (!tripId) {
          const message = 'Trip id is required';
          socket.emit('join_denied', { tripId: null, message });
          if (ack) ack({ ok: false, message });
          return;
        }
        try {
          const { trip, studentIds } = await access.authorizeTrip(identity, tripId);
          joinTripRooms(socket, trip._id, studentIds);
          const snapshot = await access.getTripSnapshot(trip);
          const payload = { tripId: String(trip._id), ok: true };
          socket.emit('joined', payload);
          socket.emit('trip_snapshot', snapshot);
          if (ack) ack({ ok: true, tripId: String(trip._id) });

          if (identity.role === 'admin') {
            try {
              await auditService(
                { user: { id: user.id, role: user.role }, ip: socket.handshake?.address },
                'socket.join_trip',
                'Trip',
                String(trip._id),
                { source: 'socket' }
              );
            } catch {
              /* audit failure must not block realtime join */
            }
          }
        } catch (err) {
          const message = safeClientMessage(err, 'You are not authorized to access this trip');
          socket.emit('join_denied', { tripId: String(tripId), message });
          if (ack) ack({ ok: false, message });
        }
      })
    );

    socket.on(
      'leave_trip',
      guarded(async (input, maybeAck) => {
        const ack = ackCallback(maybeAck);
        const tripId = parseTripId(input);
        if (!tripId) {
          if (ack) ack({ ok: false, message: 'Trip id is required' });
          return;
        }
        leaveTripRooms(socket, tripId);
        socket.emit('left', { room: rooms.trip(tripId), tripId: String(tripId) });
        if (ack) ack({ ok: true, tripId: String(tripId) });
      })
    );

    socket.on(
      'gps_update',
      guarded(async (data) => {
        try {
          if (identity.role !== 'driver') {
            socket.emit('gps_error', { message: 'Not authorized to submit GPS' });
            return;
          }
          const tripId = data?.tripId;
          if (!tripId) {
            socket.emit('gps_error', { message: 'Trip id is required' });
            return;
          }
          const result = await ingestTripLocation(
            { user: { id: user.id, role: user.role } },
            tripId,
            {
              latitude: data?.latitude,
              longitude: data?.longitude,
              recordedAt: data?.recordedAt,
              accuracyMeters: data?.accuracyMeters,
              speedKmh: data?.speedKmh,
              heading: data?.heading,
              source: 'driver_app',
            }
          );
          const recordedAt = result?.location?.recordedAt || data?.recordedAt;
          socket.emit('gps_ack', { tripId: String(tripId), recordedAt });
        } catch (err) {
          socket.emit('gps_error', { message: safeClientMessage(err, 'GPS update failed') });
        }
      })
    );

    socket.on(
      'trip_event',
      guarded(async (data) => {
        try {
          if (identity.role !== 'driver') {
            socket.emit('trip_event_error', { message: 'Not authorized to post trip events' });
            return;
          }
          const tripId = data?.tripId;
          const event = data?.event;
          if (!tripId || !event) {
            socket.emit('trip_event_error', { message: 'Missing tripId or event' });
            return;
          }
          if (!ALLOWED_SOCKET_TRIP_EVENTS.has(event)) {
            socket.emit('trip_event_error', {
              message: 'This event must be submitted through the REST API',
            });
            return;
          }

          const { trip } = await access.authorizeTrip(identity, tripId);
          if (isTerminal(trip.status)) {
            socket.emit('trip_event_error', { message: 'Cannot post events for a finished trip' });
            return;
          }

          await recordTripEvent({
            trip,
            eventType: event,
            actor: user.id,
            actorRole: user.role,
            source: 'socket',
            occurredAt: new Date(),
          });

          socket.emit('event_ack', { tripId: String(trip._id), event });
        } catch (err) {
          socket.emit('trip_event_error', {
            message: safeClientMessage(err, 'Trip event failed'),
          });
        }
      })
    );

    socket.on('disconnect', () => {
      // Socket.IO handles room cleanup automatically
    });
  });

  return io;
}
