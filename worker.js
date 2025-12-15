const { io } = require('socket.io-client');
const http = require('http');
const https = require('https');

// Configuration
const SERVER_URL = 'https://wordle.geobattery.com';
const SELF_URL = process.env.RENDER_EXTERNAL_URL || 'http://localhost:3001';
const PORT = process.env.PORT || 3001;

// Random player names that look real
const namePool = ['Alex', 'Jordan', 'Taylor', 'Morgan', 'Casey', 'Riley', 'Quinn', 'Avery', 'Parker', 'Sage', 'Blake', 'Drew', 'Jamie', 'Reese', 'Skyler'];
const suffixes = ['', '99', '23', '_x', '2k', 'Jr', '007', '_pro', 'XD', ''];
const playerName = namePool[Math.floor(Math.random() * namePool.length)] + suffixes[Math.floor(Math.random() * suffixes.length)];

// Realistic user agents
const userAgents = [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:121.0) Gecko/20100101 Firefox/121.0',
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15'
];
const userAgent = userAgents[Math.floor(Math.random() * userAgents.length)];

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
            lastHttpPing: lastHttpPingTime ? new Date(lastHttpPingTime).toISOString() : null,
            socketConnected: socket ? socket.connected : false,
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

// Track last HTTP ping
let lastHttpPingTime = null;

// HTTP ping to keep the Wordle server alive (more reliable than websocket alone)
function pingWordleServer() {
    return new Promise((resolve) => {
        const url = new URL(SERVER_URL);
        const options = {
            hostname: url.hostname,
            port: url.port || 443,
            path: '/',
            method: 'GET',
            timeout: 30000,
            headers: {
                'User-Agent': userAgent,
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
                'Accept-Language': 'en-US,en;q=0.5',
                'Connection': 'keep-alive',
                'Cache-Control': 'no-cache'
            }
        };
        
        const req = https.request(options, (res) => {
            lastHttpPingTime = Date.now();
            stats.httpPings = (stats.httpPings || 0) + 1;
            log(`HTTP ping successful: ${res.statusCode}`);
            res.resume(); // Consume response data
            resolve(true);
        });
        
        req.on('error', (err) => {
            log(`HTTP ping error: ${err.message}`);
            resolve(false);
        });
        
        req.on('timeout', () => {
            log('HTTP ping timeout');
            req.destroy();
            resolve(false);
        });
        
        req.end();
    });
}

// Ping self to keep this service alive
function pingSelf(actionType) {
    const url = `${SELF_URL}/action?type=${encodeURIComponent(actionType)}`;
    const client = url.startsWith('https') ? https : http;
    
    client.get(url, (res) => {
        log(`Self-ping successful: ${actionType}`);
        res.resume();
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
    // Random delay between 6-14 minutes (in ms) - varied to look natural
    return randomInt(6 * 60 * 1000, 14 * 60 * 1000);
}

function randomHttpDelay() {
    // Random delay between 4-12 minutes for HTTP pings
    return randomInt(4 * 60 * 1000, 12 * 60 * 1000);
}

function log(message) {
    const now = new Date().toISOString();
    console.log(`[${now}] ${message}`);
}

// Actions - weighted to look like real user behavior
const actions = [
    {
        name: 'Create and join room',
        weight: 4,
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
                
                const messages = [
                    'gg', 'nice', 'lol', 'brb', 'hey', '👋', '🎮', 'yo', 
                    'good game', 'one more?', 'ready', 'lets go', 'hi',
                    'sup', ':)', 'haha', 'close one', 'wow'
                ];
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
        reconnectionDelayMax: 30000,
        timeout: 60000,
        pingTimeout: 60000,
        pingInterval: 25000
    });
    
    socket.on('connect', () => {
        log('Connected to server!');
        socket.emit('registerUser', { name: playerName });
    });
    
    socket.on('userRegistered', (data) => {
        myFriendCode = data.friendCode;
        log(`Registered with friend code: ${myFriendCode}`);
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
        // Try HTTP ping when socket fails
        pingWordleServer();
    });
    
    socket.on('reconnect', (attemptNumber) => {
        log(`Reconnected after ${attemptNumber} attempts`);
    });
    
    socket.on('reconnect_attempt', (attemptNumber) => {
        log(`Reconnection attempt ${attemptNumber}`);
    });
    
    // Start actions after connection
    socket.once('connect', () => {
        setTimeout(doAction, randomInt(5000, 15000));
    });
}

// Regular HTTP ping with randomized interval to look natural
function scheduleHttpPing() {
    const delay = randomHttpDelay();
    const minutes = Math.round(delay / 60000);
    log(`Next HTTP ping in ~${minutes} minutes`);
    setTimeout(async () => {
        log('Performing scheduled HTTP ping...');
        await pingWordleServer();
        pingSelf('scheduled_http_ping');
        scheduleHttpPing(); // Schedule next one
    }, delay);
}

// Start randomized HTTP pings
scheduleHttpPing();

// Also ping self with randomized interval
function scheduleSelfPing() {
    const delay = randomInt(8 * 60 * 1000, 14 * 60 * 1000);
    setTimeout(() => {
        pingSelf('keepalive_interval');
        scheduleSelfPing();
    }, delay);
}
scheduleSelfPing();

// Print stats periodically (randomized)
function scheduleStatsLog() {
    const delay = randomInt(4 * 60 * 1000, 7 * 60 * 1000);
    setTimeout(() => {
        const uptimeMin = Math.round((Date.now() - startTime) / 60000);
        log(`Stats - Uptime: ${uptimeMin}m, Rooms: ${stats.roomsCreated}, Messages: ${stats.messagesSent}, Actions: ${stats.actionsCount}, HTTP: ${stats.httpPings || 0}, Socket: ${socket?.connected ? 'connected' : 'disconnected'}`);
        scheduleStatsLog();
    }, delay);
}
scheduleStatsLog();

// Start
log('=== Wordle Keep-Alive Worker ===');
log(`Player name: ${playerName}`);

// Do initial HTTP ping to wake up the server
pingWordleServer().then(() => {
    log('Initial HTTP ping complete, connecting socket...');
    connect();
});

// Keep process alive
process.on('SIGINT', () => {
    log('Shutting down...');
    if (socket) socket.disconnect();
    process.exit(0);
});
