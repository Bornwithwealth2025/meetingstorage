// RecordingManager.js - HIGH PERFORMANCE VERSION
// No Sharp per-frame, sequential queue processing, FFmpeg scales once
const fs = require('fs-extra');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const ffmpeg = require('fluent-ffmpeg');
const { spawn } = require('child_process');


function getYearWeek(date = new Date()) {
  const today = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const lastDayOfYear = new Date(`${date.getFullYear()}-12-31`)
  const diffInDay = (lastDayOfYear - today) / (1000 * 60 * 60 * 24)
  const totalDayPast = Math.ceil(365 - diffInDay)
  const week = Math.floor(totalDayPast / 7)
  return `${date.getFullYear()}-W${String(week).padStart(2, "0")}`
}

// usage
const weekly = getYearWeek();

const createLogDirAndLog = (msg)=>{

	try{
	// const montly = (new Date()).toISOString().slice(0, 7);
	 const logDir = path.join(__dirname, 'logs')
	 if (!fs.existsSync(logDir)){
        fs.mkdir(logDir, (err, data)=>{
        	if (err) {
        	  console.log(err)
        	}
        	console.log(data)
        });
	 }
	
	 const log = `${(new Date()).toISOString()}----${msg}\n`
	 fs.writeFileSync(logDir+'/'+weekly+'.log', log, {flag: 'a'})
	}catch(e){
	  console.log(e)
	}
}



const DEBUG = true; // Set to false to disable all logging
const mode = 'file' // 'console' or 'file'
const logger = (...args) => {
  if (!DEBUG) return;
  if (mode === 'file') {
    createLogDirAndLog(args.join(' '))
  }else {
   console.log(`[RecordingManager]`, ...args);
  }
   
}

class RecordingManager {
  constructor(roomId, socketId, user_id, options = {}) {
    this.roomId = roomId;
    this.socketId = socketId;
    this.user_id = user_id
    this.recordingId = null;
    this.recordings = new Map();
    this.activeRecording = null;
    this.isFFmpegAvailable = options.isFFmpegAvailable || false;
    this.storagePath = path.resolve(options.storagePath || './ui-recordings');
    
    // Frame queue for backpressure handling
    this.frameQueue = [];
    this.isProcessingFrames = false;
    
    this.frameCounter = 0;
    this.audioChunks = [];
    this.audioIndex = 0;
    
    this.initializeStorage();
  }

  getSocketId() {
    return this.socketId;
  }
  
  getRecording() {
    return this.activeRecording;
  }

  setSocketId(socketId) {
    this.socketId = socketId;
  }

  initializeStorage() {
    const roomStorage = path.join(this.storagePath, 'rooms', this.roomId);
    fs.ensureDirSync(path.join(roomStorage, 'temp'));
    fs.ensureDirSync(path.join(roomStorage, 'completed'));
    fs.ensureDirSync(path.join(roomStorage, 'thumbnails'));
    fs.ensureDirSync(path.join(roomStorage, 'audio'));
  }

  async startUIRecording(userId, options = {}) {
   
     try {
        
    if (!this.isFFmpegAvailable) {
      throw new Error('FFmpeg is not available');
    }

    if (this.activeRecording && 
        (this.activeRecording.status === 'recording' || 
         this.activeRecording.status === 'paused')) {
      throw new Error(`Room ${this.roomId} already has an active recording`);
    }

    const recordingId = uuidv4();
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = `ui-recording_${this.roomId}_${timestamp}.mp4`;
    const roomStorage = path.join(this.storagePath, 'rooms', this.roomId);
    
    const recording = {
      id: recordingId,
      roomId: this.roomId,
      user_id: this.user_id,
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
      tempDir: path.join(roomStorage, 'temp', recordingId),
      framesDir: path.join(roomStorage, 'temp', recordingId, 'frames'),
      audioDir: path.join(roomStorage, 'temp', recordingId, 'audio'),
      options: {
        fps: options.fps || 30,
        width: options.width || 1280,
        height: options.height || 720,
        quality: options.quality || 23,
        captureSurface: options.captureSurface || 'unknown',
        withAudio: true
      },
      stats: {
        framesReceived: 0,
        framesProcessed: 0,
        framesWritten: 0,
        audioChunksReceived: 0,
        lastFrameTime: null,
        firstFrameTime: null,
        droppedFrames: 0,
        errors: 0,
        averageFPS: 0,
        startTime: Date.now(),
        lastAudioTimestamp: 0
      },
      frameFiles: [],
      frameTimestamps: [],
      audioFiles: [],
      isProcessing: false
    };

    await fs.ensureDir(recording.tempDir);
    await fs.ensureDir(recording.framesDir);
    await fs.ensureDir(recording.audioDir);
    
    recording.status = 'recording';
    this.recordings.set(recordingId, recording);
    this.activeRecording = recording;
    this.recordingId = recordingId;
    this.frameCounter = 0;
    this.frameQueue = [];
    this.isProcessingFrames = false;
    
    logger(`🎥 UI Recording started in room ${this.roomId}: ${recordingId}`);
    logger(`📊 Target FPS: ${recording.options.fps}, Audio: ${recording.options.withAudio}`);
    return recording;
     } catch (error) {
        logger(`❌ Error starting recording in room ${this.roomId}:`, error.message);
        throw error;
     }

  }

  async addUIFrame(frameData, timestamp, metadata = {}) {
    if (!this.activeRecording) {
      throw new Error('No active recording');
    }

    const recording = this.activeRecording;
    
    if (recording.status !== 'recording' && recording.status !== 'stopping') {
      throw new Error(`Cannot add frame - recording status is: ${recording.status}`);
    }

    recording.stats.framesReceived++;

    try {
      await this.processFrame(recording, frameData, timestamp, metadata);
      
      return {
        success: true,
        recordingId: recording.id,
        framesWritten: recording.stats.framesWritten,
        framesReceived: recording.stats.framesReceived
      };
    } catch (error) {
     
      recording.stats.errors++;
      recording.stats.droppedFrames++;
      
      return {
        success: false,
        error: error.message,
        recordingId: recording.id,
        framesWritten: recording.stats.framesWritten
      };
    }
  }




  async addBulkFrames(recordingId, frames) {
    const recording = this.recordings.get(recordingId) || this.activeRecording;
    
    if (!recording) {
      throw new Error('No recording found');
    }

    let processed = 0;
    let failed = 0;

    for (const frame of frames) {
      try {
        await this.processFrame(
          recording,
          frame.data,
          frame.timestamp,
          frame.metadata
        );
        processed++;
      } catch (error) {
        failed++;
        recording.stats.droppedFrames++;
       
      }
    }

    logger(`📊 Processed ${processed} frames, failed: ${failed}`);
    return {
      processed,
      failed,
      totalFrames: recording.stats.framesWritten
    };
  }

  async addAudioChunk(recordingId, audioData, timestamp, index) {
   const recording = this.recordings.get(recordingId) || this.activeRecording;

    if (!recording) {
      throw new Error('No recording found');
    }

    if (!recording.options.withAudio) {
      return;
    }

    try {
      // Handle both base64 string and ArrayBuffer
      let buffer;
      if (typeof audioData === 'string') {
        buffer = Buffer.from(audioData, 'base64');
      } else if (audioData instanceof ArrayBuffer) {
        buffer = Buffer.from(audioData);
      } else if (Buffer.isBuffer(audioData)) {
        buffer = audioData;
      } else {
        throw new Error(`Invalid audio data type: ${typeof audioData}`);
      }
      
      if (buffer.length === 0) {
        logger(`⚠️ Audio chunk ${index} is empty, skipping`);
        return;
      }
      
      // Append to single audio file instead of creating separate files
      const singleAudioPath = path.join(recording.audioDir, 'recording.webm');
      await fs.appendFile(singleAudioPath, buffer);
      
      recording.stats.audioChunksReceived++;
      // Track the end of the latest audio chunk for duration alignment
      const chunkEnd = (timestamp || 0) + 250;
      recording.stats.lastAudioTimestamp = Math.max(recording.stats.lastAudioTimestamp || 0, chunkEnd);
      
      if (recording.stats.audioChunksReceived % 10 === 0) {
        logger(`🎤 Audio chunks received: ${recording.stats.audioChunksReceived}`);
      }
    } catch (error) {
      logger(`❌ Error adding audio chunk ${index}: ${error.message}`);
      throw error;
    }
  }







  async processFrame(recording, frameBuffer, timestamp, metadata) {
    try {
      // NO Sharp processing - just write the frame as-is
      // Frames arrive as WebP blobs from browser (already compressed, perfect size)
      
      if (!Buffer.isBuffer(frameBuffer)) {
        throw new Error('Invalid frame buffer format');
      }

      const frameNumber = this.frameCounter++;
      const frameFilename = `frame_${frameNumber.toString().padStart(6, '0')}.webp`;
      const framePath = path.join(recording.framesDir, frameFilename);

      // Sequential write (no parallel processing) - respects backpressure
      await fs.writeFile(framePath, frameBuffer);
      
      const frameInfo = {
        path: framePath,
        timestamp: timestamp,
        frameNumber,
        filename: frameFilename,
        size: frameBuffer.length
      };
      
      recording.frameFiles.push(frameInfo);
      recording.stats.framesWritten++;

      if (recording.stats.framesWritten === 1) {
        recording.stats.firstFrameTime = frameInfo.timestamp;
      }
      
      recording.stats.lastFrameTime = frameInfo.timestamp;

      // Calculate actual FPS
      if (recording.stats.framesWritten > 1 && recording.stats.firstFrameTime) {
        const elapsedTime = (recording.stats.lastFrameTime - recording.stats.firstFrameTime) / 1000;
        if (elapsedTime > 0) {
          recording.stats.averageFPS = (recording.stats.framesWritten / elapsedTime).toFixed(2);
        }
      }

      if (recording.stats.framesWritten % 30 === 0) {
        logger(`📊 Room ${this.roomId}: ${recording.stats.framesWritten} frames, ${(frameBuffer.length / 1024).toFixed(1)}KB avg, FPS: ${recording.stats.averageFPS}`);
      }

    } catch (error) {
     
      recording.stats.droppedFrames++;
      throw error;
    }
  }

  async pauseRecording() {
    if (!this.activeRecording || this.activeRecording.status !== 'recording') {
      throw new Error('Cannot pause - no active recording or not in recording state');
    }

    this.activeRecording.status = 'paused';
    this.activeRecording.pausedAt = new Date();

    logger(`⏸️ Recording paused in room ${this.roomId}`);
    return this.activeRecording;
  }

  async resumeRecording() {
    if (!this.activeRecording || this.activeRecording.status !== 'paused') {
      throw new Error('Cannot resume - no active recording or not paused');
    }

    this.activeRecording.status = 'recording';
    this.activeRecording.resumedAt = new Date();

    logger(`▶️ Recording resumed in room ${this.roomId}`);
    return this.activeRecording;
  }



  async generateAllVideoFile(recording, frameInfos) {
    const toPosix = (p) => path.resolve(p).replace(/\\/g, '/');
    const concatFilePath = path.resolve(recording.tempDir, 'all_frames.txt');
    await fs.ensureDir(path.dirname(concatFilePath));

    if (!frameInfos || frameInfos.length === 0) {
      throw new Error('No frames provided for concat list');
    }

    // Calculate approximate FPS
    // let fps = recording.options.fps || 30;
    // if (frameInfos.length > 1) {
    //   const durationSec = (frameInfos[frameInfos.length - 1].timestamp - frameInfos[0].timestamp) / 1000;
    //   if (durationSec > 0) {
    //     fps = Math.min(Math.round(frameInfos.length / durationSec), 60);
    //   }
    // }


    // const lines = [];
    // for (let i = 0; i < frameInfos.length; i++) {
    //   const curr = frameInfos[i];
    //   const next = frameInfos[i + 1];

    //   let durSec;
    //   if (next) {
    //     durSec = Math.max((next.timestamp - curr.timestamp) / 1000, 1 / fps);
    //   } else {
    //     durSec = 1 / fps;
    //   }

    //   lines.push(`file '${toPosix(curr.path)}'`);
    //   lines.push(`duration ${durSec.toFixed(6)}`);
    // }

    const sorted = frameInfos.sort((a, b) => a.timestamp - b.timestamp);
    
    const lines = [];
    for (let i = 0; i < sorted.length; i++) {
      const curr = sorted[i];
      const next = sorted[i + 1];

      let durSec;
      if (next) {
        //  Use ACTUAL timestamp difference
        durSec = Math.max((next.timestamp - curr.timestamp) / 1000, 0.001);
      } else {
        // Last frame: use target FPS
        durSec = 1 / (recording.options.fps || 30);
      }

      lines.push(`file '${toPosix(curr.path)}'`);
      lines.push(`duration ${durSec.toFixed(6)}`);
    }

    const fps = recording.options.fps || 30;
    const firstTimestamp = sorted[0].timestamp;
    const lastTimestamp = sorted[sorted.length - 1].timestamp;
    const nominalDurationMs = Math.max(0, lastTimestamp - firstTimestamp) + (1000 / fps);
    const targetDurationMs = Math.max(nominalDurationMs, recording.stats.lastAudioTimestamp || 0);
    const extraTailSec = Math.max(0, (targetDurationMs - nominalDurationMs) / 1000);

    if (extraTailSec > 0) {
      const lastDurationIndex = lines.length - 1; // Last duration entry (before the required duplicate file line)
      const currentDuration = parseFloat(lines[lastDurationIndex].replace('duration ', '')) || (1 / fps);
      lines[lastDurationIndex] = `duration ${(currentDuration + extraTailSec).toFixed(6)}`;
      logger(`ℹ️ Extended last frame by ${extraTailSec.toFixed(3)}s to align with audio (${(targetDurationMs / 1000).toFixed(2)}s total).`);
    }

    // FFmpeg requires the last frame to appear again without duration
    lines.push(`file '${toPosix(sorted[sorted.length - 1].path)}'`);

    fs.writeFileSync(concatFilePath, lines.join('\n'));
    return concatFilePath;



  } 




// 3️⃣ Convert single WebM audio file → AAC (.m4a)
async concatWavToAac() {
  const audioDir = path.join(this.activeRecording.tempDir, 'audio');
  const inputFile = path.join(audioDir, 'recording.webm');
  const outputFile = path.join(this.activeRecording.tempDir, 'audio.m4a');

  // Check if audio file exists
  const fileExists = await fs.pathExists(inputFile);
  if (!fileExists) {
    throw new Error('Audio recording file does not exist');
  }

  const stats = await fs.stat(inputFile);
  if (stats.size === 0) {
    throw new Error('Audio recording file is empty');
  }

  logger(`🎵 Converting WebM audio (${(stats.size / 1024).toFixed(1)}KB) to AAC`);

  return new Promise((resolve, reject) => {
    const ffmpegArgs = [
      '-i', inputFile,
      '-c:a', 'aac',
      '-ar', '48000',
      '-ac', '2',
      '-b:a', '128k',
      '-movflags', '+faststart',
      '-y',
      outputFile
    ];

    logger(`🎵 Running FFmpeg: ffmpeg ${ffmpegArgs.join(' ')}`);
    const ffmpegProcess = spawn('ffmpeg', ffmpegArgs);

    let ffmpegStderr = '';

    ffmpegProcess.stdout.on('data', data => {
      logger(`FFmpeg stdout: ${data.toString().trim()}`);
    });

    ffmpegProcess.stderr.on('data', data => {
      const msg = data.toString().trim();
      ffmpegStderr += msg + '\n';
    });

    ffmpegProcess.on('error', err => {
      logger(`❌ FFmpeg process error: ${err.message}`);
      reject(err);
    });

    ffmpegProcess.on('close', async code => {
      if (code === 0) {
        try {
          const stats = await fs.stat(outputFile);
          const sizeMB = (stats.size / (1024 * 1024)).toFixed(2);
          logger(`✅ Audio created successfully: ${outputFile} (${sizeMB}MB)`);
          resolve(outputFile);
        } catch (err) {
          reject(err);
        }
      } else {
        const errMsg = `FFmpeg exited with code ${code}\nStderr: ${ffmpegStderr}`;
        logger(`❌ ${errMsg}`);
        reject(new Error(errMsg));
      }
    });
  });
}




async stopRecording(withAudio = true) {
 
    if (!this.activeRecording) {
      // Check if there are any recordings in the map
      const allRecordings = Array.from(this.recordings.values());
      logger(`   - total recordings: ${allRecordings.length}`, allRecordings.length);
      const recentRecordings = allRecordings.filter(r => 
        r.roomId === this.roomId && 
        (r.status === 'recording' || r.status === 'paused' || r.status === 'stopping')
      );
      
      if (recentRecordings.length > 0) {
        logger(`⚠️ Found ${recentRecordings.length} recordings in map, using most recent`);
        this.activeRecording = recentRecordings[recentRecordings.length - 1];
        this.recordingId = this.activeRecording.id;
      } else {
        logger(`❌ No active recording found for room ${this.roomId}`);
        logger(`   Total recordings in map: ${allRecordings.length}`);
        
        if (allRecordings.length > 0) {
          const roomRecordings = allRecordings.filter(r => r.roomId === this.roomId);
          logger(`   Room recordings: ${roomRecordings.length}`);
          if (roomRecordings.length > 0) {
            logger(`   Last recording status: ${roomRecordings[roomRecordings.length - 1].status}`);
            // If there's a completed recording, just return it
            const lastRecording = roomRecordings[roomRecordings.length - 1];
            if (lastRecording.status === 'completed' || lastRecording.status === 'failed') {
              logger(`ℹ️ Returning last completed recording`);
              return lastRecording;
            }
          }
        }
        
        throw new Error('No active recording');
      }
    }

    logger(`🛑 Stopping recording in room ${this.roomId}: ${this.activeRecording.id}`);

    
    // If caller passed withAudio=false but we actually have audio files, force enable
    if (!withAudio && this.activeRecording.audioFiles.length > 0 && this.activeRecording.options.withAudio !== false) {
      logger(`⚠️ Override: enabling audio because ${this.activeRecording.audioFiles.length} chunks are present`);
      withAudio = true;

    }
    
    // Prevent duplicate stop requests
    if (this.activeRecording.status === 'stopping') {
      logger(`⚠️ Recording is already stopping, please wait...`);
      throw new Error('Recording is already being stopped');
    }
    
    if (this.activeRecording.status === 'completed') {
      logger(`ℹ️ Recording already completed`);
      return this.activeRecording;
    }
    
    this.activeRecording.status = 'stopping';

    try {
      
    const sortedFrameInfos = this.activeRecording.frameFiles.sort((a, b) => a.frameNumber - b.frameNumber);

     const validFrameInfos = [];
      for (const frameInfo of sortedFrameInfos) {
        const exists = await fs.pathExists(frameInfo.path);
        if (exists) {
          const stats = await fs.stat(frameInfo.path);
          if (stats.size > 0) {
            validFrameInfos.push(frameInfo);
          }
        }
      }

      if (validFrameInfos.length === 0) {
        throw new Error('No valid frame files found');
      }

      // Build video from frames
      const videoPath = await this.encodeFramesToVideo(this.activeRecording, validFrameInfos, true);
      logger(`✅ Video created: ${videoPath}`);

      // Try to build audio (may fail if all audio files were corrupted)
      let audioPath = null;
      try {
        audioPath = await this.concatWavToAac();
        logger(`✅ Audio created: ${audioPath}`);
      } catch (audioError) {
        logger(`⚠️ Audio processing failed: ${audioError.message}`);
        logger(`ℹ️ Continuing with video-only output`);
      }

      // Mux video and audio if both exist
      const roomStorage = path.resolve(this.storagePath, 'rooms', this.roomId);
      const finalPath = path.resolve(roomStorage, 'completed', this.activeRecording.filename);
      
      if (audioPath && await fs.pathExists(audioPath)) {
       
        await this.muxVideoAndAudio(videoPath, audioPath, finalPath);
        logger(`✅ Final video with audio: ${finalPath}`);
      } else {
        logger(`ℹ️ Using video-only output (no audio)`);
        // Move video from temp to completed
        await fs.move(videoPath, finalPath, { overwrite: true });
        logger(`✅ Moved video-only to: ${finalPath}`);
      }
      
      this.activeRecording.fileUrl = `/recordings/rooms/${this.roomId}/completed/${this.activeRecording.filename}`;

      await this.generateThumbnail(this.activeRecording);

      this.activeRecording.status = 'completed';
      this.activeRecording.completedAt = new Date();

      const completedRecording = { ...this.activeRecording };

      const duration = (this.activeRecording.completedAt - this.activeRecording.startedAt) / 1000;
      this.activeRecording.stats.duration = Math.round(duration);

      logger(`✅ Recording completed in room ${this.roomId}`);
      logger(`📊 Stats: ${validFrameInfos.length} frames, ${this.activeRecording.stats.audioChunksReceived} audio chunks, ${duration}s duration`);
      logger(`📁 File URL: ${this.activeRecording.fileUrl}`, completedRecording);
      return completedRecording;

    } catch (error) {
      logger('❌ Error stopping recording:', error);
     

      if (this.activeRecording) {
        this.activeRecording.status = 'failed';
        this.activeRecording.error = error.message;
      }

      throw error;
    }
  }



async encodeFramesToVideo(recording, frameInfos) {
  const toPosix = (p) => path.resolve(p).replace(/\\/g, '/');
  const roomStorage = path.resolve(this.storagePath, 'rooms', this.roomId);
  const outputPath = path.resolve(roomStorage, 'temp', recording.id, recording.filename);


  await fs.ensureDir(path.join(roomStorage, 'temp', recording.id));

  // Step 1: Only build video from images (no audio)
  return new Promise(async (resolve, reject) => {
    try {
      const allFramesListPath = await this.generateAllVideoFile(recording, frameInfos); 

      // Build video from frames (no audio)
      const ffmpegArgs = [
        '-f', 'concat', 
        '-safe', '0', 
        '-i', toPosix(allFramesListPath),
        '-vsync', 'vfr',
        '-c:v', 'libx264', 
       // '-r', String(recording.options.fps), // FPS from the recording options
        '-pix_fmt', 'yuv420p', 
        '-preset', 'veryfast', 
        '-crf', '23', 
        '-y', 
        outputPath
      ];

      // Spawn FFmpeg process
      const ffmpegProcess = spawn('ffmpeg', ffmpegArgs);

      ffmpegProcess.stdout.on('data', (data) => {
        process.stdout.write(`FFmpeg stdout: ${data}`);
      });

      ffmpegProcess.stderr.on('data', (data) => {
        process.stderr.write(`FFmpeg stderr: ${data}`);
      });

      ffmpegProcess.on('error', (err) => {
        logger('❌ Video encoding failed:', err.message);
        reject(err);
      });

      ffmpegProcess.on('close', async (code) => {
        if (code === 0) {
          logger('\n✅ Video encoding complete');
          recording.fileUrl = `/recordings/rooms/${this.roomId}/completed/${recording.filename}`;
          
          // Check file size once encoding is done
          try {
            const stats = await fs.stat(outputPath);
            const sizeMB = (stats.size / (1024 * 1024)).toFixed(2);
            logger(`📁 Output: ${sizeMB}MB at ${outputPath}`);
            resolve(outputPath);
          } catch (error) {
            reject(error);
          }
        } else {
          reject(new Error(`FFmpeg exited with code ${code}`));
        }
      });
      
    } catch (error) {
      logger('❌ Encoding setup error:', error);
      reject(error);
    }
  });
}

  async generateThumbnail(recording) {
    try {
      const roomStorage = path.resolve(this.storagePath, 'rooms', this.roomId);
      const videoPath = path.resolve(roomStorage, 'completed', recording.filename);
      
      if (!fs.existsSync(videoPath)) {
        return;
      }

      const thumbnailPath = path.resolve(roomStorage, 'thumbnails', `${recording.id}.jpg`);
      
      await new Promise((resolve, reject) => {
        ffmpeg(videoPath)
          .screenshots({
            timestamps: ['10%'],
            filename: `${recording.id}.jpg`,
            folder: path.resolve(roomStorage, 'thumbnails'),
            size: '320x180'
          })
          .on('end', () => {
            recording.thumbnailUrl = `/recordings/rooms/${this.roomId}/thumbnails/${recording.id}.jpg`;
            logger('✅ Thumbnail generated');
            resolve();
          })
          .on('error', reject);
      });
    } catch (error) {
      reject(`Could not generate thumbnail:`, error);
    }
  }

  async cleanupTempFiles(recording) {
    try {
      await fs.remove(recording.tempDir);
      logger(`🧹 Cleaned up temp files for ${recording.id}`);
    } catch (error) {
      logger(`Cleanup error:`, error);
      throw new Error('Could not cleanup temp files');
    }
  }

  getStatus() {
    if (!this.activeRecording) {
      for (const [id, recording] of this.recordings.entries()) {
        if (recording.roomId === this.roomId) {
          return this.formatRecordingStatus(recording);
        }
      }
      return null;
    }

    return this.formatRecordingStatus(this.activeRecording);
  }

  formatRecordingStatus(recording) {
    const now = Date.now();
    const startedAt = recording.startedAt.getTime();
    const duration = recording.completedAt 
      ? (recording.completedAt.getTime() - startedAt) / 1000
      : (now - startedAt) / 1000;

    return {
      id: recording.id,
      roomId: this.roomId,
      status: recording.status,
      duration: Math.round(duration),
      framesReceived: recording.stats.framesReceived,
      framesWritten: recording.stats.framesWritten,
      droppedFrames: recording.stats.droppedFrames,
      audioChunksReceived: recording.stats.audioChunksReceived,
      averageFPS: recording.stats.averageFPS,
      fileUrl: recording.fileUrl,
      thumbnailUrl: recording.thumbnailUrl,
      startedAt: recording.startedAt,
      completedAt: recording.completedAt,
      error: recording.error,
      withAudio: recording.options.withAudio
    };
  }

  async cleanup() {
    logger(`🧹 Cleaning up recording manager for room ${this.roomId}...`);
    
    if (this.activeRecording && 
        (this.activeRecording.status === 'recording' || 
         this.activeRecording.status === 'paused')) {
      try {
        await this.stopRecording(false);
      } catch (error) {
        logger(`Error stopping recording:`, error);
        throw error;
      }
    }
    
    logger(`✅ Cleanup completed for room ${this.roomId}`);
  }

  // Mux video.mp4 and audio.m4a into final.mp4
async  muxVideoAndAudio(videoPath, audioPath, outputPath) {

  await fs.ensureDir(path.dirname(outputPath));
  logger(`🎬 Muxing video and audio to: ${outputPath}`);
  console.log(videoPath, audioPath, 'both')
  return new Promise((resolve, reject) => {
    // Build the FFmpeg command arguments
    const ffmpegArgs = [
      '-i', videoPath,           // Input video
      '-i', audioPath,           // Input audio
      '-map', '0:v:0',           // Map video from input 0 (video file)
      '-map', '1:a:0',           // Map audio from input 1 (audio file)
      '-c', 'copy',              // Copy audio and video codecs (no re-encoding)
      '-shortest',               // Make output as short as the shortest input (audio/video)
      '-movflags', '+faststart',
      '-y',                      // Overwrite output file without asking
      outputPath                // Output path
    ];

    // Spawn the FFmpeg process
    const ffmpegProcess = spawn('ffmpeg', ffmpegArgs);

    // Handle stdout from FFmpeg
    ffmpegProcess.stdout.on('data', (data) => {
    
          logger(`FFmpeg stdout: ${data}`);
      
        // process.stdout.write(`FFmpeg stdout: ${data}`)
      
    });

    // Handle stderr from FFmpeg
    ffmpegProcess.stderr.on('data', (data) => {
      
          logger(`FFmpeg stderr: ${data}`);
      
        // process.stderr.write(`FFmpeg stderr: ${data}`);
      
    });

    // Handle process errors
    ffmpegProcess.on('error', (err) => {
      logger('❌ Muxing failed:', err.message);
      reject(err);
    });

    // Handle process completion
    ffmpegProcess.on('close', async (code) => {
      if (code === 0) {
        try {
          const stats = await fs.stat(outputPath);
          const sizeMB = (stats.size / (1024 * 1024)).toFixed(2);
           fs.rm(path.dirname(this.activeRecording.tempDir), { recursive: true }).catch(() => {});
          logger(`✅ Muxing complete: ${sizeMB}MB`);
          resolve();
        } catch (error) {
          reject(error);
        }
      } else {
        reject(new Error(`FFmpeg exited with code ${code}`));
      }
    });
  });
}



} 

module.exports = RecordingManager;