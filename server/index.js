import express from 'express';

import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import apiRoutes from './routes/api.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 8011;

// Middleware
app.use(cors());
app.use(express.json({ limit: '50mb' }));

// Serve static frontend
app.use(express.static(path.join(__dirname, '..', 'public')));

// API routes
app.use('/api', apiRoutes);

// SPA fallback
app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

// Start server
const server = app.listen(PORT, () => {
    console.log(`
╔══════════════════════════════════════════════╗
║   📰  News Merger & Publisher               ║
║   🌐  http://localhost:${PORT}                  ║
║   🎯  Ready to merge and publish articles   ║
╚══════════════════════════════════════════════╝
  `);

    // Validate env
    if (!process.env.GEMINI_API_KEY) {
        console.warn('⚠️  GEMINI_API_KEY not set. Copy .env.example to .env and add your key.');
    }
    if (!process.env.WP_USER || !process.env.WP_APP_PASSWORD) {
        console.warn('⚠️  WP_USER and/or WP_APP_PASSWORD not set. WordPress publishing will fail.');
    }
});

server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
        console.error(`❌ Port ${PORT} is already in use. Stop the other process or set a different PORT in .env.`);
        process.exit(1);
    }
    console.error('❌ Server failed to start:', err);
    process.exit(1);
});

// Increase timeout significantly for long-running LLM and image tasks
server.setTimeout(15 * 60 * 1000); // 15 minutes
server.keepAliveTimeout = 15 * 60 * 1000;
server.headersTimeout = 15 * 60 * 1000 + 1000;
