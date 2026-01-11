#!/bin/bash
# Quick Diagnostic Script for Recording Issues
# Usage: bash check-recording.sh <roomId>

ROOM_ID=${1:-"ltqnDcMy29oT2bBnijOhApsl"}

echo "🔍 QUICK RECORDING DIAGNOSTIC"
echo "============================="
echo ""
echo "Room ID: $ROOM_ID"
echo ""

ROOM_PATH="./ui-recordings/rooms/$ROOM_ID"

if [ ! -d "$ROOM_PATH" ]; then
    echo "❌ Room path not found: $ROOM_PATH"
    exit 1
fi

echo "📁 Directory Structure:"
echo "─────────────────────"

# Count temp recordings
TEMP_COUNT=$(find "$ROOM_PATH/temp" -maxdepth 1 -type d -not -name "temp" 2>/dev/null | wc -l)
echo "Recordings in temp: $TEMP_COUNT"

# Get the most recent recording
LATEST_REC=$(ls -t "$ROOM_PATH/temp" 2>/dev/null | head -1)
if [ -z "$LATEST_REC" ]; then
    echo "❌ No recordings found in temp directory"
    exit 1
fi

echo "Latest recording: $LATEST_REC"
REC_PATH="$ROOM_PATH/temp/$LATEST_REC"

echo ""
echo "📊 FRAMES:"
echo "──────────"
FRAME_COUNT=$(ls -1 "$REC_PATH/frames"/*.jpg 2>/dev/null | wc -l)
echo "Total: $FRAME_COUNT frames"

if [ $FRAME_COUNT -gt 0 ]; then
    echo "First frame: $(ls -lh "$REC_PATH/frames" | head -2 | tail -1)"
    echo "Last frame: $(ls -lh "$REC_PATH/frames" | tail -1)"
else
    echo "❌ NO FRAMES FOUND - Check frontend frame capture"
fi

echo ""
echo "🎤 AUDIO:"
echo "─────────"
AUDIO_COUNT=$(ls -1 "$REC_PATH/audio"/*.webm 2>/dev/null | wc -l)
echo "Total: $AUDIO_COUNT chunks"

if [ $AUDIO_COUNT -gt 0 ]; then
    echo "Files:"
    ls -lh "$REC_PATH/audio" | tail -5
    
    # Calculate total audio size
    AUDIO_SIZE=$(du -sh "$REC_PATH/audio" | cut -f1)
    echo "Total size: $AUDIO_SIZE"
else
    echo "⚠️  NO AUDIO CHUNKS - Check:"
    echo "    1. Browser microphone permission"
    echo "    2. Browser console for audio errors"
    echo "    3. Server console for 'Audio chunk received' logs"
fi

echo ""
echo "✅ COMPLETED:"
echo "────────────"
COMPLETED_COUNT=$(ls -1 "$ROOM_PATH/completed"/*.mp4 2>/dev/null | wc -l)
echo "Total: $COMPLETED_COUNT videos"

if [ $COMPLETED_COUNT -gt 0 ]; then
    ls -lh "$ROOM_PATH/completed"
fi

echo ""
echo "📋 SUMMARY:"
echo "───────────"
if [ $FRAME_COUNT -eq 1 ]; then
    echo "⚠️  WARNING: Only 1 frame recorded"
    echo "   Issue: Frame capture loop is stopping after first iteration"
    echo "   Solution: Apply FIX #1 from FRAME_CAPTURE_FIX.js"
elif [ $FRAME_COUNT -lt 30 ]; then
    echo "⚠️  WARNING: Very few frames ($FRAME_COUNT)"
    echo "   Expected: 30+ frames per second"
    echo "   Check: Frame capture loop continuity"
elif [ $FRAME_COUNT -gt 30 ]; then
    echo "✅ GOOD: Frames are being captured continuously"
    echo "   FPS: ~$((FRAME_COUNT / 1)) per second"
fi

if [ $AUDIO_COUNT -eq 0 ]; then
    echo "⚠️  No audio chunks recorded"
    echo "   Check: Browser microphone permission granted?"
else
    echo "✅ GOOD: Audio chunks are being recorded ($AUDIO_COUNT chunks)"
fi

echo ""
echo "🔧 Next Steps:"
echo "──────────────"
if [ $FRAME_COUNT -eq 1 ]; then
    echo "1. Check browser console during recording"
    echo "2. Look for frame capture warnings/errors"
    echo "3. Apply FIX #1 to MeetingUIRecorder.tsx"
    echo "4. Restart recording with fix applied"
fi

if [ $AUDIO_COUNT -eq 0 ]; then
    echo "1. Check browser DevTools > Privacy & Security"
    echo "2. Ensure microphone is allowed"
    echo "3. Check server logs for 'audio-chunk' messages"
    echo "4. Look for audio recording errors in browser console"
fi

if [ $COMPLETED_COUNT -gt 0 ]; then
    echo "1. Video file created successfully"
    echo "2. Play the video to verify content"
    echo "3. Check audio track: ffprobe completed/*.mp4"
fi
