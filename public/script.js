// Connect to the server
const socket = io();

// Initialize canvas
const canvas = document.getElementById('drawingCanvas');
const ctx = canvas.getContext('2d');
let isDrawing = false;
let currentColor = '#1d1d1d';
let lastX = 0;
let lastY = 0;
let lastTouchTime = 0;
let canDraw = true;

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
    history.forEach(data => {
        if (data.type === 'draw') {
            drawLine(data.x0, data.y0, data.x1, data.y1, data.color);
        }
    });
});

// Handle current state update
socket.on('current-state', (history) => {
    // Clear canvas
    ctx.fillStyle = '#efefef';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    
    // Redraw current state
    history.forEach(data => {
        if (data.type === 'draw') {
            drawLine(data.x0, data.y0, data.x1, data.y1, data.color);
        }
    });
});

function getPosition(e) {
    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;

    const x = ((e.type.includes('touch') ? e.touches[0].clientX : e.clientX) - rect.left) * scaleX;
    const y = ((e.type.includes('touch') ? e.touches[0].clientY : e.clientY) - rect.top) * scaleY;

    return { x, y };
}

function drawLine(x0, y0, x1, y1, color) {
    ctx.beginPath();
    ctx.moveTo(x0, y0);
    ctx.lineTo(x1, y1);
    ctx.lineWidth = 3;
    ctx.lineCap = 'round';
    ctx.strokeStyle = color;
    ctx.stroke();
}

function handleTouchStart(e) {
    if (!canDraw) return;
    
    const now = Date.now();
    // Only handle single-finger touches for drawing
    if (e.touches.length === 1) {
        // If the last touch ended very recently, don't start drawing yet
        if (now - lastTouchTime > 100) {
            isDrawing = true;
            const pos = getPosition(e);
            lastX = pos.x;
            lastY = pos.y;
            e.preventDefault(); // Prevent default only for drawing
        }
    }
}

function handleTouchMove(e) {
    if (!canDraw) return;
    
    // Only handle drawing for single-finger touches
    if (isDrawing && e.touches.length === 1) {
        draw(e);
        e.preventDefault(); // Prevent default only for drawing
    }
}

function handleTouchEnd(e) {
    // Immediately reset drawing state
    if (isDrawing) {
        isDrawing = false;
        // Record when the touch ended
        lastTouchTime = Date.now();
    }
}

function startDrawing(e) {
    if (!canDraw) return;
    
    if (e.type.includes('mouse')) {
        isDrawing = true;
        const pos = getPosition(e);
        lastX = pos.x;
        lastY = pos.y;
    }
}

function stopDrawing() {
    isDrawing = false;
}

function draw(e) {
    if (!isDrawing || !canDraw) return;

    const pos = getPosition(e);

    drawLine(lastX, lastY, pos.x, pos.y, currentColor);

    // Emit line data
    socket.emit('draw', {
        type: 'draw',
        x0: lastX,
        y0: lastY,
        x1: pos.x,
        y1: pos.y,
        color: currentColor
    });

    lastX = pos.x;
    lastY = pos.y;
}

// Receive drawing data from server
socket.on('draw', (data) => {
    if (data.type === 'draw') {
        drawLine(data.x0, data.y0, data.x1, data.y1, data.color);
    }
});

// Handle forced canvas clear
socket.on('force-clear-canvas', () => {
    // Immediately stop any drawing and prevent new drawing until next interaction
    isDrawing = false;
    canDraw = false;
    
    // Force clear the canvas
    ctx.fillStyle = '#efefef';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    
    // Reset drawing states
    lastX = 0;
    lastY = 0;
    
    // Re-enable drawing on next touch/click
    setTimeout(() => {
        canDraw = true;
    }, 100);
    
    console.log('Canvas force cleared by server');
});

// Event listeners for mouse
canvas.addEventListener('mousedown', startDrawing);
canvas.addEventListener('mousemove', draw);
canvas.addEventListener('mouseup', stopDrawing);
canvas.addEventListener('mouseout', stopDrawing);

// Event listeners for touch devices
canvas.addEventListener('touchstart', handleTouchStart, { passive: false });
canvas.addEventListener('touchmove', handleTouchMove, { passive: false });
canvas.addEventListener('touchend', handleTouchEnd);
canvas.addEventListener('touchcancel', handleTouchEnd);

// Color selection
document.querySelectorAll('.color-dot').forEach(dot => {
    dot.addEventListener('click', (e) => {
        currentColor = e.target.style.backgroundColor;
    });
});