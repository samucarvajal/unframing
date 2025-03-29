const fs = require('fs');
const { createCanvas } = require('canvas');
const cloudinary = require('../config/cloudinary');

/**
 * Handles retrying operations with exponential backoff
 * @param {Function} operation - Function to retry
 * @param {Object} options - Retry options
 * @returns {Promise} - Result of the operation
 */
async function withRetry(operation, options = {}) {
    const maxRetries = options.maxRetries || 3;
    const initialDelay = options.initialDelay || 1000;
    
    let attempt = 0;
    let lastError = null;
    
    while (attempt < maxRetries) {
        try {
            return await operation();
        } catch (error) {
            lastError = error;
            attempt++;
            
            if (attempt >= maxRetries) {
                break;
            }
            
            // Exponential backoff with jitter
            const delay = initialDelay * Math.pow(2, attempt - 1) * (0.5 + Math.random() * 0.5);
            console.log(`Retry attempt ${attempt} after ${Math.round(delay)}ms`);
            await new Promise(resolve => setTimeout(resolve, delay));
        }
    }
    
    throw lastError;
}

const takeSnapshot = async (drawingHistory, snapshotDir, io) => {
    console.log('Taking snapshot and resetting canvas...');

    if (!drawingHistory.hasDrawings()) {
        console.log('No actual drawings to snapshot, skipping...');
        drawingHistory.clear();
        io.emit('force-clear-canvas', { forceEndDrawing: true }); // Notify all clients
        return null;
    }

    try {
        drawingHistory.isResetting = true;

        // Get the history before clearing
        const historyToSave = drawingHistory.getFullHistory();
        
        // Create a copy of the history for use in case of error
        const historyCopy = JSON.parse(JSON.stringify(historyToSave));
        
        // Reset the canvas after we've got a copy of the history
        drawingHistory.clear();
        io.emit('force-clear-canvas', { forceEndDrawing: true }); // Notify all clients

        const now = new Date();
        const filename = `unframing_${now.toISOString().replace(/[:.]/g, '-')}`;
        const tempPath = `${snapshotDir}/${filename}.png`;

        // Ensure snapshot directory exists
        if (!fs.existsSync(snapshotDir)) {
            fs.mkdirSync(snapshotDir, { recursive: true });
        }

        // Updated canvas size to 2880x1800
        const canvas = createCanvas(2880, 1800);
        const ctx = canvas.getContext('2d');

        // Draw the canvas
        ctx.fillStyle = '#efefef';
        ctx.fillRect(0, 0, canvas.width, canvas.height);

        historyToSave.forEach((data) => {
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

        // Save locally with retry
        await withRetry(async () => {
            return new Promise((resolve, reject) => {
                const out = fs.createWriteStream(tempPath);
                const stream = canvas.createPNGStream();
                stream.pipe(out);
                out.on('finish', resolve);
                out.on('error', reject);
            });
        });

        // Upload to Cloudinary with retry
        const result = await withRetry(async () => {
            return cloudinary.uploader.upload(tempPath, {
                folder: 'unframing',
                public_id: filename,
                timeout: 120000, // 2 minute timeout for large uploads
            });
        });

        console.log(`Snapshot uploaded to Cloudinary: ${result.secure_url}`);
        
        // Clean up the temp file with error handling
        try {
            fs.unlinkSync(tempPath);
        } catch (error) {
            console.error('Error removing temporary file:', error);
            // Non-fatal error, we can continue
        }
        
        drawingHistory.isResetting = false;
        return result.secure_url;
        
    } catch (error) {
        console.error('Error taking snapshot:', error);
        drawingHistory.isResetting = false;
        
        // Let clients know the snapshot failed but the canvas was cleared
        io.emit('snapshot-error', { message: 'Failed to save snapshot, but canvas was reset.' });
        
        return null;
    }
};

module.exports = { takeSnapshot };