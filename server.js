const express = require('express');
const app = express();
const http = require('http').createServer(app);
const { Server } = require('socket.io');
const io = new Server(http, {
    cors: {
        origin: '*',
        methods: ['GET', 'POST']
    },
    transports: ['websocket', 'polling'] // Enable WebSocket fallback
});
const path = require('path');
const fs = require('fs');

// Ensure the snapshots directory exists
const snapshotPath = path.join(__dirname, 'snapshots');
if (!fs.existsSync(snapshotPath)) {
    fs.mkdirSync(snapshotPath);
    console.log('Snapshots folder created.');
}

// Serve static files from the 'public' directory
app.use(express.static(path.join(__dirname, 'public')));

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

// Start the HTTP server on the correct port
const PORT = process.env.PORT || 3000;
http.listen(PORT, '0.0.0.0', () => {
    console.log(`Server is running on port ${PORT}`);
});
