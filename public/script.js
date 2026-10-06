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
const scroller = document.scrollingElement || document.documentElement;

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
 * Redraw the whole canvas from a compact history payload
 * ({ colours: [...], segments: [[x0, y0, x1, y1, colourIndex], ...] }).
 *
 * Renders to an offscreen canvas and swaps it in with one drawImage, so the
 * visible canvas never goes blank. Consecutive same-colour segments are
 * batched into one path, which is far cheaper than one stroke() per segment.
 */
function replayHistory({ colours = [], segments = [] } = {}) {
    const off = document.createElement('canvas');
    off.width = canvas.width;
    off.height = canvas.height;
    const octx = off.getContext('2d');
    clearCanvas(octx);
    octx.lineWidth = LINE_WIDTH;
    octx.lineCap = 'round';
    octx.lineJoin = 'round';

    let runColour = -1;
    for (const [x0, y0, x1, y1, c] of segments) {
        if (c !== runColour) {
            if (runColour !== -1) octx.stroke();
            octx.beginPath();
            octx.strokeStyle = colours[c] || '#1d1d1d';
            runColour = c;
        }
        octx.moveTo(x0, y0);
        octx.lineTo(x1, y1);
    }
    if (runColour !== -1) octx.stroke();

    ctx.drawImage(off, 0, 0);
}

clearCanvas();

// --- Server events --------------------------------------------------------

socket.on('drawing-history', replayHistory); // on (re)connect
socket.on('current-state', replayHistory);   // reply to 'request-state'

socket.on('draw', (data) => {
    if (data.type === 'draw') {
        drawLine(data.x0, data.y0, data.x1, data.y1, data.color);
    }
});

socket.on('force-clear-canvas', () => {
    endStroke();
    canDraw = false;
    clearCanvas();
    // Brief pause so an in-progress stroke doesn't bleed onto the fresh canvas
    setTimeout(() => {
        canDraw = true;
    }, 100);
});

socket.on('snapshot-error', ({ message }) => {
    console.warn('Snapshot error:', message);
});

// A backgrounded tab (especially on iOS) can miss events or lose its
// connection. If the socket dropped, Socket.IO reconnects and the server
// sends 'drawing-history' anyway; if it's still up, ask for a fresh copy.
document.addEventListener('visibilitychange', () => {
    if (!document.hidden && socket.connected) {
        socket.emit('request-state');
    }
});

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
    };
}

function endStroke() {
    stroke = null;
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
    drawLine(stroke.lastX, stroke.lastY, pos.x, pos.y, currentColor);
    socket.emit('draw', {
        type: 'draw',
        x0: stroke.lastX,
        y0: stroke.lastY,
        x1: pos.x,
        y1: pos.y,
        color: currentColor,
    });
    stroke.lastX = pos.x;
    stroke.lastY = pos.y;
}

// --- Panning (two fingers) ------------------------------------------------

const activeTouches = new Map(); // pointerId -> { clientX, clientY }
let pan = null;                  // { x, y, vx, vy, time } centroid of the two fingers
let momentumFrame = null;

function touchCentroid() {
    let x = 0;
    let y = 0;
    for (const t of activeTouches.values()) {
        x += t.clientX;
        y += t.clientY;
    }
    return { x: x / activeTouches.size, y: y / activeTouches.size };
}

function stopMomentum() {
    if (momentumFrame !== null) {
        cancelAnimationFrame(momentumFrame);
        momentumFrame = null;
    }
}

function beginPan() {
    endStroke(); // a second finger always cancels drawing
    stopMomentum();
    const c = touchCentroid();
    pan = { x: c.x, y: c.y, vx: 0, vy: 0, time: performance.now() };
}

function movePan() {
    if (!pan) return;
    const c = touchCentroid();
    const now = performance.now();
    const dt = Math.max(now - pan.time, 1);
    const dx = c.x - pan.x;
    const dy = c.y - pan.y;

    scroller.scrollBy(-dx, -dy);

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
        scroller.scrollBy(-vx * dt, -vy * dt);
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

// --- Pointer events -------------------------------------------------------
// One finger (or the mouse) draws; two fingers pan. touch-action: none on the
// canvas stops the browser from scrolling or zooming on its own, so we never
// get a pointercancel mid-stroke.

canvas.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'touch') {
        activeTouches.set(e.pointerId, { clientX: e.clientX, clientY: e.clientY });
        if (activeTouches.size === 1) {
            stopMomentum();
            if (canDraw) beginStroke(e);
        } else if (activeTouches.size === 2) {
            beginPan();
        } else {
            endStroke();
            endPan();
        }
        return;
    }

    // Mouse / pen: only the primary button draws
    if (e.button === 0 && canDraw) beginStroke(e);
});

canvas.addEventListener('pointermove', (e) => {
    if (e.pointerType === 'touch' && activeTouches.has(e.pointerId)) {
        activeTouches.set(e.pointerId, { clientX: e.clientX, clientY: e.clientY });
        if (pan && activeTouches.size === 2) {
            movePan();
            return;
        }
    }

    if (!stroke || e.pointerId !== stroke.pointerId) return;

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
    if (e.pointerType === 'touch') {
        activeTouches.delete(e.pointerId);
        if (pan && activeTouches.size < 2) endPan();
    }
    if (stroke && e.pointerId === stroke.pointerId) endStroke();
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
