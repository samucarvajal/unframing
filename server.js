const express = require('express');
const app = express();
const http = require('http').createServer(app);
const { Server } = require('socket.io');
const cloudinary = require('cloudinary').v2;
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
    cloud_name: 'du4xsnsjd', 
    api_key: '211798632235737', 
    api_secret: 'iKEjrcFjO4WYrqILrrcWqwz55wc'
});

// Add logging to check server startup
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

// In-memory storage for drawing history
let drawingHistory = [];
let isResetting = false;

// Health check endpoint for Railway
app.get('/health', (req, res) => {
    res.status(200).send('OK');
});

// Handle WebSocket connections
io.on('connection', (socket) => {
    console.log('A user connected');

    // Send the drawing history to the newly connected user
    socket.emit('drawing-history', drawingHistory);

    // Handle state request when tab regains focus
    socket.on('request-state', () => {
        socket.emit('current-state', drawingHistory);
    });

    // Handle drawing data
    socket.on('draw', (data) => {
        // Don't process new drawings during reset
        if (isResetting) return;

        // Save the drawing data to history
        drawingHistory.push(data);

        // Broadcast the drawing data to other users
        socket.broadcast.emit('draw', data);
    });

    // Handle disconnection
    socket.on('disconnect', () => {
        console.log('A user disconnected');
    });
});

// Take snapshot and reset function
const takeSnapshotAndReset = async () => {
    console.log('Taking snapshot and resetting canvas...');
    
    if (drawingHistory.length === 0) {
        console.log('No drawings to snapshot, skipping...');
        return;
    }

    try {
        // Set resetting flag
        isResetting = true;
        
        // Store current history for snapshot
        const historyToSave = [...drawingHistory];
        
        // Clear history and notify clients immediately
        drawingHistory = [];
        io.emit('force-clear-canvas', { timestamp: Date.now() });

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
        isResetting = false;
        
        console.log('Canvas reset complete');
    } catch (error) {
        console.error('Error taking snapshot:', error);
        // Make sure to reset flag even if there's an error
        isResetting = false;
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
        io.emit('force-clear-canvas', { timestamp: Date.now() });
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