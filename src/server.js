const express = require('express');
const app = express();
const http = require('http').createServer(app);
const { Server } = require('socket.io');
require('dotenv').config();
const fs = require('fs');

// Import modules
const cloudinary = require('./config/cloudinary');
const DrawingHistory = require('./services/drawingHistory');
const initializeSocket = require('./services/socket');
const { takeSnapshot } = require('./services/snapshot');

// Initialize Socket.IO
const io = new Server(http, {
    cors: {
        origin: '*',
        methods: ['GET', 'POST'],
    },
    transports: ['websocket', 'polling'],
});

// Add cache control headers
app.use((req, res, next) => {
    res.set({
        'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
        'Pragma': 'no-cache',
        'Expires': '0',
        'Surrogate-Control': 'no-store',
    });
    next();
});

// Serve static files from the 'public' directory
app.use(express.static('public'));

// Create snapshots directory if it doesn't exist
const snapshotDir = './snapshots';
if (!fs.existsSync(snapshotDir)) {
    fs.mkdirSync(snapshotDir);
}

// Initialize services
const drawingHistory = new DrawingHistory();
initializeSocket(io, drawingHistory);

// Schedule snapshots every minute
setInterval(async () => {
    await takeSnapshot(drawingHistory, snapshotDir, io); // Pass io for real-time canvas clearing
}, 60 * 1000);

// Health check endpoint
app.get('/health', (req, res) => {
    res.status(200).send('OK');
});

// Start the HTTP server
const PORT = process.env.PORT || 3000;
http.listen(PORT, '0.0.0.0', () => {
    console.log(`Server is running on port ${PORT}`);
});
