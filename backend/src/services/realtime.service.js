/**
 * Small indirection around the Socket.IO server instance.
 *
 * Keeping the server instance here avoids a circular import between the socket
 * bootstrap and the services that need to publish trip events.
 */
let ioInstance = null;

export const rooms = {
  trip: (tripId) => `trip:${tripId}`,
  tripStudent: (tripId, studentId) => `trip:${tripId}:student:${studentId}`,
  driver: (driverId) => `driver:${driverId}`,
  fleet: () => 'fleet:admin',
};

export function setIO(io) {
  ioInstance = io;
}

export function getIO() {
  return ioInstance;
}

export function emitToTrip(tripId, event, payload) {
  if (!ioInstance || !tripId) return;
  ioInstance.to(rooms.trip(tripId)).emit(event, payload);
}

export function emitToFleet(event, payload) {
  if (!ioInstance) return;
  ioInstance.to(rooms.fleet()).emit(event, payload);
}

export function emitToDriver(driverId, event, payload) {
  if (!ioInstance || !driverId) return;
  ioInstance.to(rooms.driver(driverId)).emit(event, payload);
}

export function emitToTripStudent(tripId, studentId, event, payload) {
  if (!ioInstance || !tripId || !studentId) return;
  ioInstance.to(rooms.tripStudent(tripId, studentId)).emit(event, payload);
}
