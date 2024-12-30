// Connect to the server
const socket = io();

// Initialize canvas
const canvas = document.getElementById('drawingCanvas');
const ctx = canvas.getContext('2d');
let isDrawing = false;
let isDragging = false;
let currentColor = '#1d1d1d';
let lastX = 0;
let lastY = 0;
let lastTouchTime = 0;
let canDraw = true;
let dragStart = { x: 0, y: 0 };
let canvasOffset = { x: 0, y: 0 };

// Fill canvas with initial background color
ctx.fillStyle = '#efefef';
ctx.fillRect(0, 0, canvas.width, canvas.height);

// Handle window focus
window.addEventListener('focus', () => {
    console.log('Page regained focus. Clearing canvas and requesting current state.');

    // Clear the canvas
    ctx.fillStyle = '#efefef';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    // Request the latest canvas state from the server
    socket.emit('request-state');
});

// Handle visibility change
document.addEventListener('visibilitychange', () => {
    if (!document.hidden) {
        socket.emit('request-state');
    }
});

// Handle drawing history
socket.on('drawing-history', (history) => {
    history.forEach((segment) => {
        ctx.beginPath();
        ctx.moveTo(segment.start.x, segment.start.y);
        ctx.lineTo(segment.end.x, segment.end.y);
        ctx.strokeStyle = segment.color;
        ctx.lineWidth = segment.lineWidth;
        ctx.stroke();
    });
});

// Handle server draw event
socket.on('draw', (data) => {
    ctx.beginPath();
    ctx.moveTo(data.start.x, data.start.y);
    ctx.lineTo(data.end.x, data.end.y);
    ctx.strokeStyle = data.color;
    ctx.lineWidth = data.lineWidth;
    ctx.stroke();
});

// Draw function
function draw(pos) {
    const data = {
        start: { x: lastX, y: lastY },
        end: { x: pos.x, y: pos.y },
        color: currentColor,
        lineWidth: 2
    };

    ctx.beginPath();
    ctx.moveTo(data.start.x, data.start.y);
    ctx.lineTo(data.end.x, data.end.y);
    ctx.strokeStyle = data.color;
    ctx.lineWidth = data.lineWidth;
    ctx.stroke();

    // Emit draw event
    socket.emit('draw', data);

    // Update last position
    lastX = pos.x;
    lastY = pos.y;
}

// Start drawing
function startDrawing(pos) {
    isDrawing = true;
    lastX = pos.x;
    lastY = pos.y;
}

// Stop drawing
function stopDrawing() {
    isDrawing = false;
}

// Handle mouse events
canvas.addEventListener('mousedown', (e) => {
    if (!canDraw) return;
    const pos = getPosition(e);
    startDrawing(pos);
});

canvas.addEventListener('mousemove', (e) => {
    if (!isDrawing) return;
    const pos = getPosition(e);
    draw(pos);
});

canvas.addEventListener('mouseup', stopDrawing);
canvas.addEventListener('mouseout', stopDrawing);

// Flags for gesture states
// Handle touch start
function handleTouchStart(e) {
    if (e.touches.length === 1) {
        // Single-finger touch for drawing
        if (Date.now() - lastTouchTime > 100) {
            isDrawing = true;
            const pos = getPosition(e.touches[0]);
            startDrawing(pos);
        }
    } else if (e.touches.length === 2) {
        // Two-finger touch for dragging
        isDragging = true;
        dragStart = {
            x: (e.touches[0].clientX + e.touches[1].clientX) / 2,
            y: (e.touches[0].clientY + e.touches[1].clientY) / 2
        };
    }
}

// Handle touch move
function handleTouchMove(e) {
    if (isDrawing && e.touches.length === 1) {
        // Continue drawing
        const pos = getPosition(e.touches[0]);
        draw(pos);
        e.preventDefault(); // Prevent default only for drawing
    } else if (isDragging && e.touches.length === 2) {
        // Handle dragging
        const currentDragPos = {
            x: (e.touches[0].clientX + e.touches[1].clientX) / 2,
            y: (e.touches[0].clientY + e.touches[1].clientY) / 2
        };

        const deltaX = currentDragPos.x - dragStart.x;
        const deltaY = currentDragPos.y - dragStart.y;

        // Update canvas offset
        canvasOffset.x += deltaX;
        canvasOffset.y += deltaY;

        // Apply canvas translation
        ctx.setTransform(1, 0, 0, 1, canvasOffset.x, canvasOffset.y);

        // Update drag start position
        dragStart = currentDragPos;

        e.preventDefault(); // Prevent default for dragging
    }
}

// Handle touch end
function handleTouchEnd(e) {
    if (isDrawing && e.touches.length === 0) {
        // Stop drawing
        isDrawing = false;
        lastTouchTime = Date.now();
    }

    if (isDragging && e.touches.length < 2) {
        // Stop dragging
        isDragging = false;
    }
}

// Utility: Get position relative to canvas
function getPosition(touch) {
    const rect = canvas.getBoundingClientRect();
    return {
        x: touch.clientX - rect.left - canvasOffset.x,
        y: touch.clientY - rect.top - canvasOffset.y
    };
}

// Attach event listeners
canvas.addEventListener('touchstart', handleTouchStart, { passive: false });
canvas.addEventListener('touchmove', handleTouchMove, { passive: false });
canvas.addEventListener('touchend', handleTouchEnd);
canvas.addEventListener('touchcancel', handleTouchEnd);
