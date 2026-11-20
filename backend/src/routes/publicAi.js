import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { validate } from '../middleware/validate.js';
import { aiPublicAssistantMessageSchema } from '../validators/index.js';
import * as publicAssistant from '../controllers/ai/publicAssistant.controller.js';
import * as avatar from '../controllers/ai/avatar.controller.js';

const router = Router();

// Narrow public endpoint: stricter burst control in addition to service-level limiting.
const publicAssistantLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Too many requests. Please try again later.' },
});

// Avatar session creation starts a real-time video room; keep tighter limits.
const publicAvatarLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Too many requests. Please try again later.' },
});

router.get('/status', publicAssistantLimiter, publicAssistant.status);
router.post(
  '/assistant/messages',
  publicAssistantLimiter,
  validate(aiPublicAssistantMessageSchema),
  publicAssistant.sendMessage
);

// Public photorealistic human avatar (Tavus CVI). No auth, keys stay on backend.
router.get('/avatar/status', publicAvatarLimiter, avatar.publicStatus);
router.post('/avatar/conversation', publicAvatarLimiter, avatar.createPublicConversation);

export default router;
