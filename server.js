const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const path = require('path');
const fs = require('fs-extra');
const dotenv = require('dotenv');
const { v4: uuidv4 } = require('uuid');
const ffmpeg = require('fluent-ffmpeg');
const multer = require('multer');
const sharp = require('sharp');
const WebSocket = require('ws');

dotenv.config();

const app = express();
const server = http.createServer(app);
const PORT = process.env.PORT || 4000;

// CORS configuration
app.use(cors({
  origin: process.env.CLIENT_URL || '*',
  credentials: true
}));

app.use(express.json({ limit: '100mb' }));
app.use(express.urlencoded({ extended: true, limit: '100mb' }));

// Socket.IO setup
const io = new Server(server, {
  cors: {
    origin: process.env.CLIENT_URL,
    methods: ['GET', 'POST']
  },
  transports: ['websocket', 'polling'],
  maxHttpBufferSize: 1e8, // 100MB for large chunks
  pingTimeout: 60000,
  pingInterval: 25000
});

// File upload configuration
// const storage = multer.memoryStorage();
// const upload = multer({ 
//   storage: storage,
//   limits: { fileSize: 100 * 1024 * 1024 } // 100MB
// });

// Ensure directories exist
const recordingsDir = process.env.RECORDING_DIR || './ui-recordings';
fs.ensureDirSync(recordingsDir);
fs.ensureDirSync(path.join(recordingsDir, 'temp'));
fs.ensureDirSync(path.join(recordingsDir, 'completed'));
fs.ensureDirSync(path.join(recordingsDir, 'thumbnails'));

// Recording Manager
class RecordingManager {
  constructor() {
    this.activeRecordings = new Map();
    this.recordingHistory = new Map();
    this.roomRecordings = new Map(); // roomId -> recordingId
    this.processingQueue = [];
    this.isProcessing = false;
    
    console.log('Recording storage initialized:', recordingsDir);
  }

  async startUIRecording(roomId, userId, options = {}) {
    const recordingId = uuidv4();
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = `ui-recording_${roomId}_${timestamp}.mp4`;
    
    const recording = {
      id: recordingId,
      roomId,
      userId,
      type: 'ui-screen',
      filename,
      status: 'initializing',
      startedAt: new Date(),
      pausedAt: null,
      resumedAt: null,
      completedAt: null,
      fileUrl: null,
      error: null,
      tempDir: path.join(recordingsDir, 'temp', recordingId),
      segments: [],
      currentSegment: null,
      options: {
        fps: options.fps || 30,
        width: options.width || 1920,
        height: options.height || 1080,
        quality: options.quality || 23, // CRF value
        audioBitrate: options.audioBitrate || '128k',
        videoBitrate: options.videoBitrate || '2500k'
      },
      stats: {
        framesReceived: 0,
        chunksProcessed: 0,
        lastFrameTime: null,
        droppedFrames: 0
      },
      ffmpegProcess: null
    };

    // Create temp directory
    await fs.ensureDir(recording.tempDir);
    
    // Setup FFmpeg process for real-time encoding
    await this.setupFFmpegProcess(recording);
    
    recording.status = 'recording';
    this.activeRecordings.set(recordingId, recording);
    this.roomRecordings.set(roomId, recordingId);
    
    console.log(`UI Recording started: ${recordingId} for room ${roomId}`);
    return recording;
  }

  async setupFFmpegProcess(recording) {
    const outputPath = path.join(recording.tempDir, 'output.mp4');
    
    return new Promise((resolve, reject) => {
      const command = ffmpeg()
        .input('pipe:0')
        .inputFormat('image2pipe')
        .inputFPS(recording.options.fps)
        .videoCodec('libx264')
        .outputOptions([
          '-preset ultrafast',
          `-crf ${recording.options.quality}`,
          '-tune zerolatency',
          '-pix_fmt yuv420p',
          '-movflags +faststart',
          '-g 60', // Keyframe interval
          '-bf 2', // B-frames
          '-refs 3' // Reference frames
        ])
        .size(`${recording.options.width}x${recording.options.height}`)
        .output(outputPath)
        .on('start', (commandLine) => {
          console.log(`🚀 FFmpeg started: ${commandLine}`);
          recording.ffmpegProcess = command;
          resolve(command);
        })
        .on('error', (err) => {
          console.error('❌ FFmpeg error:', err);
          recording.error = err.message;
          recording.status = 'failed';
          reject(err);
        })
        .on('end', () => {
          console.log(`✅ FFmpeg encoding completed: ${recording.id}`);
        });

      // Create write stream
      recording.ffmpegStream = command.stdin;
      
      // Handle stdin errors
      command.stdin.on('error', (err) => {
        if (err.code !== 'EPIPE') {
          console.error('FFmpeg stdin error:', err);
        }
      });
    });
  }

  async addUIFrame(recordingId, frameData, timestamp, metadata = {}) {
    const recording = this.activeRecordings.get(recordingId);
    if (!recording || recording.status !== 'recording') {
      throw new Error('Recording not found or not active');
    }

    try {
      // Convert base64/ArrayBuffer to Buffer
      let buffer;
      if (Buffer.isBuffer(frameData)) {
        buffer = frameData;
      } else if (typeof frameData === 'string') {
        // Remove data:image prefix if present
        const base64Data = frameData.replace(/^data:image\/\w+;base64,/, '');
        buffer = Buffer.from(base64Data, 'base64');
      } else if (frameData instanceof ArrayBuffer) {
        buffer = Buffer.from(frameData);
      } else {
        throw new Error('Invalid frame data format');
      }

      // Process image with sharp for optimization
      const processedBuffer = await sharp(buffer)
        .resize(recording.options.width, recording.options.height, {
          fit: 'contain',
          background: { r: 0, g: 0, b: 0 }
        })
        .jpeg({ quality: 85, mozjpeg: true })
        .toBuffer();

      // Write to FFmpeg process
      if (recording.ffmpegStream && !recording.ffmpegStream.destroyed) {
        recording.ffmpegStream.write(processedBuffer);
        recording.stats.framesReceived++;
        recording.stats.lastFrameTime = timestamp || Date.now();
        
        // Throttle if needed
        const currentTime = Date.now();
        if (recording.stats.lastFrameTime && 
            currentTime - recording.stats.lastFrameTime < 1000 / recording.options.fps) {
          recording.stats.droppedFrames++;
        }
      } else {
        throw new Error('FFmpeg stream not available');
      }

      return { success: true, frames: recording.stats.framesReceived };
    } catch (error) {
      console.error('Frame processing error:', error);
      recording.stats.droppedFrames++;
      throw error;
    }
  }

  async addAudioChunk(recordingId, audioData, timestamp) {
    const recording = this.activeRecordings.get(recordingId);
    if (!recording || recording.status !== 'recording') {
      throw new Error('Recording not found or not active');
    }

    // Note: For audio, we need to implement separate audio pipe
    // This is a simplified version - in production, you'd mix UI audio with meeting audio
    console.log('Audio chunk received for recording:', recordingId);
    
    return { success: true };
  }

  async pauseRecording(recordingId) {
    const recording = this.activeRecordings.get(recordingId);
    if (!recording) throw new Error('Recording not found');
    
    if (recording.status !== 'recording') {
      throw new Error(`Cannot pause - recording is ${recording.status}`);
    }

    recording.status = 'paused';
    recording.pausedAt = new Date();
    
    // Pause FFmpeg processing
    if (recording.ffmpegStream) {
      recording.ffmpegStream.pause();
    }

    console.log(`⏸️ Recording paused: ${recordingId}`);
    return recording;
  }

  async resumeRecording(recordingId) {
    const recording = this.activeRecordings.get(recordingId);
    if (!recording) throw new Error('Recording not found');
    
    if (recording.status !== 'paused') {
      throw new Error(`Cannot resume - recording is ${recording.status}`);
    }

    recording.status = 'recording';
    recording.resumedAt = new Date();
    
    // Resume FFmpeg processing
    if (recording.ffmpegStream) {
      recording.ffmpegStream.resume();
    }

    console.log(`▶️ Recording resumed: ${recordingId}`);
    return recording;
  }

  async stopRecording(recordingId, finalize = true) {
    const recording = this.activeRecordings.get(recordingId);
    if (!recording) throw new Error('Recording not found');

    recording.status = 'stopping';
    console.log(`Stopping recording: ${recordingId}`);

    try {
      // Close FFmpeg stream
      if (recording.ffmpegStream && !recording.ffmpegStream.destroyed) {
        recording.ffmpegStream.end();
      }

      if (recording.ffmpegProcess) {
        await new Promise((resolve, reject) => {
          recording.ffmpegProcess.on('end', resolve).on('error', reject);
        });
      }

      if (finalize) {
        // Finalize recording
        await this.finalizeRecording(recording);
      }

      // Cleanup
      this.activeRecordings.delete(recordingId);
      this.roomRecordings.delete(recording.roomId);
      
      console.log(`✅ Recording stopped: ${recordingId}`);
      return recording;
    } catch (error) {
      console.error('Error stopping recording:', error);
      recording.status = 'failed';
      recording.error = error.message;
      throw error;
    }
  }

  async finalizeRecording(recording) {
    const tempOutput = path.join(recording.tempDir, 'output.mp4');
    const finalOutput = path.join(recordingsDir, 'completed', recording.filename);
    
    // Check if output file exists
    if (!await fs.pathExists(tempOutput)) {
      throw new Error('No output file generated');
    }

    // Post-process with FFmpeg for better quality
    await new Promise((resolve, reject) => {
      ffmpeg(tempOutput)
        .outputOptions([
          '-c:v libx264',
          '-preset medium',
          `-crf ${recording.options.quality}`,
          '-c:a aac',
          '-b:a 128k',
          '-movflags +faststart',
          '-y'
        ])
        .output(finalOutput)
        .on('end', () => {
          console.log(`🎉 Recording finalized: ${finalOutput}`);
          resolve();
        })
        .on('error', reject)
        .run();
    });

    // Generate thumbnail
    await this.generateThumbnail(finalOutput, recording.id);

    // Update recording info
    recording.fileUrl = `/recordings/completed/${recording.filename}`;
    recording.thumbnailUrl = `/recordings/thumbnails/${recording.id}.jpg`;
    recording.completedAt = new Date();
    recording.status = 'completed';
    
    // Save to history
    this.recordingHistory.set(recording.id, recording);
    
    // Cleanup temp files
    await fs.remove(recording.tempDir).catch(console.error);
    
    return recording;
  }

  async generateThumbnail(videoPath, recordingId) {
    const thumbnailPath = path.join(recordingsDir, 'thumbnails', `${recordingId}.jpg`);
    
    return new Promise((resolve, reject) => {
      ffmpeg(videoPath)
        .screenshots({
          timestamps: ['50%'], // Middle of video
          filename: `${recordingId}.jpg`,
          folder: path.join(recordingsDir, 'thumbnails'),
          size: '320x180'
        })
        .on('end', resolve)
        .on('error', reject);
    });
  }

  getRecordingByRoom(roomId) {
    const recordingId = this.roomRecordings.get(roomId);
    if (!recordingId) return null;
    
    return this.activeRecordings.get(recordingId) || this.recordingHistory.get(recordingId);
  }

  getRecordingStatus(recordingId) {
    const recording = this.activeRecordings.get(recordingId) || this.recordingHistory.get(recordingId);
    if (!recording) throw new Error('Recording not found');

    const now = Date.now();
    const startedAt = recording.startedAt.getTime();
    const duration = recording.completedAt 
      ? (recording.completedAt.getTime() - startedAt) / 1000
      : (now - startedAt) / 1000;

    return {
      id: recording.id,
      roomId: recording.roomId,
      status: recording.status,
      duration: Math.round(duration),
      framesReceived: recording.stats.framesReceived,
      droppedFrames: recording.stats.droppedFrames,
      fileUrl: recording.fileUrl,
      thumbnailUrl: recording.thumbnailUrl,
      startedAt: recording.startedAt,
      completedAt: recording.completedAt,
      error: recording.error
    };
  }

  async cleanup() {
    console.log('🧹 Cleaning up recording manager...');
    
    // Stop all active recordings
    const stopPromises = Array.from(this.activeRecordings.keys()).map(async (recordingId) => {
      try {
        await this.stopRecording(recordingId, false);
      } catch (error) {
        console.error(`Error stopping recording ${recordingId}:`, error);
      }
    });
    
    await Promise.allSettled(stopPromises);
    
    // Cleanup old temp files
    const tempDir = path.join(recordingsDir, 'temp');
    if (await fs.pathExists(tempDir)) {
      const dirs = await fs.readdir(tempDir);
      const cutoffTime = Date.now() - (24 * 60 * 60 * 1000); // 24 hours ago
      
      for (const dir of dirs) {
        const dirPath = path.join(tempDir, dir);
        try {
          const stats = await fs.stat(dirPath);
          if (stats.birthtimeMs < cutoffTime) {
            await fs.remove(dirPath);
            console.log(`Cleaned up old temp dir: ${dir}`);
          }
        } catch (error) {
          console.error(`Error cleaning up ${dir}:`, error);
        }
      }
    }
    
    console.log('✅ Cleanup completed');
  }
}

// Initialize recording manager
const recordingManager = new RecordingManager();

// Serve static files
app.use('/recordings', express.static(recordingsDir));

// Health endpoint
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    activeRecordings: recordingManager.activeRecordings.size,
    server: 'ui-recording-server'
  });
});

// Get recording status endpoint
app.get('/api/v1/recording/:id/status', (req, res) => {
  try {
    const status = recordingManager.getRecordingStatus(req.params.id);
    res.json(status);
  } catch (error) {
    res.status(404).json({ error: error.message });
  }
});

// List recordings endpoint
app.get('/api/v1/recordings', (req, res) => {
  const recordings = [];
  
  // Add active recordings
  for (const recording of recordingManager.activeRecordings.values()) {
    recordings.push({
      id: recording.id,
      roomId: recording.roomId,
      status: recording.status,
      startedAt: recording.startedAt,
      duration: recording.stats.duration,
      type: recording.type
    });
  }
  
  // Add historical recordings
  for (const recording of recordingManager.recordingHistory.values()) {
    recordings.push({
      id: recording.id,
      roomId: recording.roomId,
      status: recording.status,
      startedAt: recording.startedAt,
      completedAt: recording.completedAt,
      fileUrl: recording.fileUrl,
      thumbnailUrl: recording.thumbnailUrl,
      duration: recording.stats.duration,
      type: recording.type
    });
  }
  
  res.json({ recordings });
});

// Download recording endpoint
app.get('/api/v1/recording/:id/download', async (req, res) => {
  try {
    const recording = recordingManager.recordingHistory.get(req.params.id);
    if (!recording || !recording.fileUrl) {
      throw new Error('Recording not found');
    }
    
    const filePath = path.join(recordingsDir, 'completed', recording.filename);
    if (!await fs.pathExists(filePath)) {
      throw new Error('File not found');
    }
    
    res.download(filePath, recording.filename);
  } catch (error) {
    res.status(404).json({ error: error.message });
  }
});

// Socket.IO handlers
io.on('connection', (socket) => {
  console.log('🔌 Client connected:', socket.id);

  socket.on('join-recording-room', (roomId) => {
    socket.join(roomId);
    console.log(`Client ${socket.id} joined recording room ${roomId}`);
    
    // Send current recording status for this room
    const recording = recordingManager.getRecordingByRoom(roomId);
    if (recording) {
      socket.emit('recording-status', {
        recordingId: recording.id,
        status: recording.status,
        roomId
      });
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

      // Check if room already has active recording
      const existingRecording = recordingManager.getRecordingByRoom(roomId);
      if (existingRecording && (existingRecording.status === 'recording' || existingRecording.status === 'paused')) {
        throw new Error(`Room ${roomId} already has an active recording`);
      }

      const recording = await recordingManager.startUIRecording(roomId, userId, options);
      
      // Broadcast to room
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

      console.log(`🎥 UI Recording ${recording.id} started for room ${roomId}`);
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
      const { recordingId, frameData, timestamp, metadata = {} } = data;
      
      if (!recordingId || !frameData) {
        throw new Error('recordingId and frameData are required');
      }

      const result = await recordingManager.addUIFrame(
        recordingId,
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
        callback({ success: false, error: error.message });
      }
    }
  });

  // Send Audio Chunk
  socket.on('audio-chunk', async (data, callback) => {
    try {
      const { recordingId, audioData, timestamp, codec = 'opus' } = data;
      
      if (!recordingId || !audioData) {
        throw new Error('recordingId and audioData are required');
      }

      const result = await recordingManager.addAudioChunk(
        recordingId,
        audioData,
        timestamp || Date.now()
      );

      if (callback) {
        callback({ success: true, ...result });
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
      const { recordingId, roomId } = data;
      
      if (!recordingId || !roomId) {
        throw new Error('recordingId and roomId are required');
      }

      const recording = await recordingManager.pauseRecording(recordingId);
      
      // Broadcast to room
      socket.to(roomId).emit('recording-paused', {
        recordingId,
        roomId,
        timestamp: new Date().toISOString()
      });

      if (callback) {
        callback({ success: true, recordingId });
      }

      console.log(`⏸️ Recording ${recordingId} paused`);
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
      const { recordingId, roomId } = data;
      
      if (!recordingId || !roomId) {
        throw new Error('recordingId and roomId are required');
      }

      const recording = await recordingManager.resumeRecording(recordingId);
      
      // Broadcast to room
      socket.to(roomId).emit('recording-resumed', {
        recordingId,
        roomId,
        timestamp: new Date().toISOString()
      });

      if (callback) {
        callback({ success: true, recordingId });
      }

      console.log(`▶️ Recording ${recordingId} resumed`);
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
      const { recordingId, roomId } = data;
      
      if (!recordingId || !roomId) {
        throw new Error('recordingId and roomId are required');
      }

      const recording = await recordingManager.stopRecording(recordingId);
      
      // Broadcast to room
      socket.to(roomId).emit('recording-stopped', {
        recordingId,
        roomId,
        fileUrl: recording.fileUrl,
        thumbnailUrl: recording.thumbnailUrl,
        timestamp: new Date().toISOString()
      });

      if (callback) {
        callback({
          success: true,
          recordingId,
          fileUrl: recording.fileUrl,
          thumbnailUrl: recording.thumbnailUrl
        });
      }

      console.log(`🛑 Recording ${recordingId} stopped`);
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
      const { recordingId } = data;
      
      if (!recordingId) {
        throw new Error('recordingId is required');
      }

      const status = recordingManager.getRecordingStatus(recordingId);
      
      if (callback) {
        callback({ success: true, ...status });
      }
    } catch (error) {
      console.error('Get status error:', error);
      if (callback) {
        callback({ success: false, error: error.message });
      }
    }
  });

  // Bulk Frames Upload (for efficient batch processing)
  socket.on('bulk-frames', async (data, callback) => {
    try {
      const { recordingId, frames, roomId } = data;
      
      if (!recordingId || !frames || !Array.isArray(frames)) {
        throw new Error('recordingId and frames array are required');
      }

      const results = [];
      for (const frame of frames) {
        try {
          const result = await recordingManager.addUIFrame(
            recordingId,
            frame.data,
            frame.timestamp,
            frame.metadata
          );
          results.push({ success: true, ...result });
        } catch (frameError) {
          results.push({ success: false, error: frameError.message });
        }
      }

      // Send progress update to room
      socket.to(roomId).emit('frames-processed', {
        recordingId,
        processed: results.filter(r => r.success).length,
        total: frames.length
      });

      if (callback) {
        callback({
          success: true,
          processed: results.filter(r => r.success).length,
          failed: results.filter(r => !r.success).length,
          results
        });
      }
    } catch (error) {
      console.error('Bulk frames error:', error);
      if (callback) {
        callback({ success: false, error: error.message });
      }
    }
  });

  // Heartbeat
  socket.on('heartbeat', (data, callback) => {
    if (callback) {
      callback({
        success: true,
        timestamp: new Date().toISOString(),
        serverTime: Date.now()
      });
    }
  });

  socket.on('disconnect', (reason) => {
    console.log('Client disconnected:', socket.id, 'Reason:', reason);
  });

  socket.on('error', (error) => {
    console.error('Socket error:', socket.id, error);
  });
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error('Server error:', err);
  res.status(500).json({
    error: 'Internal server error',
    message: err.message,
    timestamp: new Date().toISOString()
  });
});

// Start server
server.listen(PORT, () => {
  console.log(`UI Recording Server running on port ${PORT}`);
  console.log(`Recordings stored in: ${recordingsDir}`);
  console.log(`Socket.IO endpoint: ws://localhost:${PORT}`);
});

// Cleanup on exit
process.on('SIGINT', async () => {
  console.log('\n🛑 Shutting down UI Recording Server...');
  
  try {
    await recordingManager.cleanup();
    io.close();
    server.close();
    
    console.log('✅ Server shutdown complete');
    process.exit(0);
  } catch (error) {
    console.error('❌ Shutdown error:', error);
    process.exit(1);
  }
});

// Handle uncaught errors
process.on('uncaughtException', (error) => {
  console.error('💥 Uncaught Exception:', error);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('💥 Unhandled Rejection at:', promise, 'reason:', reason);
});

module.exports = { app, server, io, recordingManager };