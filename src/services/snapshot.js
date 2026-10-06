const { createCanvas } = require('canvas');
const cloudinary = require('../config/cloudinary');
const { CANVAS_WIDTH, CANVAS_HEIGHT, BACKGROUND_COLOUR, LINE_WIDTH } = require('../config/canvas');

const CLOUDINARY_FOLDER = 'unframing';
const UPLOAD_TIMEOUT_MS = 120_000;

/**
 * Retry an async operation with exponential backoff and jitter.
 */
async function withRetry(operation, { maxRetries = 3, initialDelay = 1000 } = {}) {
    let lastError = null;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            return await operation();
        } catch (error) {
            lastError = error;
            if (attempt === maxRetries) break;

            const delay = initialDelay * 2 ** (attempt - 1) * (0.5 + Math.random() * 0.5);
            console.log(`Attempt ${attempt} failed (${error.message}); retrying in ${Math.round(delay)}ms`);
            await new Promise((resolve) => setTimeout(resolve, delay));
        }
    }

    throw lastError;
}

/** Render the segment list to a PNG buffer. */
function renderToPng(history) {
    const canvas = createCanvas(CANVAS_WIDTH, CANVAS_HEIGHT);
    const ctx = canvas.getContext('2d');

    ctx.fillStyle = BACKGROUND_COLOUR;
    ctx.fillRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);

    ctx.lineWidth = LINE_WIDTH;
    ctx.lineCap = 'round';

    for (const segment of history) {
        if (segment.type !== 'draw') continue;
        ctx.beginPath();
        if (segment.x0 === segment.x1 && segment.y0 === segment.y1) {
            // A tap: drawn as a filled circle, exactly as the clients do
            ctx.arc(segment.x0, segment.y0, LINE_WIDTH / 2, 0, Math.PI * 2);
            ctx.fillStyle = segment.color;
            ctx.fill();
        } else {
            ctx.moveTo(segment.x0, segment.y0);
            ctx.lineTo(segment.x1, segment.y1);
            ctx.strokeStyle = segment.color;
            ctx.stroke();
        }
    }

    return canvas.toBuffer('image/png');
}

/** Upload a PNG buffer straight to Cloudinary without touching the disk. */
function uploadPng(buffer, publicId) {
    return new Promise((resolve, reject) => {
        const stream = cloudinary.uploader.upload_stream(
            {
                folder: CLOUDINARY_FOLDER,
                public_id: publicId,
                resource_type: 'image',
                timeout: UPLOAD_TIMEOUT_MS,
            },
            (error, result) => (error ? reject(error) : resolve(result)),
        );
        stream.end(buffer);
    });
}

/**
 * Snapshot the current canvas to Cloudinary and reset it for everyone.
 *
 * The canvas is cleared as soon as we've captured the history, so clients
 * get a prompt reset even if the upload is slow. Returns the uploaded
 * image URL, or null if there was nothing to save or the upload failed.
 */
const takeSnapshot = async (drawingHistory, io) => {
    console.log('Taking snapshot and resetting canvas...');

    if (!drawingHistory.hasDrawings()) {
        console.log('No drawings to snapshot, clearing canvas only');
        drawingHistory.clear();
        io.emit('force-clear-canvas', { epoch: drawingHistory.epoch });
        return null;
    }

    drawingHistory.isResetting = true;
    let history;
    try {
        history = drawingHistory.getFullHistory();
        drawingHistory.clear();
        io.emit('force-clear-canvas', { epoch: drawingHistory.epoch });
    } finally {
        // Accept new strokes again as soon as the old ones are captured
        drawingHistory.isResetting = false;
    }

    try {
        const publicId = `unframing_${new Date().toISOString().replace(/[:.]/g, '-')}`;
        console.log(`Rendering ${history.length} segments to PNG`);

        const png = renderToPng(history);
        const result = await withRetry(() => uploadPng(png, publicId));

        console.log(`Snapshot uploaded to Cloudinary: ${result.secure_url}`);
        return result.secure_url;
    } catch (error) {
        console.error('Error taking snapshot:', error);
        io.emit('snapshot-error', { message: 'Failed to save snapshot, but canvas was reset.' });
        return null;
    }
};

module.exports = { takeSnapshot };
