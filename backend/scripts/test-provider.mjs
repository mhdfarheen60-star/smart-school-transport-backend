import 'dotenv/config';
import { generateAssistantText } from '../src/services/ai/providers/llm.js';

const scenario = process.env.TEST_SCENARIO || 'live';
const started = Date.now();
const result = await generateAssistantText({
  system: 'You are a helpful assistant.',
  messages: [{ role: 'user', content: 'Hello. Introduce yourself in two sentences.' }],
});
console.log(
  JSON.stringify({
    scenario,
    ok: result.ok,
    reason: result.reason,
    provider: result.provider,
    model: result.model,
    retryCount: result.retryCount,
    providerMs: result.timings?.providerMs,
    elapsedMs: Date.now() - started,
    message: result.ok ? undefined : result.message,
    text: result.ok ? String(result.text).slice(0, 160) : undefined,
  })
);
