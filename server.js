const express = require('express');
const app = express();
const http = require('http').createServer(app);
const { Server } = require('socket.io');
const { createCanvas } = require('canvas'); // For server-side canvas support
const fs = require('fs');
const path = require('path');

const io = new Server(http, {
    cors: {
        origin: '*',
        methods: ['GET', 'POST']
    },
    transports: ['websocket', 'polling'] // Enable WebSocket fallback
});

// Serve static files from the 'public' directory
app.use(express.static(path.join(__dirname, 'public')));

// In-memory storage for drawing history
let drawingHistory = [];

// Ensure the snapshots directory exists
const snapshotFolder = path.join(__dirname, 'snapshots');
if (!fs.existsSync(snapshotFolder)) {
    fs.mkdirSync(snapshotFolder);
    console.log('Snapshots folder created.');
}

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

// Function to save a snapshot and reset the canvas
function saveSnapshot() {
    // Create a server-side canvas
    const canvas = createCanvas(1440, 760); // Match your frontend canvas dimensions
    const ctx = canvas.getContext('2d');

    // Fill the background with #efefef (light grey)
    ctx.fillStyle = '#efefef';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    // Replay the drawing history onto the server-side canvas
    drawingHistory.forEach(data => {
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

    // Generate the snapshot filename
    const date = new Date().toLocaleDateString('en-AU').replace(/\//g, '-');
    const filename = `unframing_${date}.png`;
    const filepath = path.join(snapshotFolder, filename);

    // Save the canvas as a PNG file
    const out = fs.createWriteStream(filepath);
    const stream = canvas.createPNGStream();
    stream.pipe(out);

    out.on('finish', () => {
        console.log(`Snapshot saved: ${filepath}`);
    });

    // Clear drawing history and notify clients to reset their canvas
    drawingHistory = [];
    io.emit('clear-canvas'); // Notify clients
    console.log('Canvas reset and clients notified.');
}

// Schedule the snapshot and reset for every minute (for testing)
function scheduleSnapshot() {
    console.log('Starting the canvas snapshot schedule...');

    // Initial delay of 1 minute
    setTimeout(() => {
        saveSnapshot();
        setInterval(saveSnapshot, 60 * 1000); // Repeat every 1 minute
    }, 60 * 1000); // Initial delay set to 1 minute
}

scheduleSnapshot();

// Start the HTTP server on the correct port
const PORT = process.env.PORT || 3000;
http.listen(PORT, '0.0.0.0', () => {
    console.log(`Server is running on port ${PORT}`);
});
