import cors from 'cors';
import express from 'express';
import rateLimit from 'express-rate-limit';
import helmet from 'helmet';
import morgan from 'morgan';
import { env } from './config/env.js';
import { errorHandler, notFound } from './middleware/error.js';
import { sanitizeRequest } from './middleware/sanitize.js';
import api from './routes/index.js';
import { ApiError } from './utils/http.js';

const app = express();

app.disable('x-powered-by');
app.set('env', env.nodeEnv);
app.set('query parser', 'simple');
app.set('json escape', true);
if (env.trustProxy !== false) app.set('trust proxy', env.trustProxy);

const allowedOrigins = new Set(env.clientUrls);
const corsOptions = {
  origin(origin, callback) {
    if (!origin || allowedOrigins.has(origin)) return callback(null, true);
    return callback(new ApiError(403, 'Origin is not allowed by CORS'));
  },
  credentials: true,
  methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  exposedHeaders: ['Content-Disposition'],
  maxAge: 600,
  optionsSuccessStatus: 204,
};

app.use(helmet({
  contentSecurityPolicy: {
    useDefaults: false,
    directives: {
      defaultSrc: ["'none'"],
      baseUri: ["'none'"],
      formAction: ["'none'"],
      frameAncestors: ["'none'"],
      objectSrc: ["'none'"],
    },
  },
  crossOriginResourcePolicy: { policy: 'cross-origin' },
  crossOriginOpenerPolicy: { policy: 'same-origin' },
  hsts: env.isProd ? { maxAge: 15552000, includeSubDomains: true, preload: false } : false,
  referrerPolicy: { policy: 'no-referrer' },
}));

app.use((_req, res, next) => {
  res.setHeader(
    'Permissions-Policy',
    'accelerometer=(), camera=(), geolocation=(self), gyroscope=(), magnetometer=(), microphone=(), payment=(), usb=()'
  );
  res.setHeader('X-Permitted-Cross-Domain-Policies', 'none');
  res.setHeader('Cache-Control', 'no-store');
  next();
});

app.use(cors(corsOptions));
app.use(express.json({ limit: '100kb', strict: true }));
app.use(sanitizeRequest);
if (env.nodeEnv !== 'test') app.use(morgan(env.isProd ? 'combined' : 'dev'));

app.get('/api/health', (_req, res) => res.json({ success: true, data: { status: 'ok' } }));

const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 600,
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => req.path === '/health',
  message: { success: false, message: 'Too many requests. Please try again later.' },
});

app.use('/api', apiLimiter);
app.use('/api', api);

app.use(notFound);
app.use(errorHandler);

export default app;
