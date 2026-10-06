const { CANVAS_WIDTH, CANVAS_HEIGHT } = require('../config/canvas');

// Accept #rgb, #rrggbb, rgb(r, g, b) and rgba(r, g, b, a). Browsers normalise
// inline styles to the rgb()/rgba() form, which is what the client sends.
const COLOUR_PATTERN = /^(#[0-9a-f]{3}|#[0-9a-f]{6}|rgba?\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}\s*(,\s*(0|1|0?\.\d+)\s*)?\))$/i;

// Allow a small margin beyond the canvas so strokes that run off the edge
// aren't rejected outright.
const MARGIN = 50;

function isValidCoordinate(value, max) {
    return typeof value === 'number' &&
        Number.isFinite(value) &&
        value >= -MARGIN &&
        value <= max + MARGIN;
}

function isValidColour(colour) {
    return typeof colour === 'string' && colour.length <= 40 && COLOUR_PATTERN.test(colour);
}

function isValidSegment(data) {
    return data &&
        typeof data === 'object' &&
        data.type === 'draw' &&
        isValidCoordinate(data.x0, CANVAS_WIDTH) &&
        isValidCoordinate(data.y0, CANVAS_HEIGHT) &&
        isValidCoordinate(data.x1, CANVAS_WIDTH) &&
        isValidCoordinate(data.y1, CANVAS_HEIGHT) &&
        isValidColour(data.color);
}

const initializeSocket = (io, drawingHistory) => {
    io.engine.on('connection_error', (err) => {
        console.error('Connection error:', err.message || err);
    });

    io.on('connection', (socket) => {
        console.log('A user connected:', socket.id);

        const sendHistory = (event) => {
            try {
                socket.emit(event, drawingHistory.toWireFormat());
            } catch (error) {
                console.error(`Error sending ${event}:`, error);
                socket.emit(event, { colours: [], segments: [] });
            }
        };

        // Catch the newly connected user up with everything drawn so far
        sendHistory('drawing-history');

        // Re-sync when a tab regains focus
        socket.on('request-state', () => sendHistory('current-state'));

        socket.on('draw', (data) => {
            if (!isValidSegment(data)) {
                return; // Silently drop malformed input; don't let it reach other clients
            }

            // Only forward the fields we validated, never the raw payload
            const segment = {
                type: 'draw',
                x0: data.x0,
                y0: data.y0,
                x1: data.x1,
                y1: data.y1,
                color: data.color,
            };

            if (drawingHistory.addSegment(segment)) {
                socket.broadcast.emit('draw', segment);
            }
        });

        socket.on('error', (error) => {
            console.error('Socket error for client', socket.id, ':', error);
        });

        socket.on('disconnect', (reason) => {
            console.log(`User disconnected (${reason}):`, socket.id);
        });
    });
};

module.exports = initializeSocket;
