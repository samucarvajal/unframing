/**
 * In-memory store of every line segment drawn on the shared canvas.
 *
 * Segments are stored compactly (rounded integer coordinates and a small
 * colour index rather than the full colour string) because the canvas can
 * accumulate hundreds of thousands of segments between hourly snapshots.
 */

// Hard cap on stored segments so a runaway client can't exhaust memory.
// At ~40 bytes a segment this is roughly 40 MB worst case.
const MAX_SEGMENTS = 1_000_000;

const DEFAULT_COLOUR = '#1d1d1d';

class DrawingHistory {
    constructor() {
        this.segments = [];
        this.isResetting = false;

        // colour string -> index, and index -> colour string.
        // Kept across resets so indices stay stable for the life of the process.
        this.colourToIndex = new Map();
        this.indexToColour = [];
    }

    getColorIndex(colour) {
        let index = this.colourToIndex.get(colour);
        if (index === undefined) {
            index = this.indexToColour.length;
            this.colourToIndex.set(colour, index);
            this.indexToColour.push(colour);
        }
        return index;
    }

    getColorFromIndex(index) {
        return this.indexToColour[index] ?? DEFAULT_COLOUR;
    }

    /**
     * Record a validated segment. Returns true if it was stored.
     * Callers are expected to have validated `data` already.
     */
    addSegment(data) {
        if (this.isResetting || data.type !== 'draw') return false;
        if (this.segments.length >= MAX_SEGMENTS) return false;

        this.segments.push({
            x0: Math.round(data.x0),
            y0: Math.round(data.y0),
            x1: Math.round(data.x1),
            y1: Math.round(data.y1),
            c: this.getColorIndex(data.color),
        });
        return true;
    }

    clear() {
        this.segments = [];
    }

    expandSegment(segment) {
        return {
            type: 'draw',
            x0: segment.x0,
            y0: segment.y0,
            x1: segment.x1,
            y1: segment.y1,
            color: this.getColorFromIndex(segment.c),
        };
    }

    /** Full history in the shape the client and snapshot renderer expect. */
    getFullHistory() {
        return this.segments.map((segment) => this.expandSegment(segment));
    }

    hasDrawings() {
        return this.segments.length > 0;
    }

    get size() {
        return this.segments.length;
    }
}

module.exports = DrawingHistory;
