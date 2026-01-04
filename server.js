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
        console.error('❌ FFmpeg not found or not accessible:', err.message);
        resolve(false);
      } else {
        console.log('✅ FFmpeg is available');
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
    console.log(`📁 Created recording manager for room ${roomId}`);
  }
  return roomManagers.get(roomId);
}

// Clean up inactive room managers
function cleanupInactiveRooms() {
  const oneHourAgo = Date.now() - (60 * 60 * 1000);
  
  for (const [roomId, manager] of roomManagers.entries()) {
    const status = manager.getStatus();
    if (!status || (status.completedAt && status.completedAt.getTime() < oneHourAgo)) {
      manager.cleanup();
      roomManagers.delete(roomId);
      console.log(`🧹 Removed inactive room manager for room ${roomId}`);
    }
  }
}

// Set interval to clean up inactive rooms
setInterval(cleanupInactiveRooms, 30 * 60 * 1000);

// Serve static files
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
        framesWritten: status.framesWritten
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
  console.log('🔌 Client connected:', socket.id);

  socket.on('join-recording-room', (roomId) => {
    socket.join(roomId);
    console.log(`Client ${socket.id} joined recording room ${roomId}`);
    
    const manager = getRoomManager(roomId, socket.id);
    const status = manager.getStatus();
    
    if (status) {
      socket.emit('recording-status', status);
    }
  });

  socket.on('leave-recording-room', (roomId) => {
    socket.leave(roomId);
    console.log(`Client ${socket.id} left recording room ${roomId}`);
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

      console.log(`🎥 UI Recording ${recording.id} started in room ${roomId}`);
    } catch (error) {
      console.error('Start recording error:', error);
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

  // Send UI Frame
  socket.on('ui-frame', async (data, callback) => {
    try {
      const { roomId, frameData, timestamp, metadata = {} } = data;
      
      if (!roomId || !frameData) {
        throw new Error('roomId and frameData are required');
      }

      const manager = getRoomManager(roomId);
      const result = await manager.addUIFrame(
        frameData,
        timestamp || Date.now(),
        metadata
      );

      if (callback) {
        callback({ success: true, ...result });
      }
    } catch (error) {
      console.error('UI frame error:', error);
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
      console.error('Bulk frames error:', error);
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
      await manager.addAudioChunk(recordingId, audioData, timestamp, index);
      
      if (callback) {
        callback({ success: true });
      }
    } catch (error) {
      console.error('Audio chunk error:', error);
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

      console.log(`⏸️ Recording paused in room ${roomId}`);
    } catch (error) {
      console.error('Pause recording error:', error);
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

      console.log(`▶️ Recording resumed in room ${roomId}`);
    } catch (error) {
      console.error('Resume recording error:', error);
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

      if (callback) {
        callback({
          success: true,
          recordingId: recording.id,
          fileUrl: recording.fileUrl,
          thumbnailUrl: recording.thumbnailUrl
        });
      }

      console.log(`🛑 Recording stopped in room ${roomId}, file: ${recording.fileUrl}`);
    } catch (error) {
      console.error('Stop recording error:', error);
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
      console.error('Get status error:', error);
      if (callback) {
        callback({ success: false, error: error.message });
      }
    }
  });

  socket.on('disconnect', async () => {
    console.log('Client disconnected:', socket.id);
    
    for (const [roomId, manager] of roomManagers.entries()) {
      if (manager.getSocketId() === socket.id) {
        try {
          await manager.cleanup();
        } catch (error) {
          console.error('Cleanup error on disconnect:', error);
        }
      }
    }
  });
});

// Initialize FFmpeg and start server
checkFFmpeg().then((available) => {
  isFFmpegAvailable = available;
  
  server.listen(PORT, () => {
    console.log(`✅ UI Recording Server running on port ${PORT}`);
    console.log(`📁 Recordings stored in: ${recordingsDir}`);
    console.log(`🔗 Socket.IO endpoint: ws://localhost:${PORT}`);
    console.log(`🌐 HTTP API endpoint: http://localhost:${PORT}`);
    console.log(`📊 Health check: http://localhost:${PORT}/health`);
    console.log(`🎥 FFmpeg available: ${isFFmpegAvailable}`);
  });
});

// Cleanup on exit
process.on('SIGINT', async () => {
  console.log('\n🛑 Shutting down UI Recording Server...');
  
  try {
    for (const [roomId, manager] of roomManagers.entries()) {
      await manager.cleanup();
    }
    
    io.close();
    server.close();
    
    console.log('✅ Server shutdown complete');
    process.exit(0);
  } catch (error) {
    console.error('❌ Shutdown error:', error);
    process.exit(1);
  }
});

module.exports = { app, server, io, roomManagers };