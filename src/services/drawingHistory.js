class DrawingHistory {
    constructor() {
        // Main segments storage - will use more efficient format internally
        this.segments = [];
        this.batchSize = 0;
        this.currentBatch = [];
        this.isResetting = false;
        this.activeDrawers = new Set();
        
        // Color cache to avoid storing full color strings repeatedly
        this.colorCache = {};
        this.colorIndex = 0;
    }

    // Get or create a short index for a color to save memory
    getColorIndex(color) {
        if (!this.colorCache[color]) {
            this.colorCache[color] = this.colorIndex++;
        }
        return this.colorCache[color];
    }

    // Convert back to full color for rendering
    getColorFromIndex(index) {
        for (const [color, idx] of Object.entries(this.colorCache)) {
            if (idx === index) return color;
        }
        return '#1d1d1d'; // Default color as fallback
    }

    startDrawing(socketId) {
        this.activeDrawers.add(socketId);
    }

    stopDrawing(socketId) {
        this.activeDrawers.delete(socketId);
    }

    addSegment(data, socketId) {
        if (this.isResetting) return false;

        if (data.type === 'draw') {
            // Store data in a more compact format
            const compactData = {
                // Store only what's needed in an optimal format
                t: 'd', // 'd' for draw instead of 'draw'
                x0: Math.round(data.x0),
                y0: Math.round(data.y0),
                x1: Math.round(data.x1),
                y1: Math.round(data.y1),
                c: this.getColorIndex(data.color)
            };

            this.currentBatch.push(compactData);
            this.batchSize++;

            if (this.batchSize >= 50) {
                this.commitBatch();
            }
            return true;
        } else if (data.type === 'end') {
            this.commitBatch();
            this.stopDrawing(socketId);
            return true;
        }
        return false;
    }

    commitBatch() {
        if (this.currentBatch.length > 0) {
            this.segments.push(...this.currentBatch);
            this.currentBatch = [];
            this.batchSize = 0;
        }
    }

    clear() {
        this.segments = [];
        this.currentBatch = [];
        this.batchSize = 0;
        this.activeDrawers.clear();
        // Keep color cache across resets to maintain memory benefits
    }

    // Expand back to the format expected by the client
    expandSegment(compactData) {
        return {
            type: 'draw',
            x0: compactData.x0,
            y0: compactData.y0,
            x1: compactData.x1,
            y1: compactData.y1,
            color: this.getColorFromIndex(compactData.c)
        };
    }

    getFullHistory() {
        this.commitBatch();
        // Convert compressed format back to the format expected by clients
        return this.segments.map(segment => this.expandSegment(segment));
    }

    hasDrawings() {
        return this.segments.length > 0 || this.currentBatch.length > 0;
    }

    hasActiveDrawers() {
        return this.activeDrawers.size > 0;
    }
}

module.exports = DrawingHistory;