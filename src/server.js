const express = require('express');
const app = express();
const http = require('http').createServer(app);
const { Server } = require('socket.io');
const cloudinary = require('cloudinary').v2;
require('dotenv').config();
const io = new Server(http, {
    cors: {
        origin: '*',
        methods: ['GET', 'POST']
    },
    transports: ['websocket', 'polling']
});
const fs = require('fs');

// Configure Cloudinary
cloudinary.config({ 
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET
});

console.log('Server script is starting...');

// Add cache control headers
app.use((req, res, next) => {
    res.set({
        'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
        'Pragma': 'no-cache',
        'Expires': '0',
        'Surrogate-Control': 'no-store'
    });
    next();
});

// Create snapshots directory if it doesn't exist
const snapshotDir = './snapshots';
if (!fs.existsSync(snapshotDir)) {
    fs.mkdirSync(snapshotDir);
}

// Serve static files from the 'public' directory
app.use(express.static('public'));

// Add rate limiter
const rateLimiters = {};

const createRateLimiter = (maxEvents, timeWindow) => {
    return (socketId) => {
        const now = Date.now();
        if (!rateLimiters[socketId]) {
            rateLimiters[socketId] = [];
        }

        // Keep only events within the time window
        rateLimiters[socketId] = rateLimiters[socketId].filter(
            (timestamp) => now - timestamp < timeWindow
        );

        // Add the current event timestamp
        rateLimiters[socketId].push(now);

        // Check if the number of events exceeds the limit
        return rateLimiters[socketId].length <= maxEvents;
    };
};

// Allow up to 60 events per second per user
const isWithinRateLimit = createRateLimiter(60, 1000);

class DrawingHistory {
    constructor() {
        this.segments = [];
        this.batchSize = 0;
        this.currentBatch = [];
        this.isResetting = false;
        this.activeDrawers = new Set();
    }

    startDrawing(socketId) {
        this.activeDrawers.add(socketId);
    }

    stopDrawing(socketId) {
        this.activeDrawers.delete(socketId);
    }

    addSegment(data, socketId) {
        if (this.isResetting) return false;
        
        if (data.type === 'draw') {
            this.currentBatch.push(data);
            this.batchSize++;

            if (this.batchSize >= 50) {
                this.commitBatch();
            }
            return true;
        } else if (data.type === 'end') {
            this.commitBatch();
            this.stopDrawing(socketId);
            return true;
        }
        return false;
    }

    commitBatch() {
        if (this.currentBatch.length > 0) {
            this.segments.push(...this.currentBatch);
            this.currentBatch = [];
            this.batchSize = 0;
        }
    }

    clear() {
        this.segments = [];
        this.currentBatch = [];
        this.batchSize = 0;
        this.activeDrawers.clear();
    }

    getFullHistory() {
        this.commitBatch();
        return this.segments;
    }

    hasDrawings() {
        return this.segments.length > 0 || this.currentBatch.length > 0;
    }

    hasActiveDrawers() {
        return this.activeDrawers.size > 0;
    }
}

// Initialize drawing history
const drawingHistory = new DrawingHistory();

// Health check endpoint for Railway
app.get('/health', (req, res) => {
    res.status(200).send('OK');
});

// Handle WebSocket connections
io.on('connection', (socket) => {
    console.log('A user connected');

    // Send the drawing history to the newly connected user
    socket.emit('drawing-history', drawingHistory.getFullHistory());

    // Handle state request when tab regains focus
    socket.on('request-state', () => {
        socket.emit('current-state', drawingHistory.getFullHistory());
    });

    // Handle drawing data with rate limiting
    socket.on('draw', (data) => {
        if (!isWithinRateLimit(socket.id)) {
            // Silently drop events exceeding the limit
            return;
        }

        const wasProcessed = drawingHistory.addSegment(data, socket.id);
        if (wasProcessed && data.type === 'draw') {
            socket.broadcast.emit('draw', data);
        }
    });

    socket.on('disconnect', () => {
        delete rateLimiters[socket.id]; // Clean up rate limiter memory
        drawingHistory.stopDrawing(socket.id);
        console.log('A user disconnected');
    });
});

// Take snapshot and reset function
const takeSnapshotAndReset = async () => {
    console.log('Taking snapshot and resetting canvas...');
    
    if (!drawingHistory.hasDrawings()) {
        console.log('No actual drawings to snapshot, skipping...');
        drawingHistory.clear();
        io.emit('force-clear-canvas', { forceEndDrawing: true });
        return;
    }

    try {
        // Set resetting flag
        drawingHistory.isResetting = true;
        
        // Store current history for snapshot
        const historyToSave = drawingHistory.getFullHistory();
        
        // Clear history and notify clients immediately
        drawingHistory.clear();
        io.emit('force-clear-canvas', { forceEndDrawing: true });

        const now = new Date();
        const filename = `unframing_${now.toISOString().replace(/[:.]/g, '-')}`;
        const tempPath = `${snapshotDir}/${filename}.png`;

        const { createCanvas } = require('canvas');
        const canvas = createCanvas(1440, 760);
        const ctx = canvas.getContext('2d');

        ctx.fillStyle = '#efefef';
        ctx.fillRect(0, 0, canvas.width, canvas.height);

        historyToSave.forEach((data) => {
            if (data.type === 'draw') {
                ctx.beginPath();
                ctx.moveTo(data.x0, data.y0);
                ctx.lineTo(data.x1, data.y1);
                ctx.lineWidth = 3;
                ctx.lineCap = 'round';
                ctx.strokeStyle = data.color;
                ctx.stroke();
            }
        });

        // First save locally
        const out = fs.createWriteStream(tempPath);
        const stream = canvas.createPNGStream();
        
        await new Promise((resolve, reject) => {
            stream.pipe(out);
            out.on('finish', resolve);
            out.on('error', reject);
        });

        // Then upload to Cloudinary
        const result = await cloudinary.uploader.upload(tempPath, {
            folder: 'unframing',
            public_id: filename
        });

        console.log(`Snapshot uploaded to Cloudinary: ${result.secure_url}`);

        // Delete local file after upload
        fs.unlinkSync(tempPath);
        
        // Reset flag after everything is done
        drawingHistory.isResetting = false;
        
        console.log('Canvas reset complete');
    } catch (error) {
        console.error('Error taking snapshot:', error);
        // Make sure to reset flag even if there's an error
        drawingHistory.isResetting = false;
    }
};

// Schedule snapshots to run every minute (for testing)
const scheduleSnapshots = () => {
    console.log('Setting up one-minute interval for snapshots...');
    
    // Log the next scheduled time
    const nextReset = new Date(Date.now() + 60 * 1000);
    console.log(`Next reset scheduled for: ${nextReset.toLocaleTimeString()}`);
    
    // Set up interval for snapshots every minute
    setInterval(() => {
        console.log('Timer triggered, attempting snapshot and reset...');
        // Force immediate clear before taking snapshot
        takeSnapshotAndReset();
        
        // Log next scheduled time
        const nextReset = new Date(Date.now() + 60 * 1000);
        console.log(`Next reset scheduled for: ${nextReset.toLocaleTimeString()}`);
    }, 60 * 1000);
};

// Initialize snapshot scheduling
scheduleSnapshots();

// Start the HTTP server on the correct port
const PORT = process.env.PORT || 3000;
http.listen(PORT, '0.0.0.0', () => {
    console.log(`Server is running on port ${PORT}`);
});
