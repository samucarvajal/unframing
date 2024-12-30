// Connect to the server
const socket = io();

// Initialize canvas
const canvas = document.getElementById('drawingCanvas');
const ctx = canvas.getContext('2d');
let isDrawing = false;
let currentColor = '#1d1d1d';
let lastX = 0;
let lastY = 0;
let canDraw = true;

// Fill canvas with initial background color
ctx.fillStyle = '#efefef';
ctx.fillRect(0, 0, canvas.width, canvas.height);

// Handle window focus
window.addEventListener('focus', () => {
    ctx.fillStyle = '#efefef';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    socket.emit('request-state');
});

// Handle visibility change
document.addEventListener('visibilitychange', () => {
    if (!document.hidden) {
        socket.emit('request-state');
    }
});

// Drawing functions
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

// Touch handlers for canvas
function handleTouchStart(e) {
    if (!canDraw) return;
    
    if (e.touches.length === 1) {
        isDrawing = true;
        const pos = getPosition(e);
        lastX = pos.x;
        lastY = pos.y;
        e.preventDefault();
    }
}

function handleTouchMove(e) {
    if (e.touches.length > 1) {
        isDrawing = false;
        return;
    }
    
    if (isDrawing && e.touches.length === 1) {
        const pos = getPosition(e);
        drawLine(lastX, lastY, pos.x, pos.y, currentColor);
        
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
        e.preventDefault();
    }
}

function handleTouchEnd(e) {
    if (isDrawing) {
        isDrawing = false;
        socket.emit('draw', { type: 'end' });
    }
}

// Mouse handlers
function startDrawing(e) {
    if (!canDraw || e.type.includes('touch')) return;
    
    isDrawing = true;
    const pos = getPosition(e);
    lastX = pos.x;
    lastY = pos.y;
}

function draw(e) {
    if (!isDrawing || !canDraw || e.type.includes('touch')) return;

    const pos = getPosition(e);
    drawLine(lastX, lastY, pos.x, pos.y, currentColor);

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

function stopDrawing() {
    if (isDrawing) {
        isDrawing = false;
        socket.emit('draw', { type: 'end' });
    }
}

// Improved color selection handling
function handleColorSelect(e) {
    e.preventDefault();
    e.stopPropagation();
    currentColor = e.target.style.backgroundColor;
    
    // Visual feedback
    document.querySelectorAll('.color-dot').forEach(dot => {
        dot.classList.remove('selected');
    });
    e.target.classList.add('selected');
}

// Socket event handlers
socket.on('drawing-history', (history) => {
    history.forEach(data => {
        if (data.type === 'draw') {
            drawLine(data.x0, data.y0, data.x1, data.y1, data.color);
        }
    });
});

socket.on('current-state', (history) => {
    ctx.fillStyle = '#efefef';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    
    history.forEach(data => {
        if (data.type === 'draw') {
            drawLine(data.x0, data.y0, data.x1, data.y1, data.color);
        }
    });
});

socket.on('draw', (data) => {
    if (data.type === 'draw') {
        drawLine(data.x0, data.y0, data.x1, data.y1, data.color);
    }
});

socket.on('force-clear-canvas', () => {
    isDrawing = false;
    canDraw = false;
    
    ctx.fillStyle = '#efefef';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    
    lastX = 0;
    lastY = 0;
    
    setTimeout(() => {
        canDraw = true;
    }, 100);
});

// Event listeners for canvas
canvas.addEventListener('mousedown', startDrawing);
canvas.addEventListener('mousemove', draw);
canvas.addEventListener('mouseup', stopDrawing);
canvas.addEventListener('mouseout', stopDrawing);

canvas.addEventListener('touchstart', handleTouchStart, { passive: false });
canvas.addEventListener('touchmove', handleTouchMove, { passive: false });
canvas.addEventListener('touchend', handleTouchEnd);
canvas.addEventListener('touchcancel', handleTouchEnd);

// Improved color selection event listeners
document.querySelectorAll('.color-dot').forEach(dot => {
    dot.addEventListener('touchstart', handleColorSelect, { passive: false });
    dot.addEventListener('mousedown', handleColorSelect);
});