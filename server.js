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
        console.log('Drawing data received:', data);

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

// Schedule snapshots and reset
const takeSnapshotAndReset = () => {
    console.log('Taking snapshot...');
    const now = new Date();
    const filename = `snapshots/unframing_${now.toISOString().split('T')[0]}.png`;

    const { createCanvas } = require('canvas');
    const canvas = createCanvas(1440, 760);
    const ctx = canvas.getContext('2d');

    ctx.fillStyle = '#efefef';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

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

    const out = fs.createWriteStream(filename);
    const stream = canvas.createPNGStream();
    stream.pipe(out);
    out.on('finish', () => console.log(`Snapshot saved as ${filename}`));

    // Clear the drawing history and notify clients
    drawingHistory = [];
    io.emit('clear-canvas');
};

// Schedule snapshots to run at midnight
const scheduleMidnightSnapshot = () => {
    const now = new Date();
    const nextMidnight = new Date();
    nextMidnight.setHours(24, 0, 0, 0); // Set to midnight
    const timeUntilMidnight = nextMidnight - now;

    console.log(`Scheduled first snapshot/reset in ${Math.ceil(timeUntilMidnight / 60000)} minutes.`);

    setTimeout(() => {
        takeSnapshotAndReset();
        setInterval(takeSnapshotAndReset, 24 * 60 * 60 * 1000); // Every 24 hours
    }, timeUntilMidnight);
};

scheduleMidnightSnapshot();

// Log before starting the server
console.log('About to start the server...');

// Start the HTTP server on the correct port
const PORT = process.env.PORT || 3000;
http.listen(PORT, '0.0.0.0', () => {
    console.log(`Server is running on port ${PORT}`);
});
