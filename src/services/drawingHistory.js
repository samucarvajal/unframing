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
 * Storage
 * -------
 * The canvas lives for a whole day, so it can accumulate millions of
 * segments. They're kept in flat typed arrays (four Int16 coordinates and a
 * Uint8 colour index, 9 bytes a segment) rather than one object each, which
 * is roughly eight times smaller and keeps a busy day well within memory.
 */

// Hard cap on stored segments so a runaway day can't exhaust memory.
// At 9 bytes a segment this is ~36 MB.
const MAX_SEGMENTS = 4_000_000;

const INITIAL_CAPACITY = 65_536;
const DEFAULT_COLOUR = '#1d1d1d';

function newEpoch() {
    // Time-based so a restarted server never reuses an epoch a client has seen
    return Date.now();
}

class DrawingHistory {
    constructor() {
        this.epoch = newEpoch();
        this.isResetting = false;

        // colour string -> index, and index -> colour string.
        // Kept across resets so indices stay stable for the life of the process.
        this.colourToIndex = new Map();
        this.indexToColour = [];

        this.allocate(INITIAL_CAPACITY);
    }

    allocate(capacity) {
        this.capacity = capacity;
        this.length = 0;
        this.x0 = new Int16Array(capacity);
        this.y0 = new Int16Array(capacity);
        this.x1 = new Int16Array(capacity);
        this.y1 = new Int16Array(capacity);
        this.colour = new Uint8Array(capacity);
    }

    grow() {
        const capacity = Math.min(MAX_SEGMENTS, this.capacity * 2);
        const copy = (old, Type) => { const next = new Type(capacity); next.set(old.subarray(0, this.length)); return next; };
        this.x0 = copy(this.x0, Int16Array);
        this.y0 = copy(this.y0, Int16Array);
        this.x1 = copy(this.x1, Int16Array);
        this.y1 = copy(this.y1, Int16Array);
        this.colour = copy(this.colour, Uint8Array);
        this.capacity = capacity;
    }

    getColorIndex(colour) {
        let index = this.colourToIndex.get(colour);
        if (index === undefined) {
            index = this.indexToColour.length;
            if (index > 255) return 0; // the palette has 7 colours; this can't happen in practice
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
        return this.length;
    }

    /**
     * Record a validated segment. Returns its sequence number, or 0 if it
     * was not stored. Callers are expected to have validated `data` already.
     */
    addSegment(data) {
        if (this.isResetting || data.type !== 'draw') return 0;
        if (this.length >= MAX_SEGMENTS) return 0;
        if (this.length === this.capacity) this.grow();

        const i = this.length;
        this.x0[i] = Math.round(data.x0);
        this.y0[i] = Math.round(data.y0);
        this.x1[i] = Math.round(data.x1);
        this.y1[i] = Math.round(data.y1);
        this.colour[i] = this.getColorIndex(data.color);
        this.length = i + 1;
        return this.length;
    }

    /** Start a new epoch with an empty canvas. */
    clear() {
        this.allocate(INITIAL_CAPACITY);
        this.epoch = newEpoch();
    }

    expandSegment(i) {
        return {
            type: 'draw',
            x0: this.x0[i],
            y0: this.y0[i],
            x1: this.x1[i],
            y1: this.y1[i],
            color: this.getColorFromIndex(this.colour[i]),
        };
    }

    /** Full history, expanded, for the snapshot renderer. */
    getFullHistory() {
        const out = new Array(this.length);
        for (let i = 0; i < this.length; i++) out[i] = this.expandSegment(i);
        return out;
    }

    /**
     * Compact state for clients: colour palette plus one
     * [x0, y0, x1, y1, colourIndex] tuple per segment after `afterSeq`.
     * With afterSeq = 0 this is the whole canvas.
     */
    toWireFormat(afterSeq = 0) {
        const from = Math.max(0, Math.min(afterSeq, this.length));
        const segments = new Array(this.length - from);
        for (let i = from; i < this.length; i++) {
            segments[i - from] = [this.x0[i], this.y0[i], this.x1[i], this.y1[i], this.colour[i]];
        }
        return {
            epoch: this.epoch,
            from,
            seq: this.length,
            colours: this.indexToColour,
            segments,
        };
    }

    hasDrawings() {
        return this.length > 0;
    }

    get size() {
        return this.length;
    }
}

module.exports = DrawingHistory;
