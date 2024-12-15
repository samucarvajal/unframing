const initializeSocket = (io, drawingHistory) => {
    io.on('connection', (socket) => {
        console.log('A user connected:', socket.id);

        // Send the drawing history to the newly connected user
        socket.emit('drawing-history', drawingHistory.getFullHistory());

        // Handle state request when tab regains focus
        socket.on('request-state', () => {
            socket.emit('current-state', drawingHistory.getFullHistory());
        });

        // Handle drawing data
        socket.on('draw', (data) => {
            const wasProcessed = drawingHistory.addSegment(data, socket.id);
            if (wasProcessed && data.type === 'draw') {
                socket.broadcast.emit('draw', data);
            }
        });

        // Handle user disconnection
        socket.on('disconnect', () => {
            drawingHistory.stopDrawing(socket.id);
            console.log('A user disconnected:', socket.id);
        });
    });
};

module.exports = initializeSocket;
