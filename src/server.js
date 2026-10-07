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

const sydneyParts = new Intl.DateTimeFormat('en-US', {
    timeZone: TIME_ZONE,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
});

/** Sydney wall-clock date/time of an instant, as numbers. */
function getSydneyWallClock(date) {
    const parts = {};
    for (const { type, value } of sydneyParts.formatToParts(date)) {
        if (type !== 'literal') parts[type] = Number(value);
    }
    return parts;
}

/** Sydney's UTC offset in milliseconds at the given instant (+10h or +11h). */
function getSydneyOffsetMs(date) {
    const p = getSydneyWallClock(date);
    const wallClockAsUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
    const instantToSecond = Math.floor(date.getTime() / 1_000) * 1_000;
    return wallClockAsUtc - instantToSecond;
}

/**
 * The instant of the next midnight on Sydney's calendar.
 * The offset is read once at "now" for a first guess and once at the guess
 * itself, so a daylight-saving change on the day in between (they happen
 * at 2am/3am, never at midnight) still lands on exactly 00:00:00.
 */
function getNextSydneyMidnight(now = new Date()) {
    const today = getSydneyWallClock(now);
    const tomorrowMidnightWallClock = Date.UTC(today.year, today.month - 1, today.day + 1);
    const guess = tomorrowMidnightWallClock - getSydneyOffsetMs(now);
    return new Date(tomorrowMidnightWallClock - getSydneyOffsetMs(new Date(guess)));
}

function scheduleNextMidnightSnapshot() {
    clearTimeout(snapshotTimeout);

    const now = new Date();
    const delay = getNextSydneyMidnight(now).getTime() - now.getTime();
    console.log(`Next snapshot in ${Math.round(delay / 60_000)} minutes (Sydney time now: ${formatSydneyTime(now)})`);

    snapshotTimeout = setTimeout(async () => {
        try {
            console.log(`Taking scheduled snapshot at ${formatSydneyTime()} Sydney time`);
            await takeSnapshot(drawingHistory, io);
        } catch (error) {
            console.error('Error in scheduled snapshot:', error);
        }
        scheduleNextMidnightSnapshot();
    }, delay);
}

scheduleNextMidnightSnapshot();

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
