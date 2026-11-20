import mongoose from 'mongoose';
import { aiConfig, aiProviderStatus } from '../../config/ai.js';

export function getAiStatus() {
  const providers = aiProviderStatus();
  const dbReady = mongoose.connection.readyState === 1;
  const assistantReady = providers.assistant.configured && aiConfig.assistant.enabled;
  const routingReady = providers.routing?.configured;
  const avatarReady = Boolean(providers.avatar?.enabled);
  const features = {
    routeOptimization: {
      available: true,
      mode: routingReady ? 'implemented_with_routing_provider' : 'implemented',
      message: routingReady
        ? `Deterministic route optimization is available using existing assignment, vehicle, and location data with ${providers.routing.provider} road distance/geometry integration (subject to provider availability). Administrator approval is required before applying suggestions.`
        : 'Deterministic route optimization is available using existing assignment, vehicle, and location data. Configure AI_ROUTING_PROVIDER (OSRM_BASE_URL or GOOGLE_MAPS_API_KEY) for actual road distance/geometry; fallback estimates are used otherwise. Administrator approval is required before applying suggestions.',
    },
    etaPrediction: {
      available: true,
      mode: 'implemented',
      message: 'ETA prediction uses trip schedule, attendance progress, historical trip data, and ingested GPS location history when available. Authenticated GPS location ingestion endpoints are implemented; estimates clearly indicate GPS availability, staleness, or missing data.',
    },
    predictiveMaintenance: {
      available: true,
      mode: 'rule_based',
      message: 'Rule-based maintenance insights use vehicle records, reported problems, trip usage, and maintenance/mileage/service-history data when recorded. Outputs distinguish actual recorded signals from estimated/advisory risk. No mechanical failure predictions are made; telemetry may be limited.',
    },
    attendanceAnalytics: { available: true, mode: 'implemented', message: 'Attendance analytics are available from recorded attendance data (trends, route/class/student summaries, grounded insights).' },
    assistant: {
      available: assistantReady,
      mode: assistantReady ? 'implemented' : (aiConfig.assistant.enabled ? 'unavailable' : 'disabled'),
      message: assistantReady
        ? 'AI Transport Assistant is available with backend-configured provider access, role-scoped read-only context retrieval, and shared DB-backed rate limiting.'
        : (providers.assistant.message || 'AI assistant provider is not configured.'),
    },
    humanAvatar: {
      available: avatarReady,
      mode: avatarReady ? 'tavus_cvi' : 'unavailable',
      message: avatarReady
        ? 'Real-time photorealistic human avatar (Tavus CVI) is available for live voice/video conversations. Session creation and API keys are handled exclusively on the backend.'
        : (providers.avatar?.message || 'Photorealistic human avatar is not configured.'),
    },
    safetyMonitoring: {
      available: true,
      mode: 'rule_based',
      message: 'Deterministic safety monitoring is available from trip, route schedule, attendance records, ingested GPS/location history, and configurable geofences (when provided). Detects delays/progress anomalies and, with GPS/geofence data, missing/stale updates, prolonged stops, and route/corridor deviation indicators. Alerts are deduplicated with acknowledge/resolve workflows and are indicators for review, not confirmed incidents.',
    },
  };

  return {
    ok: true,
    service: 'ai',
    timestamp: new Date().toISOString(),
    database: { connected: dbReady },
    providers,
    features,
  };
}
