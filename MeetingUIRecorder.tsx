// MeetingUIRecorder.tsx (Fixed version)
import { DoorClosed } from 'lucide-react';
import React, { useState, useEffect, useRef, useCallback } from 'react';
import io, { Socket } from 'socket.io-client';

interface Props {
  roomId: string;
  userId: string;
  serverUrl?: string;
  closeRecordWidget: ()=> void;
  recordWidgetOpen: boolean;
}

interface Stats {
  framesSent: number;
  droppedFrames: number;
  lastFrameSize: number;
  averageFPS: number;
  audioChunksSent: number;
}

interface FrameData {
  data: Blob;
  timestamp: number;
  metadata: {
    width: number;
    height: number;
    frameNumber: number;
  };
}

interface IResponseObject{
   success: boolean;
    recordingId?: string;
    error?: string;
    fileUrl?: string;
    thumbnailUrl?: string;

}

const MeetingUIRecorder: React.FC<Props> = ({ 
  roomId = 'demo-room', 
  userId = 'user-123', 
  serverUrl = 'http://localhost:4000',
  closeRecordWidget,
  recordWidgetOpen
}) => {
  const [isRecording, setIsRecording] = useState(false);
  const [isPaused, setIsPaused] = useState(false);
  const [recordingTime, setRecordingTime] = useState(0);
  const [recordingId, setRecordingId] = useState<string | null>(null);
  const [downloadUrl, setDownloadUrl] = useState<string | null>(null);
  const [stats, setStats] = useState<Stats>({ 
    framesSent: 0, 
    droppedFrames: 0,
    lastFrameSize: 0,
    averageFPS: 0,
    audioChunksSent: 0
  });
  const [isConnected, setIsConnected] = useState(false);
  const [debugLog, setDebugLog] = useState<string[]>([]);
  const [queueSize, setQueueSize] = useState(0);
  const [isProcessingVideo, setIsProcessingVideo] = useState(false);
  const [downloadError, setDownloadError] = useState(false);
  const [processingTimeout, setProcessingTimeout] = useState<NodeJS.Timeout | null>(null);
  const [processingFailed, setProcessingFailed] = useState(false);
  
  const socketRef = useRef<Socket | null>(null);
  const timerRef = useRef<NodeJS.Timeout | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const audioStreamRef = useRef<MediaStream | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const animationFrameRef = useRef<number | null>(null);
  const captureIntervalRef = useRef<NodeJS.Timeout | null>(null);
  const frameQueueRef = useRef<FrameData[]>([]);
  const audioChunksRef = useRef<Blob[]>([]);
  const isProcessingRef = useRef(false);
  const fpsCounterRef = useRef<number[]>([]);
  const isRecordingRef = useRef(false);
  const isPausedRef = useRef(false);
  const recordingIdRef = useRef<string | null>(null);
  const audioIndexRef = useRef(0);
  const lastFrameSentRef = useRef<number>(0);
  const frameNumberRef = useRef(0);
  const healthCheckRef = useRef<NodeJS.Timeout | null>(null);
  const statusPollRef = useRef<NodeJS.Timeout | null>(null);
  //  NEW: Shared recording start timestamp (monotonic)
  const recordingStartTimeRef = useRef<number>(0);

  const TARGET_FPS = 30; // Target 30 FPS
  const FRAME_INTERVAL = 1000 / TARGET_FPS;
  const MAX_QUEUE_SIZE = 300; // Increased to 10 seconds buffer at 30fps

  const addLog = useCallback((message: string) => {
    const timestamp = new Date().toLocaleTimeString();
    console.log(`[${timestamp}] ${message}`);
    setDebugLog(prev => [...prev.slice(-20), `[${timestamp}] ${message}`]);
  }, []);

  // Initialize socket
  useEffect(() => {
    addLog('Initializing socket connection...');
    
    const socket = io(serverUrl, { 
      transports: ['websocket', 'polling'], 
      reconnection: true,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 5000,
      reconnectionAttempts: 5
    });
    
    socketRef.current = socket;

    // Socket event handlers
    socket.on('connect', () => {
      addLog('✅ Socket connected');
      setIsConnected(true);
      socket.emit('join-recording-room', roomId);
    });

    socket.on('disconnect', () => {
      addLog('❌ Socket disconnected');
      setIsConnected(false);
    });

    socket.on('connect_error', (error) => {
      addLog(`⚠️ Connection error: ${error.message}`);
      setIsConnected(false);
    });

    socket.on('recording-started', (data: IResponseObject) => {
      addLog(`🎬 Recording started: ${data.recordingId}`);
    });

    socket.on('recording-paused', () => {
      addLog('⏸️ Recording paused (server)');
    });

    socket.on('recording-resumed', () => {
      addLog('▶️ Recording resumed (server)');
    });

    socket.on('recording-stopped', (data: IResponseObject) => {
      addLog('🛑 Recording stopped (server)');
      addLog(`📁 Recording URL: ${data.fileUrl}`);
      setIsRecording(false);
      setIsPaused(false);
      setRecordingId(null);
      setDownloadUrl(data.fileUrl);
      stopStreams();
    });

    socket.on('recording-error', (error: IResponseObject) => {
      addLog(`❌ Recording error: ${error.error}`);
    });

    return () => {
      socket.disconnect();
    };
  }, [roomId, serverUrl, addLog]);

  // Timer
  useEffect(() => {
    isRecordingRef.current = isRecording;
    isPausedRef.current = isPaused;
    
    if (isRecording && !isPaused) {
      timerRef.current = setInterval(() => {
        setRecordingTime(prev => prev + 1);
      }, 1000);
    } else {
      if (timerRef.current) {
        clearInterval(timerRef.current);
        timerRef.current = null;
      }
    }

    return () => {
      if (timerRef.current) {
        clearInterval(timerRef.current);
      }
    };
  }, [isRecording, isPaused]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      addLog('🧹 Component unmounting - cleaning up...');
      
      // Stop everything
      isRecordingRef.current = false;
      isPausedRef.current = false;
      
      // Cancel animation frame
      if (animationFrameRef.current) {
        cancelAnimationFrame(animationFrameRef.current);
      }
      
      // Clear all intervals
      if (timerRef.current) {
        clearInterval(timerRef.current);
      }
      if (healthCheckRef.current) {
        clearInterval(healthCheckRef.current);
      }
      if (statusPollRef.current) {
        clearInterval(statusPollRef.current);
      }
      if (captureIntervalRef.current) {
        clearInterval(captureIntervalRef.current);
        captureIntervalRef.current = null;
      }
      if (processingTimeout) {
        clearTimeout(processingTimeout);
      }
      
      // Stop media recorder
      if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
        try {
          mediaRecorderRef.current.stop();
        } catch (e) {
          // Ignore
        }
      }
      
      // Stop all tracks
      if (streamRef.current) {
        streamRef.current.getTracks().forEach(track => track.stop());
      }
      if (audioStreamRef.current) {
        audioStreamRef.current.getTracks().forEach(track => track.stop());
      }
    };
  }, []);






  /**
   * Request screen capture with audio
   */
  const requestScreenCapture = async () => {
    try {
      addLog('Requesting screen capture...');
      
      const displayMediaOptions: DisplayMediaStreamOptions = {
        video: {
          frameRate: { ideal: TARGET_FPS, max: TARGET_FPS },
          width: { ideal: 1280, max: 1280 },
          height: { ideal: 720, max: 720 },
         // cursor: 'always'
        } ,
        audio: true
      };

      const displayStream = await navigator.mediaDevices.getDisplayMedia(displayMediaOptions);
      
      const videoTrack = displayStream.getVideoTracks()[0];
      const audioTracks = displayStream.getAudioTracks();
      const settings = videoTrack.getSettings();
      
      addLog(`Screen captured: ${settings.width}x${settings.height}`);
     
      if (audioTracks.length > 0) {
        addLog(`Audio tracks: ${audioTracks.length}`);
      }

      videoTrack.onended = () => {
        addLog('Screen sharing ended by user');
        stopRecording();
      };

      // Combine streams - NO double capture
      const combinedStream = new MediaStream();
      combinedStream.addTrack(videoTrack);
      
      let hasAudio = false;
      let microphoneStream: MediaStream | null = null;
      


      // Try to get microphone first (better quality)
      try {
        microphoneStream = await navigator.mediaDevices.getUserMedia({
          audio: {
            echoCancellation: false,// alway make it false to avoid issues
            noiseSuppression: false,
            autoGainControl: false,
            //////////////////////
            sampleRate: 48000,
            sampleSize: 24,
            ///////////////
            channelCount: 2,
            
          },
          video: false
        });
        
        const micTrack = microphoneStream.getAudioTracks()[0];
        if (micTrack) {
          combinedStream.addTrack(micTrack);
          audioStreamRef.current = microphoneStream;
          addLog('✅ Microphone audio added');
          hasAudio = true;
        }
      } catch (micError: unknown) {
        if (micError instanceof Error) {
        addLog(`ℹ️ No microphone: ${micError.message}`);
        }
        
        // Fallback to screen audio if available
        if (audioTracks.length > 0) {
          combinedStream.addTrack(audioTracks[0]);
          addLog('✅ Screen audio added');
          hasAudio = true;
        }
      }
      
      if (!hasAudio) {
        addLog('⚠️ No audio sources available');
      }

      streamRef.current = combinedStream;

      return {
        success: true,
        stream: combinedStream,
        width: settings.width || 1280,
        height: settings.height || 720,
        frameRate: settings.frameRate || TARGET_FPS,
        hasAudio: microphoneStream !== null || audioTracks.length > 0
      };

    } catch (error: unknown) {
      if( error instanceof Error ){
          addLog(`Capture error: ${error.message}`);
         return { success: false, error: error.message }; 
      }

    }
  };


  /**
   * Start audio recording synchronized with video
   */
  const startAudioRecording = (stream: MediaStream, recId: string) => {
    try {
      // Use the audio tracks already in the combined stream
      const audioTracks = stream.getAudioTracks();
      
      if (audioTracks.length === 0) {
        addLog('⚠️ No audio tracks in stream');
        return null;
      }

      addLog(`🎤 Found ${audioTracks.length} audio track(s)`);
      
      // Create audio-only stream from the combined stream's audio
      const audioStream = new MediaStream();
      audioTracks.forEach(track => audioStream.addTrack(track));
      
      const options: MediaRecorderOptions = { 
        audioBitsPerSecond: 128000
      };

      if (MediaRecorder.isTypeSupported('audio/webm;codecs=opus')) {
        options.mimeType = 'audio/webm;codecs=opus';
      } else if (MediaRecorder.isTypeSupported('audio/webm')) {
        options.mimeType = 'audio/webm';
      }

      const mediaRecorder = new MediaRecorder(audioStream, options);
      mediaRecorderRef.current = mediaRecorder;
      audioChunksRef.current = [];

      mediaRecorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          audioChunksRef.current.push(event.data);

          if (recId && socketRef.current?.connected) {
            // Calculate precise timestamp relative to recording start
            const relativeTimestamp = performance.now() - recordingStartTimeRef.current;
            
            // Send audio chunk DIRECTLY as binary data
            event.data.arrayBuffer().then(arrayBuffer => {
              socketRef.current?.emit('audio-chunk', {
                roomId,
                recordingId: recId,
                audioData: arrayBuffer,
                timestamp: relativeTimestamp,
                index: audioIndexRef.current++
              }, (response: IResponseObject) => {
                if (response?.success) {
                  setStats(prev => ({
                    ...prev,
                    audioChunksSent: prev.audioChunksSent + 1
                  }));
                } else {
                  addLog(`⚠️ Audio chunk failed to send: ${response?.error}`);
                }
              });
            }).catch(err => {
              addLog(`❌ Error converting audio chunk: ${err.message}`);
            });
          }
        }
      };

      mediaRecorder.onerror = (event: Event) => {
        addLog(`❌ Audio recorder error: ${event}`);
      };

      mediaRecorder.onstop = () => {
        addLog('🎤 Audio recording stopped');
      };
     
      //CRITICAL: Smaller chunks (250ms) for better sync
      mediaRecorder.start(250); // 1 second chunks for better sync
      addLog('🎤 Audio recording started (synced with video)');
      return mediaRecorder;
    } catch (error: unknown) {
      if (error instanceof Error) {
        addLog(`❌ Audio recording error: ${error.message}`);
      }
      return null;
    }
  };


  /**
   * Start frame capture loop - FIXED VERSION
   */
  /**
 * Start frame capture loop - OPTIMIZED VERSION
 */
  const startFrameCapture = (
    video: HTMLVideoElement,
    canvas: HTMLCanvasElement,
    ctx: CanvasRenderingContext2D
  ) => {
    const captureFrame = () => {
      if (!isRecordingRef.current || isPausedRef.current) {
        return;
      }

      if (!socketRef.current?.connected || video.readyState < video.HAVE_CURRENT_DATA) {
        return;
      }

      try {
        const now = performance.now();
        const elapsed = now - lastFrameSentRef.current;

        if (elapsed < FRAME_INTERVAL) {
          return;
        }

        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

        canvas.toBlob(
          (blob) => {
            if (blob && recordingIdRef.current && isRecordingRef.current) {
              frameNumberRef.current++;
              const relativeTimestamp = now - recordingStartTimeRef.current;

              const frame: FrameData = {
                data: blob,
                timestamp: relativeTimestamp,
                metadata: {
                  width: canvas.width,
                  height: canvas.height,
                  frameNumber: frameNumberRef.current
                }
              };

              if (frameQueueRef.current.length >= MAX_QUEUE_SIZE) {
                const dropped = frameQueueRef.current.splice(0, 30);
                setStats(prev => ({ ...prev, droppedFrames: prev.droppedFrames + dropped.length }));
                addLog(`⚠️ Queue full! Dropped ${dropped.length} old frames`);
              }

              frameQueueRef.current.push(frame);
              setQueueSize(frameQueueRef.current.length);

              fpsCounterRef.current.push(now);
              if (fpsCounterRef.current.length > 30) {
                fpsCounterRef.current.shift();
              }

              if (fpsCounterRef.current.length > 1) {
                const firstTime = fpsCounterRef.current[0];
                const lastTime = fpsCounterRef.current[fpsCounterRef.current.length - 1];
                const duration = (lastTime - firstTime) / 1000;
                if (duration > 0) {
                  const currentFPS = (fpsCounterRef.current.length - 1) / duration;
                  setStats(prev => ({
                    ...prev,
                    framesSent: prev.framesSent + 1,
                    lastFrameSize: Math.round(blob.size / 1024),
                    averageFPS: Math.round(currentFPS * 10) / 10
                  }));
                }
              } else {
                setStats(prev => ({
                  ...prev,
                  framesSent: prev.framesSent + 1,
                  lastFrameSize: Math.round(blob.size / 1024)
                }));
              }

              processFrameQueue();
              lastFrameSentRef.current = now;
            }
          },
          'image/webp',
          0.70
        );
      } catch (error: unknown) {
        if (error instanceof Error) addLog(`Frame error: ${error.message}`);
      }
    };

    addLog('🎬 Starting frame capture loop');
    lastFrameSentRef.current = performance.now() - FRAME_INTERVAL;

    if (captureIntervalRef.current) {
      clearInterval(captureIntervalRef.current);
    }

    captureIntervalRef.current = setInterval(captureFrame, FRAME_INTERVAL);

    let lastFrameCount = 0;
    const healthCheck = setInterval(() => {
      if (!isRecordingRef.current) {
        clearInterval(healthCheck);
        return;
      }
      const currentCount = frameNumberRef.current;
      if (currentCount === lastFrameCount && !isPausedRef.current) {
        addLog(`⚠️ WARNING: No frames captured in last second! Count: ${currentCount}`);
        addLog(`  - isRecordingRef: ${isRecordingRef.current}`);
        addLog(`  - isPausedRef: ${isPausedRef.current}`);
        addLog(`  - video.readyState: ${video?.readyState}`);
        addLog(`  - socketConnected: ${socketRef.current?.connected}`);
      }
      lastFrameCount = currentCount;
    }, 1000);

    healthCheckRef.current = healthCheck;
  };




  // Process frame queue - OPTIMIZED for throughput with server ACK
  const processFrameQueue = useCallback(async () => {
    const currentRecId = recordingIdRef.current || recordingId;
    if (isProcessingRef.current || frameQueueRef.current.length === 0 || !currentRecId || !socketRef.current?.connected) {
      return;
    }

    isProcessingRef.current = true;

    try {
      // Send more frames per batch for better throughput
      const batchSize = Math.min(10, frameQueueRef.current.length);
      const framesToSend = frameQueueRef.current.splice(0, batchSize);
      
      // Update queue size immediately
      const newQueueSize = frameQueueRef.current.length;
      setQueueSize(newQueueSize);
      
      // Convert all frames to ArrayBuffer first
      const framesWithBuffers = await Promise.all(
        framesToSend.map(async (frame) => ({
          frame,
          arrayBuffer: await frame.data.arrayBuffer()
        }))
      );

      // Send frames and wait for server acknowledgment
      const sendPromises = framesWithBuffers.map(({ frame, arrayBuffer }) => {
        return new Promise<void>((resolve) => {
          try {
            socketRef.current?.emit('ui-frame', {
              roomId,
              recordingId: currentRecId,
              frameBlob: arrayBuffer,
              timestamp: frame.timestamp,
              metadata: frame.metadata
            }, (response: IResponseObject) => {
              if (!response?.success) {
                addLog(`⚠️ Frame ACK failed: ${response?.error}`);
              }
              resolve();
            });
          } catch (err: unknown) {
            if (err instanceof Error) addLog(`Frame emit error: ${err.message}`);
            resolve();
          }
        });
      });
      
      // Wait for all frames in batch to be acknowledged by server
      await Promise.all(sendPromises);
    } catch (error: unknown) {
      if (error instanceof Error) addLog(`Queue error: ${error.message}`);
    } finally {
      isProcessingRef.current = false;
      
      // Immediately process more frames if queue is not empty
      if (frameQueueRef.current.length > 0 && isRecordingRef.current) {
        // Reduce delay significantly - process as fast as possible
        setTimeout(processFrameQueue, 5);
      }
    }
  }, [recordingId, roomId, addLog]);





  const startRecording = async () => {
    if (!isConnected) {
      addLog('❌ Not connected to server');
      return;
    }

    try {
      addLog('Starting recording...');
      
      const captureResult = await requestScreenCapture();
      if (!captureResult.success) {
        throw new Error(captureResult.error);
      }

      const { stream, width, height, hasAudio } = captureResult;

      // Setup canvas
      const canvas = canvasRef.current || document.createElement('canvas');
      canvas.width = Math.min(width || 1280, 1280);
      canvas.height = Math.min(height || 720, 720);
      const ctx = canvas.getContext('2d', { alpha: false });
      
      if (!ctx) throw new Error('Failed to get canvas context');
      
      canvasRef.current = canvas;
      addLog(`Canvas: ${canvas.width}x${canvas.height}`);

      // Setup video element
      const video = videoRef.current;
      if (!video) {
        throw new Error('Video element not available');
      }

      video.srcObject = stream;
      video.muted = true; // MUST be muted for autoplay to work
      video.playsInline = true;
      video.autoplay = true;
      
      // Request recording from server
      socketRef.current?.emit('start-ui-recording', {
        roomId,
        userId,
        options: {
          fps: TARGET_FPS,
          width: canvas.width,
          height: canvas.height,
          quality: 23,
          withAudio: hasAudio
        }
      }, async (response:IResponseObject) => {
        if (response.success && response.recordingId) {
          const recId = response.recordingId;
          setRecordingId(recId);
          recordingIdRef.current = recId;

           // CRITICAL: Set shared recording start time FIRST
          recordingStartTimeRef.current = performance.now();
          addLog(`✅ Recording ID: ${recId}`);

          // Reset state first
          isRecordingRef.current = true;
          isPausedRef.current = false;
          setIsRecording(true);
          setIsPaused(false);
          setDownloadUrl(null);
          setRecordingTime(0);
          setStats({
            framesSent: 0,
            droppedFrames: 0,
            lastFrameSize: 0,
            averageFPS: 0,
            audioChunksSent: 0
          });
          setQueueSize(0); // Reset queue size
          frameQueueRef.current = [];
          frameNumberRef.current = 0;
          lastFrameSentRef.current = 0;
          audioIndexRef.current = 0;

          // Start audio recording FIRST (before video play)
          if (hasAudio && stream) {
            const audioRecorder = startAudioRecording(stream, recId);
            if (!audioRecorder) {
              addLog('⚠️ Failed to start audio recording');
            }
          } else {
            addLog('ℹ️ No audio track available in stream');
          }

          // Try to play video
          try {
            await video.play();
            addLog('✅ Video playing');
            addLog(`Video state: readyState=${video.readyState}, paused=${video.paused}`);
            
            // Start frame capture
            startFrameCapture(video, canvas, ctx);
            
          } catch (playError: unknown) {
            // Even if play() fails, start capture anyway - video might auto-play
            if (playError instanceof Error) {
              addLog(`⚠️ Video play() failed: ${playError.message}`);
            } else {
              addLog(`⚠️ Video play() failed: unknown error`);
            }
            addLog(`Starting capture anyway - video may auto-play`);
            
            // Start audio recording
            if (hasAudio && stream) {
              startAudioRecording(stream, recId);
            }
            
            // Start frame capture regardless - it will capture when video is ready
            startFrameCapture(video, canvas, ctx);
            
            // Also set up a retry mechanism
            let retries = 0;
            const retryPlay = setInterval(async () => {
              if (video.paused && retries < 5) {
                try {
                  await video.play();
                  addLog('✅ Video playing after retry');
                  clearInterval(retryPlay);
                } catch (e) {
                  retries++;
                }
              } else {
                clearInterval(retryPlay);
              }
            }, 500);
          }
        } else {
          addLog(`❌ Failed to start: ${response.error}`);
          stopStreams();
        }
      });

    } catch (error: unknown) {
      if (error instanceof Error) {
        addLog(`Start error: ${error.message}`);
      }
      stopStreams();
    }
  };




  const stopStreams = () => {
    addLog('Stopping streams...');
    
    // Stop all refs and flags first
    isRecordingRef.current = false;
    isPausedRef.current = false;
    isProcessingRef.current = false;
    
    // Cancel animation frame
    if (animationFrameRef.current) {
      cancelAnimationFrame(animationFrameRef.current);
      animationFrameRef.current = null;
    }
    if (captureIntervalRef.current) {
      clearInterval(captureIntervalRef.current);
      captureIntervalRef.current = null;
    }
    
    // Stop audio recording
    if (mediaRecorderRef.current) {
      try {
        if (mediaRecorderRef.current.state !== 'inactive') {
          mediaRecorderRef.current.stop();
          addLog('🎤 MediaRecorder stopped');
        }
      } catch (e) {
        // Ignore errors
      }
      mediaRecorderRef.current = null;
    }
    
    // Stop all tracks in main stream
    if (streamRef.current) {
      streamRef.current.getTracks().forEach(track => {
        track.stop();
        addLog(`Stopped track: ${track.kind}`);
      });
      streamRef.current = null;
    }
    
    // Stop audio stream tracks
    if (audioStreamRef.current) {
      audioStreamRef.current.getTracks().forEach(track => {
        track.stop();
        addLog(`Stopped audio track: ${track.kind}`);
      });
      audioStreamRef.current = null;
    }
    
    // Clear video element
    if (videoRef.current) {
      videoRef.current.srcObject = null;
      videoRef.current.pause();
    }
    
    // Clear health check interval
    if (healthCheckRef.current) {
      clearInterval(healthCheckRef.current);
      healthCheckRef.current = null;
    }
    
    // Clear status polling
    if (statusPollRef.current) {
      clearInterval(statusPollRef.current);
      statusPollRef.current = null;
    }
    
    // Clear processing timeout
    if (processingTimeout) {
      clearTimeout(processingTimeout);
      setProcessingTimeout(null);
    }
    
    // Clear all queues and counters
    frameQueueRef.current = [];
    audioChunksRef.current = [];
    fpsCounterRef.current = [];
    setQueueSize(0);
    
    // Reset refs
    recordingIdRef.current = null;
    frameNumberRef.current = 0;
    audioIndexRef.current = 0;
    lastFrameSentRef.current = 0;
    recordingStartTimeRef.current = 0; // Reset
  };

  const pauseRecording = () => {
    if (isRecording && !isPaused && recordingId) {
      socketRef.current?.emit('pause-recording', { 
        roomId 
      }, (response: IResponseObject) => {
        if (response?.success) {
          isPausedRef.current = true;
          setIsPaused(true);
          
          if (mediaRecorderRef.current && mediaRecorderRef.current.state === 'recording') {
            mediaRecorderRef.current.pause();
          }
          
          addLog('⏸️ Recording paused');
        } else {
          addLog('❌ Failed to pause');
        }
      });
    }
  };

  const resumeRecording = () => {
    if (isRecording && isPaused && recordingId) {
      socketRef.current?.emit('resume-recording', { 
        roomId 
      }, (response: IResponseObject) => {
        if (response?.success) {
          isPausedRef.current = false;
          setIsPaused(false);
          
          if (mediaRecorderRef.current && mediaRecorderRef.current.state === 'paused') {
            mediaRecorderRef.current.resume();
          }
          
          addLog('▶️ Recording resumed');
          
          // Frame capture loop will continue automatically because
          // the captureFrame function checks isPausedRef.current
        } else {
          addLog('❌ Failed to resume');
        }
      });
    }
  };

  const stopRecording = async () => {
    if (!isRecording || !(recordingIdRef.current || recordingId)) return;
  
  addLog('🛑 Stopping recording...');
  setIsProcessingVideo(true);
  setDownloadError(false);
  
  // Set timeout to stop processing indicator after 2 minutes
  const timeout = setTimeout(() => {
    addLog('⚠️ Processing timeout - video may still be encoding');
    setIsProcessingVideo(false);
    setProcessingFailed(true);
  }, 120000);
  
  setProcessingTimeout(timeout);
  
  // IMMEDIATELY stop all capturing, timers, and refs
  isRecordingRef.current = false;
  isPausedRef.current = false;
  setIsRecording(false);
  setIsPaused(false);
  
  // Cancel frame capture loop
  if (animationFrameRef.current) {
    cancelAnimationFrame(animationFrameRef.current);
    animationFrameRef.current = null;
  }
  if (captureIntervalRef.current) {
    clearInterval(captureIntervalRef.current);
    captureIntervalRef.current = null;
  }
  
  // Stop audio recording IMMEDIATELY
  if (mediaRecorderRef.current) {
    try {
      if (mediaRecorderRef.current.state !== 'inactive') {
        mediaRecorderRef.current.stop();
        addLog('🎤 Audio recording stopped');
      }
    } catch (e) {
      addLog('⚠️ Audio already stopped');
    }
  }
  
  // Clear health check interval
  if (healthCheckRef.current) {
    clearInterval(healthCheckRef.current);
    healthCheckRef.current = null;
  }
    
    // Send remaining frames
    const remainingFrames = frameQueueRef.current.length;
    if (remainingFrames > 0) {
      addLog(`📤 Sending ${remainingFrames} remaining frames...`);
      
      while (frameQueueRef.current.length > 0 && socketRef.current?.connected) {
        await processFrameQueue();
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      
      addLog(`✅ Queued frames sent`);
    }
    
    // Wait for processing
    let attempts = 0;
    while (isProcessingRef.current && attempts < 10) {
      addLog(`⏳ Waiting for frame processing... (${attempts + 1}/10)`);
      await new Promise(resolve => setTimeout(resolve, 500));
      attempts++;
    }
    
    // Additional safety delay
    await new Promise(resolve => setTimeout(resolve, 2000));
    
    // Send stop command
    socketRef.current?.emit('stop-recording', { 
      roomId,
      withAudio: true
    }, (response: IResponseObject) => {
      // Clear timeout
      if (processingTimeout) {
        clearTimeout(processingTimeout);
        setProcessingTimeout(null);
      }
      
      setIsProcessingVideo(false); // Hide processing indicator
      
      addLog(`Stop response: ${JSON.stringify(response)}`);
      
      if (response?.success) {
        addLog('✅ Recording stopped successfully');
        
        // Handle fileUrl from response or nested in recording object
        const fileUrl = response.fileUrl
        
        if (fileUrl) {
          addLog(`📁 Download URL: ${fileUrl}`);
          setDownloadUrl(fileUrl);
          setDownloadError(false);
          setProcessingFailed(false);
        } else {
          addLog('⚠️ No fileUrl in response, polling...');
          startStatusPolling();
        }
        
        setIsPaused(false);
        setRecordingId(null);
        stopStreams();
      } else {
        addLog(`❌ Failed to stop: ${response?.error || 'Unknown error'}`);
        setIsPaused(false);
        setDownloadError(true);
        setProcessingFailed(true);
        // Fallback: poll server for recording status and set downloadUrl if available
        startStatusPolling();
      }
    });
  };

  const startStatusPolling = () => {
    if (statusPollRef.current) return;
    addLog('🔎 Polling recording status for fileUrl...');
    const poll = async () => {
      try {
        const res = await fetch(`${serverUrl}/api/v1/rooms/${encodeURIComponent(roomId)}/recording/status`);
        if (res.ok) {
          const status = await res.json();
          if (status && status.fileUrl) {
            addLog(`✅ Found fileUrl via status: ${status.fileUrl}`);
            setDownloadUrl(status.fileUrl);
            setProcessingFailed(false);
            setIsProcessingVideo(false);
            if (statusPollRef.current) {
              clearInterval(statusPollRef.current);
              statusPollRef.current = null;
            }
          }
        }
      } catch (e: unknown) {
        if (e instanceof Error) {
          addLog(`ℹ️ Status poll error: ${e.message}`);
        }
      }
    };
    statusPollRef.current = setInterval(poll, 2000);
    poll();
  };

  const downloadRecording = () => {
    if (downloadUrl) {
      const fullUrl = `${serverUrl}${downloadUrl}`;
      addLog(`Downloading: ${fullUrl}`);
      
      // Try to download
      try {
        window.open(fullUrl, '_blank');
        setDownloadError(false);
      } catch (error: unknown) {
        if (error instanceof Error) {
          addLog(`❌ Download failed: ${error.message}`);
        }
        setDownloadError(true);
      }
    } else {
      addLog('No recording available');
      setDownloadError(true);
    }
  };

  const retryDownload = () => {
    addLog('🔄 Retrying download...');
    setDownloadError(false);
    downloadRecording();
  };

  const retryStop = () => {
    addLog('🔄 Retrying stop recording...');
    setProcessingFailed(false);
    setIsProcessingVideo(true);
    stopRecording();
  };

  const formatTime = (seconds: number): string => {
    const hrs = Math.floor(seconds / 3600);
    const mins = Math.floor((seconds % 3600) / 60);
    const secs = seconds % 60;
    return `${hrs.toString().padStart(2, '0')}:${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  };

  return (
    <div className={`absolute bg-gray-900 text-gray-100 p-6 top-0 ${recordWidgetOpen ? '' : 'hidden'}`}>
     
      <div className="max-w-6xl mx-auto">
        {/* Header */}
        <div className="bg-gray-800 rounded-lg p-6 mb-6">
          <h1 className="text-3xl font-bold mb-4">🎥 Meeting Recorder</h1>
          <div className="flex flex-wrap gap-4">
              <button type='button' className='bg-red-500 flex p-2 gap-2 items-center' onClick={closeRecordWidget}
            ><DoorClosed /> close Record widget
            </button>
            <span className="px-3 py-1 bg-blue-600 rounded">Room: {roomId}</span>
            <span className="px-3 py-1 bg-purple-600 rounded">User: {userId}</span>
            <span className={`px-3 py-1 rounded ${isConnected ? 'bg-green-600' : 'bg-red-600'}`}>
              {isConnected ? '🟢 Connected' : '🔴 Disconnected'}
            </span>
            <span className={`px-3 py-1 rounded ${isRecording ? 'bg-green-600' : 'bg-gray-600'}`}>
              {isRecording ? (isPaused ? '⏸️ Paused' : '🔴 Recording') : '⚪ Idle'}
            </span>
            <span className="px-3 py-1 bg-gray-700 rounded">FPS: {TARGET_FPS}</span>
          </div>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {/* Left side - Video and Controls */}
          <div>
            {/* Video Preview */}
            <div className="bg-gray-800 rounded-lg p-4 mb-6 hidden">
              <h2 className="text-xl font-bold mb-4">Preview</h2>
              <video 
                ref={videoRef} 
                className="w-full bg-black rounded"
                muted 
                playsInline 
                controls
                autoPlay
              />
            </div>

            {/* Stats */}
             <div className="flex md:flex-row flex-wrap gap-4 mb-6">
              <div className="bg-gray-800 flex-1 rounded-lg p-4">
                <div className="text-gray-400 text-sm">Duration</div>
                <div className="text-xl font-bold">{formatTime(recordingTime)}</div>
              </div>
              <div className="bg-gray-800  flex-1  rounded-lg p-4">
                <div className="text-gray-400 text-sm">FPS</div>
                <div className="text-xl font-bold">{stats.averageFPS.toFixed(1)}</div>
              </div>
              <div className="bg-gray-800 flex-1  rounded-lg p-4">
                <div className="text-gray-400 text-sm">Frames</div>
                <div className="text-xl font-bold">{stats.framesSent}</div>
              </div>
              <div className="bg-gray-800 flex-1  rounded-lg p-4">
                <div className="text-gray-400 text-sm">Dropped</div>
                <div className="text-xl font-bold text-yellow-400">{stats.droppedFrames}</div>
              </div>
              <div className="bg-gray-800 flex-1  rounded-lg p-4">
                <div className="text-gray-400 text-sm">Audio</div>
                <div className="text-xl font-bold text-green-400">{stats.audioChunksSent}</div>
              </div>
            </div>

            {/* Controls */}
            <div className="bg-gray-800 rounded-lg p-6">
              {isProcessingVideo && (
                <div className="mb-4 p-4 bg-blue-900 border border-blue-500 rounded-lg text-center">
                  <div className="flex items-center justify-center gap-3">
                    <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-white"></div>
                    <span className="text-lg font-semibold">🎬 Processing video... Please wait</span>
                  </div>
                </div>
              )}
              
              {processingFailed && (
                <div className="mb-4 p-4 bg-red-900 border border-red-500 rounded-lg text-center">
                  <div className="flex flex-col gap-2">
                    <span className="text-lg font-semibold">⚠️ Video processing took too long</span>
                    <button
                      onClick={retryStop}
                      className="px-6 py-2 bg-orange-600 hover:bg-orange-700 rounded-lg font-bold transition-colors"
                    >
                      🔄 Retry Stop & Process
                    </button>
                  </div>
                </div>
              )}
              
              <div className="flex flex-wrap justify-center gap-4">
                {!isRecording ? (
                  <button
                    onClick={startRecording}
                    disabled={!isConnected || isProcessingVideo}
                    className="px-6 py-3 bg-green-600 hover:bg-green-700 disabled:bg-gray-700 rounded-lg font-bold transition-colors"
                  >
                    🎬 Start Recording
                  </button>
                ) : (
                  <>
                    {!isPaused ? (
                      <button
                        onClick={pauseRecording}
                        disabled={isProcessingVideo}
                        className="px-6 py-3 bg-yellow-600 hover:bg-yellow-700 disabled:bg-gray-700 rounded-lg font-bold transition-colors"
                      >
                        ⏸️ Pause
                      </button>
                    ) : (
                      <button
                        onClick={resumeRecording}
                        disabled={isProcessingVideo}
                        className="px-6 py-3 bg-green-600 hover:bg-green-700 disabled:bg-gray-700 rounded-lg font-bold transition-colors"
                      >
                        ▶️ Resume
                      </button>
                    )}
                    
                    <button
                      onClick={stopRecording}
                      disabled={isProcessingVideo || processingFailed}
                      className="px-6 py-3 bg-red-600 hover:bg-red-700 disabled:bg-gray-700 rounded-lg font-bold transition-colors"
                    >
                      ⏹️ Stop
                    </button>
                  </>
                )}

                {downloadUrl && (
                  <>
                    <button
                      onClick={downloadRecording}
                      className="px-6 py-3 bg-blue-600 hover:bg-blue-700 rounded-lg font-bold transition-colors"
                    >
                      📥 Download
                    </button>
                    
                    {downloadError && (
                      <button
                        onClick={retryDownload}
                        className="px-6 py-3 bg-orange-600 hover:bg-orange-700 rounded-lg font-bold transition-colors"
                      >
                        🔄 Retry Download
                      </button>
                    )}
                  </>
                )}
              </div>
            </div>
          </div>

          {/* Right side - Debug Log */}
          <div className="bg-gray-800 rounded-lg p-4">
            <div className="flex justify-between items-center mb-4">
              <h2 className="text-xl font-bold">Debug Log</h2>
              <div className="flex gap-2">
                <button 
                  onClick={() => setDebugLog([])}
                  className="px-3 py-1 bg-gray-700 hover:bg-gray-600 rounded text-sm"
                >
                  Clear
                </button>
                <span className="px-3 py-1 bg-gray-700 rounded text-sm">
                  Queue: {queueSize}
                </span>
              </div>
            </div>
            <div className="bg-gray-900 rounded p-4 h-[600px] overflow-y-auto font-mono text-sm">
              {debugLog.length === 0 ? (
                <div className="text-gray-500 italic">No logs yet...</div>
              ) : (
                debugLog.map((log, i) => (
                  <div 
                    key={i} 
                    className={`mb-1 ${log.includes('✅') ? 'text-green-400' : log.includes('❌') || log.includes('error') ? 'text-red-400' : log.includes('⚠️') ? 'text-yellow-400' : log.includes('📊') ? 'text-blue-400' : 'text-gray-300'}`}
                  >
                    {log}
                  </div>
                ))
              )}
            </div>
          </div>


        </div>
      </div>
    </div>
  );
};

export default MeetingUIRecorder;