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
let syncComplete = true; // Simplified to default as true
let lastDrawnPoint = { x: null, y: null };

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
    syncComplete = true; // Allow drawing immediately after sync
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

// Function to check if a point is within the viewport bounds
function isWithinViewport(clientX, clientY) {
    // Get the viewport dimensions
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;
    
    // Add a small threshold (5px) for better edge detection
    const threshold = 5;
    
    // Check if the point is within bounds (with threshold)
    return (
        clientX >= threshold && 
        clientX <= viewportWidth - threshold && 
        clientY >= threshold && 
        clientY <= viewportHeight - threshold
    );
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
            lastDrawnPoint = { x: e.touches[0].clientX, y: e.touches[0].clientY };
            e.preventDefault();
        }
    }
}

function handleTouchMove(e) {
    if (!canDraw || !syncComplete) return;
    if (isDrawing && e.touches.length === 1) {
        // Check if the touch is at the viewport edge
        if (!isWithinViewport(e.touches[0].clientX, e.touches[0].clientY)) {
            // Stop drawing if we're at the edge
            isDrawing = false;
            return;
        }
        
        // If the distance is too large between points, it might be a jump across screen edges
        const dx = Math.abs(e.touches[0].clientX - lastDrawnPoint.x);
        const dy = Math.abs(e.touches[0].clientY - lastDrawnPoint.y);
        if (dx > 100 || dy > 100) {
            isDrawing = false;
            return;
        }
        
        draw(e);
        lastDrawnPoint = { x: e.touches[0].clientX, y: e.touches[0].clientY };
        e.preventDefault();
    }
}

function handleTouchEnd(e) {
    if (isDrawing) {
        isDrawing = false;
        lastTouchTime = Date.now();
        lastDrawnPoint = { x: null, y: null };
    }
}

function startDrawing(e) {
    if (!canDraw || !syncComplete) return;
    if (e.type.includes('mouse')) {
        isDrawing = true;
        const pos = getPosition(e);
        lastX = pos.x;
        lastY = pos.y;
        lastDrawnPoint = { x: e.clientX, y: e.clientY };
    }
}

function stopDrawing() {
    isDrawing = false;
    lastDrawnPoint = { x: null, y: null };
}

function draw(e) {
    if (!isDrawing || !canDraw || !syncComplete) return;
    
    // For mouse events, check if we're at the viewport edge
    if (!e.type.includes('touch')) {
        if (!isWithinViewport(e.clientX, e.clientY)) {
            // Stop drawing if we're at the edge
            isDrawing = false;
            return;
        }
        
        // If the distance is too large between points, it might be a jump across screen edges
        if (lastDrawnPoint.x !== null) {
            const dx = Math.abs(e.clientX - lastDrawnPoint.x);
            const dy = Math.abs(e.clientY - lastDrawnPoint.y);
            if (dx > 100 || dy > 100) {
                isDrawing = false;
                return;
            }
        }
        
        lastDrawnPoint = { x: e.clientX, y: e.clientY };
    }
    
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
    syncComplete = true; // Simplify logic for uninterrupted drawing
    ctx.fillStyle = '#efefef';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    setTimeout(() => {
        canDraw = true;
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