import app from './app.js';
import { connectDB, disconnectDB } from './config/db.js';
import { env } from './config/env.js';
import { initSocketIO } from './services/socketHandler.js';
import { cleanupExpiredLocations } from './services/tripLocation.service.js';
import { generateTripsToday } from './services/tripScheduling.service.js';
import dns from 'node:dns';

dns.setServers(['8.8.8.8']);

const GPS_CLEANUP_INTERVAL_MS = 6 * 60 * 60 * 1000; // every 6 hours
const TRIP_GENERATION_CHECK_MS = 30 * 60 * 1000; // every 30 minutes
const SCHOOL_TIMEZONE = 'Asia/Kolkata';

/**
 * Raw GPS telemetry grows quickly. Retention is enforced on a timer so the
 * database does not grow without bound on long-running deployments.
 *
 * This never deletes trip events, attendance or trip records — only raw
 * TripLocation points older than the configured retention window.
 */
function startGpsRetentionJob() {
  let running = false;

  const run = async () => {
    if (running) return;
    running = true;
    try {
      const result = await cleanupExpiredLocations();
      if (result.deleted > 0) {
        console.log(
          `GPS retention: deleted ${result.deleted} point(s) older than ${result.retentionDays} day(s)`
        );
      }
    } catch (err) {
      console.error('GPS retention job failed:', err.message);
    } finally {
      running = false;
    }
  };

  // Delay the first run so startup is not blocked by maintenance work.
  const first = setTimeout(run, 60 * 1000);
  const timer = setInterval(run, GPS_CLEANUP_INTERVAL_MS);
  first.unref?.();
  timer.unref?.();
  return () => {
    clearTimeout(first);
    clearInterval(timer);
  };
}

/**
 * Generate the day's trips automatically.
 *
 * Checking every 30 minutes (instead of a fixed midnight cron) makes the job
 * resilient to restarts, missed timers and small clock drift. Generation is
 * idempotent: existing trips are skipped, so repeated checks are safe.
 *
 * Set AUTO_TRIP_GENERATION=false to disable (e.g. in tests).
 */
function startDailyTripGenerationJob() {
  if ((process.env.AUTO_TRIP_GENERATION || 'true').toLowerCase() === 'false') {
    console.log('Daily trip generation disabled (AUTO_TRIP_GENERATION=false)');
    return () => {};
  }

  let running = false;
  let lastGeneratedDate = null;

  const todayInSchoolTz = () =>
    new Date().toLocaleDateString('en-CA', { timeZone: SCHOOL_TIMEZONE });

  const run = async () => {
    if (running) return;
    const today = todayInSchoolTz();
    if (lastGeneratedDate === today) return;
    running = true;
    try {
      const result = await generateTripsToday({ timezone: SCHOOL_TIMEZONE });
      lastGeneratedDate = today;
      if (!result.workingDay) {
        console.log(`Daily trips: ${today} is a non-working day, nothing generated`);
        return;
      }
      const trips = result.trips || [];
      const created = trips.filter((t) => t.status === 'created').length;
      const skipped = trips.filter((t) => t.status !== 'created').length;
      console.log(`Daily trips: ${today} checked, ${created} created, ${skipped} already present/skipped`);
    } catch (err) {
      // Do not set lastGeneratedDate, so the next check retries.
      console.error('Daily trip generation failed:', err.message);
    } finally {
      running = false;
    }
  };

  // Small startup delay keeps the API responsive while booting.
  const first = setTimeout(run, 30 * 1000);
  const timer = setInterval(run, TRIP_GENERATION_CHECK_MS);
  first.unref?.();
  timer.unref?.();
  return () => {
    clearTimeout(first);
    clearInterval(timer);
  };
}

async function main() {
  await connectDB();
  const server = app.listen(env.port, () => {
    console.log(`API listening on http://localhost:${env.port}/api (${env.nodeEnv})`);
  });
  initSocketIO(server);
  console.log('Socket.IO initialized');

  const stopGpsRetention = startGpsRetentionJob();
  const stopTripGeneration = startDailyTripGenerationJob();

  const shutdown = async () => {
    stopGpsRetention();
    stopTripGeneration();
    server.close();
    await disconnectDB();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
