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
      processingDelay: options.processingDelay || 10,
      maxConcurrent: options.maxConcurrent || 3,
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
 // 4. Improved processFrame method with verification:
// 4. Improved processFrame method with verification:
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

    // Process with sharp
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

    // Write file and verify
    await fs.writeFile(framePath, processedBuffer);
    
    // Verify file was written
    const exists = await fs.pathExists(framePath);
    if (!exists) {
      throw new Error(`Frame file was not written: ${framePath}`);
    }

    recording.frameFiles.push(framePath);
    recording.stats.framesWritten++;

    // Calculate FPS
    const elapsedTime = Date.now() - recording.stats.startTime;
    recording.stats.averageFPS = (recording.stats.framesWritten / (elapsedTime / 1000)).toFixed(2);
    recording.stats.lastFrameTime = timestamp || Date.now();

    // Log progress every 30 frames
    if (recording.stats.framesWritten % 30 === 0) {
      console.log(`📊 Progress: ${recording.stats.framesWritten} frames written, ${recording.stats.averageFPS} fps`);
    }

  } catch (error) {
    console.error('Frame processing error:', error.message);
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






  // 2. Replace the stopRecording method completely:
async stopRecording() {
  if (!this.activeRecording) {
    throw new Error('No active recording');
  }

  console.log(`🛑 Stopping recording in room ${this.roomId}: ${this.activeRecording.id}`);
  this.activeRecording.status = 'stopping';

  try {
    // CRITICAL: Wait for queue to completely finish
    console.log(`⏳ Waiting for frame queue to finish...`);
    console.log(`Queue stats: ${JSON.stringify(this.queue.getStats())}`);

    // Use the waitForCompletion method
    await this.queue.waitForCompletion();

    // Additional safety wait to ensure disk writes complete
    console.log('⏳ Waiting for disk writes to complete...');
    await new Promise(resolve => setTimeout(resolve, 3000));

    // Verify frames directory exists
    const framesExist = await fs.pathExists(this.activeRecording.framesDir);
    if (!framesExist) {
      throw new Error(`Frames directory does not exist: ${this.activeRecording.framesDir}`);
    }

    // Read actual frame files from disk
    const frameFiles = await fs.readdir(this.activeRecording.framesDir);
    const jpgFiles = frameFiles
      .filter(f => f.endsWith('.jpg'))
      .sort(); // Sort to ensure correct order

    console.log(`📁 Found ${jpgFiles.length} frame files in directory`);
    console.log(`First few frames: ${jpgFiles.slice(0, 5).join(', ')}`);

    if (jpgFiles.length === 0) {
      throw new Error('No frames were written to disk');
    }

    // Update recording with actual files
    this.activeRecording.frameFiles = jpgFiles.map(f => 
      path.join(this.activeRecording.framesDir, f)
    );
    this.activeRecording.stats.framesWritten = jpgFiles.length;

    console.log(`📊 Encoding ${jpgFiles.length} frames to video...`);

    // Encode video
    await this.encodeFramesToVideo(this.activeRecording);
    
    // Generate thumbnail
    await this.generateThumbnail(this.activeRecording);

    // Update status
    this.activeRecording.status = 'completed';
    this.activeRecording.completedAt = new Date();

    const completedRecording = { ...this.activeRecording };

    // Calculate duration
    const duration = (this.activeRecording.completedAt - this.activeRecording.startedAt) / 1000;
    this.activeRecording.stats.duration = Math.round(duration);

    // Cleanup temp files
    await this.cleanupTempFiles(this.activeRecording);

    // Reset active recording
    const oldId = this.activeRecording.id;
    this.activeRecording = null;
    this.recordingId = null;

    console.log(`✅ Recording completed in room ${this.roomId}: ${oldId}, Duration: ${duration}s`);
    return completedRecording;

  } catch (error) {
    console.error('❌ Error stopping recording:', error);
    console.error('Stack:', error.stack);

    if (this.activeRecording) {
      this.activeRecording.status = 'failed';
      this.activeRecording.error = error.message;
      this.recordings.set(this.activeRecording.id, { ...this.activeRecording });
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

 // 3. Replace the encodeFramesToVideo method:
async encodeFramesToVideo(recording) {
  const roomStorage = path.join(this.storagePath, 'rooms', this.roomId);
  const outputPath = path.join(roomStorage, 'completed', recording.filename);

  // Ensure output directory exists
  await fs.ensureDir(path.join(roomStorage, 'completed'));

  return new Promise((resolve, reject) => {
    try {
      // Verify all frame files exist
      console.log(`📝 Verifying ${recording.frameFiles.length} frame files...`);
      const missingFiles = [];
      for (const file of recording.frameFiles) {
        if (!fs.existsSync(file)) {
          missingFiles.push(file);
        }
      }
      
      if (missingFiles.length > 0) {
        throw new Error(`Missing ${missingFiles.length} frame files. First missing: ${missingFiles[0]}`);
      }

      // Create frame list file - CRITICAL FORMAT FIX
      const frameListPath = path.join(recording.tempDir, 'frames.txt');
      
      // Build frame list with LAST frame needing no duration
      const frameDuration = 1 / recording.options.fps;
      const frameListLines = [];
      
      for (let i = 0; i < recording.frameFiles.length; i++) {
        const file = recording.frameFiles[i];
        const absolutePath = path.resolve(file);
        const escapedPath = absolutePath.replace(/\\/g, '/').replace(/'/g, "'\\''");
        
        frameListLines.push(`file '${escapedPath}'`);
        
        // CRITICAL: Add duration for ALL frames except the last one
        if (i < recording.frameFiles.length - 1) {
          frameListLines.push(`duration ${frameDuration.toFixed(5)}`);
        }
      }
      
      const frameListContent = frameListLines.join('\n');

      // Write frame list
      fs.writeFileSync(frameListPath, frameListContent);
      console.log(`📝 Frame list written to: ${frameListPath}`);
      console.log(`📝 Total lines: ${frameListLines.length}`);
      console.log(`📝 First few lines:\n${frameListContent.split('\n').slice(0, 10).join('\n')}`);
      console.log(`📝 Last few lines:\n${frameListContent.split('\n').slice(-6).join('\n')}`);

      // Verify frame list exists
      if (!fs.existsSync(frameListPath)) {
        throw new Error('Frame list file was not created');
      }

      // Verify frame list content
      const frameListSize = fs.statSync(frameListPath).size;
      console.log(`📝 Frame list size: ${frameListSize} bytes`);

      const command = ffmpeg()
        .input(frameListPath)
        .inputOptions([
          '-f concat',
          '-safe 0'
        ])
        .videoCodec('libx264')
        .fps(recording.options.fps) // Set output FPS
        .outputOptions([
          '-preset ultrafast',
          `-crf ${recording.options.quality}`,
          '-pix_fmt yuv420p',
          '-movflags +faststart',
          '-y'
        ])
        .size(`${recording.options.width}x${recording.options.height}`)
        .output(outputPath);

      command
        .on('start', (commandLine) => {
          console.log(`🚀 FFmpeg command: ${commandLine}`);
        })
        .on('progress', (progress) => {
          if (progress.percent) {
            console.log(`⏳ Encoding progress: ${Math.round(progress.percent)}%`);
          }
        })
        .on('end', () => {
          console.log(`✅ FFmpeg encoding completed: ${recording.id}`);
          console.log(`✅ Video file: ${outputPath}`);
          
          // Verify output file exists
          if (fs.existsSync(outputPath)) {
            const stats = fs.statSync(outputPath);
            console.log(`✅ Video size: ${(stats.size / 1024 / 1024).toFixed(2)} MB`);
          }
          
          recording.fileUrl = `/recordings/rooms/${this.roomId}/completed/${recording.filename}`;
          resolve();
        })
        .on('error', (err, stdout, stderr) => {
          console.error(`❌ FFmpeg error for ${recording.id}:`, err.message);
          console.error(`FFmpeg stderr:`, stderr);
          console.error(`Frame list path: ${frameListPath}`);
          console.error(`Frame list exists: ${fs.existsSync(frameListPath)}`);
          
          // Print frame list content for debugging
          try {
            const content = fs.readFileSync(frameListPath, 'utf8');
            console.error(`Frame list content (first 500 chars):\n${content.substring(0, 500)}`);
          } catch (e) {
            console.error('Could not read frame list for debugging');
          }
          
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