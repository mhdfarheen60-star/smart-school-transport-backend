import { aiConfig } from '../../../config/ai.js';

export function getOptimizationProviderInfo() {
  return {
    provider: aiConfig.optimization.provider || 'heuristic',
    configured: true,
    mode: 'deterministic',
  };
}

export async function optimizeRoutePlan(input) {
  // Phase 2 will implement full constraint-aware optimization.
  // Foundation returns an explicit unavailable response rather than fabricated suggestions.
  return {
    ok: false,
    unavailable: true,
    reason: 'not_implemented',
    message: 'Route optimization engine is scaffolded but not yet implemented. No route changes have been made.',
    provider: getOptimizationProviderInfo().provider,
    mode: 'deterministic',
    inputSummary: input ? { keys: Object.keys(input) } : null,
  };
}
