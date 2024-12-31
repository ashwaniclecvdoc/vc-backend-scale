const express = require("express");
const http = require("http");
const socketIo = require("socket.io");
const mediasoup = require("mediasoup");
const cors = require("cors");

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"],
  },
});

app.use(cors());

const PORT = process.env.PORT || 3001;

// Mediasoup variables
let worker;
let router;
let transportPool = {};
let producers = {};
let consumers = {};
let peers = {};

// Create Mediasoup Worker
(async () => {
  worker = await mediasoup.createWorker();
  router = await worker.createRouter({ mediaCodecs: [
    {
      kind: "audio",
      mimeType: "audio/opus",
      clockRate: 48000,
      channels: 2,
    },
    {
      kind: "video",
      mimeType: "video/VP8",
      clockRate: 90000,
      parameters: {
        "x-google-start-bitrate": 1000,
      },
    },
  ] });
  console.log("Mediasoup router created!");
})();

// Handle WebSocket connections
io.on("connection", (socket) => {
  console.log(`Client connected: ${socket.id}`);

  // Store peer information
  peers[socket.id] = { transports: [], producers: [], consumers: [] };

  // Create WebRTC Transport
  socket.on("create-transport", async (_, callback) => {
    const transport = await router.createWebRtcTransport({
      listenIps: [{ ip: "0.0.0.0", announcedIp: null }],
      enableUdp: true,
      enableTcp: true,
    });
    transportPool[transport.id] = transport;

    transport.on("dtlsstatechange", (state) => {
      if (state === "closed") {
        delete transportPool[transport.id];
      }
    });

    callback({
      id: transport.id,
      iceParameters: transport.iceParameters,
      iceCandidates: transport.iceCandidates,
      dtlsParameters: transport.dtlsParameters,
    });
  });

  // Produce Media
  socket.on("produce", async ({ kind, rtpParameters, transportId }, callback) => {
    const transport = transportPool[transportId];
    const producer = await transport.produce({ kind, rtpParameters });
    producers[producer.id] = producer;

    peers[socket.id].producers.push(producer.id);
    callback({ id: producer.id });
  });

  // Consume Media
  socket.on("consume", async ({ producerId, rtpCapabilities }, callback) => {
    if (!router.canConsume({ producerId, rtpCapabilities })) {
      return callback({ error: "Cannot consume this producer" });
    }

    const transport = peers[socket.id].transports[0];
    const consumer = await transport.consume({
      producerId,
      rtpCapabilities,
    });

    consumers[consumer.id] = consumer;
    peers[socket.id].consumers.push(consumer.id);

    callback({
      id: consumer.id,
      producerId: consumer.producerId,
      kind: consumer.kind,
      rtpParameters: consumer.rtpParameters,
    });
  });

  socket.on("disconnect", () => {
    console.log(`Client disconnected: ${socket.id}`);
    peers[socket.id]?.producers.forEach((id) => producers[id]?.close());
    peers[socket.id]?.consumers.forEach((id) => consumers[id]?.close());
    delete peers[socket.id];
  });
});

server.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
