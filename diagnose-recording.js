#!/usr/bin/env node

/**
 * Diagnostic script to check recording files
 * Run: node diagnose-recording.js <roomId> [recordingId]
 */

const fs = require('fs-extra');
const path = require('path');

const roomId = process.argv[2];
const recordingId = process.argv[3];

if (!roomId) {
  console.log('Usage: node diagnose-recording.js <roomId> [recordingId]');
  console.log('Example: node diagnose-recording.js ltqnDcMy29oT2bBnijOhApsl');
  process.exit(1);
}

const recordingsDir = './ui-recordings';
const roomPath = path.join(recordingsDir, 'rooms', roomId);
const tempPath = path.join(roomPath, 'temp');

console.log('\n📊 RECORDING DIAGNOSTICS');
console.log('========================\n');
console.log(`Room ID: ${roomId}`);
console.log(`Room Path: ${roomPath}\n`);

// Check if room exists
if (!fs.existsSync(roomPath)) {
  console.error('❌ Room path does not exist');
  process.exit(1);
}

// List all temp recordings
const tempDir = fs.readdirSync(tempPath || './');
console.log(`📁 Recordings found in temp: ${tempDir.length}`);
tempDir.forEach((dir, i) => {
  console.log(`  ${i + 1}. ${dir}`);
});

// If no specific recording, use first one
let recId = recordingId;
if (!recId && tempDir.length > 0) {
  recId = tempDir[0];
  console.log(`\n✅ Using first recording: ${recId}\n`);
}

if (!recId) {
  console.error('No recording ID provided or found');
  process.exit(1);
}

const recordingPath = path.join(tempPath, recId);

console.log(`\n📍 Recording Path: ${recordingPath}\n`);

// Check frames
const framesDir = path.join(recordingPath, 'frames');
if (fs.existsSync(framesDir)) {
  const frames = fs.readdirSync(framesDir).filter(f => f.endsWith('.jpg'));
  console.log(`🎥 FRAMES: ${frames.length} files`);
  if (frames.length > 0) {
    frames.slice(0, 5).forEach((frame, i) => {
      const filePath = path.join(framesDir, frame);
      const stat = fs.statSync(filePath);
      console.log(`  ${i + 1}. ${frame} - ${Math.round(stat.size / 1024)}KB`);
    });
    if (frames.length > 5) {
      console.log(`  ... and ${frames.length - 5} more`);
    }
  } else {
    console.log('  ❌ NO FRAMES FOUND');
  }
} else {
  console.log('❌ Frames directory does not exist');
}

// Check audio
const audioDir = path.join(recordingPath, 'audio');
if (fs.existsSync(audioDir)) {
  const audioFiles = fs.readdirSync(audioDir);
  console.log(`\n🎤 AUDIO: ${audioFiles.length} chunks`);
  if (audioFiles.length > 0) {
    audioFiles.slice(0, 5).forEach((audio, i) => {
      const filePath = path.join(audioDir, audio);
      const stat = fs.statSync(filePath);
      console.log(`  ${i + 1}. ${audio} - ${Math.round(stat.size / 1024)}KB`);
    });
    if (audioFiles.length > 5) {
      console.log(`  ... and ${audioFiles.length - 5} more`);
    }
  } else {
    console.log('  ⚠️  NO AUDIO FILES - Check if browser allowed microphone access');
  }
} else {
  console.log('\n❌ Audio directory does not exist');
}

// Check completed recordings
const completedPath = path.join(roomPath, 'completed');
if (fs.existsSync(completedPath)) {
  const completed = fs.readdirSync(completedPath);
  console.log(`\n✅ COMPLETED: ${completed.length} files`);
  completed.forEach((file, i) => {
    const filePath = path.join(completedPath, file);
    const stat = fs.statSync(filePath);
    console.log(`  ${i + 1}. ${file} - ${Math.round(stat.size / (1024 * 1024) * 100) / 100}MB`);
  });
}

console.log('\n');
console.log('SUMMARY:');
console.log('--------');
if (fs.existsSync(framesDir)) {
  const frames = fs.readdirSync(framesDir).filter(f => f.endsWith('.jpg'));
  console.log(`Frames collected: ${frames.length}`);
}
if (fs.existsSync(audioDir)) {
  const audioFiles = fs.readdirSync(audioDir);
  console.log(`Audio chunks collected: ${audioFiles.length}`);
}

console.log('\nIf frames are only 1 or 2:');
console.log('  - Check browser console for frame capture errors');
console.log('  - Verify socket connection is stable');
console.log('  - Check network tab for dropped frame emissions\n');

console.log('If audio is 0:');
console.log('  - Check browser permissions for microphone');
console.log('  - Check browser console for audio recording errors');
console.log('  - Verify MediaRecorder is initialized\n');
