// Load environment variables before anything reads process.env
require('dotenv').config();

const path = require('path');
const express = require('express');
const { Server } = require('socket.io');

const DrawingHistory = require('./services/drawingHistory');
const initializeSocket = require('./services/socket');
const { takeSnapshot } = require('./services/snapshot');

const PORT = process.env.PORT || 3000;
const TIME_ZONE = 'Australia/Sydney';
const SHUTDOWN_GRACE_MS = 10_000;

// Keep the process alive through non-critical errors, but make sure they're logged
process.on('uncaughtException', (error) => {
    console.error('Uncaught exception:', error);
});

process.on('unhandledRejection', (reason) => {
    console.error('Unhandled rejection:', reason);
});

const app = express();
const http = require('http').createServer(app);

const io = new Server(http, {
    cors: {
        origin: '*',
        methods: ['GET', 'POST'],
    },
    transports: ['websocket', 'polling'],
    pingTimeout: 60_000,
    pingInterval: 25_000,
    connectTimeout: 45_000,
    maxHttpBufferSize: 1e6, // 1 MB max payload
});

// Always serve fresh HTML/JS so clients pick up deploys immediately
app.use((req, res, next) => {
    res.set({
        'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
        'Pragma': 'no-cache',
        'Expires': '0',
        'Surrogate-Control': 'no-store',
    });
    next();
});

app.get('/health', (req, res) => {
    res.status(200).send('OK');
});

// Resolve relative to this file so the server works from any working directory
app.use(express.static(path.join(__dirname, '..', 'public')));

app.use((err, req, res, next) => {
    console.error('Express error:', err);
    res.status(500).send('Something went wrong');
});

const drawingHistory = new DrawingHistory();
initializeSocket(io, drawingHistory);

// --- Hourly snapshot scheduling (on the hour, Sydney time) -----------------

let snapshotTimeout = null;

function formatSydneyTime(date = new Date()) {
    return date.toLocaleString('en-AU', { timeZone: TIME_ZONE, hour12: false });
}

/**
 * Milliseconds until the next wall-clock hour boundary in Sydney.
 * Hour boundaries line up with UTC hour boundaries (the Sydney offset is a
 * whole number of hours in both standard and daylight time), so this only
 * needs the current minute/second/millisecond.
 */
function getMillisecondsUntilNextHour(now = new Date()) {
    const elapsedInHour =
        now.getUTCMinutes() * 60_000 +
        now.getUTCSeconds() * 1_000 +
        now.getUTCMilliseconds();
    return 3_600_000 - elapsedInHour;
}

function scheduleNextHourSnapshot() {
    clearTimeout(snapshotTimeout);

    const delay = getMillisecondsUntilNextHour();
    console.log(`Next snapshot in ${Math.round(delay / 60_000)} minutes (Sydney time now: ${formatSydneyTime()})`);

    snapshotTimeout = setTimeout(async () => {
        try {
            console.log(`Taking scheduled snapshot at ${formatSydneyTime()} Sydney time`);
            await takeSnapshot(drawingHistory, io);
        } catch (error) {
            console.error('Error in scheduled snapshot:', error);
        }
        scheduleNextHourSnapshot();
    }, delay);
}

scheduleNextHourSnapshot();

// --- Startup / shutdown ---------------------------------------------------

// A failure to bind is fatal; don't let the global handler swallow it and
// leave a process running that serves nothing
http.on('error', (error) => {
    console.error(`Failed to start server on port ${PORT}:`, error.message);
    process.exit(1);
});

http.listen(PORT, '0.0.0.0', () => {
    console.log(`Server is running on port ${PORT}`);
    console.log(`Current Sydney time: ${formatSydneyTime()}`);
});

let shuttingDown = false;

async function gracefulShutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`Received ${signal}, shutting down gracefully...`);

    clearTimeout(snapshotTimeout);

    // Don't let a slow snapshot or lingering connection keep the process alive
    const forceExit = setTimeout(() => {
        console.error('Forceful shutdown after timeout');
        process.exit(1);
    }, SHUTDOWN_GRACE_MS);
    forceExit.unref();

    if (drawingHistory.hasDrawings()) {
        try {
            console.log('Taking final snapshot before shutdown...');
            await takeSnapshot(drawingHistory, io);
        } catch (error) {
            console.error('Error taking final snapshot:', error);
        }
    }

    // Closing Socket.IO also closes the underlying HTTP server
    io.close((err) => {
        if (err) {
            console.error('Error closing server:', err);
            process.exit(1);
        }
        console.log('Server closed');
        process.exit(0);
    });
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
