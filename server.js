const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const path = require('path');
const fs = require('fs-extra');
const cron = require('node-cron');
const dotenv = require('dotenv');
const RecordingManager = require('./RecordingManager');
const recordRepository = require('./repository/recordRepository');


dotenv.config();

const app = express();
const server = http.createServer(app);
const PORT = process.env.PORT || 4000;
const RECORD_RETENTION_DAYS = Number(process.env.RECORD_RETENTION_DAYS) || 7;
const RECORD_CLEANUP_CRON = process.env.RECORD_CLEANUP_CRON || '0 0 * * *';
const RECORD_CLEANUP_TZ = process.env.RECORD_CLEANUP_TZ || process.env.TZ;





function serializeRecording(recording) {
  if (!recording) {
    return null;
  }

  return {
    id: recording.id,
    roomId: recording.roomId,
    user_id: recording.user_id,
    userId: recording.userId,
    type: recording.type,
    filename: recording.filename,
    fileUrl: recording.fileUrl,
    thumbnailUrl: recording.thumbnailUrl,
    startedAt: recording.startedAt,
    completedAt: recording.completedAt,
  };
}

function extractRoomIdFromRecord(record) {
  if (record?.roomId) {
    return String(record.roomId);
  }

  const candidateUrls = [record?.fileUrl, record?.thumbnailUrl];
  for (const candidate of candidateUrls) {
    if (!candidate || typeof candidate !== 'string') {
      continue;
    }

    const urlPath = candidate.split('?')[0];
    const match = urlPath.match(/\/rooms\/([^/]+)\//);
    if (match?.[1]) {
      return decodeURIComponent(match[1]);
    }
  }

  return null;
}

function resolveAssetPath(assetUrl) {
  if (!assetUrl || typeof assetUrl !== 'string') {
    return null;
  }

  let pathname = assetUrl.trim();
  try {
    if (/^https?:\/\//i.test(pathname)) {
      pathname = new URL(pathname).pathname;
    }
  } catch {
    return null;
  }

  pathname = pathname.split('?')[0];
  const absoluteRecordingsDir = path.resolve(recordingsDir);

  if (path.isAbsolute(pathname) && !pathname.startsWith('/recordings/')) {
    const absolutePath = path.resolve(pathname);
    return absolutePath.startsWith(absoluteRecordingsDir) ? absolutePath : null;
  }

  let relativePath = null;
  if (pathname.startsWith('/recordings/')) {
    relativePath = pathname.slice('/recordings/'.length);
  } else if (pathname.startsWith('/rooms/')) {
    relativePath = pathname.slice(1);
  } else if (pathname.startsWith('rooms/')) {
    relativePath = pathname;
  }

  if (!relativePath) {
    return null;
  }

  const absolutePath = path.resolve(recordingsDir, relativePath);
  return absolutePath.startsWith(absoluteRecordingsDir) ? absolutePath : null;
}

async function deleteRecordAssets(record) {
  const targets = [
    resolveAssetPath(record?.fileUrl),
    resolveAssetPath(record?.thumbnailUrl),
  ].filter(Boolean);

  for (const targetPath of targets) {
    try {
      if (await fs.pathExists(targetPath)) {
        await fs.remove(targetPath);
      }
    } catch (error) {
      console.error(`Failed to remove record asset: ${targetPath}`, error);
    }
  }
}

async function runExpiredRecordCleanup() {
  try {
    const expiredRecords = await recordRepository.getExpiredRecords(RECORD_RETENTION_DAYS);
    if (!expiredRecords.length) {
      console.log('Record cleanup: no expired records found');
      return;
    }

    const affectedRooms = new Set();
    let deletedRows = 0;

    for (const record of expiredRecords) {
      const userId = record?.user_id || record?.userId;
      const recordId = record?.id || record?.recordId;
      if (!userId || !recordId) {
        continue;
      }

      await deleteRecordAssets(record);

      const roomId = extractRoomIdFromRecord(record);
      if (roomId) {
        affectedRooms.add(roomId);
      }

      const deleted = await recordRepository.deleteRecordByUserAndRecordId(userId, recordId);
      if (deleted) {
        deletedRows += 1;
      }
    }

    const absoluteRecordingsDir = path.resolve(recordingsDir);
    for (const roomId of affectedRooms) {
      const remainingCount = await recordRepository.countRecordsByRoomId(roomId);
      if (remainingCount > 0) {
        continue;
      }

      const roomFolderPath = path.resolve(recordingsDir, 'rooms', roomId);
      if (!roomFolderPath.startsWith(absoluteRecordingsDir)) {
        continue;
      }

      if (await fs.pathExists(roomFolderPath)) {
        await fs.remove(roomFolderPath);
      }
    }

    console.log(`Record cleanup completed. Deleted rows: ${deletedRows}`);
  } catch (error) {
    console.error('Record cleanup failed:', error);
  }
}

function startRecordCleanupCron() {
  if (!cron.validate(RECORD_CLEANUP_CRON)) {
    console.error(`Invalid cleanup cron expression: ${RECORD_CLEANUP_CRON}`);
    return;
  }

  const options = RECORD_CLEANUP_TZ ? { timezone: RECORD_CLEANUP_TZ } : undefined;
  recordCleanupTask = cron.schedule(RECORD_CLEANUP_CRON, () => {
    runExpiredRecordCleanup();
  }, options);

  console.log(`Record cleanup cron started: ${RECORD_CLEANUP_CRON}`);
}







/**
 * App implemtation started
 */

// CORS configuration
app.use(cors({
  //origin: process.env.CLIENT_URL_LOCAL || '*',
 origin: process.env.CLIENT_URL,
  credentials: true
}));

app.use(express.json({ limit: '100mb' }));
app.use(express.urlencoded({ extended: true, limit: '100mb' }));

// Socket.IO setup
const io = new Server(server, {
  cors: {
   // origin: process.env.CLIENT_URL || '*',
    origin: process.env.CLIENT_URL,
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
let recordCleanupTask = null;

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
function getRoomManager(roomId, socketId='', user_id='') {
  if (!roomManagers.has(roomId)) {
    const manager = new RecordingManager(roomId, socketId, user_id, {
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
app.use('', express.static(recordingsDir));

// Health endpoint
app.get('/api/v1/health', (req, res) => {
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


const saveRecord = async (record) => {
  try {
    await recordRepository.saveRecord(record);
    console.log('Record saved to database for user:', record.user_id || record.userId);
  } catch (error) {
    console.error('Error saving record to database:', error);
  }
};
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


async function getRoomBySocketId(socketId){
  let room = null
   for (const [roomId, manager] of roomManagers.entries()) {
   
    if (manager.getSocketId() === socketId) {
      room  = manager;
      break;
    }
  }
  return room
}

async function getAllRecords(user_id) {
  try {
    return await recordRepository.getRecordsByUserId(user_id);
  } catch (error) {
    console.error('Error retrieving records from database:', error);
    return [];
  }
}


app.get('/api/v1/records/:user_id', async (req, res) => {
  try {
    const user_id = req.params.user_id;
    const records = await getAllRecords(user_id);
    res.json({ records, total: records.length });
  } catch (error) {
    console.log(error);
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/v1/records/:user_id/:record_id', async (req, res) => {
  try {
    const { user_id, record_id } = req.params;
    const record = await recordRepository.getRecordByUserAndRecordId(user_id, record_id);

    if (!record) {
      return res.status(404).json({ error: 'Record not found' });
    }

    res.json({ record });
  } catch (error) {
    console.log(error);
    res.status(500).json({ error: error.message });
  }
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
  
 console.log(`Socket connected: ${socket.id}`);
  socket.on('join-recording-room', ({roomId, user_id}) => {
    socket.join(roomId);
    
    
    const manager = getRoomManager(roomId, socket.id, user_id);
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
      ///console.log("Manager in start-ui-recording:", manager, options);
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
      //console.log("Bulk frames received:", data);
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
      
      // audioData comes from frontend as ArrayBuffer via Socket.io
      // Socket.io will convert it to a Buffer automatically
      // No need to convert from base64 here
      let buffer;
      if (Buffer.isBuffer(audioData)) {
        buffer = audioData;
      } else if (typeof audioData === 'string') {
        buffer = Buffer.from(audioData, 'base64');
      } else if (audioData instanceof ArrayBuffer) {
        buffer = Buffer.from(audioData);
      } else {
        throw new Error(`Invalid audioData format: ${typeof audioData}`);
      }
      
      if (buffer.length === 0) {
        throw new Error('Audio chunk is empty');
      }
      
      const sizeMB = (buffer.length / (1024 * 1024)).toFixed(3);
      console.log(`[Audio] Chunk ${index}: ${sizeMB}MB (timestamp: ${timestamp})`);
      
      await manager.addAudioChunk(recordingId, buffer, timestamp, index);
      
      if (callback) {
        callback({ success: true });
      }
    } catch (error) {
      console.error(`[Audio Error]`, error.message);
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
      const record = serializeRecording(recording);
      await saveRecord(record);
     // console.log("Recording stopped:", recording);
      socket.to(roomId).emit('recording-stopped', {  
        recordingId: recording.id,
        roomId,
        fileUrl: recording.fileUrl,
        thumbnailUrl: recording.thumbnailUrl,
        timestamp: new Date().toISOString()
      });
    
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
    
    console.log(`Socket disconnected: ${socket.id}`);
    for (const [roomId, manager] of roomManagers.entries()) {
    
      if (manager  !== null && manager.socketId === socket.id) {
        try {
          const status = manager?.recordings?.get(manager?.recordingId);
        
          if(!status) continue;

          let recordToSave = status;
          if (status.status === 'recording' || status.status === 'paused') {
            recordToSave = await manager.stopRecording(false);
          }

          const rec = serializeRecording(recordToSave);
          if (rec?.fileUrl) {
            await saveRecord(rec);
          }

          await manager.cleanup();
        } catch (error) {
          console.log(`Error during cleanup for socket ${socket.id}:`, error);
        }finally{
          roomManagers.delete(roomId);
          await manager.cleanup();
        }
      }
    }
  });
});

// Initialize FFmpeg and start server
checkFFmpeg().then(async (available) => {
  isFFmpegAvailable = available;
  try {
    await recordRepository.initialize();
    console.log('Record repository initialized successfully');
    startRecordCleanupCron();
  } catch (error) {
    console.error('Record repository initialization failed:', error);
  }
  
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
    if (recordCleanupTask) {
      recordCleanupTask.stop();
    }
    await recordRepository.close();
    
    
    process.exit(0);
  } catch (error) {
    
    process.exit(1);
  }
});

module.exports = { app, server, io, roomManagers };