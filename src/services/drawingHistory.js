/**
 * In-memory store of every line segment drawn on the shared canvas.
 *
 * Consistency model
 * -----------------
 * Every segment gets a sequence number (its 1-based position in the current
 * epoch) and every canvas lifetime - from one reset to the next - gets an
 * epoch id. Clients track (epoch, seq) and periodically ask the server for
 * anything newer, so a dropped event, a throttled background tab, or a
 * server restart all self-correct within a few seconds instead of leaving
 * that device permanently out of step.
 *
 * Segments are stored compactly (rounded integer coordinates and a small
 * colour index rather than the full colour string) because the canvas can
 * accumulate hundreds of thousands of segments between daily snapshots.
 */

// Hard cap on stored segments so a runaway client can't exhaust memory.
// At ~40 bytes a segment this is roughly 40 MB worst case.
const MAX_SEGMENTS = 1_000_000;

const DEFAULT_COLOUR = '#1d1d1d';

function newEpoch() {
    // Time-based so a restarted server never reuses an epoch a client has seen
    return Date.now();
}

class DrawingHistory {
    constructor() {
        this.segments = [];
        this.epoch = newEpoch();
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

    /** Sequence number of the most recent segment (0 when empty). */
    get seq() {
        return this.segments.length;
    }

    /**
     * Record a validated segment. Returns its sequence number, or 0 if it
     * was not stored. Callers are expected to have validated `data` already.
     */
    addSegment(data) {
        if (this.isResetting || data.type !== 'draw') return 0;
        if (this.segments.length >= MAX_SEGMENTS) return 0;

        this.segments.push({
            x0: Math.round(data.x0),
            y0: Math.round(data.y0),
            x1: Math.round(data.x1),
            y1: Math.round(data.y1),
            c: this.getColorIndex(data.color),
        });
        return this.segments.length;
    }

    /** Start a new epoch with an empty canvas. */
    clear() {
        this.segments = [];
        this.epoch = newEpoch();
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

    /** Full history, expanded, for the snapshot renderer. */
    getFullHistory() {
        return this.segments.map((segment) => this.expandSegment(segment));
    }

    /**
     * Compact state for clients: colour palette plus one
     * [x0, y0, x1, y1, colourIndex] tuple per segment after `afterSeq`.
     * With afterSeq = 0 this is the whole canvas.
     */
    toWireFormat(afterSeq = 0) {
        const from = Math.max(0, Math.min(afterSeq, this.segments.length));
        return {
            epoch: this.epoch,
            from,
            seq: this.segments.length,
            colours: this.indexToColour,
            segments: this.segments.slice(from).map((s) => [s.x0, s.y0, s.x1, s.y1, s.c]),
        };
    }

    hasDrawings() {
        return this.segments.length > 0;
    }

    get size() {
        return this.segments.length;
    }
}

module.exports = DrawingHistory;
