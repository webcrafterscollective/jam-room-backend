/**
 * server.js — Production Grade Hybrid Vibe Server
 * FIXED: "callback is not a function" crash protection.
 */

const os = require('os');
const http = require('http');
const express = require('express');
const { Server: SocketIOServer } = require('socket.io');
const mediasoup = require('mediasoup');
const cors = require('cors');

// ───────────────────────────────────────────────────────────────────────────────
// 1. CONFIGURATION
// ───────────────────────────────────────────────────────────────────────────────
const config = {
  listenIp: process.env.LISTEN_IP || '0.0.0.0',
  listenPort: Number(process.env.PORT) || 4000,
  
  mediasoup: {
    numWorkers: Object.keys(os.cpus()).length, 
    worker: {
      logLevel: 'warn', 
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
          parameters: { useinbandfec: 1, stereo: 1 }, 
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
          announcedIp: process.env.MEDIASOUP_ANNOUNCED_IP || '127.0.0.1', 
        },
      ],
      enableUdp: true,
      enableTcp: true,
      preferUdp: true, 
      enableSctp: true, 
    },
  },
};

// ───────────────────────────────────────────────────────────────────────────────
// 2. UTILITY
// ───────────────────────────────────────────────────────────────────────────────
function log(scope, msg, data = {}) {
  console.log(JSON.stringify({ ts: Date.now(), scope, msg, ...data }));
}
function error(scope, msg, err) {
  console.error(JSON.stringify({ ts: Date.now(), scope, msg, error: err?.message || err }));
}

// Helper to ensure callback never crashes server
function safeCallback(cb, data) {
  if (typeof cb === 'function') {
    cb(data);
  } else {
    // If no callback provided by client, just log the error if it's an error
    if (data && data.error) {
      error('SafeCallback', 'Client sent no callback, but error occurred:', data.error);
    }
  }
}

// ───────────────────────────────────────────────────────────────────────────────
// 3. WORKER MANAGER
// ───────────────────────────────────────────────────────────────────────────────
class WorkerManager {
  constructor() {
    this.workers = []; 
  }

  async init() {
    log('WorkerManager', `Spawning ${config.mediasoup.numWorkers} workers...`);
    for (let i = 0; i < config.mediasoup.numWorkers; i++) {
      const worker = await mediasoup.createWorker(config.mediasoup.worker);
      worker.on('died', () => {
        error('WorkerManager', `Worker ${worker.pid} died. Exiting...`);
        process.exit(1); 
      });
      this.workers.push({ worker, load: 0, pid: worker.pid });
    }
  }

  getWorker() {
    const bestWorkerObj = this.workers.sort((a, b) => a.load - b.load)[0];
    bestWorkerObj.load++; 
    return bestWorkerObj.worker;
  }

  releaseWorker(workerPid) {
    const workerObj = this.workers.find(w => w.pid === workerPid);
    if (workerObj && workerObj.load > 0) {
      workerObj.load--;
    }
  }
}

// ───────────────────────────────────────────────────────────────────────────────
// 4. SERVER INIT
// ───────────────────────────────────────────────────────────────────────────────
const workerManager = new WorkerManager();
const rooms = new Map(); 

const app = express();
app.use(cors());
const httpServer = http.createServer(app);
const io = new SocketIOServer(httpServer, {
  cors: { origin: '*' },
  pingInterval: 10000,
  pingTimeout: 5000,
});

(async () => {
  try {
    await workerManager.init();
    httpServer.listen(config.listenPort, config.listenIp, () => {
      log('Boot', `Server listening on ${config.listenIp}:${config.listenPort}`);
    });
  } catch (err) {
    error('Boot', 'Failed to start', err);
  }
})();

// ───────────────────────────────────────────────────────────────────────────────
// 5. SIGNALING LOGIC
// ───────────────────────────────────────────────────────────────────────────────
io.on('connection', (socket) => {
  
  const participant = {
    transports: new Map(),
    producers: new Map(),
    consumers: new Map(),
    dataProducers: new Map(),
    dataConsumers: new Map()
  };

  // --- A. SYNC ---

  socket.on('syncTime', (payload, callback) => {
    safeCallback(callback, {
      t0: payload?.t0,
      t1: Date.now() 
    });
  });

  socket.on('signalPeer', ({ targetSocketId, signalData }) => {
    const roomId = socket.roomId;
    if (!roomId) return;
    const room = rooms.get(roomId);
    if (!room || !room.participants.has(targetSocketId)) return;

    io.to(targetSocketId).emit('peerSignal', {
      senderSocketId: socket.id,
      signalData
    });
  });

  // --- B. ROOM ---

  socket.on('joinRoom', async ({ roomId }, callback) => {
    try {
      if (!roomId) throw new Error('Room ID required');
      
      let room = rooms.get(roomId);

      if (!room) {
        log('Room', 'Creating new room', { roomId });
        const worker = workerManager.getWorker(); 
        const router = await worker.createRouter({ 
          mediaCodecs: config.mediasoup.router.mediaCodecs 
        });
        router.appData.workerPid = worker.pid;

        room = {
          router,
          participants: new Map(),
          metronome: { isPlaying: false, tempo: 120, startTime: 0, leaderId: socket.id }
        };
        rooms.set(roomId, room);
      }

      room.participants.set(socket.id, participant);
      socket.join(roomId);
      socket.roomId = roomId;

      const peerIds = Array.from(room.participants.keys()).filter(id => id !== socket.id);
      
      const existingProducers = [];
      for (const [pId, pObj] of room.participants) {
        if (pId === socket.id) continue;
        for (const prod of pObj.producers.values()) {
          existingProducers.push({
            id: prod.id,
            ownerId: pId,
            kind: prod.kind
          });
        }
      }

      // Important: Use 'rtpCapabilities' key matching your controller
      safeCallback(callback, {
        rtpCapabilities: room.router.rtpCapabilities,
        peerIds, 
        existingProducers, 
        metronome: room.metronome 
      });

      socket.to(roomId).emit('participantJoined', { socketId: socket.id });

    } catch (err) {
      error('Room', 'Join Error', err);
      safeCallback(callback, { error: err.message });
    }
  });

  // --- C. TRANSPORTS ---

  // *** FIXED: Now uses safeCallback to prevent crash ***
  socket.on('createTransport', async (data, callback) => {
    try {
      const room = rooms.get(socket.roomId);
      if (!room) throw new Error('Room not found');

      const transport = await room.router.createWebRtcTransport(config.mediasoup.webRtcTransport);

      transport.on('dtlsstatechange', (dtlsState) => {
        if (dtlsState === 'failed' || dtlsState === 'closed') transport.close();
      });
      transport.on('close', () => {
        participant.transports.delete(transport.id);
      });

      participant.transports.set(transport.id, transport);

      safeCallback(callback, {
        id: transport.id,
        iceParameters: transport.iceParameters,
        iceCandidates: transport.iceCandidates,
        dtlsParameters: transport.dtlsParameters,
        sctpParameters: transport.sctpParameters,
      });
    } catch (err) {
      error('Transport', 'Create Error', err);
      safeCallback(callback, { error: err.message });
    }
  });

  socket.on('connectTransport', async ({ transportId, dtlsParameters }, callback) => {
    try {
      const transport = participant.transports.get(transportId);
      if (!transport) throw new Error('Transport missing');
      await transport.connect({ dtlsParameters });
      safeCallback(callback, { success: true });
    } catch (err) {
      safeCallback(callback, { error: err.message });
    }
  });

  // --- D. PRODUCE ---

  socket.on('produce', async ({ transportId, kind, rtpParameters }, callback) => {
    try {
      const transport = participant.transports.get(transportId);
      if (!transport) throw new Error('Transport missing');

      // DTLS Race Condition Protection
      if (transport.dtlsState !== 'connected') {
         await new Promise((resolve, reject) => {
             const timeout = setTimeout(() => reject(new Error('DTLS Connection Timeout')), 3000);
             const onStateChange = (state) => {
                 if (state === 'connected') {
                     clearTimeout(timeout);
                     transport.removeListener('dtlsstatechange', onStateChange);
                     resolve();
                 } else if (state === 'failed' || state === 'closed') {
                     clearTimeout(timeout);
                     transport.removeListener('dtlsstatechange', onStateChange);
                     reject(new Error('DTLS Failed'));
                 }
             };
             transport.on('dtlsstatechange', onStateChange);
         });
      }

      const producer = await transport.produce({ kind, rtpParameters });
      participant.producers.set(producer.id, producer);

      socket.to(socket.roomId).emit('newProducer', {
        producerId: producer.id,
        ownerId: socket.id,
        kind: kind
      });

      safeCallback(callback, { id: producer.id });
    } catch (err) {
      safeCallback(callback, { error: err.message });
    }
  });

  socket.on('produceData', async ({ transportId, sctpStreamParameters, label, protocol }, callback) => {
    try {
      const transport = participant.transports.get(transportId);
      if (!transport) throw new Error('Transport missing');

      const dataProducer = await transport.produceData({
        sctpStreamParameters,
        label,
        protocol
      });

      participant.dataProducers.set(dataProducer.id, dataProducer);
      safeCallback(callback, { id: dataProducer.id });
    } catch (err) {
      safeCallback(callback, { error: err.message });
    }
  });

  // --- E. CONSUME ---

  socket.on('consume', async ({ producerId, rtpCapabilities, transportId }, callback) => {
    try {
      const room = rooms.get(socket.roomId);
      if (!room) throw new Error('Room missing');
      
      const transport = participant.transports.get(transportId);
      if (!transport) throw new Error('Transport missing');

      if (!room.router.canConsume({ producerId, rtpCapabilities })) {
        throw new Error('Codec Incompatible');
      }

      const consumer = await transport.consume({
        producerId,
        rtpCapabilities,
        paused: true 
      });

      participant.consumers.set(consumer.id, consumer);

      consumer.on('transportclose', () => consumer.close());
      consumer.on('producerclose', () => {
        socket.emit('consumerClosed', { consumerId: consumer.id });
        consumer.close();
        participant.consumers.delete(consumer.id);
      });

      safeCallback(callback, {
        id: consumer.id,
        producerId,
        kind: consumer.kind,
        rtpParameters: consumer.rtpParameters,
        type: consumer.type
      });
    } catch (err) {
      safeCallback(callback, { error: err.message });
    }
  });

  socket.on('resumeConsumer', async ({ consumerId }, callback) => {
    const consumer = participant.consumers.get(consumerId);
    if (consumer) {
      await consumer.resume();
      safeCallback(callback, {});
    }
  });

  // --- F. METRONOME ---

  socket.on('updateMetronome', ({ isPlaying, tempo }, callback) => {
    const roomId = socket.roomId;
    if (!roomId) return;
    const room = rooms.get(roomId);

    if (room.metronome.leaderId !== socket.id) {
      return safeCallback(callback, { error: 'Not Leader' });
    }

    const now = Date.now();
    room.metronome.isPlaying = isPlaying;
    room.metronome.tempo = tempo;
    
    if (isPlaying) {
      room.metronome.startTime = now + 200; 
    }

    io.to(roomId).emit('metronomeSync', room.metronome);
    safeCallback(callback, { success: true, state: room.metronome });
  });

  // --- G. CLEANUP ---

  socket.on('disconnect', (reason) => {
    const roomId = socket.roomId;
    if (!roomId) return;
    
    const room = rooms.get(roomId);
    if (!room) return;

    participant.transports.forEach(t => t.close());
    room.participants.delete(socket.id);

    if (room.metronome.leaderId === socket.id) {
      const nextLeader = room.participants.keys().next().value;
      room.metronome.leaderId = nextLeader || null;
      if (nextLeader) {
        io.to(roomId).emit('metronomeSync', room.metronome); 
      }
    }

    io.to(roomId).emit('participantLeft', { socketId: socket.id });

    if (room.participants.size === 0) {
      log('Room', 'Closing empty room', { roomId });
      workerManager.releaseWorker(room.router.appData.workerPid);
      room.router.close();
      rooms.delete(roomId);
    }
  });
});