// CRITICAL FIX: Single Frame Recording Issue
// ============================================
// 
// PROBLEM: Only 1 frame is recorded instead of a continuous video stream
// CAUSE: The requestAnimationFrame loop is stopping prematurely
//
// APPLY THIS FIX TO: MeetingUIRecorder.tsx in the startFrameCapture function

/* ============================================================================
   FIX #1: Ensure frame capture loop continues (CRITICAL)
   ============================================================================ */

// LOCATION: Inside startFrameCapture function
// FIND THIS CODE:
/*
const captureFrame = () => {
  if (!isRecordingRef.current || isPausedRef.current) {
    return;
  }
  
  // ... frame capture logic ...
  
  if (isRecordingRef.current && !isPausedRef.current) {
    animationFrameRef.current = requestAnimationFrame(captureFrame);
  }
};
*/

// REPLACE THE FINAL LINE WITH THIS:
/*
if (isRecordingRef.current) {
  // Continue the loop as long as recording is active
  // (pause state is checked at the top of the function)
  animationFrameRef.current = requestAnimationFrame(captureFrame);
}
*/

// EXPLANATION:
// The old code: "if (isRecordingRef.current && !isPausedRef.current)"
// Problem: When paused, it stops scheduling the next frame
// Result: After resuming, no new frames are captured because rAF never fires again
// 
// New code: "if (isRecordingRef.current)"
// Solution: Keep scheduling frames as long as recording is active
// Pause check is already done at the function start, so we don't double-check


/* ============================================================================
   FIX #2: Add frame capture diagnostics
   ============================================================================ */

// ADD THIS CODE after "captureFrame()" is first called in startFrameCapture:

/*
// Diagnostics: Monitor frame capture loop health
let frameCheckInterval: NodeJS.Timeout | null = null;
const startDiagnostics = () => {
  let lastFrameCount = frameNumberRef.current;
  let checksWithNoFrames = 0;
  
  frameCheckInterval = setInterval(() => {
    const currentFrameCount = frameNumberRef.current;
    
    if (currentFrameCount === lastFrameCount) {
      checksWithNoFrames++;
      if (checksWithNoFrames === 1) {
        addLog('⚠️ Frame capture may have stalled');
      }
      if (checksWithNoFrames >= 3) {
        addLog('❌ Frame capture has STOPPED - no new frames for 3 seconds');
        // Force restart frame capture
        const video = videoRef.current;
        const canvas = canvasRef.current;
        if (video && canvas && isRecordingRef.current && !isPausedRef.current) {
          const ctx = canvas.getContext('2d', { alpha: false });
          if (ctx) {
            addLog('🔄 Restarting frame capture...');
            startFrameCapture(video, canvas, ctx);
          }
        }
      }
    } else {
      checksWithNoFrames = 0;
      const fps = currentFrameCount - lastFrameCount;
      // Uncomment to see continuous FPS:
      // console.log(`Captured ${fps} frames in last 1s`);
    }
    
    lastFrameCount = currentFrameCount;
  }, 1000);
};

if (isRecordingRef.current) {
  startDiagnostics();
}

// Stop diagnostics when recording stops:
// Add to stopRecording():
if (frameCheckInterval) {
  clearInterval(frameCheckInterval);
  frameCheckInterval = null;
}
*/


/* ============================================================================
   FIX #3: Ensure audio recording starts BEFORE frame capture
   ============================================================================ */

// CURRENT CODE (has timing issue):
/*
try {
  await video.play();
  addLog('✅ Video playing');
  
  // START AUDIO FIRST
  if (hasAudio && stream) {
    const audioRecorder = startAudioRecording(stream, recId);
    ...
  }
  
  // THEN START VIDEO CAPTURE
  startFrameCapture(video, canvas, ctx);
}
*/

// This order is correct, but ensure audio is fully started before returning:
// ADD THIS after audio recording starts:
/*
if (hasAudio && stream) {
  const audioRecorder = startAudioRecording(stream, recId);
  if (audioRecorder && audioRecorder.state === 'recording') {
    addLog('✅ Audio stream synchronized with video');
  } else {
    addLog('⚠️ Audio recorder not in recording state');
  }
}
*/


/* ============================================================================
   FIX #4: Verify socket connection before sending frames
   ============================================================================ */

// IN: startFrameCapture function
// ADD THIS CHECK before pushing frames to queue:

/*
if (!socketRef.current?.connected) {
  addLog('⚠️ Socket not connected, frame dropped');
  setStats(prev => ({ 
    ...prev, 
    droppedFrames: prev.droppedFrames + 1 
  }));
  return;
}
*/


/* ============================================================================
   FIX #5: Monitor and debug audio chunks
   ============================================================================ */

// IN: startAudioRecording function
// MODIFY: mediaRecorder.ondataavailable

/*
mediaRecorder.ondataavailable = (event) => {
  if (event.data.size > 0) {
    audioChunksRef.current.push(event.data);
    addLog(`📦 Audio chunk received: ${Math.round(event.data.size / 1024)}KB`);
    
    if (recId && socketRef.current?.connected) {
      const reader = new FileReader();
      reader.onloadend = () => {
        const base64Data = (reader.result as string).split(',')[1];
        
        socketRef.current?.emit('audio-chunk', {
          roomId,
          recordingId: recId,
          audioData: base64Data,
          timestamp: Date.now(),
          index: audioIndexRef.current++
        }, (response: any) => {
          if (response?.success) {
            setStats(prev => ({
              ...prev,
              audioChunksSent: prev.audioChunksSent + 1
            }));
            addLog(`✅ Audio chunk #${audioIndexRef.current - 1} sent`);
          } else {
            addLog(`❌ Audio chunk #${audioIndexRef.current - 1} FAILED: ${response?.error}`);
          }
        });
      };
      reader.readAsDataURL(event.data);
    }
  }
};
*/


/* ============================================================================
   TESTING & VERIFICATION
   ============================================================================ */

/*
AFTER APPLYING FIXES:

1. Start recording:
   ✓ Watch console for continuous frame logs
   ✓ Verify "🎤 Audio recording started" appears
   ✓ Check browser Network tab - should see continuous 'ui-frame' events

2. Record for 10+ seconds

3. Stop recording

4. Check server logs:
   ✓ Should see "📁 Found XXX frame files" (XXX should be 300+)
   ✓ Should see "🎤 Found XX audio chunks" (XX should be 10+)

5. Run diagnostics:
   node diagnose-recording.js <roomId>
   
   Expected output:
   🎥 FRAMES: 300+ files
   🎤 AUDIO: 10+ chunks
   ✅ COMPLETED: 1 file (the .mp4)

6. Play the video:
   - Should have 10+ seconds of content
   - Should have audio if microphone was available
*/
