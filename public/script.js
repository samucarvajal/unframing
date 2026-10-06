const BACKGROUND_COLOUR = '#efefef';
const LINE_WIDTH = 3;

// Treat a pointer this close to the viewport edge as having left it
const EDGE_THRESHOLD = 5;
// A single finger must move this far (CSS px) before it counts as a stroke.
// Gives a second finger a moment to land without leaving a stray dot.
const STROKE_START_DISTANCE = 4;
// Two-finger pan momentum: per-frame velocity decay and the speed below
// which we stop coasting (px per ms)
const PAN_FRICTION = 0.94;
const PAN_MIN_VELOCITY = 0.03;

const socket = io();
const canvas = document.getElementById('drawingCanvas');
const ctx = canvas.getContext('2d');

let currentColor = '#1d1d1d';
let canDraw = true;

// Stroke style never changes, so set it once
ctx.lineWidth = LINE_WIDTH;
ctx.lineCap = 'round';
ctx.lineJoin = 'round';

// --- Rendering ------------------------------------------------------------

function clearCanvas(target = ctx) {
    target.fillStyle = BACKGROUND_COLOUR;
    target.fillRect(0, 0, canvas.width, canvas.height);
}

function drawLine(x0, y0, x1, y1, color) {
    ctx.beginPath();
    ctx.moveTo(x0, y0);
    ctx.lineTo(x1, y1);
    ctx.strokeStyle = color;
    ctx.stroke();
}

/**
 * Draw compact segments ([x0, y0, x1, y1, colourIndex] tuples) onto a
 * context, one stroke per segment, exactly as live strokes are drawn. This
 * matters: batching segments into one path anti-aliases the joins
 * differently, and every device must end up with the same pixels whether it
 * saw a stroke live or caught up later.
 */
function drawSegments(target, colours, segments) {
    for (const [x0, y0, x1, y1, c] of segments) {
        target.beginPath();
        target.moveTo(x0, y0);
        target.lineTo(x1, y1);
        target.strokeStyle = colours[c] || '#1d1d1d';
        target.stroke();
    }
}

function replayHistory({ colours = [], segments = [] } = {}) {
    const off = document.createElement('canvas');
    off.width = canvas.width;
    off.height = canvas.height;
    const octx = off.getContext('2d');
    clearCanvas(octx);
    octx.lineWidth = LINE_WIDTH;
    octx.lineCap = 'round';
    octx.lineJoin = 'round';
    drawSegments(octx, colours, segments);
    ctx.drawImage(off, 0, 0);
}

clearCanvas();

// --- Consistency with the server ------------------------------------------
// Every segment has a sequence number and every canvas lifetime (between
// resets) has an epoch. We track where we are and check in with the server
// every few seconds: if we've missed anything it sends just the gap, and if
// the epoch changed (a reset we didn't hear about, or a server restart) it
// sends the whole canvas. Nothing depends on every single event arriving.

const SYNC_INTERVAL_MS = 3000;

let epoch = null; // unknown until the first state from the server
let seq = 0;      // last segment we know we have drawn

function applyState(state) {
    syncInFlight = false;
    if (!state || typeof state.epoch !== 'number') return;

    if (state.epoch !== epoch || state.from === 0) {
        // New epoch or full state: replace everything
        replayHistory(state);
        epoch = state.epoch;
        seq = state.seq;
        return;
    }

    if (state.from > seq) {
        // The delta starts after where we are; we can't fill the hole, so
        // ask for a full copy rather than draw something inconsistent
        requestSync(0);
        return;
    }

    // Delta: redrawing a few segments we already have is harmless
    drawSegments(ctx, state.colours, state.segments);
    seq = Math.max(seq, state.seq);
}

let syncInFlight = false;

function requestSync(fromSeq = seq) {
    if (!socket.connected || syncInFlight) return;
    syncInFlight = true;
    socket.emit('sync', { epoch, seq: fromSeq });
    // The server only replies when we're behind, so don't wait on a reply
    setTimeout(() => { syncInFlight = false; }, 1000);
}

function noteSequence(data) {
    if (!data || typeof data.epoch !== 'number') return;
    if (data.epoch !== epoch) {
        // A reset we didn't hear about: get the whole canvas
        requestSync(0);
        return;
    }
    if (data.seq > seq + 1) {
        // We missed something in between; fetch the gap
        requestSync(seq);
    }
    seq = Math.max(seq, data.seq);
}

socket.on('drawing-history', applyState); // on (re)connect
socket.on('current-state', applyState);   // legacy full re-sync
socket.on('sync-state', applyState);      // reply to our 'sync' check

socket.on('draw', (data) => {
    if (data.type !== 'draw') return;
    if (typeof data.epoch === 'number' && data.epoch !== epoch) {
        // Belongs to a canvas we don't have yet; the sync will bring it
        requestSync(0);
        return;
    }
    drawLine(data.x0, data.y0, data.x1, data.y1, data.color);
    noteSequence(data);
});

socket.on('force-clear-canvas', ({ epoch: newEpoch } = {}) => {
    endStroke();
    canDraw = false;
    clearCanvas();
    if (typeof newEpoch === 'number') {
        epoch = newEpoch;
        seq = 0;
    }
    // Brief pause so an in-progress stroke doesn't bleed onto the fresh canvas
    setTimeout(() => {
        canDraw = true;
    }, 100);
});

socket.on('snapshot-error', ({ message }) => {
    console.warn('Snapshot error:', message);
});

// Periodic check, plus an immediate one whenever the tab comes back: a
// backgrounded tab (especially on iOS) is throttled and can miss events
setInterval(() => requestSync(), SYNC_INTERVAL_MS);
document.addEventListener('visibilitychange', () => {
    if (!document.hidden) requestSync();
});
window.addEventListener('focus', () => requestSync());

// --- Geometry helpers -----------------------------------------------------

function toCanvasPosition(clientX, clientY) {
    const rect = canvas.getBoundingClientRect();
    return {
        x: (clientX - rect.left) * (canvas.width / rect.width),
        y: (clientY - rect.top) * (canvas.height / rect.height),
    };
}

function isWithinViewport(clientX, clientY) {
    return (
        clientX >= EDGE_THRESHOLD &&
        clientX <= window.innerWidth - EDGE_THRESHOLD &&
        clientY >= EDGE_THRESHOLD &&
        clientY <= window.innerHeight - EDGE_THRESHOLD
    );
}

// --- Drawing (one pointer) ------------------------------------------------

// The pointer currently drawing, or null
let stroke = null;

function beginStroke(e) {
    const pos = toCanvasPosition(e.clientX, e.clientY);
    stroke = {
        pointerId: e.pointerId,
        startClientX: e.clientX,
        startClientY: e.clientY,
        started: e.pointerType !== 'touch', // touch waits for movement, see STROKE_START_DISTANCE
        lastX: pos.x,
        lastY: pos.y,
        drewAnything: false,
    };
}

function endStroke() {
    stroke = null;
}

/** Send one segment, drawing it locally first. */
function emitSegment(x0, y0, x1, y1) {
    drawLine(x0, y0, x1, y1, currentColor);
    socket.emit('draw', { type: 'draw', x0, y0, x1, y1, color: currentColor }, (ack) => {
        // Our own strokes aren't echoed back, so the ack is how we keep our
        // place in the sequence (seq 0 means the server didn't store it)
        if (ack && ack.seq > 0) noteSequence(ack);
    });
}

/**
 * The pointer was released. If it never moved, this was a tap or click:
 * make a dot. A zero-length segment with round caps renders as a dot
 * everywhere, including in the snapshot.
 */
function releaseStroke() {
    if (stroke && !stroke.drewAnything && canDraw) {
        emitSegment(stroke.lastX, stroke.lastY, stroke.lastX, stroke.lastY);
    }
    endStroke();
}

function extendStroke(clientX, clientY) {
    if (!stroke || !canDraw) return;

    if (!isWithinViewport(clientX, clientY)) {
        endStroke();
        return;
    }

    if (!stroke.started) {
        const moved = Math.hypot(clientX - stroke.startClientX, clientY - stroke.startClientY);
        if (moved < STROKE_START_DISTANCE) return;
        stroke.started = true;
    }

    const pos = toCanvasPosition(clientX, clientY);
    emitSegment(stroke.lastX, stroke.lastY, pos.x, pos.y);
    stroke.drewAnything = true;
    stroke.lastX = pos.x;
    stroke.lastY = pos.y;
}

// --- Viewport -------------------------------------------------------------
// The page itself never scrolls. We move the canvas with a CSS transform
// instead, which sidesteps an iOS WebKit quirk where touch coordinates shift
// while the page is being scrolled underneath stationary fingers (that fed
// back into the pan and sent it flying to the far edge).

const container = document.querySelector('.canvas-container');
const view = { x: 0, y: 0 }; // translation applied to the container, in CSS px

function setView(x, y) {
    // Keep the canvas covering the viewport; allow nothing past its edges
    const minX = Math.min(0, window.innerWidth - canvas.width);
    const minY = Math.min(0, window.innerHeight - canvas.height);
    view.x = Math.min(0, Math.max(minX, x));
    view.y = Math.min(0, Math.max(minY, y));
    container.style.transform = `translate3d(${view.x}px, ${view.y}px, 0)`;
}

function panBy(dx, dy) {
    setView(view.x + dx, view.y + dy);
}

setView(0, 0);
window.addEventListener('resize', () => setView(view.x, view.y));

// Desktop: mouse wheel / trackpad pans
canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    panBy(-e.deltaX, -e.deltaY);
}, { passive: false });

// --- Panning (two fingers) ------------------------------------------------

let pan = null;          // { x, y, vx, vy, time } centroid of the fingers
let momentumFrame = null;
let fingersDown = 0;     // from touch events; > 1 means we're panning, not drawing

function touchCentroid(touches) {
    let x = 0;
    let y = 0;
    for (const t of touches) {
        x += t.clientX;
        y += t.clientY;
    }
    return { x: x / touches.length, y: y / touches.length };
}

function stopMomentum() {
    if (momentumFrame !== null) {
        cancelAnimationFrame(momentumFrame);
        momentumFrame = null;
    }
}

function beginPan(touches) {
    endStroke(); // a second finger always cancels drawing
    stopMomentum();
    const c = touchCentroid(touches);
    pan = { x: c.x, y: c.y, vx: 0, vy: 0, time: performance.now() };
}

function movePan(touches) {
    if (!pan) return;
    const c = touchCentroid(touches);
    const now = performance.now();
    const dt = Math.max(now - pan.time, 1);
    const dx = c.x - pan.x;
    const dy = c.y - pan.y;

    panBy(dx, dy);

    // Smooth the velocity a little so momentum isn't jittery
    pan.vx = pan.vx * 0.3 + (dx / dt) * 0.7;
    pan.vy = pan.vy * 0.3 + (dy / dt) * 0.7;
    pan.x = c.x;
    pan.y = c.y;
    pan.time = now;
}

function endPan() {
    if (!pan) return;
    let { vx, vy } = pan;
    let last = performance.now();
    pan = null;

    // Coast to a stop, like a native scroll view
    const step = (now) => {
        const dt = now - last;
        last = now;
        panBy(vx * dt, vy * dt);
        vx *= PAN_FRICTION;
        vy *= PAN_FRICTION;
        if (Math.hypot(vx, vy) > PAN_MIN_VELOCITY) {
            momentumFrame = requestAnimationFrame(step);
        } else {
            momentumFrame = null;
        }
    };
    if (Math.hypot(vx, vy) > PAN_MIN_VELOCITY) {
        momentumFrame = requestAnimationFrame(step);
    }
}

// --- Touch events: two-finger pan -----------------------------------------
// iOS WebKit (Safari and Chrome alike) doesn't reliably honour
// touch-action: none for multi-finger gestures: once it suspects a pinch it
// takes over and stops sending pointer events. Calling preventDefault() on
// the raw touch events is the one thing that keeps it from doing that, so
// panning is driven from here rather than from pointer events.

canvas.addEventListener('touchstart', (e) => {
    fingersDown = e.touches.length;
    if (fingersDown === 1) {
        stopMomentum();
    } else if (fingersDown === 2) {
        beginPan(e.touches);
    } else {
        endStroke();
        endPan();
    }
    e.preventDefault();
}, { passive: false });

canvas.addEventListener('touchmove', (e) => {
    if (pan && e.touches.length === 2) {
        movePan(e.touches);
    }
    e.preventDefault();
}, { passive: false });

function handleTouchEnd(e) {
    fingersDown = e.touches.length;
    if (pan && fingersDown < 2) {
        endPan();
    }
}
canvas.addEventListener('touchend', handleTouchEnd);
canvas.addEventListener('touchcancel', handleTouchEnd);

// --- Pointer events: drawing ----------------------------------------------
// One finger (or the mouse) draws. Pointer events give us coalesced samples
// for smooth fast strokes, which touch events don't.

canvas.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'touch') {
        // touchstart fires after pointerdown, so count this finger ourselves
        if (fingersDown >= 1) {
            endStroke();
            return;
        }
        if (canDraw) beginStroke(e);
        return;
    }

    // Mouse / pen: only the primary button draws
    if (e.button === 0 && canDraw) beginStroke(e);
});

canvas.addEventListener('pointermove', (e) => {
    if (!stroke || e.pointerId !== stroke.pointerId) return;
    if (e.pointerType === 'touch' && fingersDown > 1) {
        endStroke();
        return;
    }

    // Fast strokes generate more samples than pointermove events; replaying
    // the coalesced ones keeps energetic lines smooth instead of chorded.
    const samples = typeof e.getCoalescedEvents === 'function' ? e.getCoalescedEvents() : [];
    if (samples.length > 0) {
        for (const s of samples) extendStroke(s.clientX, s.clientY);
    } else {
        extendStroke(e.clientX, e.clientY);
    }
});

function handlePointerUp(e) {
    if (!stroke || e.pointerId !== stroke.pointerId) return;
    if (e.type === 'pointerup') {
        releaseStroke();
    } else {
        endStroke(); // cancelled: no dot
    }
}

canvas.addEventListener('pointerup', handlePointerUp);
canvas.addEventListener('pointercancel', handlePointerUp);
canvas.addEventListener('pointerleave', (e) => {
    if (e.pointerType !== 'touch') endStroke();
});

// Belt and braces: block native gestures (pinch-zoom, double-tap zoom) over the canvas
canvas.addEventListener('contextmenu', (e) => e.preventDefault());
document.addEventListener('gesturestart', (e) => e.preventDefault());

// --- Colour palette -------------------------------------------------------

const colourDots = document.querySelectorAll('.color-dot');

function selectColour(dot) {
    currentColor = dot.style.backgroundColor;
    colourDots.forEach((d) => d.classList.toggle('active', d === dot));
}

colourDots.forEach((dot) => {
    dot.addEventListener('click', () => selectColour(dot));
});

if (colourDots.length > 0) {
    selectColour(colourDots[0]);
}
