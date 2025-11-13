// server.js — mediasoup SFU for ultra‑low‑latency jamming
/**
 * Stage Manager. It does not play the music, 
 * and it does not even touch the audio. 
 * Job is to communicate with musicians, 
 * assign them to a studio room, 
 * and tell them which cables to plug into which sockets.
 */


// ───────────────────────────────────────────────────────────────────────────────
// Imports
// ───────────────────────────────────────────────────────────────────────────────
const express = require('express');
const http = require('http');
/**
 * walkie-talkie system. 
 * It's how the server send and receive control messages -> signaling 
 * to and from each musician (client) in real-time.
 */
const { Server: SocketIOServer } = require('socket.io');
/**
 * magic, automated patch-bay/mixing-desk 
 * (an SFU, or Selective Forwarding Unit) in a separate, 
 * high-speed C++ process. 
 * Node just gives it commands. 
 * It's the "sound system" that routes audio 
 * from one musician to all the others without mixing it.
 */
const mediasoup = require('mediasoup');
const cors = require('cors');

// ───────────────────────────────────────────────────────────────────────────────
// Runtime configuration 
// - all tunables live here
// ───────────────────────────────────────────────────────────────────────────────
const runtimeConfig = {
  bindAddress: process.env.BIND_ADDRESS || '0.0.0.0',
  bindPort: Number(process.env.PORT || 4000),
  corsOrigin: process.env.CORS_ORIGIN || 'http://localhost:3000',

  // When deploying behind NAT/Cloud, must set announced IP.
  announcedIp: process.env.MEDIASOUP_ANNOUNCED_IP || '127.0.0.1', // public IP or TURN public IP
  listenIpForTransports: process.env.MEDIASOUP_LISTEN_IP || '0.0.0.0',

  mediasoup: {
    worker: {
      // moderate log level
      logLevel: process.env.MEDIASOUP_LOG_LEVEL || 'warn',
      logTags: ['info', 'ice', 'dtls', 'rtp', 'srtp', 'rtcp'],
      rtcMinPort: Number(process.env.MEDIASOUP_RTC_MIN || 40000),
      rtcMaxPort: Number(process.env.MEDIASOUP_RTC_MAX || 49999),
    },
    router: {
      // For now Audio‑only jamming room -> lock to Opus/48k. 
      mediaCodecs: [
        {
          kind: 'audio',
          mimeType: 'audio/opus',
          clockRate: 48000,
          channels: 2,
          // Music‑friendly Opus: stereo on, in‑band FEC on, DTX off to avoid cadence holes.
          parameters: { stereo: 1, useinbandfec: 1, dtx: 0 },
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
      enableTcp: true, // prefer UDP for latency
      preferUdp: true,
      enableSctp: true, // DataChannel for metronome/clicks/chat
      numSctpStreams: { OS: 256, MIS: 256 },
      maxSctpMessageSize: 262_144,
      initialAvailableOutgoingBitrate: 1_000_000, // quick ramp - audio is tiny anyway
    },
  },
};

// ───────────────────────────────────────────────────────────────────────────────
// Logger helpers — consistent tagging improves grep‑ability
// extra is for reason
// ───────────────────────────────────────────────────────────────────────────────
function logInfo(scope, message, extra = {}) {
  console.log(JSON.stringify({ level: 'info', ts: Date.now(), scope, message, ...extra }));
}
function logWarn(scope, message, extra = {}) {
  console.warn(JSON.stringify({ level: 'warn', ts: Date.now(), scope, message, ...extra }));
}
function logError(scope, message, extra = {}) {
  console.error(JSON.stringify({ level: 'error', ts: Date.now(), scope, message, ...extra }));
}

// standardize some scope keys to use in logs.
const SCOPE = Object.freeze({
  BOOT: 'boot',
  ROOM: 'room',
  SOCKET: 'socket',
  TRANSPORT: 'transport',
  PRODUCER: 'producer',
  CONSUMER: 'consumer',
  DATACHANNEL: 'data',
});

// ───────────────────────────────────────────────────────────────────────────────
// HTTP + Socket.IO bootstrap
// ───────────────────────────────────────────────────────────────────────────────
const expressApp = express();

// cors use
expressApp.use(cors(
  { 
    origin: runtimeConfig.corsOrigin 
  }
));

// create server
const httpServer = http.createServer(expressApp);

// put io server on http
const io = new SocketIOServer(httpServer, {
  cors: { origin: runtimeConfig.corsOrigin, methods: ['GET', 'POST'] },
});

// ───────────────────────────────────────────────────────────────────────────────
// In‑memory state stores (simple maps, explicit lifetimes)
// ───────────────────────────────────────────────────────────────────────────────
// Single worker 
// - when scaling 
// - will create per‑CPU workers.
let mediasoupWorker; 
const roomStore = new Map(); // Map<roomId, JamRoom>
const producerStore = new Map(); // Map<producerId, mediasoup.Producer>

// ───────────────────────────────────────────────────────────────────────────────
// JamRoom 
// – one SFU room with participants 
// - and a leader for clock
// ───────────────────────────────────────────────────────────────────────────────
class JamRoom {
  constructor(roomId, router) {
    this.roomId = roomId;
    this.router = router;
    this.participants = new Map(); // Map<socketId, Participant>
    this.metronomeLeaderSocketId = null; // string | null
  }

  addParticipant(participant) {
    this.participants.set(participant.socketId, participant);
    if (!this.metronomeLeaderSocketId) { 
      // making metronome leader
      this.metronomeLeaderSocketId = participant.socketId; 
    }
  }

  removeParticipant(socketId) {
    const participant = this.participants.get(socketId);
    if (!participant) return;
    // transports should be closed
    participant.closeAllTransports();

    // participant should be deleted by socketId
    this.participants.delete(socketId);

    if (this.metronomeLeaderSocketId === socketId) {
      // change the leadership
      // very important
      const next = this.participants.keys().next();
      this.metronomeLeaderSocketId = next.done ? null : next.value;
    }
  }

  getParticipant(socketId) { 
    // for populating participants list
    return this.participants.get(socketId); 
  }

  getAllMediaProducers() {
    // for listing all available producers
    const list = [];
    for (const participant of this.participants.values()) {
      list.push(...participant.mediaProducers.values());
    }
    return list;
  }

  // --- ADD THIS METHOD ---
  getAllDataProducers() {
    const list = [];
    for (const participant of this.participants.values()) {
      list.push(...participant.dataProducers.values());
    }
    return list;
  }
}

// ───────────────────────────────────────────────────────────────────────────────
// Participant 
// – clear split 
// -- media vs data, send vs receive
// ───────────────────────────────────────────────────────────────────────────────
class Participant {
  constructor(socketId) {
    this.socketId = socketId;
    this.rtcTransports = new Map(); // Map<transportId, WebRtcTransport>
    this.mediaProducers = new Map(); // Map<producerId, Producer>
    this.mediaConsumers = new Map(); // Map<consumerId, Consumer>
    this.dataProducers = new Map(); // Map<dataProducerId, DataProducer>
    this.dataConsumers = new Map(); // Map<dataConsumerId, DataConsumer>
  }

  addTransport(t) { 
    // t for transport
    this.rtcTransports.set(t.id, t); 
  }

  getTransport(id) { 
    return this.rtcTransports.get(id); 
  }

  addMediaProducer(p) { 
    this.mediaProducers.set(p.id, p); 
  }

  addMediaConsumer(c) { 
    this.mediaConsumers.set(c.id, c); 
  }

  addDataProducer(dp) { 
    this.dataProducers.set(dp.id, dp); 
  }
  
  addDataConsumer(dc) { 
    this.dataConsumers.set(dc.id, dc); 
  }

  closeAllTransports() { 
    this.rtcTransports.forEach((t) => t.close()); 
  }
}

// ───────────────────────────────────────────────────────────────────────────────
// Boot sequence
// ───────────────────────────────────────────────────────────────────────────────
startServer();

async function startServer() {
  // initiate a single Worker
  await startMediasoupWorker();

  httpServer.listen(runtimeConfig.bindPort, runtimeConfig.bindAddress, () => {
    logInfo(SCOPE.BOOT, 'HTTP/WS server listening', 
      { 
        bindAddress: runtimeConfig.bindAddress, 
        bindPort: runtimeConfig.bindPort 
      }
    );
  });

  io.on('connection', (socket) => {
    logInfo(SCOPE.SOCKET, 'Socket connected', 
      { 
        socketId: socket.id 
      }
    );

    // if incoming connection made
    // create participant
    const participant = new Participant(socket.id);

    // ───────────────────────────────────────────────────────────────────────────
    // joinRoom 
    // — put participant into a room 
    // - and return capabilities
    // ───────────────────────────────────────────────────────────────────────────
    socket.on('joinRoom', async ({ roomId } = {}, reply = () => {}) => {
      try {
        if (!roomId || typeof roomId !== 'string') throw new Error('roomId is required');
        
        // Either Get or Create Jam Room
        // If not Exist Create
        // Else Get. 
        const jamRoom = await getOrCreateJamRoom(roomId);

        // add to jamRoom
        jamRoom.addParticipant(participant);
        
        // let the socket join room
        socket.join(roomId);
        socket.roomId = roomId;
        logInfo(SCOPE.ROOM, 'Participant joined room', 
          { roomId, socketId: socket.id, 
            participantCount: jamRoom.participants.size 
          });
  
        // get all existing producers
        const existingProducers = jamRoom.getAllMediaProducers().map((p) => ({
          producerId: p.id,
          kind: p.kind,
          ownerSocketId: p.appData?.ownerSocketId,
        }));
        
        // --- ADD THIS LOGIC ---
        const existingDataProducers = jamRoom.getAllDataProducers().map((dp) => ({
          dataProducerId: dp.id,
          label: dp.appData?.label,
          ownerSocketId: dp.appData?.ownerSocketId,
        }));

        // --- END ADD ---
        // make a demarcation 
        // me vs others 
        const otherParticipantIds = Array.from(jamRoom.participants.keys()).filter((id) => id !== socket.id);
        
        // send configurations and data
        // for client to use
        // handshake info is the most importanr one
        reply({
          routerRtpCapabilities: jamRoom.router.rtpCapabilities,
          existingProducers,
          existingDataProducers,
          otherParticipantIds,
          metronomeLeaderSocketId: jamRoom.metronomeLeaderSocketId,
        });

        // socke to emit
        // signal 
        // - stating user joined
        socket.to(roomId).emit('participantJoined', { socketId: socket.id });
      } catch (err) {
        logError(SCOPE.ROOM, 'joinRoom failed', { socketId: socket.id, error: err.message });
        reply({ error: err.message });
      }
    });

    // Expose router caps 
    // for more robust handshake
    socket.on('getRouterRtpCapabilities', (reply = () => {}) => {
      const jamRoom = roomStore.get(socket.roomId);
      if (!jamRoom) return reply({ error: 'Room not found' });
      reply(jamRoom.router.rtpCapabilities);
    });

    // ───────────────────────────────────────────────────────────────────────────
    // createTransport 
    // — client usually creates one send and one recv transport
    // ───────────────────────────────────────────────────────────────────────────
    socket.on('createTransport', async ({ direction } = {}, reply = () => {}) => {
      try {
        // get the specific room
        const jamRoom = roomStore.get(socket.roomId);
        if (!jamRoom) throw new Error('Room not found');
        
        // start heavy lifting
        // First Transport channel
        // Create a WebRTC transport on this room's router (SFU side)
        const webRtcTransport = await jamRoom.router.createWebRtcTransport(
          { 
            ...runtimeConfig.mediasoup.webRtcTransport 
          });
        
        // another part for handshake
        // for dtls 
        // Monitor DTLS handshake state (encryption / SRTP key negotiation)
        // Close the transport if DTLS fails or is closed
        // listens for changes in DTLS state (new, connecting, connected, failed, closed).
        
        /**
         * DTLS = Datagram Transport Layer Security
         * basically TLS but over UDP.

        * In WebRTC, DTLS is used to:
        * Secure the connection between client ↔ server (encryption).
        * Negotiate keys used for SRTP (the encrypted audio/video stream).
        * In mediasoup’s WebRtcTransport, the DTLS handshake happens after 
        * the transport is created and the client sends its DTLS parameters 
        * (via connectWebRtcTransport on the client side).
        
        */
        webRtcTransport.on('dtlsstatechange', (state) => {
          logInfo(SCOPE.TRANSPORT, 'DTLS state', { roomId: socket.roomId, socketId: socket.id, transportId: webRtcTransport.id, state });
          if (state === 'failed' || state === 'closed') webRtcTransport.close();
        });

        // Monitor ICE connectivity state (NAT traversal / network path)
        /**
         * ICE = Interactive Connectivity Establishment
         * the mechanism WebRTC uses to figure out how 
         * two peers can actually reach each other across: NATs, Firewalls, Different network paths (host, reflexive, relay/turn)

         * ICE gathers candidates (possible network paths) 
         * and tries them until it finds something that works.

         * In mediasoup, the server-side transport exposes:
         * iceParameters
         * iceCandidates
         * which we send back to the client 
         * so the client can configure its side.
         
        */
        webRtcTransport.on('icestatechange', (state) => {
          logInfo(SCOPE.TRANSPORT, 'ICE state', { roomId: socket.roomId, socketId: socket.id, transportId: webRtcTransport.id, state });
        });

         // Log when the transport itself is closed (cleanup/debug)
        webRtcTransport.on('close', () => logInfo(SCOPE.TRANSPORT, 'Transport closed', { transportId: webRtcTransport.id }));

        // finally transport created 
        // Associate this transport with the participant for later use (produce/consume)
        participant.addTransport(webRtcTransport);

        // send everything
        // Send transport parameters to the client so it can create/connect its side
        reply({
          id: webRtcTransport.id,
          iceParameters: webRtcTransport.iceParameters,
          iceCandidates: webRtcTransport.iceCandidates,
          dtlsParameters: webRtcTransport.dtlsParameters,
          sctpParameters: webRtcTransport.sctpParameters,
        });
      } catch (err) {
        logError(SCOPE.TRANSPORT, 'createTransport failed', { socketId: socket.id, error: err.message });
        reply({ error: err.message });
      }
    });

    // ───────────────────────────────────────────────────────────────────────────
    // connectTransport — finalize DTLS handshake and activate SRTP
    // This is called by the client AFTER createTransport()
    // The client sends its DTLS parameters so both sides can agree on keys
    // This completes the secure DTLS → SRTP negotiation for the transport.
    // ───────────────────────────────────────────────────────────────────────────
    socket.on('connectTransport', async ({ transportId, dtlsParameters } = {}, reply = () => {}) => {
      try {
        const webRtcTransport = participant.getTransport(transportId);
        if (!webRtcTransport) throw new Error('Transport not found');
        await webRtcTransport.connect({ dtlsParameters });
        logInfo(SCOPE.TRANSPORT, 'Transport connected', { socketId: socket.id, transportId });
        reply({ connected: true });
      } catch (err) {
        logError(SCOPE.TRANSPORT, 'connectTransport failed', { socketId: socket.id, transportId, error: err.message });
        reply({ error: err.message });
      }
    });

    // ───────────────────────────────────────────────────────────────────────────
    // produce — create an upstream media producer (audio track from client)
    // is called AFTER the client send transport is DTLS-connected.
    //
    // Steps:
    // 1. Client sends `rtpParameters` describing the audio track.
    // 2. Server calls transport.produce() to create a mediasoup Producer.
    // 3. Producer emits events 
    // 4. We store the Producer, notify others in the room, and return its ID.
    // ───────────────────────────────────────────────────────────────────────────
    socket.on('produce', async ({ kind, rtpParameters, transportId } = {}, reply = () => {}) => {
      try {
        // Warn if client tries to send video or other kinds (allowed but we expect audio)
        if (kind !== 'audio') {
          logWarn(SCOPE.PRODUCER, 'Non-audio producer requested (allowed but unexpected)', { kind });
        }

        // Retrieve the sending transport that the client previously connected via DTLS
        const sendTransport = participant.getTransport(transportId);
        if (!sendTransport) throw new Error('Transport not found');

        // mediasoup creates the Producer for this upstream track
        const mediaProducer = await sendTransport.produce({
          kind,
          rtpParameters,
          appData: { ownerSocketId: socket.id }  // Useful for cleanup & tracing ownership
        });

        // Close the Producer if its transport dies
        mediaProducer.on('transportclose', () => mediaProducer.close());

        // If the producer is closed remotely or by SFU logic, fully clean up
        mediaProducer.on('producerclose', () => mediaProducer.close());

        // Monitor inbound quality (score) — higher = better media quality
        mediaProducer.on('score', (score) => {
          logInfo(SCOPE.PRODUCER, 'Producer score', { producerId: mediaProducer.id, score });
        });

        // Store this Producer in participant/profile state
        participant.addMediaProducer(mediaProducer);
        producerStore.set(mediaProducer.id, mediaProducer);

        // Log creation for debugging and observability
        logInfo(SCOPE.PRODUCER, 'Media producer created', {
          roomId: socket.roomId,
          socketId: socket.id,
          producerId: mediaProducer.id,
          kind: mediaProducer.kind
        });

        // Notify everyone else in the room that a new Producer is available
        socket.to(socket.roomId).emit('mediaProducerCreated', {
          producerId: mediaProducer.id,
          kind: mediaProducer.kind,
          ownerSocketId: socket.id
        });

        // Return producer ID to client (used later for consuming)
        reply({ id: mediaProducer.id });

      } catch (err) {
        logError(SCOPE.PRODUCER, 'produce failed', { socketId: socket.id, error: err.message });
        reply({ error: err.message });
      }
    });

    // ───────────────────────────────────────────────────────────────────────────
    // produceData — Create an outgoing DataChannel producer (WebRTC SCTP)
    //
    // This is used for sending:
    //   • metronome ticks
    //   • chat messages
    //   • control messages (mute, cues, etc.)
    //   • any arbitrary low-latency data
    //
    // Flow:
    //   1. Client has already created a send transport + DTLS-connected it.
    //   2. Client opens a WebRTC DataChannel and extracts sctpStreamParameters.
    //   3. Client calls produceData with these parameters.
    //   4. Server creates a mediasoup DataProducer on the send transport.
    //   5. Server notifies other participants that a DataProducer exists.
    // ───────────────────────────────────────────────────────────────────────────
    socket.on('produceData', async ({ transportId, label, protocol, sctpStreamParameters } = {}, reply = () => {}) => {
      try {
        // Retrieve the send transport used for this data channel
        const sendTransport = participant.getTransport(transportId);
        if (!sendTransport) throw new Error('Transport not found');

        // Create a DataProducer on the transport.
        // NOTE:
        //   • sctpStreamParameters is REQUIRED — tells mediasoup which SCTP stream to bind to.
        //   • label and protocol mirror the client's RTCDataChannel options.
        //   • unordered + maxRetransmits=0 = "lossy but ultra-low-latency" mode
        const dataProducer = await sendTransport.produceData({
          sctpStreamParameters,           // required SCTP stream ID + reliability
          label,                          // e.g., "metronome" / "chat" / "control"
          protocol,                       // custom protocol name (optional)
          ordered: false,                 // WebRTC unordered delivery
          maxRetransmits: 0,              // no retransmissions → lowest latency
          appData: { ownerSocketId: socket.id, label } // store owner + purpose
        });

        // Store this DataProducer on the participant object
        participant.addDataProducer(dataProducer);

        // Log creation for diagnostics
        logInfo(SCOPE.DATACHANNEL, 'Data producer created', {
          roomId: socket.roomId,
          socketId: socket.id,
          dataProducerId: dataProducer.id,
          label,
        });

        // Notify all OTHER participants in the room
        // They will later call consumeData to create a DataConsumer
        socket.to(socket.roomId).emit('dataProducerCreated', {
          dataProducerId: dataProducer.id,
          label,
          ownerSocketId: socket.id,
        });

        // MUST reply with an object
        reply({ id: dataProducer.id });

      } catch (err) {
        logError(SCOPE.DATACHANNEL, 'produceData failed', {
          socketId: socket.id,
          error: err?.message,
        });

        reply({ error: err?.message || 'produceData failed' });
      }
    });

    // ───────────────────────────────────────────────────────────────────────────
    // consume — Create a mediasoup Consumer for a remote Producer (audio track)
    //
    // This is called when a client wants to receive another user's audio stream.
    //
    // Flow:
    //   1. Client sends: producerId + its own rtpCapabilities + recv transportId.
    //   2. Server verifies: room exists, producer exists, router canConsume().
    //   3. Server creates a Consumer on the client's recv transport.
    //   4. Consumer is created paused to avoid race conditions.
    //   5. Lifecycle: if producer or its transport closes → close consumer.
    //   6. Server replies with consumer parameters so the client can resume/start.
    //
    // Why paused=true?
    //   mediasoup recommends starting Consumers paused until the client is ready.
    //   Prevents packets from being sent before the client sets codec, handlers, etc.
    // ───────────────────────────────────────────────────────────────────────────
    socket.on('consume', async ({ producerId, rtpCapabilities, transportId } = {}, reply = () => {}) => {
      try {
        // Retrieve the room this socket belongs to
        const jamRoom = roomStore.get(socket.roomId);
        if (!jamRoom) throw new Error('Room not found');

        // Retrieve the remote Producer we want to consume
        const remoteProducer = producerStore.get(producerId);
        if (!remoteProducer) throw new Error('Producer not found');

        // Check if this router can produce → consume based on the client's capabilities
        if (!jamRoom.router.canConsume({ producerId, rtpCapabilities })) {
          throw new Error(`Router cannot consume ${producerId}`);
        }

        // Retrieve the receiving transport used by this client
        const recvTransport = participant.getTransport(transportId);
        if (!recvTransport) throw new Error('Transport not found');

        // Create a paused Consumer (recommended mediasoup pattern)
        const mediaConsumer = await recvTransport.consume({
          producerId,
          rtpCapabilities,
          paused: true
        });

        // Store consumer so participant can manage it later (pause, resume, close)
        participant.addMediaConsumer(mediaConsumer);

        // --- ADD THIS BLOCK ---
        mediaConsumer.on('score', (score) => {
          logInfo(SCOPE.CONSUMER, 'Consumer score', {
            consumerId: mediaConsumer.id,
            producerId: mediaConsumer.producerId,
            score: score.score, // This is a number from 0-10
          });
        });
        // --- END ADD ---

        // If the producer's transport or producer itself closes,
        // the Consumer MUST close to avoid dangling references.
        remoteProducer.on('transportclose', () => mediaConsumer.close());
        remoteProducer.on('producerclose', () => mediaConsumer.close());

        logInfo(SCOPE.CONSUMER, 'Media consumer created', {
          roomId: socket.roomId,
          socketId: socket.id,
          consumerId: mediaConsumer.id,
          producerId
        });

        // Return all parameters the client needs to set up the inbound RTP receiver
        reply({
          id: mediaConsumer.id,
          producerId: mediaConsumer.producerId,
          kind: mediaConsumer.kind,
          rtpParameters: mediaConsumer.rtpParameters
        });

      } catch (err) {
        logError(SCOPE.CONSUMER, 'consume failed', {
          socketId: socket.id,
          error: err.message
        });
        reply({ error: err.message });
      }
    });


    // ───────────────────────────────────────────────────────────────────────────
    // consumeData — Create a mediasoup DataConsumer for a remote DataProducer
    //
    // This is used for receiving:
    //   • metronome ticks
    //   • chat messages
    //   • control messages
    //   • any SCTP DataChannel-based payload
    //
    // Flow:
    //   1. Client provides receiving transportId + dataProducerId.
    //   2. Server creates a DataConsumer on that transport.
    //   3. Server returns DataConsumer id + SCTP streamId.
    //   4. Client binds an RTCDataChannel to that stream.
    //
    // Note: No rtpCapabilities are needed because this is SCTP, not RTP.
    // ───────────────────────────────────────────────────────────────────────────
    socket.on('consumeData', async ({ transportId, dataProducerId } = {}, reply = () => {}) => {
      try {
        // Retrieve the receiving transport for DataChannels
        const recvTransport = participant.getTransport(transportId);
        if (!recvTransport) throw new Error('Transport not found');

        // Create a DataConsumer tied to a remote DataProducer
        const dataConsumer = await recvTransport.consumeData({ dataProducerId });

        // Store it so participant can manage cleanup / reconnection
        participant.addDataConsumer(dataConsumer);

        logInfo(SCOPE.DATACHANNEL, 'Data consumer created', {
          roomId: socket.roomId,
          socketId: socket.id,
          dataConsumerId: dataConsumer.id,
          dataProducerId
        });

        // Return parameters required by the client to bind SCTP stream
        reply({
          id: dataConsumer.id,
          streamId: dataConsumer.sctpStreamParameters?.streamId
        });

      } catch (err) {
        logError(SCOPE.DATACHANNEL, 'consumeData failed', {
          socketId: socket.id,
          error: err.message
        });
        reply({ error: err.message });
      }
    });


    // ───────────────────────────────────────────────────────────────────────────
    // resumeConsumer — Unpause a media Consumer once the client is ready
    //
    // Why?
    //   We usually create Consumers with paused: true to avoid:
    //     • audio pops/clicks
    //     • data flowing before the client has its audio graph/processing ready
    //
    // Flow:
    //   1. Client sets up its audio nodes / Web Audio graph.
    //   2. Client calls 'resumeConsumer' with the consumerId.
    //   3. Server calls mediasoup Consumer.resume().
    //   4. Media starts flowing from SFU → client.
    // ───────────────────────────────────────────────────────────────────────────
    socket.on('resumeConsumer', async ({ consumerId } = {}, reply = () => {}) => {
      try {
        // Look up the Consumer belonging to this participant
        const mediaConsumer = participant.mediaConsumers.get(consumerId);
        if (!mediaConsumer) throw new Error('Consumer not found');

        // Start sending media for this Consumer
        await mediaConsumer.resume();

        logInfo(SCOPE.CONSUMER, 'Consumer resumed', {
          socketId: socket.id,
          consumerId
        });

        reply({ resumed: true });

      } catch (err) {
        logError(SCOPE.CONSUMER, 'resumeConsumer failed', {
          socketId: socket.id,
          error: err.message
        });

        reply({ error: err.message });
      }
    });


    // ───────────────────────────────────────────────────────────────────────────
    // closeProducer — Allow client to explicitly stop a Producer (mute/leave track)
    //
    // Use cases:
    //   • User presses "mute" or "stop sharing audio".
    //   • Client wants to permanently stop sending a track.
    //   • Cleanup of specific streams without disconnecting.
    //
    // Flow:
    //   1. Client sends the producerId to close.
    //   2. Server closes the mediasoup Producer and removes it from stores.
    //   3. Notifies other peers so they can remove corresponding Consumers.
    // ───────────────────────────────────────────────────────────────────────────
    socket.on('closeProducer', ({ producerId } = {}, reply = () => {}) => {
      try {
        // Retrieve the Producer associated with this participant
        const producer = participant.mediaProducers.get(producerId);
        if (!producer) throw new Error('Producer not found');

        // Close the Producer → SFU stops sending this media to all Consumers
        producer.close();

        // Remove references so it can be garbage-collected
        participant.mediaProducers.delete(producerId);
        producerStore.delete(producerId);

        // Tell other participants that this Producer is no longer available
        socket.to(socket.roomId).emit('mediaProducerClosed', { producerId });

        logInfo(SCOPE.PRODUCER, 'Producer closed by client', {
          socketId: socket.id,
          producerId
        });

        reply({ closed: true });

      } catch (err) {
        logError(SCOPE.PRODUCER, 'closeProducer failed', {
          socketId: socket.id,
          error: err.message
        });

        reply({ error: err.message });
      }
    });


    // ───────────────────────────────────────────────────────────────────────────
    // disconnect — Cleanup when a socket disconnects
    //
    // Triggered automatically by Socket.IO when:
    //   • client closes the tab/app
    //   • network drops
    //   • server restarts
    //
    // Responsibilities:
    //   1. Log the disconnection + reason.
    //   2. Remove the participant from the room.
    //   3. Clean up all their Producers from global store.
    //   4. Notify other participants that this user + producers are gone.
    //   5. Optionally: close the room + router if it becomes empty.
    // ───────────────────────────────────────────────────────────────────────────
    // Disconnect cleanup
        socket.on('disconnect', (reason) => {
          const roomId = socket.roomId;

          logInfo(SCOPE.SOCKET, 'Socket disconnected', {
            socketId: socket.id,
            roomId,
            reason
          });

          // If this socket was never fully associated with a room, nothing to clean up
          if (!roomId) return;

          const jamRoom = roomStore.get(roomId);
          if (!jamRoom) return;

          // Get the participant representation for this socket
          const leavingParticipant = jamRoom.getParticipant(socket.id);

          if (leavingParticipant) {
            // Clean up all Media Producers belonging to this participant
            leavingParticipant.mediaProducers.forEach((producer) => {
              // Remove producer from global lookup
              producerStore.delete(producer.id);

              // Notify others that this producer disappeared
              socket.to(roomId).emit('mediaProducerClosed', { producerId: producer.id });

              logInfo(SCOPE.PRODUCER, 'Producer removed due to disconnect', {
                producerId: producer.id,
                socketId: socket.id
              });
            });

            // --- FIX: Clean up all Data Producers belonging to this participant ---
            leavingParticipant.dataProducers.forEach((dataProducer) => {
              // (No global store for dataProducers was in the original, but if you had one, delete from it here)
              // dataProducerStore.delete(dataProducer.id);
              
              // Notify others that this data producer disappeared
              socket.to(roomId).emit('dataProducerClosed', { dataProducerId: dataProducer.id });

              logInfo(SCOPE.DATACHANNEL, 'DataProducer removed due to disconnect', {
                dataProducerId: dataProducer.id,
                socketId: socket.id
              });
            });
            // --- END FIX ---
          }

          // --- FIX: Handle Metronome Leader Change ---
          // Get the leader ID *before* removing the participant
          const oldLeaderId = jamRoom.metronomeLeaderSocketId;

          // Remove participant from room's participant map
          // (This method is responsible for re-assigning the leader)
          jamRoom.removeParticipant(socket.id);
          
          // Get the new leader ID *after* removing the participant
          const newLeaderId = jamRoom.metronomeLeaderSocketId;

          // If the person who left was the leader, and the leader has now changed,
          // notify everyone in the room of the new leader.
          if (oldLeaderId === socket.id && oldLeaderId !== newLeaderId) {
            logInfo(SCOPE.ROOM, 'Metronome leader changed', { roomId, oldLeaderId, newLeaderId });
            io.to(roomId).emit('newMetronomeLeader', { leaderSocketId: newLeaderId });
          }
          // --- END FIX ---

          // Notify others that this participant left the room
          socket.to(roomId).emit('participantLeft', { socketId: socket.id });

          logInfo(SCOPE.ROOM, 'Participant removed from room', {
            roomId,
            remaining: jamRoom.participants.size
          });

          // if no participants remain, close the router and delete the room.
          // This frees mediasoup resources and memory on the SFU.
          if (jamRoom.participants.size === 0) {
            jamRoom.router.close();
            roomStore.delete(roomId);
            logInfo(SCOPE.ROOM, 'Room closed (empty)', { roomId });
          }
        });
  });
    // ───────────────────────────────────────────────────────────────────────────────
    // Health & simple debug endpoints (Express)
    //
    // These are lightweight HTTP endpoints you can hit with curl/browser to:
    //   • Check if the signaling server is alive.
    //   • Inspect current rooms, participants, and media producers.
    //
    // Useful for:
    //   • Kubernetes/Load balancer health checks
    //   • Quick debugging without attaching a debugger
    //   • Ops dashboards / curl-based introspection
    // ───────────────────────────────────────────────────────────────────────────────

    // Basic liveness probe — returns 200 OK with a simple message.
    // Can be used as a health check endpoint for containers / load balancers.
    expressApp.get('/', (_req, res) => {
      res.send('Jam Room Signaling Server is running!');
    });

    // Simple JSON snapshot of current rooms:
    //   • roomId
    //   • participantCount
    //   • current metronomeLeaderSocketId (if any)
    //   • list of producers per room (id, kind, ownerSocketId)
    //
    // NOTE: This is intended for debugging and light introspection,
    // not as a public API. Avoid putting secrets or heavy data here.
    expressApp.get('/rooms', (_req, res) => {
      const snapshot = Array.from(roomStore.values()).map((r) => ({
        roomId: r.roomId,
        participantCount: r.participants.size,
        metronomeLeaderSocketId: r.metronomeLeaderSocketId,
        producers: r.getAllMediaProducers().map((p) => ({
          id: p.id,
          kind: p.kind,
          ownerSocketId: p.appData?.ownerSocketId
        })),
      }));

      res.json(snapshot);
    });
}

// ───────────────────────────────────────────────────────────────────────────────
// Mediasoup worker lifecycle
// ───────────────────────────────────────────────────────────────────────────────
async function startMediasoupWorker() {
  logInfo(SCOPE.BOOT, 'Starting mediasoup worker…');
  mediasoupWorker = await mediasoup.createWorker({
    logLevel: runtimeConfig.mediasoup.worker.logLevel,
    logTags: runtimeConfig.mediasoup.worker.logTags,
    rtcMinPort: runtimeConfig.mediasoup.worker.rtcMinPort,
    rtcMaxPort: runtimeConfig.mediasoup.worker.rtcMaxPort,
  });

  mediasoupWorker.on('died', (err) => {
    logError(SCOPE.BOOT, 'Mediasoup worker died', { error: err?.message });
    // let my process manager (pm2/systemd) restart me cleanly.
    process.exit(1);
  });

  logInfo(SCOPE.BOOT, 'Mediasoup worker started', { pid: mediasoupWorker.pid });
}

// ───────────────────────────────────────────────────────────────────────────────
// Room factory
// ───────────────────────────────────────────────────────────────────────────────
async function getOrCreateJamRoom(roomId) {
  let jamRoom = roomStore.get(roomId);
  if (jamRoom) return jamRoom;

  logInfo(SCOPE.ROOM, 'Creating room', { roomId });
  const router = await mediasoupWorker.createRouter(runtimeConfig.mediasoup.router);
  jamRoom = new JamRoom(roomId, router);
  roomStore.set(roomId, jamRoom);
  return jamRoom;
}
