const fs = require('fs');
const { createCanvas } = require('canvas');
const cloudinary = require('../config/cloudinary');

const takeSnapshot = async (drawingHistory, snapshotDir) => {
    console.log('Taking snapshot and resetting canvas...');

    if (!drawingHistory.hasDrawings()) {
        console.log('No actual drawings to snapshot, skipping...');
        drawingHistory.clear();
        return null;
    }

    try {
        drawingHistory.isResetting = true;
        const historyToSave = drawingHistory.getFullHistory();
        drawingHistory.clear();

        const now = new Date();
        const filename = `unframing_${now.toISOString().replace(/[:.]/g, '-')}`;
        const tempPath = `${snapshotDir}/${filename}.png`;

        const canvas = createCanvas(1440, 760);
        const ctx = canvas.getContext('2d');

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

        // Save locally
        await new Promise((resolve, reject) => {
            const out = fs.createWriteStream(tempPath);
            const stream = canvas.createPNGStream();
            stream.pipe(out);
            out.on('finish', resolve);
            out.on('error', reject);
        });

        // Upload to Cloudinary
        const result = await cloudinary.uploader.upload(tempPath, {
            folder: 'unframing',
            public_id: filename,
        });

        console.log(`Snapshot uploaded to Cloudinary: ${result.secure_url}`);
        fs.unlinkSync(tempPath);
        drawingHistory.isResetting = false;

        return result.secure_url;
    } catch (error) {
        console.error('Error taking snapshot:', error);
        drawingHistory.isResetting = false;
        return null;
    }
};

module.exports = { takeSnapshot };
