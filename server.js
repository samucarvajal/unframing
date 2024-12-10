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

// Serve static files from the 'public' directory
app.use(express.static(path.join(__dirname, 'public')));

// In-memory storage for drawing history
let drawingHistory = [];

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

// Start the HTTP server
const PORT = process.env.PORT || 3000;
http.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});
