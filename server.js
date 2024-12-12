const express = require('express');
const app = express();
const http = require('http').createServer(app);
const { Server } = require('socket.io');
const io = new Server(http, {
    cors: {
        origin: '*',
        methods: ['GET', 'POST']
    },
    transports: ['websocket', 'polling']
});
const fs = require('fs');

// Add logging to check server startup
console.log('Server script is starting...');

// Create snapshots directory if it doesn't exist
const snapshotDir = './snapshots';
if (!fs.existsSync(snapshotDir)) {
    fs.mkdirSync(snapshotDir);
}

// Serve static files from the 'public' directory
app.use(express.static('public'));

// In-memory storage for drawing history
let drawingHistory = [];

// Health check endpoint for Railway
app.get('/health', (req, res) => {
    res.status(200).send('OK');
});

// Handle WebSocket connections
io.on('connection', (socket) => {
    console.log('A user connected');

    // Send the drawing history to the newly connected user
    socket.emit('drawing-history', drawingHistory);

    // Handle drawing data
    socket.on('draw', (data) => {
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
        const now = new Date();
        const filename = `snapshots/unframing_${now.toISOString().replace(/[:.]/g, '-')}.png`;

        const { createCanvas } = require('canvas');
        const canvas = createCanvas(1440, 760);
        const ctx = canvas.getContext('2d');

        // Set background
        ctx.fillStyle = '#efefef';
        ctx.fillRect(0, 0, canvas.width, canvas.height);

        // Draw all lines
        drawingHistory.forEach((data) => {
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

        // Create write stream for the file
        const out = fs.createWriteStream(filename);
        const stream = canvas.createPNGStream();
        
        // Wait for the file to be written
        await new Promise((resolve, reject) => {
            stream.pipe(out);
            out.on('finish', resolve);
            out.on('error', reject);
        });

        console.log(`Snapshot saved as ${filename}`);
        
        // Clear the drawing history
        drawingHistory = [];
        
        // Notify all clients to clear their canvases
        io.emit('clear-canvas');
        
        console.log('Canvas reset complete');
    } catch (error) {
        console.error('Error taking snapshot:', error);
    }
};

// Schedule snapshots to run every minute (for testing)
const scheduleSnapshots = () => {
    console.log('Setting up one-minute interval for snapshots...');
    
    // Take first snapshot after 1 minute
    setTimeout(() => {
        takeSnapshotAndReset();
        // Then take snapshots every minute
        setInterval(takeSnapshotAndReset, 60 * 1000);
    }, 60 * 1000);
};

// Initialize snapshot scheduling
scheduleSnapshots();

// Start the HTTP server on the correct port
const PORT = process.env.PORT || 3000;
http.listen(PORT, '0.0.0.0', () => {
    console.log(`Server is running on port ${PORT}`);
});