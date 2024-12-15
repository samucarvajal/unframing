class DrawingHistory {
    constructor() {
        this.segments = [];
        this.batchSize = 0;
        this.currentBatch = [];
        this.isResetting = false;
        this.activeDrawers = new Set();
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
            this.currentBatch.push(data);
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
    }

    getFullHistory() {
        this.commitBatch();
        return this.segments;
    }

    hasDrawings() {
        return this.segments.length > 0 || this.currentBatch.length > 0;
    }

    hasActiveDrawers() {
        return this.activeDrawers.size > 0;
    }
}

module.exports = DrawingHistory;
