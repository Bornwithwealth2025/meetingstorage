// server.js (Updated)
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const path = require('path');
const fs = require('fs-extra');
const dotenv = require('dotenv');
const RecordingManager = require('./RecordingManager');

dotenv.config();

const app = express();
const server = http.createServer(app);
const PORT = process.env.PORT || 4000;

// CORS configuration
app.use(cors({
  origin: process.env.CLIENT_URL_LOCAL || '*',
  credentials: true
}));

app.use(express.json({ limit: '100mb' }));
app.use(express.urlencoded({ extended: true, limit: '100mb' }));

// Socket.IO setup
const io = new Server(server, {
  cors: {
    origin: process.env.CLIENT_URL || '*',
    methods: ['GET', 'POST']
  },
  transports: ['websocket', 'polling'],
  maxHttpBufferSize: 1e8,
  pingTimeout: 60000,
  pingInterval: 25000
});

// Room Managers Map
const roomManagers = new Map();
const recordingsDir = process.env.RECORDING_DIR || './ui-recordings';

// Ensure base directories exist
fs.ensureDirSync(recordingsDir);
fs.ensureDirSync(path.join(recordingsDir, 'rooms'));

// Check FFmpeg once
let isFFmpegAvailable = false;
const checkFFmpeg = () => {
  const ffmpeg = require('fluent-ffmpeg');
  return new Promise((resolve) => {
    ffmpeg.getAvailableFormats((err) => {
      if (err) {
        
        resolve(false);
      } else {
        
        resolve(true);
      }
    });
  });
};

// Get or create room manager
function getRoomManager(roomId, socketId='') {
  if (!roomManagers.has(roomId)) {
    const manager = new RecordingManager(roomId, socketId, {
      isFFmpegAvailable,
      storagePath: recordingsDir
    });
    roomManagers.set(roomId, manager);
    
    return manager;
  }
  const manager = roomManagers.get(roomId);
  // Keep the manager bound to the latest socket for this room
  if (socketId) {
    try {
      manager.setSocketId(socketId);
    } catch {}
  }
  return manager;
}

// Clean up inactive room managers
function cleanupInactiveRooms() {
  const oneHourAgo = Date.now() - (60 * 60 * 1000);
  
  for (const [roomId, manager] of roomManagers.entries()) {
    const status = manager.getStatus();
    if (!status || (status.completedAt && status.completedAt.getTime() < oneHourAgo)) {
      manager.cleanup();
      roomManagers.delete(roomId);
      
    }
  }
}

// Set interval to clean up inactive rooms
setInterval(cleanupInactiveRooms, 30 * 60 * 1000);

// Serve static files with roomId decoding/mapping
app.use('/recordings/rooms/:encodedRoomId/:folder/:file', (req, res) => {
  try {
    const encodedRoomId = req.params.encodedRoomId;
    const folder = req.params.folder; // 'completed' or 'thumbnails'
    const file = req.params.file;
    
    // Decode the roomId (it was URL encoded, e.g., atstQ1WlLUo3mvL8ANj_PLqO)
    const decodedRoomId = decodeURIComponent(encodedRoomId);
    
    // Reconstruct path using sanitized roomId
    const filePath = path.resolve(recordingsDir, 'rooms', decodedRoomId, folder, file);
    
    // Verify file exists and is within recordings directory (security check)
    const absPath = path.resolve(filePath);
    const absRecordingsDir = path.resolve(recordingsDir);
    if (!absPath.startsWith(absRecordingsDir)) {
      return res.status(403).json({ error: 'Access denied' });
    }
    
    if (!fs.existsSync(absPath)) {
      return res.status(404).json({ error: 'File not found' });
    }
    
    res.download(absPath);
  } catch (error) {
    
    res.status(500).json({ error: error.message });
  }
});

// Fallback static serve for other paths
app.use('/recordings', express.static(recordingsDir));

// Health endpoint
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    ffmpegAvailable: isFFmpegAvailable,
    activeRooms: roomManagers.size,
    server: 'ui-recording-server'
  });
});

// Get room recording status
app.get('/api/v1/rooms/:roomId/recording/status', (req, res) => {
  try {
    const manager = getRoomManager(req.params.roomId);
    const status = manager.getStatus();
    
    if (!status) {
      return res.status(404).json({ error: 'No active recording in this room' });
    }
    
    res.json(status);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// List all rooms with recordings
app.get('/api/v1/rooms', (req, res) => {
  const rooms = [];
  
  for (const [roomId, manager] of roomManagers.entries()) {
    const status = manager.getStatus();
    if (status) {
      rooms.push({
        roomId,
        recordingId: status.id,
        status: status.status,
        startedAt: status.startedAt,
        duration: status.duration,
        framesWritten: status.framesWritten,
        audioChunksReceived: status.audioChunksReceived
      });
    }
  }
  
  res.json({ rooms, total: rooms.length });
});

// Download recording for a room
app.get('/api/v1/rooms/:roomId/recording/download', async (req, res) => {
  try {
    const manager = getRoomManager(req.params.roomId);
    const status = manager.getStatus();
    
    if (!status || !status.fileUrl) {
      return res.status(404).json({ error: 'No completed recording found for this room' });
    }
    
    // Extract filename from fileUrl
    const filename = status.fileUrl.split('/').pop();
    const filePath = path.join(recordingsDir, 'rooms', req.params.roomId, 'completed', filename);
    
    if (!await fs.pathExists(filePath)) {
      return res.status(404).json({ error: 'File not found' });
    }
    
    res.download(filePath, filename);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Socket.IO handlers
io.on('connection', (socket) => {
  

  socket.on('join-recording-room', (roomId) => {
    socket.join(roomId);
    
    
    const manager = getRoomManager(roomId, socket.id);
    // Ensure manager is bound to the latest socket
    manager.setSocketId(socket.id);
    const status = manager.getStatus();
    
    if (status) {
      socket.emit('recording-status', status);
    }
  });

  socket.on('leave-recording-room', (roomId) => {
    socket.leave(roomId);
    
  });

  // Start UI Recording
  socket.on('start-ui-recording', async (data, callback) => {
    try {
      const { roomId, userId, options = {} } = data;
      
      if (!roomId || !userId) {
        throw new Error('roomId and userId are required');
      }

      const manager = getRoomManager(roomId);
      const recording = await manager.startUIRecording(userId, options);
      
      socket.to(roomId).emit('recording-started', {
        recordingId: recording.id,
        roomId,
        userId,
        timestamp: new Date().toISOString()
      });

      if (callback) {
        callback({
          success: true,
          recordingId: recording.id,
          message: 'UI recording started'
        });
      }

      
    } catch (error) {
      
      if (callback) {
        callback({
          success: false,
          error: error.message
        });
      }
      socket.emit('recording-error', {
        error: 'Failed to start recording',
        details: error.message
      });
    }
  });

  // Send UI Frame - NOW BINARY WEBP
  socket.on('ui-frame', async (data, callback) => {
    try {
      const { roomId, recordingId, frameBlob, timestamp, metadata = {} } = data;
      
      if (!roomId || !recordingId || !frameBlob) {
        throw new Error('roomId, recordingId and frameBlob are required');
      }

      const manager = getRoomManager(roomId);
      
      // frameBlob is a binary Buffer sent from browser
      const frameBuffer = Buffer.isBuffer(frameBlob) ? frameBlob : Buffer.from(frameBlob);
      
      const result = await manager.addUIFrame(
        frameBuffer,
        timestamp || Date.now(),
        metadata
      );

      if (callback) {
        callback({ success: true, ...result });
      }
    } catch (error) {
      
      if (callback) {
        callback({ 
          success: false, 
          error: error.message 
        });
      }
    }
  });

  // Bulk Frames Upload (for batch processing)
  socket.on('bulk-frames', async (data, callback) => {
    try {
      const { roomId, frames, recordingId } = data;
      
      if (!roomId || !frames || !Array.isArray(frames)) {
        throw new Error('roomId, recordingId and frames array are required');
      }

      const manager = getRoomManager(roomId);
      const results = await manager.addBulkFrames(recordingId, frames);
      
      if (callback) {
        callback({
          success: true,
          ...results
        });
      }
    } catch (error) {
      
      if (callback) {
        callback({ success: false, error: error.message });
      }
    }
  });

  // Audio chunks
  socket.on('audio-chunk', async (data, callback) => {
    try {
      const { roomId, recordingId, audioData, timestamp, index } = data;
      
      if (!roomId || !recordingId || !audioData) {
        throw new Error('roomId, recordingId and audioData are required');
      }

      const manager = getRoomManager(roomId);
      const size = Buffer.from(audioData, 'base64').length;
      
      
      await manager.addAudioChunk(recordingId, audioData, timestamp, index);
      
      if (callback) {
        callback({ success: true });
      }
    } catch (error) {
      
      if (callback) {
        callback({ success: false, error: error.message });
      }
    }
  });

  // Pause Recording
  socket.on('pause-recording', async (data, callback) => {
    try {
      const { roomId } = data;
      
      if (!roomId) {
        throw new Error('roomId is required');
      }

      const manager = getRoomManager(roomId);
      const recording = await manager.pauseRecording();
      
      socket.to(roomId).emit('recording-paused', {
        recordingId: recording.id,
        roomId,
        timestamp: new Date().toISOString()
      });

      if (callback) {
        callback({ success: true, recordingId: recording.id });
      }

      
    } catch (error) {
      
      if (callback) {
        callback({ success: false, error: error.message });
      }
      socket.emit('recording-error', {
        error: 'Failed to pause recording',
        details: error.message
      });
    }
  });

  // Resume Recording
  socket.on('resume-recording', async (data, callback) => {
    try {
      const { roomId } = data;
      
      if (!roomId) {
        throw new Error('roomId is required');
      }

      const manager = getRoomManager(roomId);
      const recording = await manager.resumeRecording();
      
      socket.to(roomId).emit('recording-resumed', {
        recordingId: recording.id,
        roomId,
        timestamp: new Date().toISOString()
      });

      if (callback) {
        callback({ success: true, recordingId: recording.id });
      }

      
    } catch (error) {
      
      if (callback) {
        callback({ success: false, error: error.message });
      }
      socket.emit('recording-error', {
        error: 'Failed to resume recording',
        details: error.message
      });
    }
  });

  // Stop Recording
  socket.on('stop-recording', async (data, callback) => {
    try {
      const { roomId, withAudio = true } = data;
      
      if (!roomId) {
        throw new Error('roomId is required');
      }

      const manager = getRoomManager(roomId);
      const recording = await manager.stopRecording(withAudio);
      
      socket.to(roomId).emit('recording-stopped', {
        recordingId: recording.id,
        roomId,
        fileUrl: recording.fileUrl,
        thumbnailUrl: recording.thumbnailUrl,
        timestamp: new Date().toISOString()
      });
     consol.lig("Resuult",recording)
      if (callback) {
        const response = {
          success: true,
          recordingId: recording.id,
          fileUrl: recording.fileUrl,
          thumbnailUrl: recording.thumbnailUrl
        };
      
        callback(response);
      }

     
    } catch (error) {
     
      if (callback) {
        callback({ success: false, error: error.message });
      }
      socket.emit('recording-error', {
        error: 'Failed to stop recording',
        details: error.message
      });
    }
  });

  // Get Recording Status
  socket.on('get-recording-status', async (data, callback) => {
    try {
      const { roomId } = data;
      
      if (!roomId) {
        throw new Error('roomId is required');
      }

      const manager = getRoomManager(roomId);
      const status = manager.getStatus();
      
      if (callback) {
        if (status) {
          callback({ success: true, ...status });
        } else {
          callback({ success: false, error: 'No active recording in this room' });
        }
      }
    } catch (error) {
     
      if (callback) {
        callback({ success: false, error: error.message });
      }
    }
  });

  socket.on('disconnect', async () => {
    
    
    for (const [roomId, manager] of roomManagers.entries()) {
      if (manager.getSocketId() === socket.id) {
        try {
          await manager.cleanup();
        } catch (error) {
          
        }
      }
    }
  });
});

// Initialize FFmpeg and start server
checkFFmpeg().then((available) => {
  isFFmpegAvailable = available;
  
  server.listen(PORT, () => {
    
    
    
    
    
    
  });
});

// Cleanup on exit
process.on('SIGINT', async () => {
  
  try {
    for (const [roomId, manager] of roomManagers.entries()) {
      await manager.cleanup();
    }
    
    io.close();
    server.close();
    
    
    process.exit(0);
  } catch (error) {
    
    process.exit(1);
  }
});

module.exports = { app, server, io, roomManagers };