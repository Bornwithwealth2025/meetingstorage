// Improved MeetingUIRecorder diagnostics and fixes
// Add these console enhancements to track the issue

// PROBLEM ANALYSIS & FIXES FOR SINGLE FRAME RECORDING:
// ====================================================
rm -rf ui-rec*/*
/*
1. FRAME CAPTURE ISSUE - "Only One Frame Recorded"
   
   Problem: requestAnimationFrame stops after first iteration
   Root Cause: The captureFrame function's recursive call is inside 
               the condition "if (isRecordingRef.current && !isPausedRef.current)"
               
   Solution: Ensure the animation frame continues even if the queue is full
   
   CURRENT BUGGY CODE (in startFrameCapture):
   ```
   if (isRecordingRef.current && !isPausedRef.current) {
     animationFrameRef.current = requestAnimationFrame(captureFrame);
   }
   // Problem: If this condition is false once, it never reschedules!
   ```
   
   FIXED CODE:
   ```
   // Always keep the loop running while recording
   if (isRecordingRef.current) {
     animationFrameRef.current = requestAnimationFrame(captureFrame);
   } else {
     console.log('Recording stopped, frame capture ended');
   }
   ```

2. AUDIO CHUNKS NOT BEING SAVED
   
   Problem: Audio chunks are sent but may not be received/saved on server
   Solution: Add verification that audio chunks are actually written to disk
   
   Checklist:
   ✓ Browser console shows "Audio chunk #X" logs (frontend)
   ✓ Server console shows "🎤 Audio chunk #X received" (backend)
   ✓ Files exist in /temp/{recordingId}/audio/ directory
   ✓ Audio files are > 0 bytes

3. SOCKET.IO ACK CALLBACK ISSUES
   
   Problem: Socket.emit callbacks might not fire properly with large base64 data
   Solution: Add timeout and retry logic
*/

// DIAGNOSTIC CHECKS TO RUN:
// =========================

const DIAGNOSTIC_CHECKLIST = `
BEFORE STARTING RECORDING:
☐ Check browser console for "Initializing socket connection..."
☐ Verify "✅ Socket connected" appears
☐ Check microphone permission is granted in browser

WHILE RECORDING:
☐ Monitor "Captured frame size:" logs - should see continuous numbers
☐ Watch frame counter - should increment every ~16ms at 60fps
☐ Listen for "🎤 Found N audio track(s)" - should be >= 1
☐ Monitor socket.io network tab - frames should send continuously

AFTER STOPPING:
Run: node diagnose-recording.js <roomId>
☐ Check "Frames collected: X" - should be >= 30-60 for 1-2 second recording
☐ Check "Audio chunks collected: X" - should be >= 4-5 for 1-2 second recording
☐ Verify files exist in frames/ directory
☐ Verify files exist in audio/ directory

IF ONLY 1 FRAME:
1. Check if video.play() failed silently
   - Look for "⚠️ Autoplay blocked" in logs
   - Try clicking the video element to trigger playback

2. Check if requestAnimationFrame is stopping
   - Add this code after captureFrame is defined to debug:
   console.log('Frame capture starting...');
   let frameCheckInterval = setInterval(() => {
     if (!isRecordingRef.current) {
       clearInterval(frameCheckInterval);
       console.log('Recording ended');
     }
   }, 1000);

3. Check socket.io connection stability
   - Look for "Socket disconnected" in logs
   - Monitor Network tab for connection drops

IF NO AUDIO:
1. Check microphone was permitted
   - In browser DevTools → Privacy & Security → Microphone

2. Check AudioContext/MediaRecorder
   - "🎤 Audio recording started" should appear in logs
   - Audio chunks should send via socket.io

3. Check server received chunks
   - Server logs should show "🎤 Audio chunk #0 received: XXKb"
   - Audio files should exist in temp/{recordingId}/audio/

4. If no audio chunks on server but logs show they were sent:
   - Check MAX_QUEUE_SIZE in frontend (50 frames)
   - Check socket.io message size limits
   - Verify base64 encoding of audio data
`;

console.log(DIAGNOSTIC_CHECKLIST);

// PROPOSED FIXES FOR MeetingUIRecorder.tsx
// ==========================================

/*
FIX #1: Ensure frame capture loop continues
Location: startFrameCapture function

CHANGE THIS:
-----------
if (isRecordingRef.current && !isPausedRef.current) {
  animationFrameRef.current = requestAnimationFrame(captureFrame);
}

TO THIS:
--------
if (isRecordingRef.current) {
  // Continue loop as long as recording is active
  // (paused state is checked inside captureFrame)
  animationFrameRef.current = requestAnimationFrame(captureFrame);
} else {
  // Recording stopped, frame capture ends
  console.log('⏹️ Frame capture loop ended');
}
*/

/*
FIX #2: Improve frame queue monitoring
Add this at the end of startFrameCapture:

let frameCheckCount = 0;
const frameCheckInterval = setInterval(() => {
  if (!isRecordingRef.current) {
    clearInterval(frameCheckInterval);
    addLog(`Frame capture stopped after ${frameCheckCount} iterations`);
    return;
  }
  frameCheckCount++;
}, 500);
*/

/*
FIX #3: Debug socket.io frame sending
In processFrameQueue, add better error handling:

socketRef.current?.emit('ui-frame', {
  roomId,
  frameData: frame.data,
  timestamp: frame.timestamp,
  metadata: frame.metadata
}, (response: any) => {
  clearTimeout(timeout);
  console.log(`Frame sent: ${response?.success ? '✅' : '❌'}`, response?.framesWritten);
  resolve(response || { success: false, error: 'No response' });
});
*/

module.exports = { DIAGNOSTIC_CHECKLIST };
