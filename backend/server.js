const express = require('express');
const cors = require('cors');
const http = require('http');
const dotenv = require('dotenv');
const { initWebSocket } = require('./websocket');
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

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

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
