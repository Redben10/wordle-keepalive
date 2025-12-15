const { io } = require('socket.io-client');
const http = require('http');
const https = require('https');

// Configuration
const SERVER_URL = 'https://wordle.geobattery.com/';
const SELF_URL = process.env.RENDER_EXTERNAL_URL || 'http://localhost:3001';
const PORT = process.env.PORT || 3001;
const playerName = 'KeepAliveBot_' + Math.random().toString(36).substring(2, 6);

// Simple HTTP server to keep this service alive
const server = http.createServer((req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    
    if (url.pathname === '/status') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            status: 'running',
            player: playerName,
            stats: stats,
            uptime: Math.round((Date.now() - startTime) / 1000),
            timestamp: new Date().toISOString()
        }));
    } else if (url.pathname === '/action') {
        const action = url.searchParams.get('type') || 'unknown';
        log(`Received self-ping: ${action}`);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ received: action, timestamp: new Date().toISOString() }));
    } else {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('Wordle Keep-Alive Worker is running!');
    }
});

server.listen(PORT, () => {
    log(`HTTP server listening on port ${PORT}`);
});

// Ping self to keep this service alive
function pingSelf(actionType) {
    const url = `${SELF_URL}/action?type=${encodeURIComponent(actionType)}`;
    const client = url.startsWith('https') ? https : http;
    
    client.get(url, (res) => {
        log(`Self-ping successful: ${actionType}`);
    }).on('error', (err) => {
        // Ignore errors for self-ping (might fail on localhost)
    });
}

const startTime = Date.now();

let socket = null;
let myFriendCode = null;
let currentRoomCode = null;
let stats = {
    roomsCreated: 0,
    messagesSent: 0,
    actionsCount: 0
};

// Random helpers
function randomInt(min, max) {
    return Math.floor(Math.random() * (max - min + 1)) + min;
}

function randomDelay() {
    // Random delay between 8-14 minutes (in ms)
    return randomInt(8 * 60 * 1000, 14 * 60 * 1000);
}

function log(message) {
    const now = new Date().toISOString();
    console.log(`[${now}] ${message}`);
}

// Actions
const actions = [
    {
        name: 'Create and join room',
        weight: 3,
        execute: () => {
            return new Promise((resolve) => {
                log('Creating a new room...');
                socket.emit('createRoom', { 
                    maxPlayers: randomInt(2, 6), 
                    maxRounds: randomInt(3, 10),
                    playerName: playerName
                });
                
                const onRoomCreated = (data) => {
                    currentRoomCode = data.roomCode;
                    stats.roomsCreated++;
                    stats.actionsCount++;
                    log(`Room created: ${data.roomCode}`);
                    pingSelf('room_created');
                    
                    // Leave room after a bit
                    setTimeout(() => {
                        if (currentRoomCode) {
                            socket.emit('leaveRoom');
                            log(`Left room: ${currentRoomCode}`);
                            currentRoomCode = null;
                        }
                        resolve();
                    }, randomInt(5000, 15000));
                };
                
                socket.once('roomCreated', onRoomCreated);
                
                // Timeout fallback
                setTimeout(() => {
                    socket.off('roomCreated', onRoomCreated);
                    resolve();
                }, 20000);
            });
        }
    },
    {
        name: 'Send self message',
        weight: 2,
        execute: () => {
            return new Promise((resolve) => {
                if (!myFriendCode) {
                    log('No friend code yet, skipping message');
                    resolve();
                    return;
                }
                
                const messages = ['ping', 'still here', 'keepalive', '👋', 'test', 'hello', 'checking in'];
                const msg = messages[randomInt(0, messages.length - 1)];
                
                socket.emit('sendChatMessage', {
                    toFriendCode: myFriendCode,
                    message: msg
                });
                
                stats.messagesSent++;
                stats.actionsCount++;
                log(`Sent message: "${msg}"`);
                pingSelf('message_sent');
                resolve();
            });
        }
    },
    {
        name: 'Update status',
        weight: 2,
        execute: () => {
            return new Promise((resolve) => {
                const isAway = Math.random() > 0.5;
                socket.emit('updateAwayStatus', { away: isAway });
                stats.actionsCount++;
                log(`Updated status: ${isAway ? 'Away' : 'Online'}`);
                pingSelf('status_updated');
                resolve();
            });
        }
    },
    {
        name: 'Browse rooms',
        weight: 3,
        execute: () => {
            return new Promise((resolve) => {
                log('Browsing for rooms...');
                socket.emit('updateRoomStatus', { inRoom: false, roomCode: null });
                stats.actionsCount++;
                log('Finished browsing');
                pingSelf('browsed_rooms');
                resolve();
            });
        }
    }
];

// Pick weighted random action
function pickAction() {
    const totalWeight = actions.reduce((sum, a) => sum + a.weight, 0);
    let random = Math.random() * totalWeight;
    
    for (const action of actions) {
        random -= action.weight;
        if (random <= 0) return action;
    }
    return actions[0];
}

// Execute action and schedule next
async function doAction() {
    const action = pickAction();
    log(`Executing: ${action.name}`);
    
    try {
        await action.execute();
    } catch (err) {
        log(`Error: ${err.message}`);
    }
    
    scheduleNextAction();
}

// Schedule next action
function scheduleNextAction() {
    const delay = randomDelay();
    const minutes = Math.round(delay / 60000);
    log(`Next action in ${minutes} minutes`);
    setTimeout(doAction, delay);
}

// Connect to server
function connect() {
    log(`Connecting to ${SERVER_URL}...`);
    
    socket = io(SERVER_URL, {
        transports: ['websocket', 'polling'],
        reconnection: true,
        reconnectionAttempts: Infinity,
        reconnectionDelay: 5000,
        reconnectionDelayMax: 30000
    });
    
    socket.on('connect', () => {
        log('Connected to server!');
        socket.emit('registerUser', { name: playerName });
    });
    
    socket.on('friendCodeAssigned', (data) => {
        myFriendCode = data.friendCode;
        log(`Assigned friend code: ${myFriendCode}`);
    });
    
    socket.on('disconnect', (reason) => {
        log(`Disconnected: ${reason}`);
    });
    
    socket.on('connect_error', (err) => {
        log(`Connection error: ${err.message}`);
    });
    
    // Start actions after connection
    socket.once('connect', () => {
        setTimeout(doAction, randomInt(5000, 15000));
    });
}

// Print stats periodically
setInterval(() => {
    log(`Stats - Rooms: ${stats.roomsCreated}, Messages: ${stats.messagesSent}, Actions: ${stats.actionsCount}`);
}, 5 * 60 * 1000); // Every 5 minutes

// Start
log('=== Wordle Keep-Alive Worker ===');
log(`Player name: ${playerName}`);
connect();

// Keep process alive
process.on('SIGINT', () => {
    log('Shutting down...');
    if (socket) socket.disconnect();
    process.exit(0);
});
