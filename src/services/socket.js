const { CANVAS_WIDTH, CANVAS_HEIGHT } = require('../config/canvas');

// Accept #rgb, #rrggbb, rgb(r, g, b) and rgba(r, g, b, a). Browsers normalise
// inline styles to the rgb()/rgba() form, which is what the client sends.
const COLOUR_PATTERN = /^(#[0-9a-f]{3}|#[0-9a-f]{6}|rgba?\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}\s*(,\s*(0|1|0?\.\d+)\s*)?\))$/i;

// Strokes may run slightly off the canvas edge; anything further is clamped
// rather than dropped, so what the drawer sees is what everyone else sees.
const MARGIN = 50;

// Don't flood the logs if a client misbehaves
let rejectionsLogged = 0;
const MAX_REJECTIONS_LOGGED = 50;

function logRejection(socketId, reason, data) {
    if (rejectionsLogged++ < MAX_REJECTIONS_LOGGED) {
        console.warn(`Rejected draw from ${socketId}: ${reason}`, JSON.stringify(data)?.slice(0, 200));
    }
}

function isFiniteNumber(value) {
    return typeof value === 'number' && Number.isFinite(value);
}

function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
}

function isValidColour(colour) {
    return typeof colour === 'string' && colour.length <= 40 && COLOUR_PATTERN.test(colour);
}

/**
 * Turn an incoming payload into a clean segment, or return null (with a
 * reason) if it can't be salvaged. Only the fields we validated are kept.
 */
function sanitiseSegment(data) {
    if (!data || typeof data !== 'object') return { error: 'not an object' };
    if (data.type !== 'draw') return { error: `unexpected type ${data.type}` };

    const coords = [data.x0, data.y0, data.x1, data.y1];
    if (!coords.every(isFiniteNumber)) return { error: 'non-numeric coordinate' };
    if (!isValidColour(data.color)) return { error: `bad colour ${data.color}` };

    return {
        segment: {
            type: 'draw',
            x0: clamp(data.x0, -MARGIN, CANVAS_WIDTH + MARGIN),
            y0: clamp(data.y0, -MARGIN, CANVAS_HEIGHT + MARGIN),
            x1: clamp(data.x1, -MARGIN, CANVAS_WIDTH + MARGIN),
            y1: clamp(data.y1, -MARGIN, CANVAS_HEIGHT + MARGIN),
            color: data.color,
        },
    };
}

const initializeSocket = (io, drawingHistory) => {
    io.engine.on('connection_error', (err) => {
        console.error('Connection error:', err.message || err);
    });

    io.on('connection', (socket) => {
        console.log('A user connected:', socket.id);

        const sendState = (event, afterSeq = 0) => {
            try {
                socket.emit(event, drawingHistory.toWireFormat(afterSeq));
            } catch (error) {
                console.error(`Error sending ${event}:`, error);
            }
        };

        // Catch the newly connected user up with everything drawn so far
        sendState('drawing-history');

        // Legacy full re-sync (kept for any client still on the old script)
        socket.on('request-state', () => sendState('current-state'));

        /**
         * Consistency check. The client says where it thinks it is; we reply
         * only if it's behind. A different epoch means the canvas was reset
         * (or the server restarted) and it missed the news, so it gets the
         * whole canvas; otherwise just the segments it hasn't seen.
         */
        socket.on('sync', (client) => {
            const epoch = client && Number(client.epoch);
            const seq = client && Number(client.seq);

            if (epoch !== drawingHistory.epoch || !Number.isFinite(seq)) {
                sendState('sync-state', 0);
            } else if (seq < drawingHistory.seq) {
                sendState('sync-state', seq);
            }
            // else: fully in sync, nothing to send
        });

        /**
         * A new segment. The ack carries the segment's sequence number (or 0
         * if it was rejected) so the drawer can track its own position in the
         * stream without being sent its own strokes back.
         */
        socket.on('draw', (data, ack) => {
            const { segment, error } = sanitiseSegment(data);
            const reply = typeof ack === 'function' ? ack : () => {};

            if (!segment) {
                logRejection(socket.id, error, data);
                reply({ epoch: drawingHistory.epoch, seq: 0 });
                return;
            }

            const seq = drawingHistory.addSegment(segment);
            if (seq === 0) {
                // Mid-reset or history full; the drawer will catch up on the next sync
                reply({ epoch: drawingHistory.epoch, seq: 0 });
                return;
            }

            reply({ epoch: drawingHistory.epoch, seq });
            socket.broadcast.emit('draw', { ...segment, epoch: drawingHistory.epoch, seq });
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
