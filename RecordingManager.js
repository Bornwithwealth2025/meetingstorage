// RecordingManager.js - HIGH PERFORMANCE VERSION
// No Sharp per-frame, sequential queue processing, FFmpeg scales once
const fs = require('fs-extra');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const ffmpeg = require('fluent-ffmpeg');

const DEBUG = true;
const logger = (...args) => {
  if (!DEBUG) return;
   console.log(`[RecordingManager]`, ...args);
}

class RecordingManager {
  constructor(roomId, socketId, options = {}) {
    this.roomId = roomId;
    this.socketId = socketId;
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
        startTime: Date.now()
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
      console.error(`No recording found for ID: ${recordingId}`);
      throw new Error('No recording found');
    }

    if (!recording.options.withAudio) {
      return;
    }

    try {
      const audioFilename = `audio_${String(index).padStart(6, '0')}_${timestamp}.webm`;
      const audioPath = path.join(recording.audioDir, audioFilename);
      
      const buffer = Buffer.from(audioData, 'base64');
      await fs.writeFile(audioPath, buffer);
      
      recording.audioFiles.push({
        path: audioPath,
        timestamp,
        index
      });
      
      recording.stats.audioChunksReceived++;
      logger(`🎤 Audio chunk ${index} saved (${Math.round(buffer.length / 1024)}KB) - Total: ${recording.stats.audioChunksReceived}`);
    } catch (error) {
      console.error('Audio chunk save error:', error);
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
        timestamp: timestamp || Date.now(),
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
      console.error('Frame write error:', error.message);
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

  async stopRecording(withAudio = true) {
    logger(`🛑 Stop recording requested for room ${this.roomId}`);
    logger(`   - activeRecording: ${this.activeRecording ? this.activeRecording.id : 'null'}`);
    logger(`   - recordings in map: ${this.recordings.size}`);
    logger(`   - withAudio (requested): ${withAudio}`, this.activeRecording);
    //this.activeRecording.frameFiles [{path, timestamp, frameNumber,timestamp,size}]
    //this.activeRecording.audioFiles [{path, timestamp, index}]
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
        console.error(`❌ No active recording found for room ${this.roomId}`);
        console.error(`   Total recordings in map: ${allRecordings.length}`);
        
        if (allRecordings.length > 0) {
          const roomRecordings = allRecordings.filter(r => r.roomId === this.roomId);
          console.error(`   Room recordings: ${roomRecordings.length}`);
          if (roomRecordings.length > 0) {
            console.error(`   Last recording status: ${roomRecordings[roomRecordings.length - 1].status}`);
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
      await new Promise(resolve => setTimeout(resolve, 2000));
      
      const framesExist = await fs.pathExists(this.activeRecording.framesDir);
      if (!framesExist) {
        throw new Error('Frames directory does not exist');
      }

      const frameFiles = await fs.readdir(this.activeRecording.framesDir);
      const jpgFiles = frameFiles.filter(f => f.endsWith('.webp'));
      
      if (jpgFiles.length === 0) {
        throw new Error('No frames were written');
      }

      logger(`📁 Found ${jpgFiles.length} frame files`);
      logger(`🎤 Found ${this.activeRecording.audioFiles.length} audio chunks`);

      // FIXED: Use the stored frameFiles array which has timestamps
      const sortedFrameInfos = this.activeRecording.frameFiles.sort((a, b) => a.frameNumber - b.frameNumber);

      // Verify all frames exist
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

      if (validFrameInfos.length === 0) {9
        throw new Error('No valid frame files found');
      }

      logger(`✅ Valid frames: ${validFrameInfos.length} out of ${sortedFrameInfos.length}`);

      await this.encodeFramesToVideo(this.activeRecording, validFrameInfos, withAudio);
      
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
    const toPosix = (p) => path.resolve(p).replace(/\\/g, '/');
    const roomStorage = path.resolve(this.storagePath, 'rooms', this.roomId);
    const outputPath = path.resolve(roomStorage, 'completed', recording.filename);

    await fs.ensureDir(path.join(roomStorage, 'completed'));

    return new Promise(async(resolve, reject) => {
      try {
        // FIXED: Calculate FPS from actual recorded data
        let actualFPS = recording.options.fps;
        if (frameInfos.length > 1) {
          const firstFrameTime = frameInfos[0].timestamp;
          const lastFrameTime = frameInfos[frameInfos.length - 1].timestamp;
          const duration = (lastFrameTime - firstFrameTime) / 1000;
          
          if (duration > 0) {
            actualFPS = Math.min(Math.round(frameInfos.length / duration), 60);
            logger(`📊 Calculated actual FPS: ${actualFPS} (${frameInfos.length} frames over ${duration.toFixed(2)}s)`);
          }
        }
        
        const encodeFPS = actualFPS;
        const allFramesListPath = path.resolve(recording.tempDir, 'all_frames.txt');
        await fs.ensureDir(path.dirname(allFramesListPath));
        
        // FIXED: Build concat file with proper relative durations
        const lines = [];
        const firstTimestamp = frameInfos[0].timestamp;
        
        for (let i = 0; i < frameInfos.length; i++) {
          const curr = frameInfos[i];
          const next = frameInfos[i + 1];
          
          // FIXED: Calculate duration as difference between consecutive frames
          let durSec;
          if (next) {
            // Use actual time difference between frames
            durSec = Math.max((next.timestamp - curr.timestamp) / 1000, 1 / encodeFPS);
          } else {
            // Last frame: use average frame duration
            durSec = 1 / encodeFPS;
          }
          
          lines.push(`file '${toPosix(curr.path)}'`);
          lines.push(`duration ${durSec.toFixed(6)}`);
        }
        
        // FIXED: Properly terminate concat file (required by FFmpeg)
        if (frameInfos.length > 0) {
          lines.push(`file '${toPosix(frameInfos[frameInfos.length - 1].path)}'`);
        }
        
        fs.writeFileSync(allFramesListPath, lines.join('\n'));
        
        logger(`🎬 Concat list created with ${frameInfos.length} frames`);
        logger(`📝 First 3 lines:\n${lines.slice(0, 6).join('\n')}`);
        
        // FIXED: Pre-merge audio with proper timing
        let mergedAudioPath = null;
        let audioOffsetSec = 0;
        
        if (withAudio && recording.options.withAudio && recording.audioFiles.length > 0) {
          logger(`🎤 Processing ${recording.audioFiles.length} audio chunks...`);
          
          const sortedAudioFiles = recording.audioFiles.sort((a, b) => a.index - b.index);
          const concatListPath = path.resolve(recording.tempDir, 'audio-concat.txt');
          const audioLines = sortedAudioFiles.map(af => `file '${toPosix(af.path)}'`).join('\n');
          fs.writeFileSync(concatListPath, audioLines);
          
          logger(`📝 Audio concat file created with ${sortedAudioFiles.length} files`);
          
          mergedAudioPath = path.resolve(recording.tempDir, 'merged-audio.webm');
          
          try {
            await new Promise((resolveAudio, rejectAudio) => {
              ffmpeg()
                .input(toPosix(concatListPath))
                .inputOptions(['-f', 'concat', '-safe', '0'])
                .audioCodec('copy')
                .output(toPosix(mergedAudioPath))
                .outputOptions(['-y'])
                .on('start', (cmd) => {
                  logger(`🎤 Merging ${recording.audioFiles.length} audio chunks...`);
                  logger(`Command preview: ${cmd.substring(0, 150)}...`);
                })
                .on('end', () => {
                  logger('✅ Audio merged successfully');
                  resolveAudio();
                })
                .on('error', (err) => {
                  console.error('❌ Audio merge error:', err.message);
                  console.error('Full error:', err);
                  rejectAudio(err);
                })
                .run();
            });
            
            if (fs.existsSync(mergedAudioPath)) {
              const audioStats = fs.statSync(mergedAudioPath);
              logger(`🎤 Merged audio file size: ${Math.round(audioStats.size / 1024)}KB`);
              
              if (audioStats.size < 1024) {
                console.warn(`⚠️ Warning: Merged audio file is very small (${audioStats.size} bytes), may be empty`);
              }
              
              // FIXED: Calculate offset relative to first frame (in seconds, not milliseconds)
              const firstFrameTs = frameInfos[0].timestamp;
              const firstAudioTs = sortedAudioFiles[0].timestamp;
              audioOffsetSec = (firstAudioTs - firstFrameTs) / 1000;
              
              logger(`🎤 Audio offset: ${audioOffsetSec.toFixed(3)}s (${(audioOffsetSec * 1000).toFixed(0)}ms)`);
            } else {
              console.error('❌ Merged audio file does not exist after merge!');
              mergedAudioPath = null;
            }
          } catch (audioError) {
            console.error('❌ Audio merge error:', audioError);
            console.warn('⚠️ Continuing without audio');
            mergedAudioPath = null;
          }
        } else {
          console.warn(`⚠️ Skipping audio: withAudio=${withAudio}, hasAudioFiles=${recording.audioFiles.length > 0}`);
        }
        
        // Build FFmpeg command - scale ONCE during encode
        const command = ffmpeg()
          .input(toPosix(allFramesListPath))
          .inputOptions(['-f', 'concat', '-safe', '0']);
        
        // Add audio if available
        if (mergedAudioPath && fs.existsSync(mergedAudioPath)) {
          logger(`🎤 Adding audio track (offset: ${audioOffsetSec.toFixed(3)}s)...`);
          
          if (audioOffsetSec > 0.05) {
            command.input(toPosix(mergedAudioPath))
              .inputOptions(['-itsoffset', audioOffsetSec.toFixed(3)]);
          } else if (audioOffsetSec < -0.05) {
            command.input(toPosix(mergedAudioPath))
              .inputOptions(['-ss', (-audioOffsetSec).toFixed(3)]);
          } else {
            command.input(toPosix(mergedAudioPath));
          }
        }
        
        // Video encoding with SCALE filter (do scaling ONCE, not per-frame)
        command
          .videoCodec('libx264')
          .outputOptions([
            '-vf', `scale=${recording.options.width}:${recording.options.height}:force_original_aspect_ratio=decrease,pad=${recording.options.width}:${recording.options.height}:(ow-iw)/2:(oh-ih)/2`,
            '-preset', 'veryfast',
            '-crf', '23',
            '-pix_fmt', 'yuv420p',
            '-movflags', '+faststart',
            '-vsync', 'vfr'
          ])
          .size(`${recording.options.width}x${recording.options.height}`);
        
        // Add audio mapping if available
        if (mergedAudioPath && fs.existsSync(mergedAudioPath)) {
          command.outputOptions([
            '-map', '0:v:0',
            '-map', '1:a:0',
            '-c:a', 'aac',
            '-b:a', '128k',
            '-ar', '44100',
            '-ac', '2',
            '-shortest'
          ]);
        }
        
        command.outputOptions(['-y']);
        
        command
          .output(outputPath)
          .on('start', (cmd) => {
            logger(`🚀 FFmpeg started`);
            logger(`Command: ${cmd.substring(0, 200)}...`);
          })
          .on('progress', (progress) => {
            if (progress.percent) {
              process.stdout.write(`\r⏳ Encoding: ${Math.round(progress.percent)}%`);
            }
          })
          .on('end', () => {
            logger('\n✅ Video encoding complete');
            recording.fileUrl = `/recordings/rooms/${this.roomId}/completed/${recording.filename}`;
            
            fs.stat(outputPath, (err, stats) => {
              if (err) {
                console.error('❌ Output verification failed:', err);
                reject(err);
              } else {
                const sizeMB = (stats.size / (1024 * 1024)).toFixed(2);
                logger(`📁 Output: ${sizeMB}MB at ${outputPath}`);
                
                // Verify with ffprobe
                const ffprobe = require('fluent-ffmpeg');
                ffprobe.ffprobe(outputPath, (err, metadata) => {
                  if (!err && metadata && metadata.streams) {
                    const videoStream = metadata.streams.find(s => s.codec_type === 'video');
                    const audioStream = metadata.streams.find(s => s.codec_type === 'audio');
                    
                    if (videoStream) {
                      logger(`✅ Video: ${videoStream.width}x${videoStream.height}, ${videoStream.codec_name}, ${videoStream.nb_frames || 'unknown'} frames`);
                    }
                    if (audioStream) {
                      logger(`✅ Audio: ${audioStream.codec_name}, ${audioStream.sample_rate}Hz, ${audioStream.duration}s`);
                    } else if (withAudio && recording.options.withAudio) {
                      console.warn('⚠️ No audio track in output');
                    }
                  }
                  resolve();
                });
              }
            });
          })
          .on('error', (err) => {
            console.error('❌ FFmpeg error:', err.message);
            reject(err);
          })
          .run();
      } catch (error) {
        console.error('❌ Encoding setup error:', error);
        reject(error);
      }
    });
  }

  async generateThumbnail(recording) {
    try {
      const roomStorage = path.resolve(this.storagePath, 'rooms', this.roomId);
      const videoPath = path.resolve(roomStorage, 'completed', recording.filename);
      
      if (!fs.existsSync(videoPath)) {
        console.warn('Video file not found for thumbnail generation');
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
      console.warn(`Could not generate thumbnail:`, error);
    }
  }

  async cleanupTempFiles(recording) {
    try {
      await fs.remove(recording.tempDir);
      logger(`🧹 Cleaned up temp files for ${recording.id}`);
    } catch (error) {
      console.warn(`Cleanup error:`, error);
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
        console.error(`Error stopping recording:`, error);
      }
    }
    
    logger(`✅ Cleanup completed for room ${this.roomId}`);
  }
}

module.exports = RecordingManager;