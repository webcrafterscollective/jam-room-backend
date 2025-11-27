/**
 * server.js — Production Grade Cascading Sync Music Jamming Server
 * 
 * Architecture:
 * - Drummer (lead) → listens to own instrument, owns the metronome
 * - Bassist → locks to drummer, compensates for network latency to drummer
 * - Rhythm Guitar → locks to drummer + bassist
 * - Lead Guitar/Vocals → locks to drummer + bassist + rhythm guitar
 * 
 * Features:
 * - Role-based musician hierarchy
 * - Per-peer latency matrix with continuous measurement
 * - Cascading metronome sync with individual offsets
 * - Priority-based audio routing
 * - Production-grade error handling and logging
 */

'use strict';

const os = require('os');
const http = require('http');
const express = require('express');
const { Server: SocketIOServer } = require('socket.io');
const mediasoup = require('mediasoup');
const cors = require('cors');

// ═══════════════════════════════════════════════════════════════════════════════
// 1. CONFIGURATION
// ═══════════════════════════════════════════════════════════════════════════════

const config = {
  env: process.env.NODE_ENV || 'development',
  listenIp: process.env.LISTEN_IP || '0.0.0.0',
  listenPort: Number(process.env.PORT) || 4000,
  
  // Latency measurement settings
  latency: {
    measurementInterval: 2000,      // How often to measure latency (ms)
    historySize: 10,                // Number of samples to keep for averaging
    maxAcceptableLatency: 500,      // Warn if latency exceeds this (ms)
    compensationBuffer: 50,         // Additional buffer for jitter (ms)
  },

  // Audio routing priorities (lower = higher priority)
  roles: {
    DRUMMER:       { priority: 0, syncTo: [],                                         canLead: true  },
    BASSIST:       { priority: 1, syncTo: ['DRUMMER'],                                canLead: true  },
    RHYTHM_GUITAR: { priority: 2, syncTo: ['DRUMMER', 'BASSIST'],                     canLead: false },
    LEAD_GUITAR:   { priority: 3, syncTo: ['DRUMMER', 'BASSIST', 'RHYTHM_GUITAR'],    canLead: false },
    VOCALS:        { priority: 3, syncTo: ['DRUMMER', 'BASSIST', 'RHYTHM_GUITAR'],    canLead: false },
    KEYS:          { priority: 2, syncTo: ['DRUMMER', 'BASSIST'],                     canLead: false },
    PERCUSSION:    { priority: 1, syncTo: ['DRUMMER'],                                canLead: false },
    SPECTATOR:     { priority: 99, syncTo: [],                                        canLead: false },
  },

  mediasoup: {
    numWorkers: Math.max(1, Math.floor(os.cpus().length / 2)),
    worker: {
      logLevel: process.env.NODE_ENV === 'production' ? 'error' : 'warn',
      logTags: ['info', 'ice', 'dtls', 'rtp', 'srtp', 'rtcp'],
      rtcMinPort: Number(process.env.RTC_MIN_PORT) || 40000,
      rtcMaxPort: Number(process.env.RTC_MAX_PORT) || 49999,
    },
    router: {
      mediaCodecs: [
        {
          kind: 'audio',
          mimeType: 'audio/opus',
          clockRate: 48000,
          channels: 2,
          parameters: {
            useinbandfec: 1,
            stereo: 1,
            maxplaybackrate: 48000,
            sprop_maxcapturerate: 48000,
            maxaveragebitrate: 128000,
          },
        },
        {
          kind: 'video',
          mimeType: 'video/VP8',
          clockRate: 90000,
          parameters: {},
        },
        {
          kind: 'video',
          mimeType: 'video/H264',
          clockRate: 90000,
          parameters: {
            'packetization-mode': 1,
            'profile-level-id': '42e01f',
            'level-asymmetry-allowed': 1,
          },
        },
      ],
    },
    webRtcTransport: {
      listenIps: [
        {
          ip: process.env.MEDIASOUP_LISTEN_IP || '0.0.0.0',
          announcedIp: process.env.MEDIASOUP_ANNOUNCED_IP || null,
        },
      ],
      enableUdp: true,
      enableTcp: true,
      preferUdp: true,
      enableSctp: true,
      initialAvailableOutgoingBitrate: 1000000,
      minimumAvailableOutgoingBitrate: 600000,
      maxSctpMessageSize: 262144,
    },
  },
};

// Validate announced IP in production
if (config.env === 'production' && !config.mediasoup.webRtcTransport.listenIps[0].announcedIp) {
  console.error('FATAL: MEDIASOUP_ANNOUNCED_IP must be set in production');
  process.exit(1);
}

// ═══════════════════════════════════════════════════════════════════════════════
// 2. LOGGING & UTILITIES
// ═══════════════════════════════════════════════════════════════════════════════

const LogLevel = { DEBUG: 0, INFO: 1, WARN: 2, ERROR: 3 };
const currentLogLevel = config.env === 'production' ? LogLevel.INFO : LogLevel.DEBUG;

function log(level, scope, msg, data = {}) {
  if (level < currentLogLevel) return;
  const levelStr = ['DEBUG', 'INFO', 'WARN', 'ERROR'][level];
  const output = {
    ts: new Date().toISOString(),
    level: levelStr,
    scope,
    msg,
    ...data
  };
  if (level >= LogLevel.ERROR) {
    console.error(JSON.stringify(output));
  } else {
    console.log(JSON.stringify(output));
  }
}

const logger = {
  debug: (scope, msg, data) => log(LogLevel.DEBUG, scope, msg, data),
  info: (scope, msg, data) => log(LogLevel.INFO, scope, msg, data),
  warn: (scope, msg, data) => log(LogLevel.WARN, scope, msg, data),
  error: (scope, msg, data) => log(LogLevel.ERROR, scope, msg, data),
};

/**
 * Safe callback wrapper - prevents crashes from missing callbacks
 */
function safeCallback(cb, data) {
  if (typeof cb === 'function') {
    try {
      cb(data);
    } catch (err) {
      logger.error('SafeCallback', 'Callback execution failed', { error: err.message });
    }
  } else if (data?.error) {
    logger.warn('SafeCallback', 'No callback provided for error response', { error: data.error });
  }
}

/**
 * Generate unique ID
 */
function generateId(prefix = '') {
  return `${prefix}${Date.now().toString(36)}_${Math.random().toString(36).substr(2, 9)}`;
}

/**
 * Calculate median from array of numbers
 */
function median(arr) {
  if (!arr.length) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * Calculate jitter (standard deviation) from latency samples
 */
function calculateJitter(samples) {
  if (samples.length < 2) return 0;
  const avg = samples.reduce((a, b) => a + b, 0) / samples.length;
  const squareDiffs = samples.map(value => Math.pow(value - avg, 2));
  return Math.sqrt(squareDiffs.reduce((a, b) => a + b, 0) / samples.length);
}

// ═══════════════════════════════════════════════════════════════════════════════
// 3. WORKER MANAGER
// ═══════════════════════════════════════════════════════════════════════════════

class WorkerManager {
  constructor() {
    this.workers = [];
    this.nextWorkerIdx = 0;
  }

  async init() {
    logger.info('WorkerManager', `Spawning ${config.mediasoup.numWorkers} workers...`);
    
    for (let i = 0; i < config.mediasoup.numWorkers; i++) {
      await this.createWorker(i);
    }
    
    logger.info('WorkerManager', 'All workers initialized', {
      count: this.workers.length,
      pids: this.workers.map(w => w.pid)
    });
  }

  async createWorker(index) {
    const worker = await mediasoup.createWorker(config.mediasoup.worker);
    
    worker.on('died', (error) => {
      logger.error('WorkerManager', `Worker ${worker.pid} died`, { error: error?.message });
      
      // Remove dead worker
      this.workers = this.workers.filter(w => w.pid !== worker.pid);
      
      // Attempt to spawn replacement
      setTimeout(async () => {
        try {
          await this.createWorker(index);
          logger.info('WorkerManager', 'Replacement worker spawned');
        } catch (err) {
          logger.error('WorkerManager', 'Failed to spawn replacement worker', { error: err.message });
          if (this.workers.length === 0) {
            logger.error('WorkerManager', 'No workers remaining, exiting...');
            process.exit(1);
          }
        }
      }, 2000);
    });

    this.workers.push({
      worker,
      pid: worker.pid,
      load: 0,
      routers: new Set()
    });
  }

  /**
   * Get least loaded worker using round-robin with load balancing
   */
  getWorker() {
    if (this.workers.length === 0) {
      throw new Error('No workers available');
    }

    // Find worker with minimum load
    let minLoad = Infinity;
    let selectedWorker = null;

    for (const w of this.workers) {
      if (w.load < minLoad) {
        minLoad = w.load;
        selectedWorker = w;
      }
    }

    selectedWorker.load++;
    return selectedWorker.worker;
  }

  releaseWorker(workerPid, routerId) {
    const workerObj = this.workers.find(w => w.pid === workerPid);
    if (workerObj) {
      workerObj.load = Math.max(0, workerObj.load - 1);
      workerObj.routers.delete(routerId);
    }
  }

  getStats() {
    return this.workers.map(w => ({
      pid: w.pid,
      load: w.load,
      routerCount: w.routers.size
    }));
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// 4. LATENCY TRACKER
// ═══════════════════════════════════════════════════════════════════════════════

class LatencyTracker {
  constructor(historySize = config.latency.historySize) {
    this.historySize = historySize;
    // Map: peerId -> Map<targetPeerId, {samples: number[], lastUpdate: number}>
    this.matrix = new Map();
  }

  /**
   * Record a latency measurement between two peers
   */
  record(fromPeerId, toPeerId, rtt) {
    if (!this.matrix.has(fromPeerId)) {
      this.matrix.set(fromPeerId, new Map());
    }
    
    const peerLatencies = this.matrix.get(fromPeerId);
    
    if (!peerLatencies.has(toPeerId)) {
      peerLatencies.set(toPeerId, { samples: [], lastUpdate: 0 });
    }
    
    const entry = peerLatencies.get(toPeerId);
    entry.samples.push(rtt);
    
    // Keep only recent samples
    if (entry.samples.length > this.historySize) {
      entry.samples.shift();
    }
    
    entry.lastUpdate = Date.now();
  }

  /**
   * Get the estimated one-way latency from peer A to peer B
   */
  getLatency(fromPeerId, toPeerId) {
    const peerLatencies = this.matrix.get(fromPeerId);
    if (!peerLatencies) return null;
    
    const entry = peerLatencies.get(toPeerId);
    if (!entry || entry.samples.length === 0) return null;
    
    // Use median for robustness against outliers
    const rtt = median(entry.samples);
    
    // One-way latency is approximately half RTT
    return Math.round(rtt / 2);
  }

  /**
   * Get comprehensive latency stats between two peers
   */
  getStats(fromPeerId, toPeerId) {
    const peerLatencies = this.matrix.get(fromPeerId);
    if (!peerLatencies) return null;
    
    const entry = peerLatencies.get(toPeerId);
    if (!entry || entry.samples.length === 0) return null;
    
    const samples = entry.samples;
    const rtt = median(samples);
    
    return {
      rtt: Math.round(rtt),
      oneWay: Math.round(rtt / 2),
      jitter: Math.round(calculateJitter(samples)),
      samples: samples.length,
      lastUpdate: entry.lastUpdate,
      min: Math.round(Math.min(...samples)),
      max: Math.round(Math.max(...samples))
    };
  }

  /**
   * Calculate cumulative latency through sync chain
   * e.g., for Rhythm Guitar: latency to Drummer + latency to Bassist
   */
  getCumulativeLatency(peerId, syncTargets, participants) {
    let maxLatency = 0;
    
    for (const targetRole of syncTargets) {
      // Find participant with this role
      const targetPeer = Array.from(participants.entries())
        .find(([_, p]) => p.role === targetRole);
      
      if (targetPeer) {
        const [targetId] = targetPeer;
        const latency = this.getLatency(peerId, targetId);
        if (latency !== null) {
          maxLatency = Math.max(maxLatency, latency);
        }
      }
    }
    
    return maxLatency;
  }

  /**
   * Get full latency matrix for a room
   */
  getRoomMatrix(participantIds) {
    const matrix = {};
    
    for (const fromId of participantIds) {
      matrix[fromId] = {};
      for (const toId of participantIds) {
        if (fromId !== toId) {
          matrix[fromId][toId] = this.getStats(fromId, toId);
        }
      }
    }
    
    return matrix;
  }

  /**
   * Clean up entries for a disconnected peer
   */
  removePeer(peerId) {
    this.matrix.delete(peerId);
    
    // Also remove this peer from other peers' entries
    for (const [_, peerLatencies] of this.matrix) {
      peerLatencies.delete(peerId);
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// 5. ROOM MANAGER
// ═══════════════════════════════════════════════════════════════════════════════

class Room {
  constructor(id, router) {
    this.id = id;
    this.router = router;
    this.createdAt = Date.now();
    this.participants = new Map();
    this.latencyTracker = new LatencyTracker();
    
    // Metronome state
    this.metronome = {
      isPlaying: false,
      tempo: 120,
      beatsPerMeasure: 4,
      startTime: 0,           // Server timestamp when metronome started
      currentBeat: 0,         // Current beat position
      leaderId: null,         // Socket ID of drummer/leader
    };
    
    // Session state
    this.session = {
      name: 'Jam Session',
      createdBy: null,
      settings: {
        maxParticipants: 8,
        allowSpectators: true,
        requireRole: true,
      }
    };
  }

  /**
   * Add participant to room
   */
  addParticipant(socketId, participant) {
    this.participants.set(socketId, participant);
    
    // If this is the first participant or they're a drummer, make them leader
    if (!this.metronome.leaderId || participant.role === 'DRUMMER') {
      this.promoteToLeader(socketId);
    }
  }

  /**
   * Remove participant from room
   */
  removeParticipant(socketId) {
    const participant = this.participants.get(socketId);
    if (!participant) return null;
    
    // Clean up participant's resources
    participant.transports.forEach(t => {
      try { t.close(); } catch (e) { /* ignore */ }
    });
    
    this.participants.delete(socketId);
    this.latencyTracker.removePeer(socketId);
    
    // Handle leader succession
    if (this.metronome.leaderId === socketId) {
      this.electNewLeader();
    }
    
    return participant;
  }

  /**
   * Elect new metronome leader based on role priority
   */
  electNewLeader() {
    let bestCandidate = null;
    let bestPriority = Infinity;
    
    for (const [socketId, participant] of this.participants) {
      const roleConfig = config.roles[participant.role];
      if (roleConfig && roleConfig.canLead && roleConfig.priority < bestPriority) {
        bestPriority = roleConfig.priority;
        bestCandidate = socketId;
      }
    }
    
    this.metronome.leaderId = bestCandidate;
    
    if (bestCandidate) {
      logger.info('Room', 'New leader elected', {
        roomId: this.id,
        leaderId: bestCandidate,
        role: this.participants.get(bestCandidate)?.role
      });
    }
  }

  /**
   * Promote specific participant to leader
   */
  promoteToLeader(socketId) {
    const participant = this.participants.get(socketId);
    if (!participant) return false;
    
    const roleConfig = config.roles[participant.role];
    if (!roleConfig?.canLead) return false;
    
    this.metronome.leaderId = socketId;
    return true;
  }

  /**
   * Get all producers in the room
   */
  getAllProducers() {
    const producers = [];
    
    for (const [socketId, participant] of this.participants) {
      for (const producer of participant.producers.values()) {
        producers.push({
          id: producer.id,
          ownerId: socketId,
          ownerRole: participant.role,
          kind: producer.kind,
          paused: producer.paused,
        });
      }
    }
    
    return producers;
  }

  /**
   * Calculate sync offset for a participant based on their role
   */
  calculateSyncOffset(socketId) {
    const participant = this.participants.get(socketId);
    if (!participant) return 0;
    
    const roleConfig = config.roles[participant.role];
    if (!roleConfig) return 0;
    
    // Get cumulative latency to all sync targets
    const latency = this.latencyTracker.getCumulativeLatency(
      socketId,
      roleConfig.syncTo,
      this.participants
    );
    
    // Add compensation buffer for jitter
    return latency + config.latency.compensationBuffer;
  }

  /**
   * Get room status
   */
  getStatus() {
    const participantList = [];
    
    for (const [socketId, p] of this.participants) {
      participantList.push({
        socketId,
        role: p.role,
        displayName: p.displayName,
        isLeader: socketId === this.metronome.leaderId,
        producerCount: p.producers.size,
        consumerCount: p.consumers.size,
      });
    }
    
    return {
      id: this.id,
      participantCount: this.participants.size,
      participants: participantList,
      metronome: this.metronome,
      createdAt: this.createdAt,
      session: this.session,
    };
  }

  isEmpty() {
    return this.participants.size === 0;
  }
}

class RoomManager {
  constructor(workerManager) {
    this.rooms = new Map();
    this.workerManager = workerManager;
  }

  async createRoom(roomId) {
    if (this.rooms.has(roomId)) {
      return this.rooms.get(roomId);
    }

    const worker = this.workerManager.getWorker();
    const router = await worker.createRouter({
      mediaCodecs: config.mediasoup.router.mediaCodecs
    });
    
    router.appData.workerPid = worker.pid;
    router.appData.roomId = roomId;

    const room = new Room(roomId, router);
    this.rooms.set(roomId, room);

    logger.info('RoomManager', 'Room created', {
      roomId,
      workerPid: worker.pid
    });

    return room;
  }

  getRoom(roomId) {
    return this.rooms.get(roomId);
  }

  deleteRoom(roomId) {
    const room = this.rooms.get(roomId);
    if (!room) return false;

    try {
      this.workerManager.releaseWorker(
        room.router.appData.workerPid,
        room.router.id
      );
      room.router.close();
    } catch (err) {
      logger.error('RoomManager', 'Error closing router', { error: err.message });
    }

    this.rooms.delete(roomId);
    logger.info('RoomManager', 'Room deleted', { roomId });
    return true;
  }

  getRoomList() {
    return Array.from(this.rooms.values()).map(room => room.getStatus());
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// 6. PARTICIPANT CLASS
// ═══════════════════════════════════════════════════════════════════════════════

class Participant {
  constructor(socketId, options = {}) {
    this.socketId = socketId;
    this.role = options.role || 'SPECTATOR';
    this.displayName = options.displayName || `User_${socketId.slice(0, 6)}`;
    this.joinedAt = Date.now();
    
    // MediaSoup resources
    this.transports = new Map();
    this.producers = new Map();
    this.consumers = new Map();
    this.dataProducers = new Map();
    this.dataConsumers = new Map();
    
    // Sync state
    this.syncOffset = 0;
    this.clockOffset = 0;  // Offset between client and server clocks
    
    // Stats
    this.stats = {
      messagesReceived: 0,
      messagesSent: 0,
      lastActivity: Date.now(),
    };
  }

  getRoleConfig() {
    return config.roles[this.role] || config.roles.SPECTATOR;
  }

  getSyncTargets() {
    return this.getRoleConfig().syncTo;
  }

  canLead() {
    return this.getRoleConfig().canLead;
  }

  updateActivity() {
    this.stats.lastActivity = Date.now();
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// 7. SERVER INITIALIZATION
// ═══════════════════════════════════════════════════════════════════════════════

const workerManager = new WorkerManager();
let roomManager;

const app = express();

// Middleware
app.use(cors({
  origin: process.env.CORS_ORIGIN || '*',
  methods: ['GET', 'POST'],
  credentials: true,
}));
app.use(express.json());

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    uptime: process.uptime(),
    timestamp: Date.now(),
    workers: workerManager.getStats(),
    rooms: roomManager?.getRoomList().length || 0,
  });
});

// Room list endpoint (for debugging/admin)
app.get('/rooms', (req, res) => {
  res.json(roomManager?.getRoomList() || []);
});

// Role configuration endpoint
app.get('/roles', (req, res) => {
  res.json(config.roles);
});

const httpServer = http.createServer(app);

const io = new SocketIOServer(httpServer, {
  cors: {
    origin: process.env.CORS_ORIGIN || '*',
    methods: ['GET', 'POST'],
    credentials: true,
  },
  pingInterval: 10000,
  pingTimeout: 5000,
  transports: ['websocket', 'polling'],
});

// Graceful shutdown
process.on('SIGTERM', gracefulShutdown);
process.on('SIGINT', gracefulShutdown);

async function gracefulShutdown() {
  logger.info('Server', 'Graceful shutdown initiated...');
  
  // Close all rooms
  if (roomManager) {
    for (const [roomId] of roomManager.rooms) {
      roomManager.deleteRoom(roomId);
    }
  }
  
  // Close socket.io
  io.close();
  
  // Close HTTP server
  httpServer.close(() => {
    logger.info('Server', 'HTTP server closed');
    process.exit(0);
  });
  
  // Force exit after 10 seconds
  setTimeout(() => {
    logger.warn('Server', 'Forcing exit after timeout');
    process.exit(1);
  }, 10000);
}

// Bootstrap
(async () => {
  try {
    await workerManager.init();
    roomManager = new RoomManager(workerManager);
    
    httpServer.listen(config.listenPort, config.listenIp, () => {
      logger.info('Server', `Listening on ${config.listenIp}:${config.listenPort}`, {
        env: config.env,
        workers: config.mediasoup.numWorkers,
        rtcPorts: `${config.mediasoup.worker.rtcMinPort}-${config.mediasoup.worker.rtcMaxPort}`,
      });
    });
  } catch (err) {
    logger.error('Server', 'Failed to start', { error: err.message, stack: err.stack });
    process.exit(1);
  }
})();

// ═══════════════════════════════════════════════════════════════════════════════
// 8. SOCKET.IO SIGNALING
// ═══════════════════════════════════════════════════════════════════════════════

io.on('connection', (socket) => {
  logger.debug('Socket', 'Client connected', { socketId: socket.id });
  
  let participant = null;
  let currentRoom = null;

  // ─────────────────────────────────────────────────────────────────────────────
  // A. TIME SYNCHRONIZATION
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Sync time between client and server
   * Client sends t0 (client timestamp when request was sent)
   * Server responds with t0 and t1 (server timestamp)
   * Client can calculate RTT and clock offset
   */
  socket.on('syncTime', (payload, callback) => {
    const t1 = Date.now();
    safeCallback(callback, {
      t0: payload?.t0 || 0,
      t1,
    });
  });

  /**
   * Measure latency to a specific peer
   * Used to build the latency matrix
   */
  socket.on('pingPeer', ({ targetSocketId, pingId, t0 }, callback) => {
    if (!currentRoom) {
      return safeCallback(callback, { error: 'Not in a room' });
    }

    const targetParticipant = currentRoom.participants.get(targetSocketId);
    if (!targetParticipant) {
      return safeCallback(callback, { error: 'Target peer not found' });
    }

    // Forward ping to target peer
    io.to(targetSocketId).emit('peerPing', {
      fromSocketId: socket.id,
      pingId,
      t0,
    });

    safeCallback(callback, { sent: true });
  });

  /**
   * Handle pong response from peer
   */
  socket.on('pongPeer', ({ targetSocketId, pingId, t0 }) => {
    if (!currentRoom) return;

    // Forward pong back to original sender
    io.to(targetSocketId).emit('peerPong', {
      fromSocketId: socket.id,
      pingId,
      t0,
      t1: Date.now(),
    });
  });

  /**
   * Record measured latency
   */
  socket.on('recordLatency', ({ targetSocketId, rtt }) => {
    if (!currentRoom) return;
    
    currentRoom.latencyTracker.record(socket.id, targetSocketId, rtt);
    
    // Update participant's sync offset
    if (participant) {
      participant.syncOffset = currentRoom.calculateSyncOffset(socket.id);
    }
  });

  /**
   * Get latency matrix for the room
   */
  socket.on('getLatencyMatrix', (_, callback) => {
    if (!currentRoom) {
      return safeCallback(callback, { error: 'Not in a room' });
    }

    const participantIds = Array.from(currentRoom.participants.keys());
    const matrix = currentRoom.latencyTracker.getRoomMatrix(participantIds);
    
    safeCallback(callback, { matrix });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // B. ROOM MANAGEMENT
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Join or create a room
   */
  socket.on('joinRoom', async ({ roomId, role, displayName }, callback) => {
    try {
      if (!roomId) {
        throw new Error('Room ID is required');
      }

      // Validate role
      const validRole = config.roles[role] ? role : 'SPECTATOR';
      
      // Get or create room
      currentRoom = await roomManager.createRoom(roomId);
      
      // Check room capacity
      if (currentRoom.participants.size >= currentRoom.session.settings.maxParticipants) {
        if (validRole !== 'SPECTATOR' || !currentRoom.session.settings.allowSpectators) {
          throw new Error('Room is full');
        }
      }

      // Check role availability (only one drummer, etc.)
      if (validRole === 'DRUMMER') {
        const existingDrummer = Array.from(currentRoom.participants.values())
          .find(p => p.role === 'DRUMMER');
        if (existingDrummer) {
          throw new Error('Room already has a drummer');
        }
      }

      // Create participant
      participant = new Participant(socket.id, {
        role: validRole,
        displayName: displayName || undefined,
      });

      currentRoom.addParticipant(socket.id, participant);
      socket.join(roomId);
      socket.roomId = roomId;

      // Gather existing room state
      const peerIds = Array.from(currentRoom.participants.keys())
        .filter(id => id !== socket.id);
      
      const existingProducers = currentRoom.getAllProducers()
        .filter(p => p.ownerId !== socket.id);

      const participantList = Array.from(currentRoom.participants.entries())
        .filter(([id]) => id !== socket.id)
        .map(([id, p]) => ({
          socketId: id,
          role: p.role,
          displayName: p.displayName,
        }));

      logger.info('Room', 'Participant joined', {
        roomId,
        socketId: socket.id,
        role: validRole,
        participantCount: currentRoom.participants.size,
      });

      // Notify others
      socket.to(roomId).emit('participantJoined', {
        socketId: socket.id,
        role: validRole,
        displayName: participant.displayName,
      });

      safeCallback(callback, {
        success: true,
        rtpCapabilities: currentRoom.router.rtpCapabilities,
        peerIds,
        participants: participantList,
        existingProducers,
        metronome: currentRoom.metronome,
        isLeader: currentRoom.metronome.leaderId === socket.id,
        syncTargets: participant.getSyncTargets(),
        roles: config.roles,
      });

    } catch (err) {
      logger.error('Room', 'Join failed', { error: err.message, roomId });
      safeCallback(callback, { error: err.message });
    }
  });

  /**
   * Change role within room
   */
  socket.on('changeRole', async ({ newRole }, callback) => {
    try {
      if (!currentRoom || !participant) {
        throw new Error('Not in a room');
      }

      if (!config.roles[newRole]) {
        throw new Error('Invalid role');
      }

      // Check role availability
      if (newRole === 'DRUMMER') {
        const existingDrummer = Array.from(currentRoom.participants.values())
          .find(p => p.role === 'DRUMMER' && p.socketId !== socket.id);
        if (existingDrummer) {
          throw new Error('Room already has a drummer');
        }
      }

      const oldRole = participant.role;
      participant.role = newRole;

      // Re-evaluate leader if needed
      if (oldRole === 'DRUMMER' || newRole === 'DRUMMER') {
        currentRoom.electNewLeader();
      }

      // Recalculate sync offset
      participant.syncOffset = currentRoom.calculateSyncOffset(socket.id);

      // Notify room
      io.to(currentRoom.id).emit('participantRoleChanged', {
        socketId: socket.id,
        oldRole,
        newRole,
        isLeader: currentRoom.metronome.leaderId === socket.id,
      });

      safeCallback(callback, {
        success: true,
        newRole,
        syncTargets: participant.getSyncTargets(),
        isLeader: currentRoom.metronome.leaderId === socket.id,
      });

    } catch (err) {
      safeCallback(callback, { error: err.message });
    }
  });

  /**
   * Leave room
   */
  socket.on('leaveRoom', (_, callback) => {
    handleDisconnect('leaveRoom');
    safeCallback(callback, { success: true });
  });

  /**
   * Get room status
   */
  socket.on('getRoomStatus', (_, callback) => {
    if (!currentRoom) {
      return safeCallback(callback, { error: 'Not in a room' });
    }
    safeCallback(callback, currentRoom.getStatus());
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // C. TRANSPORT MANAGEMENT
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Create WebRTC transport (send or receive)
   */
  socket.on('createTransport', async ({ direction }, callback) => {
    try {
      if (!currentRoom || !participant) {
        throw new Error('Not in a room');
      }

      const transport = await currentRoom.router.createWebRtcTransport(
        config.mediasoup.webRtcTransport
      );

      transport.on('dtlsstatechange', (dtlsState) => {
        logger.debug('Transport', 'DTLS state changed', {
          transportId: transport.id,
          state: dtlsState,
        });
        if (dtlsState === 'failed' || dtlsState === 'closed') {
          transport.close();
        }
      });

      transport.on('icestatechange', (iceState) => {
        logger.debug('Transport', 'ICE state changed', {
          transportId: transport.id,
          state: iceState,
        });
      });

      transport.on('close', () => {
        participant?.transports.delete(transport.id);
      });

      // Store with direction metadata
      transport.appData.direction = direction;
      participant.transports.set(transport.id, transport);

      safeCallback(callback, {
        id: transport.id,
        iceParameters: transport.iceParameters,
        iceCandidates: transport.iceCandidates,
        dtlsParameters: transport.dtlsParameters,
        sctpParameters: transport.sctpParameters,
      });

    } catch (err) {
      logger.error('Transport', 'Create failed', { error: err.message });
      safeCallback(callback, { error: err.message });
    }
  });

  /**
   * Connect transport (complete DTLS handshake)
   */
  socket.on('connectTransport', async ({ transportId, dtlsParameters }, callback) => {
    try {
      if (!participant) {
        throw new Error('Not in a room');
      }

      const transport = participant.transports.get(transportId);
      if (!transport) {
        throw new Error('Transport not found');
      }

      await transport.connect({ dtlsParameters });
      
      safeCallback(callback, { success: true });

    } catch (err) {
      logger.error('Transport', 'Connect failed', { error: err.message });
      safeCallback(callback, { error: err.message });
    }
  });

  /**
   * Close a specific transport
   */
  socket.on('closeTransport', ({ transportId }, callback) => {
    try {
      if (!participant) {
        throw new Error('Not in a room');
      }

      const transport = participant.transports.get(transportId);
      if (transport) {
        transport.close();
        participant.transports.delete(transportId);
      }

      safeCallback(callback, { success: true });

    } catch (err) {
      safeCallback(callback, { error: err.message });
    }
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // D. PRODUCER MANAGEMENT (Send media)
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Create a producer to send media
   */
  socket.on('produce', async ({ transportId, kind, rtpParameters, appData }, callback) => {
    try {
      if (!currentRoom || !participant) {
        throw new Error('Not in a room');
      }

      const transport = participant.transports.get(transportId);
      if (!transport) {
        throw new Error('Transport not found');
      }

      // Wait for DTLS to be connected
      if (transport.dtlsState !== 'connected') {
        await waitForDtls(transport);
      }

      const producer = await transport.produce({
        kind,
        rtpParameters,
        appData: {
          ...appData,
          ownerRole: participant.role,
          ownerId: socket.id,
        },
      });

      producer.on('transportclose', () => {
        participant?.producers.delete(producer.id);
      });

      producer.on('score', (score) => {
        logger.debug('Producer', 'Score update', {
          producerId: producer.id,
          score,
        });
      });

      participant.producers.set(producer.id, producer);

      // Notify room about new producer
      socket.to(currentRoom.id).emit('newProducer', {
        producerId: producer.id,
        ownerId: socket.id,
        ownerRole: participant.role,
        ownerName: participant.displayName,
        kind: producer.kind,
      });

      logger.debug('Producer', 'Created', {
        producerId: producer.id,
        kind,
        ownerRole: participant.role,
      });

      safeCallback(callback, { id: producer.id });

    } catch (err) {
      logger.error('Producer', 'Create failed', { error: err.message });
      safeCallback(callback, { error: err.message });
    }
  });

  /**
   * Pause a producer
   */
  socket.on('pauseProducer', async ({ producerId }, callback) => {
    try {
      if (!participant) {
        throw new Error('Not in a room');
      }

      const producer = participant.producers.get(producerId);
      if (!producer) {
        throw new Error('Producer not found');
      }

      await producer.pause();
      
      // Notify room
      socket.to(currentRoom.id).emit('producerPaused', {
        producerId,
        ownerId: socket.id,
      });

      safeCallback(callback, { success: true });

    } catch (err) {
      safeCallback(callback, { error: err.message });
    }
  });

  /**
   * Resume a producer
   */
  socket.on('resumeProducer', async ({ producerId }, callback) => {
    try {
      if (!participant) {
        throw new Error('Not in a room');
      }

      const producer = participant.producers.get(producerId);
      if (!producer) {
        throw new Error('Producer not found');
      }

      await producer.resume();
      
      // Notify room
      socket.to(currentRoom.id).emit('producerResumed', {
        producerId,
        ownerId: socket.id,
      });

      safeCallback(callback, { success: true });

    } catch (err) {
      safeCallback(callback, { error: err.message });
    }
  });

  /**
   * Close a producer
   */
  socket.on('closeProducer', ({ producerId }, callback) => {
    try {
      if (!participant) {
        throw new Error('Not in a room');
      }

      const producer = participant.producers.get(producerId);
      if (producer) {
        producer.close();
        participant.producers.delete(producerId);
        
        // Notify room
        socket.to(currentRoom.id).emit('producerClosed', {
          producerId,
          ownerId: socket.id,
        });
      }

      safeCallback(callback, { success: true });

    } catch (err) {
      safeCallback(callback, { error: err.message });
    }
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // E. CONSUMER MANAGEMENT (Receive media)
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Create a consumer to receive media from a producer
   */
  socket.on('consume', async ({ producerId, rtpCapabilities, transportId }, callback) => {
    try {
      if (!currentRoom || !participant) {
        throw new Error('Not in a room');
      }

      const transport = participant.transports.get(transportId);
      if (!transport) {
        throw new Error('Transport not found');
      }

      // Check if we can consume this producer
      if (!currentRoom.router.canConsume({ producerId, rtpCapabilities })) {
        throw new Error('Cannot consume: codec incompatible');
      }

      // Find producer owner for priority info
      let producerOwner = null;
      for (const [pid, p] of currentRoom.participants) {
        if (p.producers.has(producerId)) {
          producerOwner = p;
          break;
        }
      }

      const consumer = await transport.consume({
        producerId,
        rtpCapabilities,
        paused: true, // Start paused, client will resume
        appData: {
          producerOwnerRole: producerOwner?.role,
          producerOwnerId: producerOwner?.socketId,
        },
      });

      consumer.on('transportclose', () => {
        consumer.close();
        participant?.consumers.delete(consumer.id);
      });

      consumer.on('producerclose', () => {
        socket.emit('consumerClosed', {
          consumerId: consumer.id,
          producerId,
        });
        consumer.close();
        participant?.consumers.delete(consumer.id);
      });

      consumer.on('producerpause', () => {
        socket.emit('consumerPaused', { consumerId: consumer.id });
      });

      consumer.on('producerresume', () => {
        socket.emit('consumerResumed', { consumerId: consumer.id });
      });

      participant.consumers.set(consumer.id, consumer);

      safeCallback(callback, {
        id: consumer.id,
        producerId,
        kind: consumer.kind,
        rtpParameters: consumer.rtpParameters,
        type: consumer.type,
        producerPaused: consumer.producerPaused,
        producerOwnerRole: producerOwner?.role,
      });

    } catch (err) {
      logger.error('Consumer', 'Create failed', { error: err.message });
      safeCallback(callback, { error: err.message });
    }
  });

  /**
   * Resume a consumer (after initial creation)
   */
  socket.on('resumeConsumer', async ({ consumerId }, callback) => {
    try {
      if (!participant) {
        throw new Error('Not in a room');
      }

      const consumer = participant.consumers.get(consumerId);
      if (!consumer) {
        throw new Error('Consumer not found');
      }

      await consumer.resume();
      safeCallback(callback, { success: true });

    } catch (err) {
      safeCallback(callback, { error: err.message });
    }
  });

  /**
   * Pause a consumer
   */
  socket.on('pauseConsumer', async ({ consumerId }, callback) => {
    try {
      if (!participant) {
        throw new Error('Not in a room');
      }

      const consumer = participant.consumers.get(consumerId);
      if (!consumer) {
        throw new Error('Consumer not found');
      }

      await consumer.pause();
      safeCallback(callback, { success: true });

    } catch (err) {
      safeCallback(callback, { error: err.message });
    }
  });

  /**
   * Set consumer priority (for prioritized audio routing)
   */
  socket.on('setConsumerPriority', async ({ consumerId, priority }, callback) => {
    try {
      if (!participant) {
        throw new Error('Not in a room');
      }

      const consumer = participant.consumers.get(consumerId);
      if (!consumer) {
        throw new Error('Consumer not found');
      }

      await consumer.setPriority(priority);
      safeCallback(callback, { success: true });

    } catch (err) {
      safeCallback(callback, { error: err.message });
    }
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // F. DATA CHANNEL MANAGEMENT
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Create data producer (for low-latency data like MIDI, click track)
   */
  socket.on('produceData', async ({ transportId, sctpStreamParameters, label, protocol }, callback) => {
    try {
      if (!currentRoom || !participant) {
        throw new Error('Not in a room');
      }

      const transport = participant.transports.get(transportId);
      if (!transport) {
        throw new Error('Transport not found');
      }

      const dataProducer = await transport.produceData({
        sctpStreamParameters,
        label,
        protocol,
        appData: {
          ownerId: socket.id,
          ownerRole: participant.role,
        },
      });

      dataProducer.on('transportclose', () => {
        participant?.dataProducers.delete(dataProducer.id);
      });

      participant.dataProducers.set(dataProducer.id, dataProducer);

      // Notify room
      socket.to(currentRoom.id).emit('newDataProducer', {
        dataProducerId: dataProducer.id,
        ownerId: socket.id,
        label,
      });

      safeCallback(callback, { id: dataProducer.id });

    } catch (err) {
      logger.error('DataProducer', 'Create failed', { error: err.message });
      safeCallback(callback, { error: err.message });
    }
  });

  /**
   * Create data consumer
   */
  socket.on('consumeData', async ({ dataProducerId, transportId }, callback) => {
    try {
      if (!currentRoom || !participant) {
        throw new Error('Not in a room');
      }

      const transport = participant.transports.get(transportId);
      if (!transport) {
        throw new Error('Transport not found');
      }

      const dataConsumer = await transport.consumeData({
        dataProducerId,
      });

      dataConsumer.on('transportclose', () => {
        participant?.dataConsumers.delete(dataConsumer.id);
      });

      dataConsumer.on('dataproducerclose', () => {
        socket.emit('dataConsumerClosed', { dataConsumerId: dataConsumer.id });
        participant?.dataConsumers.delete(dataConsumer.id);
      });

      participant.dataConsumers.set(dataConsumer.id, dataConsumer);

      safeCallback(callback, {
        id: dataConsumer.id,
        dataProducerId,
        sctpStreamParameters: dataConsumer.sctpStreamParameters,
        label: dataConsumer.label,
        protocol: dataConsumer.protocol,
      });

    } catch (err) {
      safeCallback(callback, { error: err.message });
    }
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // G. METRONOME / SYNC
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Update metronome state (leader only)
   */
  socket.on('updateMetronome', ({ isPlaying, tempo, beatsPerMeasure }, callback) => {
    try {
      if (!currentRoom) {
        throw new Error('Not in a room');
      }

      // Only leader can update metronome
      if (currentRoom.metronome.leaderId !== socket.id) {
        throw new Error('Only the leader can control the metronome');
      }

      const now = Date.now();
      
      if (typeof isPlaying === 'boolean') {
        currentRoom.metronome.isPlaying = isPlaying;
        if (isPlaying) {
          // Add a small delay for network propagation
          currentRoom.metronome.startTime = now + 200;
          currentRoom.metronome.currentBeat = 0;
        }
      }
      
      if (typeof tempo === 'number' && tempo >= 20 && tempo <= 300) {
        currentRoom.metronome.tempo = tempo;
      }
      
      if (typeof beatsPerMeasure === 'number' && beatsPerMeasure >= 1 && beatsPerMeasure <= 16) {
        currentRoom.metronome.beatsPerMeasure = beatsPerMeasure;
      }

      // Broadcast to all participants with their individual sync offsets
      for (const [socketId, p] of currentRoom.participants) {
        const syncOffset = currentRoom.calculateSyncOffset(socketId);
        
        io.to(socketId).emit('metronomeSync', {
          ...currentRoom.metronome,
          syncOffset,
          serverTime: now,
        });
      }

      safeCallback(callback, {
        success: true,
        state: currentRoom.metronome,
      });

    } catch (err) {
      safeCallback(callback, { error: err.message });
    }
  });

  /**
   * Request current metronome state with personalized sync offset
   */
  socket.on('getMetronomeState', (_, callback) => {
    if (!currentRoom || !participant) {
      return safeCallback(callback, { error: 'Not in a room' });
    }

    const syncOffset = currentRoom.calculateSyncOffset(socket.id);
    
    safeCallback(callback, {
      ...currentRoom.metronome,
      syncOffset,
      serverTime: Date.now(),
      isLeader: currentRoom.metronome.leaderId === socket.id,
    });
  });

  /**
   * Beat announcement from leader (for tight sync)
   */
  socket.on('announceBeat', ({ beatNumber, timestamp }) => {
    if (!currentRoom) return;
    if (currentRoom.metronome.leaderId !== socket.id) return;

    currentRoom.metronome.currentBeat = beatNumber;

    // Broadcast with per-participant offsets
    for (const [socketId, p] of currentRoom.participants) {
      if (socketId === socket.id) continue; // Don't send back to leader
      
      const syncOffset = currentRoom.calculateSyncOffset(socketId);
      
      io.to(socketId).emit('beatSync', {
        beatNumber,
        leaderTimestamp: timestamp,
        serverTime: Date.now(),
        syncOffset,
      });
    }
  });

  /**
   * Request to become leader
   */
  socket.on('requestLeadership', (_, callback) => {
    try {
      if (!currentRoom || !participant) {
        throw new Error('Not in a room');
      }

      if (!participant.canLead()) {
        throw new Error('Your role cannot lead');
      }

      const success = currentRoom.promoteToLeader(socket.id);
      
      if (success) {
        // Notify room
        io.to(currentRoom.id).emit('leaderChanged', {
          newLeaderId: socket.id,
          newLeaderRole: participant.role,
          newLeaderName: participant.displayName,
        });
      }

      safeCallback(callback, {
        success,
        isLeader: currentRoom.metronome.leaderId === socket.id,
      });

    } catch (err) {
      safeCallback(callback, { error: err.message });
    }
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // H. PEER SIGNALING (for direct P2P when needed)
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Send signal to specific peer
   */
  socket.on('signalPeer', ({ targetSocketId, signalData }) => {
    if (!currentRoom) return;
    if (!currentRoom.participants.has(targetSocketId)) return;

    io.to(targetSocketId).emit('peerSignal', {
      senderSocketId: socket.id,
      senderRole: participant?.role,
      signalData,
    });
  });

  /**
   * Broadcast message to room
   */
  socket.on('broadcastToRoom', ({ type, data }) => {
    if (!currentRoom) return;

    socket.to(currentRoom.id).emit('roomBroadcast', {
      type,
      data,
      senderId: socket.id,
      senderRole: participant?.role,
      timestamp: Date.now(),
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // I. STATS & DEBUGGING
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Get participant's own stats
   */
  socket.on('getMyStats', async (_, callback) => {
    try {
      if (!participant) {
        throw new Error('Not in a room');
      }

      const transportStats = [];
      for (const [id, transport] of participant.transports) {
        const stats = await transport.getStats();
        transportStats.push({ id, stats: Array.from(stats) });
      }

      const producerStats = [];
      for (const [id, producer] of participant.producers) {
        const stats = await producer.getStats();
        producerStats.push({ id, kind: producer.kind, stats: Array.from(stats) });
      }

      const consumerStats = [];
      for (const [id, consumer] of participant.consumers) {
        const stats = await consumer.getStats();
        consumerStats.push({ id, kind: consumer.kind, stats: Array.from(stats) });
      }

      safeCallback(callback, {
        socketId: socket.id,
        role: participant.role,
        syncOffset: participant.syncOffset,
        transports: transportStats,
        producers: producerStats,
        consumers: consumerStats,
      });

    } catch (err) {
      safeCallback(callback, { error: err.message });
    }
  });

  /**
   * Get sync info for this participant
   */
  socket.on('getSyncInfo', (_, callback) => {
    if (!currentRoom || !participant) {
      return safeCallback(callback, { error: 'Not in a room' });
    }

    const syncTargets = participant.getSyncTargets();
    const latencies = {};

    for (const targetRole of syncTargets) {
      const targetPeer = Array.from(currentRoom.participants.entries())
        .find(([_, p]) => p.role === targetRole);
      
      if (targetPeer) {
        const [targetId, targetParticipant] = targetPeer;
        latencies[targetRole] = {
          socketId: targetId,
          displayName: targetParticipant.displayName,
          stats: currentRoom.latencyTracker.getStats(socket.id, targetId),
        };
      }
    }

    safeCallback(callback, {
      role: participant.role,
      syncTargets,
      syncOffset: currentRoom.calculateSyncOffset(socket.id),
      latencies,
      isLeader: currentRoom.metronome.leaderId === socket.id,
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // J. CLEANUP
  // ─────────────────────────────────────────────────────────────────────────────

  function handleDisconnect(reason) {
    if (!currentRoom) return;

    logger.info('Socket', 'Client disconnecting', {
      socketId: socket.id,
      reason,
      roomId: currentRoom.id,
    });

    const roomId = currentRoom.id;
    const removedParticipant = currentRoom.removeParticipant(socket.id);

    if (removedParticipant) {
      // Notify remaining participants
      io.to(roomId).emit('participantLeft', {
        socketId: socket.id,
        role: removedParticipant.role,
        displayName: removedParticipant.displayName,
      });

      // If leader changed, notify
      if (currentRoom.metronome.leaderId && currentRoom.metronome.leaderId !== socket.id) {
        const newLeader = currentRoom.participants.get(currentRoom.metronome.leaderId);
        if (newLeader) {
          io.to(roomId).emit('leaderChanged', {
            newLeaderId: currentRoom.metronome.leaderId,
            newLeaderRole: newLeader.role,
            newLeaderName: newLeader.displayName,
          });
        }
      }
    }

    // Clean up empty room
    if (currentRoom.isEmpty()) {
      logger.info('Room', 'Closing empty room', { roomId });
      roomManager.deleteRoom(roomId);
    }

    currentRoom = null;
    participant = null;
  }

  socket.on('disconnect', (reason) => handleDisconnect(reason));
});

// ═══════════════════════════════════════════════════════════════════════════════
// 9. HELPER FUNCTIONS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Wait for transport DTLS to connect
 */
function waitForDtls(transport, timeout = 5000) {
  return new Promise((resolve, reject) => {
    if (transport.dtlsState === 'connected') {
      return resolve();
    }

    const timer = setTimeout(() => {
      transport.removeListener('dtlsstatechange', onStateChange);
      reject(new Error('DTLS connection timeout'));
    }, timeout);

    function onStateChange(state) {
      if (state === 'connected') {
        clearTimeout(timer);
        transport.removeListener('dtlsstatechange', onStateChange);
        resolve();
      } else if (state === 'failed' || state === 'closed') {
        clearTimeout(timer);
        transport.removeListener('dtlsstatechange', onStateChange);
        reject(new Error(`DTLS connection ${state}`));
      }
    }

    transport.on('dtlsstatechange', onStateChange);
  });
}

// ═══════════════════════════════════════════════════════════════════════════════
// 10. EXPORTS (for testing)
// ═══════════════════════════════════════════════════════════════════════════════

module.exports = {
  config,
  workerManager,
  roomManager: () => roomManager,
  io,
  httpServer,
};