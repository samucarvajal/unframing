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

    window.scrollBy(-dx, -dy);

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
        window.scrollBy(-vx * dt, -vy * dt);
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
