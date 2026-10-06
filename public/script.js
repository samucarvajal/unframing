const BACKGROUND_COLOUR = '#efefef';
const LINE_WIDTH = 3;
const DEFAULT_COLOUR = '#1d1d1d';

// Treat a pointer that leaves this many px from the viewport edge as "off canvas"
const EDGE_THRESHOLD = 5;
// A jump larger than this between two move events is almost certainly a
// wrap-around (e.g. pointer leaving and re-entering), not a stroke
const MAX_JUMP = 100;
// Ignore touch starts within this window after the previous touch ended
const TOUCH_DEBOUNCE_MS = 100;

const socket = io();
const canvas = document.getElementById('drawingCanvas');
const ctx = canvas.getContext('2d');

let isDrawing = false;
let canDraw = true;
let currentColor = DEFAULT_COLOUR;
let lastX = 0;
let lastY = 0;
let lastTouchTime = 0;
let lastDrawnPoint = { x: null, y: null };

// Stroke style never changes, so set it once
ctx.lineWidth = LINE_WIDTH;
ctx.lineCap = 'round';

function clearCanvas() {
    ctx.fillStyle = BACKGROUND_COLOUR;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
}

function drawLine(x0, y0, x1, y1, color) {
    ctx.beginPath();
    ctx.moveTo(x0, y0);
    ctx.lineTo(x1, y1);
    ctx.strokeStyle = color;
    ctx.stroke();
}

function replayHistory(history) {
    clearCanvas();
    for (const data of history) {
        if (data.type === 'draw') {
            drawLine(data.x0, data.y0, data.x1, data.y1, data.color);
        }
    }
}

clearCanvas();

// --- Server events --------------------------------------------------------

// Sent on (re)connect with everything drawn so far
socket.on('drawing-history', replayHistory);

// Sent in reply to 'request-state'
socket.on('current-state', replayHistory);

socket.on('draw', (data) => {
    if (data.type === 'draw') {
        drawLine(data.x0, data.y0, data.x1, data.y1, data.color);
    }
});

socket.on('force-clear-canvas', () => {
    console.log('Canvas cleared by server.');
    isDrawing = false;
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

// Re-sync when the tab comes back; a backgrounded tab may have missed events
document.addEventListener('visibilitychange', () => {
    if (!document.hidden) {
        socket.emit('request-state');
    }
});

// --- Pointer helpers ------------------------------------------------------

function getClientPoint(e) {
    const source = e.touches ? e.touches[0] : e;
    return { clientX: source.clientX, clientY: source.clientY };
}

function toCanvasPosition({ clientX, clientY }) {
    const rect = canvas.getBoundingClientRect();
    return {
        x: (clientX - rect.left) * (canvas.width / rect.width),
        y: (clientY - rect.top) * (canvas.height / rect.height),
    };
}

function isWithinViewport({ clientX, clientY }) {
    return (
        clientX >= EDGE_THRESHOLD &&
        clientX <= window.innerWidth - EDGE_THRESHOLD &&
        clientY >= EDGE_THRESHOLD &&
        clientY <= window.innerHeight - EDGE_THRESHOLD
    );
}

function isSuspiciousJump({ clientX, clientY }) {
    if (lastDrawnPoint.x === null) return false;
    return Math.abs(clientX - lastDrawnPoint.x) > MAX_JUMP ||
        Math.abs(clientY - lastDrawnPoint.y) > MAX_JUMP;
}

function beginStroke(point) {
    isDrawing = true;
    const pos = toCanvasPosition(point);
    lastX = pos.x;
    lastY = pos.y;
    lastDrawnPoint = { x: point.clientX, y: point.clientY };
}

function endStroke() {
    isDrawing = false;
    lastDrawnPoint = { x: null, y: null };
}

/** Extend the current stroke to `point`, drawing locally and broadcasting. */
function continueStroke(point) {
    if (!isDrawing || !canDraw) return;

    if (!isWithinViewport(point) || isSuspiciousJump(point)) {
        endStroke();
        return;
    }

    const pos = toCanvasPosition(point);
    drawLine(lastX, lastY, pos.x, pos.y, currentColor);
    socket.emit('draw', {
        type: 'draw',
        x0: lastX,
        y0: lastY,
        x1: pos.x,
        y1: pos.y,
        color: currentColor,
    });

    lastX = pos.x;
    lastY = pos.y;
    lastDrawnPoint = { x: point.clientX, y: point.clientY };
}

// --- Mouse ----------------------------------------------------------------

canvas.addEventListener('mousedown', (e) => {
    if (!canDraw) return;
    beginStroke(getClientPoint(e));
});
canvas.addEventListener('mousemove', (e) => continueStroke(getClientPoint(e)));
canvas.addEventListener('mouseup', endStroke);
canvas.addEventListener('mouseout', endStroke);

// --- Touch ----------------------------------------------------------------

canvas.addEventListener('touchstart', (e) => {
    if (!canDraw || e.touches.length !== 1) return;
    if (Date.now() - lastTouchTime <= TOUCH_DEBOUNCE_MS) return;
    beginStroke(getClientPoint(e));
    e.preventDefault();
}, { passive: false });

canvas.addEventListener('touchmove', (e) => {
    if (!isDrawing || e.touches.length !== 1) return;
    continueStroke(getClientPoint(e));
    e.preventDefault();
}, { passive: false });

function handleTouchEnd() {
    if (isDrawing) {
        lastTouchTime = Date.now();
        endStroke();
    }
}
canvas.addEventListener('touchend', handleTouchEnd);
canvas.addEventListener('touchcancel', handleTouchEnd);

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
