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
let syncComplete = true; // Initialize to true to allow drawing immediately if no delay is needed

// Fill canvas with initial background color
ctx.fillStyle = '#efefef';
ctx.fillRect(0, 0, canvas.width, canvas.height);

// Handle window focus
window.addEventListener('focus', () => {
    console.log('Page regained focus. Clearing canvas and requesting current state.');
    ctx.fillStyle = '#efefef';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    socket.emit('request-state');
});

document.addEventListener('visibilitychange', () => {
    if (!document.hidden) {
        socket.emit('request-state');
    }
});

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
    syncComplete = true; // Ensure drawing is unlocked after synchronization
    console.log('Synchronization complete. Drawing is now enabled.');
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
    if (!canDraw || !syncComplete) {
        console.log('Cannot start drawing. SyncComplete:', syncComplete, 'CanDraw:', canDraw);
        return; 
    }
    const now = Date.now();
    if (e.touches.length === 1) {
        if (now - lastTouchTime > 100) {
            isDrawing = true;
            const pos = getPosition(e);
            lastX = pos.x;
            lastY = pos.y;
            e.preventDefault();
        }
    }
}

function handleTouchMove(e) {
    if (!canDraw || !syncComplete) return;
    if (isDrawing && e.touches.length === 1) {
        draw(e);
        e.preventDefault();
    }
}

function handleTouchEnd(e) {
    if (isDrawing) {
        isDrawing = false;
        lastTouchTime = Date.now();
    }
}

function startDrawing(e) {
    if (!canDraw || !syncComplete) {
        console.log('Cannot start drawing. SyncComplete:', syncComplete, 'CanDraw:', canDraw);
        return; 
    }
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
    if (!isDrawing || !canDraw || !syncComplete) return;
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

socket.on('draw', (data) => {
    if (data.type === 'draw') {
        drawLine(data.x0, data.y0, data.x1, data.y1, data.color);
    }
});

socket.on('force-clear-canvas', () => {
    console.log('Canvas force cleared by server.');
    isDrawing = false;
    canDraw = false;
    syncComplete = false; // Lock drawing until resync
    ctx.fillStyle = '#efefef';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    setTimeout(() => {
        canDraw = true;
        syncComplete = true; // Unlock drawing after reset
        console.log('Canvas reset complete. Drawing enabled.');
    }, 100);
});

canvas.addEventListener('mousedown', startDrawing);
canvas.addEventListener('mousemove', draw);
canvas.addEventListener('mouseup', stopDrawing);
canvas.addEventListener('mouseout', stopDrawing);

canvas.addEventListener('touchstart', handleTouchStart, { passive: false });
canvas.addEventListener('touchmove', handleTouchMove, { passive: false });
canvas.addEventListener('touchend', handleTouchEnd);
canvas.addEventListener('touchcancel', handleTouchEnd);

document.querySelectorAll('.color-dot').forEach(dot => {
    dot.addEventListener('click', (e) => {
        currentColor = e.target.style.backgroundColor;
    });
});
