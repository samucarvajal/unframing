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
    // No CORS config: the page is served from this same origin, so only it
    // can connect. Another website can't embed a client that draws here.
    transports: ['websocket', 'polling'],
    pingTimeout: 60_000,
    pingInterval: 25_000,
    connectTimeout: 45_000,
    maxHttpBufferSize: 4096, // a segment is ~100 bytes; nothing legitimate is bigger than this
});

// Railway terminates TLS at its proxy; trust it for client addresses
app.set('trust proxy', 1);

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

// --- Daily snapshot scheduling (midnight, Sydney time) ---------------------

let snapshotTimeout = null;

function formatSydneyTime(date = new Date()) {
    return date.toLocaleString('en-AU', { timeZone: TIME_ZONE, hour12: false });
}

/** Sydney's UTC offset in minutes at a given instant (handles daylight saving). */
function sydneyOffsetMinutes(date) {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone: TIME_ZONE, timeZoneName: 'longOffset' })
        .formatToParts(date)
        .find((p) => p.type === 'timeZoneName').value; // e.g. "GMT+10:00" or "GMT+11:00"
    const m = parts.match(/GMT([+-])(\d{2}):(\d{2})/);
    if (!m) return 600; // AEST fallback; should never happen
    return (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3]));
}

/** The calendar date (year, month, day) it currently is in Sydney. */
function sydneyDateParts(date) {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone: TIME_ZONE, year: 'numeric', month: 'numeric', day: 'numeric' })
        .formatToParts(date);
    const get = (type) => Number(parts.find((p) => p.type === type).value);
    return { year: get('year'), month: get('month'), day: get('day') };
}

/**
 * The instant of the next midnight in Sydney. Takes the Sydney calendar
 * date, moves to the following day at 00:00 local, and converts to UTC
 * using the offset in force at that moment, so the day is 23, 24 or 25
 * hours long as daylight saving requires.
 */
function getNextSydneyMidnight(now = new Date()) {
    const { year, month, day } = sydneyDateParts(now);
    const localMidnightAsUtc = Date.UTC(year, month - 1, day + 1, 0, 0, 0, 0);
    // First guess with the current offset, then correct with the offset at the guess
    let candidate = new Date(localMidnightAsUtc - sydneyOffsetMinutes(now) * 60_000);
    candidate = new Date(localMidnightAsUtc - sydneyOffsetMinutes(candidate) * 60_000);
    return candidate;
}

function scheduleMidnightSnapshot() {
    clearTimeout(snapshotTimeout);

    const next = getNextSydneyMidnight();
    const delay = Math.max(1000, next.getTime() - Date.now());
    const hours = Math.floor(delay / 3_600_000);
    const minutes = Math.round((delay % 3_600_000) / 60_000);
    console.log(`Next reset at ${formatSydneyTime(next)} Sydney time (in ${hours}h ${minutes}m)`);

    snapshotTimeout = setTimeout(async () => {
        try {
            console.log(`Taking scheduled snapshot at ${formatSydneyTime()} Sydney time`);
            await takeSnapshot(drawingHistory, io);
        } catch (error) {
            console.error('Error in scheduled snapshot:', error);
        }
        scheduleMidnightSnapshot();
    }, delay);
}

scheduleMidnightSnapshot();

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
