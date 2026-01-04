// RecordingManager.js (Fixed version)
const fs = require('fs-extra');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const ffmpeg = require('fluent-ffmpeg');
const sharp = require('sharp');

class RecordingManager {
  constructor(roomId, socketId, options = {}) {
    this.roomId = roomId;
    this.socketId = socketId;
    this.recordingId = null;
    this.recordings = new Map();
    this.activeRecording = null;
    this.isFFmpegAvailable = options.isFFmpegAvailable || false;
    this.storagePath = options.storagePath || './ui-recordings';
    
    this.frameCounter = 0;
    this.frameTimestamps = new Map(); // Store timestamps for each frame
    this.audioChunks = [];
    this.audioIndex = 0;
    
    this.initializeStorage();
  }

  getSocketId() {
    return this.socketId;
  }

  initializeStorage() {
    const roomStorage = path.join(this.storagePath, 'rooms', this.roomId);
    fs.ensureDirSync(path.join(roomStorage, 'temp'));
    fs.ensureDirSync(path.join(roomStorage, 'completed'));
    fs.ensureDirSync(path.join(roomStorage, 'thumbnails'));
    fs.ensureDirSync(path.join(roomStorage, 'audio'));
  }

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
      audioDir: path.join(roomStorage, 'temp', recordingId, 'audio'),
      options: {
        fps: options.fps || 10,
        width: options.width || 1280,
        height: options.height || 720,
        quality: options.quality || 23,
        captureSurface: options.captureSurface || 'unknown',
        withAudio: options.withAudio !== false
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
        startTime: Date.now()
      },
      frameFiles: [],
      frameTimestamps: [], // Store timestamps for proper encoding
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
    this.frameTimestamps.clear();
    
    console.log(`🎥 UI Recording started in room ${this.roomId}: ${recordingId}`);
    console.log(`📊 Target FPS: ${recording.options.fps}`);
    return recording;
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
      console.error(`Frame processing error in room ${this.roomId}:`, error.message);
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
        console.error('Frame processing error:', error.message);
      }
    }

    console.log(`📊 Processed ${processed} frames, failed: ${failed}`);
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
      const audioFilename = `audio_${index}_${timestamp}.webm`;
      const audioPath = path.join(recording.audioDir, audioFilename);
      
      const buffer = Buffer.from(audioData, 'base64');
      await fs.writeFile(audioPath, buffer);
      
      recording.audioFiles.push({
        path: audioPath,
        timestamp,
        index
      });
      
      recording.stats.audioChunksReceived++;
    } catch (error) {
      console.error('Audio chunk save error:', error);
    }
  }

  async processFrame(recording, frameData, timestamp, metadata) {
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
          quality: 75,
          mozjpeg: true
        })
        .toBuffer();

      const frameNumber = this.frameCounter++;
      const frameFilename = `frame_${frameNumber.toString().padStart(6, '0')}.jpg`;
      const framePath = path.join(recording.framesDir, frameFilename);

      await fs.writeFile(framePath, processedBuffer);
      
      // Store frame info with timestamp
      const frameInfo = {
        path: framePath,
        timestamp: timestamp || Date.now(),
        frameNumber
      };
      
      recording.frameFiles.push(frameInfo);
      recording.stats.framesWritten++;
      recording.stats.framesProcessed++;

      // Store first frame time
      if (recording.stats.framesWritten === 1) {
        recording.stats.firstFrameTime = frameInfo.timestamp;
      }
      
      recording.stats.lastFrameTime = frameInfo.timestamp;

      // Calculate FPS
      if (recording.stats.framesWritten > 1 && recording.stats.firstFrameTime) {
        const elapsedTime = (recording.stats.lastFrameTime - recording.stats.firstFrameTime) / 1000;
        if (elapsedTime > 0) {
          recording.stats.averageFPS = (recording.stats.framesWritten / elapsedTime).toFixed(2);
        }
      }

      // Log progress every 30 frames
      if (recording.stats.framesWritten % 30 === 0) {
        console.log(`📊 Room ${this.roomId}: ${recording.stats.framesWritten} frames written, FPS: ${recording.stats.averageFPS}`);
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

  async stopRecording(withAudio = true) {
    if (!this.activeRecording) {
      throw new Error('No active recording');
    }

    console.log(`🛑 Stopping recording in room ${this.roomId}: ${this.activeRecording.id}`);
    this.activeRecording.status = 'stopping';

    try {
      // Wait for any pending operations
      await new Promise(resolve => setTimeout(resolve, 2000));
      
      // Check frames directory
      const framesExist = await fs.pathExists(this.activeRecording.framesDir);
      if (!framesExist) {
        throw new Error('Frames directory does not exist');
      }

      // Get all frame files
      const frameFiles = await fs.readdir(this.activeRecording.framesDir);
      const jpgFiles = frameFiles.filter(f => f.endsWith('.jpg'));
      
      if (jpgFiles.length === 0) {
        throw new Error('No frames were written');
      }

      console.log(`📁 Found ${jpgFiles.length} frame files`);

      // Sort files numerically
      const sortedFiles = jpgFiles.sort((a, b) => {
        const numA = parseInt(a.match(/_(\d+)\.jpg/)[1]);
        const numB = parseInt(b.match(/_(\d+)\.jpg/)[1]);
        return numA - numB;
      });

      // Read frame files and ensure they exist
      const validFrameInfos = [];
      for (const filename of sortedFiles) {
        const framePath = path.join(this.activeRecording.framesDir, filename);
        const exists = await fs.pathExists(framePath);
        if (exists) {
          const stats = await fs.stat(framePath);
          if (stats.size > 0) {
            const frameMatch = filename.match(/_(\d+)\.jpg/);
            const frameNumber = frameMatch ? parseInt(frameMatch[1]) : 0;
            validFrameInfos.push({
              path: framePath,
              frameNumber
            });
          }
        }
      }

      if (validFrameInfos.length === 0) {
        throw new Error('No valid frame files found');
      }

      console.log(`✅ Valid frames: ${validFrameInfos.length}`);

      // Encode video with proper timing
      console.log(`📊 Encoding ${validFrameInfos.length} frames to video...`);
      await this.encodeFramesToVideo(this.activeRecording, validFrameInfos, withAudio);
      
      // Generate thumbnail
      await this.generateThumbnail(this.activeRecording);

      // Update status
      this.activeRecording.status = 'completed';
      this.activeRecording.completedAt = new Date();

      const completedRecording = { ...this.activeRecording };

      // Calculate duration
      const duration = (this.activeRecording.completedAt - this.activeRecording.startedAt) / 1000;
      this.activeRecording.stats.duration = Math.round(duration);

      console.log(`✅ Recording completed in room ${this.roomId}`);
      console.log(`📊 Stats: ${validFrameInfos.length} frames, ${duration}s duration`);
      
      return completedRecording;

    } catch (error) {
      console.error('❌ Error stopping recording:', error);
      console.error('Stack:', error.stack);

      if (this.activeRecording) {
        this.activeRecording.status = 'failed';
        this.activeRecording.error = error.message;
      }

      throw error;
    }
  }

  async encodeFramesToVideo(recording, frameInfos, withAudio = true) {
    const roomStorage = path.join(this.storagePath, 'rooms', this.roomId);
    const outputPath = path.join(roomStorage, 'completed', recording.filename);

    await fs.ensureDir(path.join(roomStorage, 'completed'));

    return new Promise((resolve, reject) => {
      try {
        // Method 1: Using glob pattern (most reliable for sequential frames)
        const framePattern = path.join(recording.framesDir, 'frame_%06d.jpg');
        
        console.log(`🎬 Starting encoding with pattern: ${framePattern}`);
        console.log(`📊 FPS: ${recording.options.fps}, Frames: ${frameInfos.length}`);
        
        const command = ffmpeg()
          .input(framePattern)
          .inputOptions([
            '-framerate', recording.options.fps.toString(),
            '-pattern_type', 'sequence'
          ])
          .videoCodec('libx264')
          .outputOptions([
            '-preset', 'ultrafast',
            '-crf', recording.options.quality.toString(),
            '-pix_fmt', 'yuv420p',
            '-r', recording.options.fps.toString(), // Output framerate
            '-movflags', '+faststart',
            '-y'
          ])
          .size(`${recording.options.width}x${recording.options.height}`);
        
        // Add audio if available
        if (withAudio && recording.options.withAudio && recording.audioFiles.length > 0) {
          const audioFile = recording.audioFiles[0]?.path;
          if (audioFile && fs.existsSync(audioFile)) {
            command.input(audioFile);
            command.outputOptions([
              '-c:a', 'aac',
              '-b:a', '128k',
              '-shortest' // Match video duration
            ]);
          }
        }
        
        command
          .output(outputPath)
          .on('start', (cmd) => {
            console.log(`🚀 FFmpeg started: ${cmd}`);
          })
          .on('progress', (progress) => {
            if (progress.percent) {
              console.log(`⏳ Encoding: ${Math.round(progress.percent)}%`);
            }
          })
          .on('end', () => {
            console.log('✅ Video encoding complete');
            recording.fileUrl = `/recordings/rooms/${this.roomId}/completed/${recording.filename}`;
            
            // Verify the output file
            fs.stat(outputPath, (err, stats) => {
              if (err) {
                console.error('❌ Output file verification failed:', err);
              } else {
                console.log(`📁 Output file: ${stats.size} bytes`);
              }
              resolve();
            });
          })
          .on('error', (err) => {
            console.error('❌ FFmpeg error:', err);
            
            // Fallback method: Try creating a file list
            if (err.message.includes('No such file or directory')) {
              console.log('🔄 Trying fallback encoding method...');
              this.fallbackEncode(recording, frameInfos, outputPath)
                .then(resolve)
                .catch(reject);
            } else {
              reject(err);
            }
          })
          .run();
      } catch (error) {
        console.error('❌ Encoding setup error:', error);
        reject(error);
      }
    });
  }

  async fallbackEncode(recording, frameInfos, outputPath) {
    return new Promise((resolve, reject) => {
      try {
        // Create a text file with all frame paths
        const frameListPath = path.join(recording.tempDir, 'frames.txt');
        const lines = frameInfos.map(frame => `file '${frame.path}'`);
        fs.writeFileSync(frameListPath, lines.join('\n'));
        
        console.log(`📝 Created frame list with ${frameInfos.length} frames`);
        
        ffmpeg()
          .input(frameListPath)
          .inputOptions(['-f', 'concat', '-safe', '0'])
          .inputFPS(recording.options.fps)
          .videoCodec('libx264')
          .outputOptions([
            '-preset', 'ultrafast',
            '-crf', recording.options.quality.toString(),
            '-pix_fmt', 'yuv420p',
            '-movflags', '+faststart',
            '-y'
          ])
          .size(`${recording.options.width}x${recording.options.height}`)
          .output(outputPath)
          .on('start', (cmd) => {
            console.log(`🔄 Fallback encoding: ${cmd}`);
          })
          .on('end', () => {
            console.log('✅ Fallback encoding complete');
            recording.fileUrl = `/recordings/rooms/${this.roomId}/completed/${recording.filename}`;
            resolve();
          })
          .on('error', reject)
          .run();
      } catch (error) {
        reject(error);
      }
    });
  }

  async generateThumbnail(recording) {
    try {
      const roomStorage = path.join(this.storagePath, 'rooms', this.roomId);
      const videoPath = path.join(roomStorage, 'completed', recording.filename);
      
      if (!fs.existsSync(videoPath)) {
        console.warn('Video file not found for thumbnail generation');
        return;
      }

      const thumbnailPath = path.join(roomStorage, 'thumbnails', `${recording.id}.jpg`);
      
      await new Promise((resolve, reject) => {
        ffmpeg(videoPath)
          .screenshots({
            timestamps: ['10%'],
            filename: `${recording.id}.jpg`,
            folder: path.join(roomStorage, 'thumbnails'),
            size: '320x180'
          })
          .on('end', () => {
            recording.thumbnailUrl = `/recordings/rooms/${this.roomId}/thumbnails/${recording.id}.jpg`;
            console.log('✅ Thumbnail generated');
            resolve();
          })
          .on('error', reject);
      });
    } catch (error) {
      console.warn(`Could not generate thumbnail:`, error);
    }
  }


async createThumbnailFromFrame(recording, thumbnailPath) {
  try {
    // Get first frame file
    const frameFiles = await fs.readdir(recording.framesDir);
    const jpgFiles = frameFiles.filter(f => f.endsWith('.jpg')).sort();
    
    if (jpgFiles.length === 0) {
      throw new Error('No frame files found');
    }

    const firstFrame = path.join(recording.framesDir, jpgFiles[0]);
    
    // Resize first frame to thumbnail size
    await sharp(firstFrame)
      .resize(320, 180, {
        fit: 'cover'
      })
      .jpeg({ quality: 80 })
      .toFile(thumbnailPath);
    
    console.log('✅ Thumbnail created from first frame');
  } catch (error) {
    console.error('Failed to create thumbnail from frame:', error.message);
    throw error;
  }
}


  async cleanupTempFiles(recording) {
    try {
      await fs.remove(recording.tempDir);
      console.log(`🧹 Cleaned up temp files for ${recording.id}`);
    } catch (error) {
      console.warn(`Cleanup error:`, error);
    }
  }

  getStatus() {
    if (!this.activeRecording) {
      // Check for any recording in this room
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
    console.log(`🧹 Cleaning up recording manager for room ${this.roomId}...`);
    
    if (this.activeRecording && 
        (this.activeRecording.status === 'recording' || 
         this.activeRecording.status === 'paused')) {
      try {
        await this.stopRecording(false);
      } catch (error) {
        console.error(`Error stopping recording:`, error);
      }
    }
    
    console.log(`✅ Cleanup completed for room ${this.roomId}`);
  }
}

module.exports = RecordingManager;