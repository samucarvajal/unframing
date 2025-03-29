const initializeSocket = (io, drawingHistory) => {
    // Handle server-side socket.io errors
    io.engine.on('connection_error', (err) => {
        console.error('Connection error:', err);
    });

    io.on('connect_error', (err) => {
        console.error('Socket.IO connection error:', err);
    });

    io.on('connection', (socket) => {
        console.log('A user connected:', socket.id);

        // Validate data safety for error handling
        const safelyProcessDrawingData = (data) => {
            try {
                // Validate incoming data
                if (!data || typeof data !== 'object') {
                    console.error('Invalid drawing data received');
                    return false;
                }

                if (data.type === 'draw') {
                    // Validate coordinates and color for drawing
                    if (!isValidCoordinate(data.x0) || !isValidCoordinate(data.y0) ||
                        !isValidCoordinate(data.x1) || !isValidCoordinate(data.y1) ||
                        !isValidColor(data.color)) {
                        console.error('Invalid drawing coordinates or color');
                        return false;
                    }
                }

                // Process the data
                const wasProcessed = drawingHistory.addSegment(data, socket.id);
                if (wasProcessed && data.type === 'draw') {
                    // Only broadcast valid data
                    socket.broadcast.emit('draw', data);
                }
                return wasProcessed;
            } catch (error) {
                console.error('Error processing drawing data:', error);
                return false;
            }
        };

        try {
            // Send the drawing history to the newly connected user
            socket.emit('drawing-history', drawingHistory.getFullHistory());
        } catch (error) {
            console.error('Error sending drawing history to new user:', error);
            // Try to send an empty array as fallback
            socket.emit('drawing-history', []);
        }

        // Handle state request when tab regains focus
        socket.on('request-state', () => {
            try {
                socket.emit('current-state', drawingHistory.getFullHistory());
            } catch (error) {
                console.error('Error sending current state:', error);
                // Send empty array as fallback
                socket.emit('current-state', []);
            }
        });

        // Handle drawing data with error catching
        socket.on('draw', (data) => {
            safelyProcessDrawingData(data);
        });

        // Error handling for socket
        socket.on('error', (error) => {
            console.error('Socket error for client', socket.id, ':', error);
        });

        // Handle user disconnection
        socket.on('disconnect', (reason) => {
            try {
                drawingHistory.stopDrawing(socket.id);
                console.log(`User disconnected (${reason}):`, socket.id);
            } catch (error) {
                console.error('Error handling disconnect:', error);
            }
        });
    });
};

// Validation helper functions
function isValidCoordinate(value) {
    return typeof value === 'number' && !isNaN(value) && isFinite(value);
}

function isValidColor(color) {
    return typeof color === 'string' && 
           (color.startsWith('#') || color.startsWith('rgb') || color.startsWith('rgba'));
}

module.exports = initializeSocket;