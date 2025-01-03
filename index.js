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
app.use(express.static("public"));

const PORT = process.env.PORT || 3001;

// Mediasoup variables
let worker;
let router;
let transportPool = {};
let producers = {};
let consumers = {};
let peers = {};
let rooms = {};
let socketList = {}; // Store user details

(async () => {
  try {
    worker = await mediasoup.createWorker();
    router = await worker.createRouter({
      mediaCodecs: [
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
      ],
    });
    console.log("Mediasoup router created!");
  } catch (error) {
    console.error("Error creating Mediasoup worker or router:", error);
  }
})();

io.on("connection", (socket) => {
  console.log(`Client connected: ${socket.id}`);

  peers[socket.id] = { transports: [], producers: [], consumers: [] };

  socket.on("get-rtp-capabilities", (callback) => {
    if (router) {
      callback(router.rtpCapabilities);
    } else {
      console.error("Router not initialized");
      callback(null);
    }
  });

  socket.on("create-transport", async (_, callback) => {
    try {
      const transport = await router.createWebRtcTransport({
        listenIps: [{ ip: "0.0.0.0", announcedIp: "vc.clevdoc.com" }],
        enableUdp: true,
        enableTcp: true,
      });

      transportPool[transport.id] = transport;
      peers[socket.id].transports.push(transport.id);

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
    } catch (error) {
      console.error("Error creating transport:", error);
      callback(null);
    }
  });

  socket.on("produce", async ({ kind, rtpParameters, transportId }, callback) => {
    try {
      const transport = transportPool[transportId];
      const producer = await transport.produce({ kind, rtpParameters });

      producers[producer.id] = producer;
      peers[socket.id].producers.push(producer.id);

      callback({ id: producer.id });
      socket.broadcast.emit("new-producer", producer.id);
    } catch (error) {
      console.error("Error in produce:", error);
      callback({ error: "Failed to produce" });
    }
  });

  socket.on("consume", async ({ producerId, rtpCapabilities }, callback) => {
    try {
      if (!router.canConsume({ producerId, rtpCapabilities })) {
        console.error("Cannot consume this producer");
        return callback({ error: "Cannot consume" });
      }

      const transport = transportPool[peers[socket.id].transports[0]];
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
    } catch (error) {
      console.error("Error in consume:", error);
      callback({ error: "Failed to consume" });
    }
  });

  // Handle user joining a room
 

  socket.on("BE-check-user", ({ roomId, userName }) => {
    let error = false;

    const clients = rooms[roomId] || [];
    clients.forEach((client) => {
      if (socketList[client]?.userName === userName) {
        error = true;
      }
    });
    socket.emit("FE-error-user-exist", { error });
  });

  socket.on("BE-join-room", ({ roomId, userName }) => {
    socket.join(roomId);
    socketList[socket.id] = { userName, video: true, audio: true };

    if (!rooms[roomId]) rooms[roomId] = [];
    rooms[roomId].push(socket.id);

    const users = rooms[roomId].map((id) => ({
      userId: id,
      info: socketList[id],
    }));

    io.to(roomId).emit("FE-user-join", users);
  });

  socket.on("BE-call-user", ({ userToCall, from, signal }) => {
    io.to(userToCall).emit("FE-receive-call", {
      signal,
      from,
      info: socketList[socket.id],
    });
  });

  socket.on("BE-accept-call", ({ signal, to }) => {
    io.to(to).emit("FE-call-accepted", {
      signal,
      answerId: socket.id,
    });
  });

  socket.on("BE-leave-room", ({ roomId }) => {
    const index = rooms[roomId]?.indexOf(socket.id);
    if (index > -1) rooms[roomId].splice(index, 1);
    delete socketList[socket.id];

    socket.broadcast.to(roomId).emit("FE-user-leave", { userId: socket.id });
    socket.leave(roomId);
  });

  socket.on("BE-toggle-camera-audio", ({ roomId, switchTarget }) => {
    if (switchTarget === "video") {
      socketList[socket.id].video = !socketList[socket.id].video;
    } else {
      socketList[socket.id].audio = !socketList[socket.id].audio;
    }

    socket.broadcast.to(roomId).emit("FE-toggle-camera", {
      userId: socket.id,
      switchTarget,
    });
  });

  socket.on("BE-send-message", ({ roomId, msg, sender }) => {
    io.to(roomId).emit("FE-receive-message", { msg, sender });
  });

  socket.on("disconnect", () => {
    console.log(`Client disconnected: ${socket.id}`);

    peers[socket.id]?.producers.forEach((id) => producers[id]?.close());
    peers[socket.id]?.consumers.forEach((id) => consumers[id]?.close());
    peers[socket.id]?.transports.forEach((id) => {
      transportPool[id]?.close();
      delete transportPool[id];
    });

    Object.keys(rooms).forEach((roomId) => {
      const index = rooms[roomId]?.indexOf(socket.id);
      if (index > -1) rooms[roomId].splice(index, 1);
    });

    delete socketList[socket.id];
    delete peers[socket.id];
  });
});

server.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});







/////////////////////////////////////
// const express = require("express");
// const http = require("http");
// const socketIo = require("socket.io");
// const mediasoup = require("mediasoup");
// const cors = require("cors");

// const app = express();
// const server = http.createServer(app);
// const io = socketIo(server, {
//   cors: {
//     origin: "*",
//     methods: ["GET", "POST"],
//   },
// });

// // app.use(cors());
// app.use(express.static("public"));

// const PORT = process.env.PORT || 3001;

// // Mediasoup variables
// let worker;
// let router;
// let transportPool = {};
// let producers = {};
// let consumers = {};
// let peers = {};
// let rooms = {};
// let socketList = {}; // Store user details

// (async () => {
//   try {
//     worker = await mediasoup.createWorker();
//     router = await worker.createRouter({
//       mediaCodecs: [
//         {
//           kind: "audio",
//           mimeType: "audio/opus",
//           clockRate: 48000,
//           channels: 2,
//         },
//         {
//           kind: "video",
//           mimeType: "video/VP8",
//           clockRate: 90000,
//           parameters: {
//             "x-google-start-bitrate": 1000,
//           },
//         },
//       ],
//     });
//     console.log("Mediasoup router created!");
//   } catch (error) {
//     console.error("Error creating Mediasoup worker or router:", error);
//   }
// })();

// io.on("connection", (socket) => {
//   console.log(`Client connected: ${socket.id}`);

//   peers[socket.id] = { transports: [], producers: [], consumers: [] };

//   socket.on("get-rtp-capabilities", (callback) => {
//     if (router) {
//       callback(router.rtpCapabilities);
//     } else {
//       console.error("Router not initialized");
//       callback(null);
//     }
//   });

//   socket.on("create-transport", async (_, callback) => {
//     try {
//       const transport = await router.createWebRtcTransport({
//         listenIps: [{ ip: "0.0.0.0", announcedIp: null }],
//         enableUdp: true,
//         enableTcp: true,
//       });

//       transportPool[transport.id] = transport;
//       peers[socket.id].transports.push(transport.id);

//       transport.on("dtlsstatechange", (state) => {
//         if (state === "closed") {
//           delete transportPool[transport.id];
//         }
//       });

//       callback({
//         id: transport.id,
//         iceParameters: transport.iceParameters,
//         iceCandidates: transport.iceCandidates,
//         dtlsParameters: transport.dtlsParameters,
//       });
//     } catch (error) {
//       console.error("Error creating transport:", error);
//       callback(null);
//     }
//   });

//   socket.on("produce", async ({ kind, rtpParameters, transportId }, callback) => {
//     try {
//       const transport = transportPool[transportId];
//       const producer = await transport.produce({ kind, rtpParameters });

//       producers[producer.id] = producer;
//       peers[socket.id].producers.push(producer.id);

//       callback({ id: producer.id });
//       socket.broadcast.emit("new-producer", producer.id);
//     } catch (error) {
//       console.error("Error in produce:", error);
//       callback({ error: "Failed to produce" });
//     }
//   });

//   socket.on("consume", async ({ producerId, rtpCapabilities }, callback) => {
//     try {
//       if (!router.canConsume({ producerId, rtpCapabilities })) {
//         console.error("Cannot consume this producer");
//         return callback({ error: "Cannot consume" });
//       }

//       const transport = transportPool[peers[socket.id].transports[0]];
//       const consumer = await transport.consume({
//         producerId,
//         rtpCapabilities,
//       });

//       consumers[consumer.id] = consumer;
//       peers[socket.id].consumers.push(consumer.id);

//       callback({
//         id: consumer.id,
//         producerId: consumer.producerId,
//         kind: consumer.kind,
//         rtpParameters: consumer.rtpParameters,
//       });
//     } catch (error) {
//       console.error("Error in consume:", error);
//       callback({ error: "Failed to consume" });
//     }
//   });

//   // Handle user joining a room
//   socket.on("BE-join-room", ({ roomId, userName }) => {
//     socket.join(roomId);
//     socketList[socket.id] = { userName, video: true, audio: true };

//     if (!rooms[roomId]) rooms[roomId] = [];
//     rooms[roomId].push(socket.id);

//     const users = rooms[roomId].map((id) => ({
//       userId: id,
//       info: socketList[id],
//     }));

//     io.to(roomId).emit("FE-user-join", users);
//   });

//   socket.on("BE-check-user", ({ roomId, userName }) => {
//     let error = false;

//     const clients = rooms[roomId] || [];
//     clients.forEach((client) => {
//       if (socketList[client]?.userName === userName) {
//         error = true;
//       }
//     });
//     socket.emit("FE-error-user-exist", { error });
//   });

//   socket.on("BE-leave-room", ({ roomId }) => {
//     const index = rooms[roomId]?.indexOf(socket.id);
//     if (index > -1) rooms[roomId].splice(index, 1);
//     delete socketList[socket.id];

//     socket.broadcast.to(roomId).emit("FE-user-leave", { userId: socket.id });
//     socket.leave(roomId);
//   });

//   socket.on("BE-toggle-camera-audio", ({ roomId, switchTarget }) => {
//     if (switchTarget === "video") {
//       socketList[socket.id].video = !socketList[socket.id].video;
//     } else {
//       socketList[socket.id].audio = !socketList[socket.id].audio;
//     }

//     socket.broadcast.to(roomId).emit("FE-toggle-camera", {
//       userId: socket.id,
//       switchTarget,
//     });
//   });

//   socket.on("BE-send-message", ({ roomId, msg, sender }) => {
//     io.to(roomId).emit("FE-receive-message", { msg, sender });
//   });

//   socket.on("disconnect", () => {
//     console.log(`Client disconnected: ${socket.id}`);

//     peers[socket.id]?.producers.forEach((id) => producers[id]?.close());
//     peers[socket.id]?.consumers.forEach((id) => consumers[id]?.close());
//     peers[socket.id]?.transports.forEach((id) => {
//       transportPool[id]?.close();
//       delete transportPool[id];
//     });

//     Object.keys(rooms).forEach((roomId) => {
//       const index = rooms[roomId]?.indexOf(socket.id);
//       if (index > -1) rooms[roomId].splice(index, 1);
//     });

//     delete socketList[socket.id];
//     delete peers[socket.id];
//   });
// });

// server.listen(PORT, () => {
//   console.log(`Server running on http://localhost:${PORT}`);
// });

/////////////////////////////////////////////////////////////////////


// const express = require("express");
// const http = require("http");
// const socketIo = require("socket.io");
// const mediasoup = require("mediasoup");
// const cors = require("cors");

// const app = express();
// const server = http.createServer(app);
// const io = socketIo(server, {
//   cors: {
//     origin: "*",
//     methods: ["GET", "POST"],
//   },
// });

// app.use(cors());

// const PORT = process.env.PORT || 3001;

// // Mediasoup variables
// let worker;
// let router;
// let transportPool = {};
// let producers = {};
// let consumers = {};
// let peers = {};

// // Create Mediasoup Worker
// (async () => {
//   try {
//     worker = await mediasoup.createWorker();
//     router = await worker.createRouter({
//       mediaCodecs: [
//         {
//           kind: "audio",
//           mimeType: "audio/opus",
//           clockRate: 48000,
//           channels: 2,
//         },
//         {
//           kind: "video",
//           mimeType: "video/VP8",
//           clockRate: 90000,
//           parameters: {
//             "x-google-start-bitrate": 1000,
//           },
//         },
//       ],
//     });
//     console.log("Mediasoup router created!");
//   } catch (error) {
//     console.error("Error creating Mediasoup worker or router:", error);
//   }
// })();

// // Handle WebSocket connections
// io.on("connection", (socket) => {
//   console.log(`Client connected: ${socket.id}`);

//   // Store peer information
//   peers[socket.id] = { transports: [], producers: [], consumers: [] };

//   // Send Router Capabilities
//   socket.on("get-rtp-capabilities", (callback) => {
//     if (router) {
//       callback(router.rtpCapabilities);
//     } else {
//       console.error("Router not initialized");
//       callback(null);
//     }
//   });

//   // Create WebRTC Transport
//   socket.on("create-transport", async (_, callback) => {
//     try {
//       const transport = await router.createWebRtcTransport({
//         listenIps: [{ ip: "0.0.0.0", announcedIp: null }],
//         enableUdp: true,
//         enableTcp: true,
//       });

//       transportPool[transport.id] = transport;
//       peers[socket.id].transports.push(transport.id);

//       transport.on("dtlsstatechange", (state) => {
//         if (state === "closed") {
//           delete transportPool[transport.id];
//         }
//       });

//       callback({
//         id: transport.id,
//         iceParameters: transport.iceParameters,
//         iceCandidates: transport.iceCandidates,
//         dtlsParameters: transport.dtlsParameters,
//       });
//     } catch (error) {
//       console.error("Error creating transport:", error);
//       callback(null);
//     }
//   });

//   // Produce Media
//   socket.on("produce", async ({ kind, rtpParameters, transportId }, callback) => {
//     try {
//       const transport = transportPool[transportId];
//       const producer = await transport.produce({ kind, rtpParameters });

//       producers[producer.id] = producer;
//       peers[socket.id].producers.push(producer.id);

//       callback({ id: producer.id });
//       socket.broadcast.emit("new-producer", producer.id);
//     } catch (error) {
//       console.error("Error in produce:", error);
//       callback({ error: "Failed to produce" });
//     }
//   });

//   // Consume Media
//   socket.on("consume", async ({ producerId, rtpCapabilities }, callback) => {
//     try {
//       if (!router.canConsume({ producerId, rtpCapabilities })) {
//         console.error("Cannot consume this producer");
//         return callback({ error: "Cannot consume" });
//       }

//       const transport = transportPool[peers[socket.id].transports[0]];
//       const consumer = await transport.consume({
//         producerId,
//         rtpCapabilities,
//       });

//       consumers[consumer.id] = consumer;
//       peers[socket.id].consumers.push(consumer.id);

//       callback({
//         id: consumer.id,
//         producerId: consumer.producerId,
//         kind: consumer.kind,
//         rtpParameters: consumer.rtpParameters,
//       });
//     } catch (error) {
//       console.error("Error in consume:", error);
//       callback({ error: "Failed to consume" });
//     }
//   });

//   // Clean up on disconnect
//   socket.on("disconnect", () => {
//     console.log(`Client disconnected: ${socket.id}`);

//     peers[socket.id]?.producers.forEach((id) => producers[id]?.close());
//     peers[socket.id]?.consumers.forEach((id) => consumers[id]?.close());
//     peers[socket.id]?.transports.forEach((id) => {
//       transportPool[id]?.close();
//       delete transportPool[id];
//     });

//     delete peers[socket.id];
//   });
// });

// server.listen(PORT, () => {
//   console.log(`Server running on http://localhost:${PORT}`);
// });



