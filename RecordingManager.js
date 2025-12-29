// RecordingManager.js
const fs = require('fs-extra');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const ffmpeg = require('fluent-ffmpeg');
const sharp = require('sharp');
const ProcessingQueue = require('./ProcessingQueue')

console.log(ProcessingQueue)
class RecordingManager {
  constructor(roomId, socketId, options = {}) {
    this.roomId = roomId;
    this.socketId = socketId
    this.recordingId = null;
    this.recordings = new Map(); // Map<recordingId, recording>
    this.activeRecording = null;
    this.isFFmpegAvailable = options.isFFmpegAvailable || false;
    this.storagePath = options.storagePath || './ui-recordings';
    
    // Room-specific queue
    this.queue = new ProcessingQueue({
      processingDelay: options.processingDelay || 100,
      maxConcurrent: options.maxConcurrent || 1,
      onError: (error) => this.handleQueueError(error)
    });
    
    this.initializeStorage();
  }

  getSocketId(){
    return this.socketId
  }
  initializeStorage() {
    const roomStorage = path.join(this.storagePath, 'rooms', this.roomId);
    fs.ensureDirSync(path.join(roomStorage, 'temp'));
    fs.ensureDirSync(path.join(roomStorage, 'completed'));
    fs.ensureDirSync(path.join(roomStorage, 'thumbnails'));
  }

  /**
   * generate recording objetc data
   */

  async startUIRecording(userId, options = {}) {
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
      options: {
        fps: options.fps || 30,
        width: options.width || 1280,
        height: options.height || 720,
        quality: options.quality || 23,
        captureSurface: options.captureSurface || 'unknown'
      },
      stats: {
        framesReceived: 0,
        framesProcessed: 0,
        framesWritten: 0,
        lastFrameTime: null,
        droppedFrames: 0,
        errors: 0,
        averageFPS: 0,
        startTime: Date.now()
      },
      frameFiles: [],
      isProcessing: false
    };

    await fs.ensureDir(recording.tempDir);
    await fs.ensureDir(recording.framesDir);
    
    recording.status = 'recording';
    this.recordings.set(recordingId, recording);
    this.activeRecording = recording;
    this.recordingId = recordingId;
    
    console.log(`🎥 UI Recording started in room ${this.roomId}: ${recordingId}`);
    return recording;
  }

  /**
   * call the processFrame
   */
 async addUIFrame(frameData, timestamp, metadata = {}) {
  if (!this.activeRecording || this.activeRecording.status !== 'recording') {
    throw new Error('No active recording or recording not in recording state');
  }

  const recording = this.activeRecording;
  
  // Create a promise that resolves when the frame is processed
  return new Promise((resolve, reject) => {
    this.queue.add(async () => {
      try {
        await this.processFrame(recording, frameData, timestamp, metadata);
        resolve({ 
          success: true, 
          queued: true, 
          recordingId: recording.id,
          framesWritten: recording.stats.framesWritten
        });
      } catch (error) {
        console.error(`Frame processing error in room ${this.roomId}:`, error);
        recording.stats.errors++;
        reject(error);
      }
    });
  });
}


  /**
   * 1. get the frame string
   * 2. convert it to buffer
   * 3. pass the buffer to sharp
   * 4. sharp convert the buffer to jpg image and save it 
   */
  async processFrame(recording, frameData, timestamp, metadata) {
    recording.stats.framesReceived++;
    
    try {
      let buffer;
      if (typeof frameData === 'string') {
        const base64Data = frameData.replace(/^data:image\/\w+;base64,/, '');
        buffer = Buffer.from(base64Data, 'base64');
      } else if (Buffer.isBuffer(frameData)) {
        buffer = frameData;
      } else {
        throw new Error('Invalid frame data format');
      }

      const processedBuffer = await sharp(buffer)
        .resize(recording.options.width, recording.options.height, {
          fit: 'contain',
          background: { r: 0, g: 0, b: 0, alpha: 1 }
        })
        .jpeg({ 
          quality: 85, 
          mozjpeg: true,
          chromaSubsampling: '4:2:0'
        })
        .toBuffer();

      const frameNumber = recording.stats.framesProcessed++;
      const frameFilename = `frame_${frameNumber.toString().padStart(8, '0')}.jpg`;
      const framePath = path.join(recording.framesDir, frameFilename);
      
      await fs.writeFile(framePath, processedBuffer);
      recording.frameFiles.push(framePath);
      recording.stats.framesWritten++;

      // Calculate FPS
      const elapsedTime = Date.now() - recording.stats.startTime;
      recording.stats.averageFPS = (recording.stats.framesWritten / (elapsedTime / 1000)).toFixed(2);
      recording.stats.lastFrameTime = timestamp || Date.now();

      const expectedFrames = Math.floor(elapsedTime / 1000 * recording.options.fps);
      recording.stats.droppedFrames = Math.max(0, expectedFrames - recording.stats.framesWritten);

    } catch (error) {
      console.error('Frame processing error:', error);
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

    console.log(`⏸️ Recording paused in room ${this.roomId}`);
    return this.activeRecording;
  }

  async resumeRecording() {
    if (!this.activeRecording || this.activeRecording.status !== 'paused') {
      throw new Error('Cannot resume - no active recording or not paused');
    }

    this.activeRecording.status = 'recording';
    this.activeRecording.resumedAt = new Date();

    console.log(`▶️ Recording resumed in room ${this.roomId}`);
    return this.activeRecording;
  }

 async stopRecording() {
  if (!this.activeRecording) {
    throw new Error('No active recording');
  }

  console.log(`🛑 Stopping recording in room ${this.roomId}: ${this.activeRecording.id}`);
  this.activeRecording.status = 'stopping';

  try {
    // Wait for queue to finish processing all pending frames
    console.log(`⏳ Waiting for frame queue to finish... (${this.queue.getStats().queueLength} pending)`);
    
    let attempts = 0;
    const maxAttempts = 10; // 10 seconds max wait
    
    while (this.queue.getStats().queueLength > 0 && attempts < maxAttempts) {
      await new Promise(resolve => setTimeout(resolve, 1000));
      attempts++;
      console.log(`⏳ Waiting for frames... Attempt ${attempts}/${maxAttempts}`);
    }
    
    // Additional wait to ensure all frames are written to disk
    await new Promise(resolve => setTimeout(resolve, 2000));
    
    // Double-check if we have any frames written
    if (this.activeRecording.stats.framesWritten === 0) {
      // Try to read from the frames directory
      try {
        const files = await fs.readdir(this.activeRecording.framesDir);
        if (files.length > 0) {
          this.activeRecording.stats.framesWritten = files.length;
          this.activeRecording.frameFiles = files.map(f => 
            path.join(this.activeRecording.framesDir, f)
          );
          console.log(`📁 Found ${files.length} frame files in directory`);
        }
      } catch (dirError) {
        console.warn('Could not read frames directory:', dirError.message);
      }
    }
    
    if (this.activeRecording.stats.framesWritten === 0) {
      throw new Error('No frames recorded');
    }

    console.log(`📊 Encoding ${this.activeRecording.stats.framesWritten} frames to video...`);
    
    await this.encodeFramesToVideo(this.activeRecording);
    await this.generateThumbnail(this.activeRecording);

    this.activeRecording.status = 'completed';
    this.activeRecording.completedAt = new Date();

    const completedRecording = { ...this.activeRecording };
    
    // Calculate final duration
    const duration = (this.activeRecording.completedAt - this.activeRecording.startedAt) / 1000;
    this.activeRecording.stats.duration = Math.round(duration);
    
    // Cleanup
    await this.cleanupTempFiles(this.activeRecording);
    
    // Reset active recording
    const oldId = this.activeRecording.id;
    this.activeRecording = null;
    this.recordingId = null;

    console.log(`✅ Recording completed in room ${this.roomId}: ${oldId}, Duration: ${duration}s`);
    return completedRecording;

  } catch (error) {
    console.error('Error stopping recording:', error);
    
    if (this.activeRecording) {
      this.activeRecording.status = 'failed';
      this.activeRecording.error = error.message;
      
      // Save failed recording info
      this.recordings.set(this.activeRecording.id, { ...this.activeRecording });
      
      // Don't reset active recording on failure, allow retry
      console.log(`❌ Recording failed but kept in state for debugging: ${this.activeRecording.id}`);
    }
    
    throw error;
  }
}


async getFrameCount() {
  if (!this.activeRecording) {
    return 0;
  }
  
  try {
    const files = await fs.readdir(this.activeRecording.framesDir);
    const jpgFiles = files.filter(f => f.endsWith('.jpg'));
    return jpgFiles.length;
  } catch (error) {
    return 0;
  }
}
  /**
   * use ffmpeg to convert the the frmae to video 
   */

  async encodeFramesToVideo(recording) {
    const roomStorage = path.join(this.storagePath, 'rooms', this.roomId);
    const outputPath = path.join(roomStorage, 'completed', recording.filename);
    
    return new Promise((resolve, reject) => {
      try {
        const frameListPath = path.join(recording.tempDir, 'frames.txt');
        const frameListContent = recording.frameFiles
          .map(file => `file '${file.replace(/'/g, "'\\''")}'\nduration 0.03333`)
          .join('\n');
        
        fs.writeFileSync(frameListPath, frameListContent);

        const command = ffmpeg()
          .input(frameListPath)
          .inputOptions(['-f concat', '-safe 0'])
          .inputFPS(recording.options.fps)
          .videoCodec('libx264')
          .outputOptions([
            '-preset medium',
            `-crf ${recording.options.quality}`,
            '-pix_fmt yuv420p',
            '-movflags +faststart',
            '-g 60',
            '-bf 2',
            '-refs 3',
            '-y'
          ])
          .size(`${recording.options.width}x${recording.options.height}`)
          .output(outputPath);

        command
          .on('start', (commandLine) => {
            console.log(`🚀 FFmpeg encoding started for ${recording.id} in room ${this.roomId}`);
          })
          .on('end', () => {
            console.log(`✅ FFmpeg encoding completed: ${recording.id}`);
            recording.fileUrl = `/recordings/rooms/${this.roomId}/completed/${recording.filename}`;
            resolve();
          })
          .on('error', (err) => {
            console.error(`❌ FFmpeg error for ${recording.id}:`, err);
            reject(new Error(`FFmpeg encoding failed: ${err.message}`));
          })
          .run();

      } catch (error) {
        console.error('Encoding setup error:', error);
        reject(error);
      }
    });
  }

  async generateThumbnail(recording) {
    try {
      const roomStorage = path.join(this.storagePath, 'rooms', this.roomId);
      const videoPath = path.join(roomStorage, 'completed', recording.filename);
      const thumbnailPath = path.join(roomStorage, 'thumbnails', `${recording.id}.jpg`);
      
      await new Promise((resolve, reject) => {
        ffmpeg(videoPath)
          .screenshots({
            timestamps: ['50%'],
            filename: `${recording.id}.jpg`,
            folder: path.join(roomStorage, 'thumbnails'),
            size: '320x180'
          })
          .on('end', () => {
            recording.thumbnailUrl = `/recordings/rooms/${this.roomId}/thumbnails/${recording.id}.jpg`;
            resolve();
          })
          .on('error', reject);
      });
    } catch (error) {
      console.warn(`Could not generate thumbnail for ${recording.id}:`, error);
    }
  }

  async cleanupTempFiles(recording) {
    try {
      await fs.remove(recording.tempDir);
      console.log(`🧹 Cleaned up temp files for ${recording.id} in room ${this.roomId}`);
    } catch (error) {
      console.warn(`Could not cleanup temp files for ${recording.id}:`, error);
    }
  }

  getStatus() {
    if (!this.activeRecording) {
      return null;
    }

    const recording = this.activeRecording;
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
      averageFPS: recording.stats.averageFPS,
      fileUrl: recording.fileUrl,
      thumbnailUrl: recording.thumbnailUrl,
      startedAt: recording.startedAt,
      completedAt: recording.completedAt,
      error: recording.error,
      queueStats: this.queue.getStats()
    };
  }

  handleQueueError(error) {
    console.error(`Queue error in room ${this.roomId}:`, error);
  }

  async cleanup() {
    console.log(`🧹 Cleaning up recording manager for room ${this.roomId}...`);
    
    if (this.activeRecording && 
        (this.activeRecording.status === 'recording' || 
         this.activeRecording.status === 'paused')) {
      try {
        await this.stopRecording();
      } catch (error) {
        console.error(`Error stopping recording in room ${this.roomId}:`, error);
      }
    }
    
    this.queue.clear();
    console.log(`✅ Cleanup completed for room ${this.roomId}`);
  }
}

module.exports = RecordingManager;