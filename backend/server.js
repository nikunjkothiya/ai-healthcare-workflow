const express = require('express');
const cors = require('cors');
const http = require('http');
const dotenv = require('dotenv');
const { initWebSocket } = require('./websocket');
const llmService = require('./services/ai/llmService');
const authRoutes = require('./routes/auth');
const campaignRoutes = require('./routes/campaigns');
const callRoutes = require('./routes/calls');
const statsRoutes = require('./routes/stats');
const adminRoutes = require('./routes/admin');
const productAdminRoutes = require('./routes/productAdmin');
const patientsRoutes = require('./routes/patients');
const { authenticateToken, requireHospitalAdmin } = require('./middleware/auth');
const { initDatabase } = require('./services/database');
const { EventBus } = require('./orchestrator/eventBus');
const sttService = require('./services/ai/sttService');
const ttsService = require('./services/ai/ttsService');

dotenv.config();

const app = express();
const server = http.createServer(app);

// Initialize EventBus
const eventBus = new EventBus();
eventBus.listen().then(() => {
  console.log('EventBus initialized and listening');
}).catch(err => {
  console.error('EventBus initialization failed:', err);
});

// Make eventBus available globally
global.eventBus = eventBus;

// Best-effort LLM, STT, and TTS availability checks on startup.
// This does NOT block server startup but gives early visibility into model health.
llmService.checkAvailability().then((ok) => {
  if (!ok) {
    console.warn('LLM availability check failed at startup. Live calls may be unavailable until models are healthy.');
  }
}).catch((err) => {
  console.warn('LLM startup availability check threw an error:', err.message);
});

sttService.healthCheck().then((ok) => {
  if (ok) {
    console.log(`STT service is healthy (${sttService.sttProvider})`);
  } else {
    console.warn(`STT service health check failed at startup (${sttService.sttProvider}). Realtime transcription may fail.`);
  }
}).catch((err) => {
  console.warn('STT startup health check threw an error:', err.message);
});

ttsService.healthCheck().then((ok) => {
  if (ok) {
    console.log(`TTS service is healthy (${ttsService.ttsProvider})`);
  } else {
    console.warn(`TTS service health check failed at startup (${ttsService.ttsProvider}). Speech synthesis may fail.`);
  }
}).catch((err) => {
  console.warn('TTS startup health check threw an error:', err.message);
});

// Middleware
app.use(cors({
  origin: process.env.CORS_ORIGIN || '*',
  methods: ['GET', 'POST', 'PUT', 'DELETE'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Rate limiting for auth endpoints
const rateLimit = require('express-rate-limit');
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  message: { error: 'Too many requests, please try again later' },
  standardHeaders: true,
  legacyHeaders: false
});
app.use('/auth', authLimiter);

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Routes
app.use('/auth', authRoutes);
app.use('/campaigns', authenticateToken, requireHospitalAdmin, campaignRoutes);
app.use('/calls', authenticateToken, requireHospitalAdmin, callRoutes);
app.use('/stats', authenticateToken, requireHospitalAdmin, statsRoutes);
app.use('/admin', adminRoutes);
app.use('/product-admin', authenticateToken, productAdminRoutes);
app.use('/patients', patientsRoutes);

// Initialize WebSocket
initWebSocket(server);

// Initialize database connection
initDatabase().then(() => {
  console.log('Database connected successfully');
}).catch(err => {
  console.error('Database connection failed:', err);
  process.exit(1);
});

const PORT = process.env.PORT || 4000;

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Backend server running on port ${PORT}`);
  console.log(`WebSocket server ready`);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM received, closing server...');
  server.close(() => {
    console.log('Server closed');
    process.exit(0);
  });
});
