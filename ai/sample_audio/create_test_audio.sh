#!/bin/bash

# Create test audio files for campaign simulation
# These are silent WAV files that Whisper can process

echo "Creating test audio files..."

# Create 3 test audio files (1 second of silence each)
for i in 1 2 3; do
  # Generate 1 second of silence at 16kHz, mono, 16-bit
  ffmpeg -f lavfi -i anullsrc=r=16000:cl=mono -t 1 -acodec pcm_s16le patient${i}.wav -y 2>/dev/null
  
  if [ $? -eq 0 ]; then
    echo "✓ Created patient${i}.wav"
  else
    echo "✗ Failed to create patient${i}.wav (ffmpeg not installed)"
    echo "  Install ffmpeg: sudo apt-get install ffmpeg"
  fi
done

echo ""
echo "Test audio files created!"
echo "Note: These are silent files. Whisper will transcribe them as empty or minimal text."
echo "For better testing, replace with actual voice recordings."
