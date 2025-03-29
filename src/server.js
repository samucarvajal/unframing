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

// Global error handler
process.on('uncaughtException', (error) => {
    console.error('Uncaught Exception:', error);
    // Continue running - we don't want to crash the server due to non-critical errors
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('Unhandled Rejection at:', promise, 'reason:', reason);
    // Continue running - we don't want to crash the server due to non-critical errors
});

// Initialize Socket.IO with ping timeout and interval settings for better connection management
const io = new Server(http, {
    cors: {
        origin: '*',
        methods: ['GET', 'POST'],
    },
    transports: ['websocket', 'polling'],
    pingTimeout: 60000, // How long to wait for a ping response (60 seconds)
    pingInterval: 25000, // How often to ping (25 seconds)
    connectTimeout: 45000, // Connection timeout (45 seconds)
    maxHttpBufferSize: 1e6, // 1MB max payload size
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

// Error handling middleware
app.use((err, req, res, next) => {
    console.error('Express error:', err);
    res.status(500).send('Something went wrong');
});

// Serve static files from the 'public' directory
app.use(express.static('public'));

// Create snapshots directory if it doesn't exist
const snapshotDir = './snapshots';
if (!fs.existsSync(snapshotDir)) {
    fs.mkdirSync(snapshotDir, { recursive: true });
}

// Initialize services
const drawingHistory = new DrawingHistory();
initializeSocket(io, drawingHistory);

// Track snapshot interval for proper cleanup
let snapshotInterval = null;

// Schedule snapshots every hour (3600000ms) with error handling
const startSnapshotInterval = () => {
    if (snapshotInterval) {
        clearInterval(snapshotInterval);
    }
    
    // Changed from 60 * 1000 (1 minute) to 60 * 60 * 1000 (1 hour)
    const ONE_HOUR = 60 * 60 * 1000;
    
    snapshotInterval = setInterval(async () => {
        try {
            console.log('Taking hourly snapshot...');
            await takeSnapshot(drawingHistory, snapshotDir, io);
        } catch (error) {
            console.error('Error in snapshot interval:', error);
            // Keep the interval running even if a snapshot fails
        }
    }, ONE_HOUR);
    
    console.log('Snapshot interval set to 1 hour');
};

startSnapshotInterval();

// Health check endpoint
app.get('/health', (req, res) => {
    res.status(200).send('OK');
});

// Start the HTTP server
const PORT = process.env.PORT || 3000;
const server = http.listen(PORT, '0.0.0.0', () => {
    console.log(`Server is running on port ${PORT}`);
});

// Graceful shutdown handling
const gracefulShutdown = async () => {
    console.log('Shutting down gracefully...');
    
    // Clear the snapshot interval
    if (snapshotInterval) {
        clearInterval(snapshotInterval);
    }
    
    // Take a final snapshot if there are drawings
    if (drawingHistory.hasDrawings()) {
        try {
            console.log('Taking final snapshot before shutdown...');
            await takeSnapshot(drawingHistory, snapshotDir, io);
        } catch (error) {
            console.error('Error taking final snapshot:', error);
        }
    }
    
    // Close the Socket.IO server
    io.close((err) => {
        if (err) {
            console.error('Error closing Socket.IO:', err);
        } else {
            console.log('Socket.IO server closed');
        }
        
        // Close the HTTP server
        server.close((err) => {
            if (err) {
                console.error('Error closing HTTP server:', err);
                process.exit(1);
            } else {
                console.log('HTTP server closed');
                process.exit(0);
            }
        });
    });
    
    // Force shutdown after 10 seconds if graceful shutdown fails
    setTimeout(() => {
        console.error('Forceful shutdown after timeout');
        process.exit(1);
    }, 10000);
};

// Listen for termination signals
process.on('SIGTERM', gracefulShutdown);
process.on('SIGINT', gracefulShutdown);