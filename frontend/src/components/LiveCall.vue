<template>
  <div class="live-call">
    <h1>Live Call Mode</h1>
    
    <div class="call-container">
      <div class="call-status" :class="callState">
        <div class="status-icon">
          {{ callState === 'idle' ? '📞' : callState === 'connected' ? '🎙️' : '⏸️' }}
        </div>
        <div class="status-text">
          {{ statusText }}
        </div>
      </div>
      
      <div class="call-controls">
        <button 
          v-if="callState === 'idle'" 
          @click="startCall" 
          class="btn-start"
        >
          Start Call
        </button>
        <button 
          v-if="callState === 'connected'" 
          @click="endCall" 
          class="btn-end"
        >
          End Call
        </button>
      </div>
      
      <div v-if="callState !== 'idle'" class="conversation">
        <h3>Conversation</h3>
        <div class="messages">
          <div 
            v-for="(msg, index) in conversation" 
            :key="index" 
            :class="'message ' + msg.role"
          >
            <div class="message-role">{{ msg.role === 'user' ? 'You' : 'AI Assistant' }}</div>
            <div class="message-text">{{ msg.text }}</div>
          </div>
        </div>
      </div>
      
      <div v-if="result" class="call-result">
        <h3>Call Summary</h3>
        <div class="result-grid">
          <div class="result-item">
            <strong>Duration:</strong> {{ result.duration }}s
          </div>
          <div class="result-item">
            <strong>Sentiment:</strong> 
            <span :class="'sentiment-badge ' + result.structured.sentiment">
              {{ result.structured.sentiment }}
            </span>
          </div>
          <div class="result-item">
            <strong>Appointment Confirmed:</strong> 
            {{ result.structured.appointment_confirmed ? '✅ Yes' : '❌ No' }}
          </div>
          <div class="result-item">
            <strong>Callback Requested:</strong> 
            {{ result.structured.requested_callback ? '✅ Yes' : '❌ No' }}
          </div>
        </div>
        <div class="result-summary">
          <strong>Summary:</strong>
          <p>{{ result.structured.summary }}</p>
        </div>
      </div>
    </div>
  </div>
</template>

<script>
export default {
  name: 'LiveCall',
  data() {
    return {
      callState: 'idle',
      ws: null,
      mediaRecorder: null,
      audioContext: null,
      conversation: [],
      result: null,
      sessionId: null,
      requireServerTts: String(import.meta.env.VITE_REQUIRE_SERVER_TTS || 'false').toLowerCase() === 'true'
    };
  },
  computed: {
    statusText() {
      switch (this.callState) {
        case 'idle':
          return 'Ready to start call';
        case 'connected':
          return 'Call in progress - Speak now';
        case 'ended':
          return 'Call ended';
        default:
          return '';
      }
    }
  },
  methods: {
    async startCall() {
      try {
        this.callState = 'connected';
        this.conversation = [];
        this.result = null;
        
        // Connect WebSocket
        const wsUrl = import.meta.env.VITE_WS_URL || 'ws://localhost:4000';
        this.ws = new WebSocket(`${wsUrl}/ws`);
        
        this.ws.onopen = () => {
          console.log('WebSocket connected');
        };
        
        this.ws.onmessage = (event) => {
          const data = JSON.parse(event.data);
          
          if (data.type === 'connected') {
            this.sessionId = data.sessionId;
            this.startRecording();
          } else if (data.type === 'ai_audio') {
            this.playAudio(data.data);
            this.conversation.push({
              role: 'assistant',
              text: data.transcript
            });
            if (data.shouldEnd) {
              setTimeout(() => { this.callState = 'ended'; }, 2000);
            }
          } else if (data.type === 'ai_response') {
            this.conversation.push({
              role: 'assistant',
              text: data.transcript
            });
            if (this.requireServerTts) {
              alert('Voice service unavailable. Please retry the call.');
              this.endCall();
              return;
            }
            this.speakAssistantText(data.transcript);
            if (data.shouldEnd) {
              setTimeout(() => { this.callState = 'ended'; }, 2000);
            }
          } else if (data.type === 'call_ended') {
            this.result = data;
            this.callState = 'ended';
          } else if (data.type === 'error') {
            console.error('WebSocket error:', data.message);
            alert('Error: ' + data.message);
          }
        };
        
        this.ws.onerror = (error) => {
          console.error('WebSocket error:', error);
          alert('Connection error. Please try again.');
          this.callState = 'idle';
        };
        
        this.ws.onclose = () => {
          console.log('WebSocket closed');
          this.stopAssistantSpeech();
          this.stopRecording();
        };
      } catch (error) {
        console.error('Failed to start call:', error);
        alert('Failed to start call. Please check your microphone permissions.');
        this.callState = 'idle';
      }
    },
    
    async startRecording() {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ 
          audio: {
            channelCount: 1,
            sampleRate: 16000
          } 
        });
        
        const AudioCtx = window.AudioContext || window.webkitAudioContext;
        this.audioContext = new AudioCtx({ sampleRate: 16000 });
        await this.audioContext.audioWorklet.addModule(
          new URL('../worklets/pcmCaptureProcessor.js', import.meta.url)
        );

        const source = this.audioContext.createMediaStreamSource(stream);
        const captureNode = new AudioWorkletNode(this.audioContext, 'pcm-capture-processor', {
          numberOfInputs: 1,
          numberOfOutputs: 1,
          channelCount: 1
        });
        const silentGain = this.audioContext.createGain();
        silentGain.gain.value = 0;

        source.connect(captureNode);
        captureNode.connect(silentGain);
        silentGain.connect(this.audioContext.destination);

        const sampleRate = this.audioContext.sampleRate || 16000;
        const targetSamples = Math.floor(sampleRate * 3);
        const state = {
          pendingFrames: [],
          pendingSamples: 0
        };

        const flush = () => {
          if (state.pendingSamples === 0) return;
          const audioData = this.encodeWAV(state.pendingFrames, sampleRate);
          const base64Audio = this.arrayBufferToBase64(audioData);

          if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            this.ws.send(JSON.stringify({
              type: 'audio_chunk',
              data: base64Audio
            }));
          }

          state.pendingFrames = [];
          state.pendingSamples = 0;
        };

        captureNode.port.onmessage = (event) => {
          if (this.callState !== 'connected') return;

          const frame = new Float32Array(event.data);
          state.pendingFrames.push(frame);
          state.pendingSamples += frame.length;

          if (state.pendingSamples >= targetSamples) {
            flush();
          }
        };
        
        this.mediaRecorder = { stream, source, captureNode, silentGain, flush };
      } catch (error) {
        console.error('Failed to start recording:', error);
        alert('Microphone access denied. Please allow microphone access.');
        this.endCall();
      }
    },
    
    stopRecording() {
      if (!this.mediaRecorder) return;

      if (this.mediaRecorder.flush) {
        this.mediaRecorder.flush();
      }
      if (this.mediaRecorder.source) {
        this.mediaRecorder.source.disconnect();
      }
      if (this.mediaRecorder.captureNode) {
        this.mediaRecorder.captureNode.port.onmessage = null;
        this.mediaRecorder.captureNode.disconnect();
      }
      if (this.mediaRecorder.silentGain) {
        this.mediaRecorder.silentGain.disconnect();
      }
      if (this.mediaRecorder.stream) {
        this.mediaRecorder.stream.getTracks().forEach(track => track.stop());
      }

      this.mediaRecorder = null;

      if (this.audioContext) {
        this.audioContext.close();
        this.audioContext = null;
      }
    },
    
    endCall() {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({
          type: 'end_call',
          patientId: null
        }));
      }
      
      this.stopRecording();
      this.stopAssistantSpeech();
      
      if (this.ws) {
        this.ws.close();
      }
      
      this.callState = 'ended';
    },
    speakAssistantText(text) {
      if (!('speechSynthesis' in window) || !text) {
        return;
      }
      try {
        window.speechSynthesis.cancel();
        const utterance = new SpeechSynthesisUtterance(text);
        utterance.rate = 1.0;
        utterance.pitch = 1.0;
        window.speechSynthesis.speak(utterance);
      } catch (error) {
        console.warn('Speech synthesis fallback failed:', error);
      }
    },
    stopAssistantSpeech() {
      if ('speechSynthesis' in window) {
        window.speechSynthesis.cancel();
      }
    },
    
    playAudio(base64Audio) {
      const audioData = this.base64ToArrayBuffer(base64Audio);
      const blob = new Blob([audioData], { type: 'audio/wav' });
      const url = URL.createObjectURL(blob);
      const audio = new Audio(url);
      audio.play();
    },
    
    encodeWAV(samples, sampleRate = 16000) {
      const totalSamples = samples.reduce((sum, frame) => sum + frame.length, 0);
      const buffer = new ArrayBuffer(44 + totalSamples * 2);
      const view = new DataView(buffer);
      
      const numChannels = 1;
      const bytesPerSample = 2;
      
      // WAV header
      this.writeString(view, 0, 'RIFF');
      view.setUint32(4, 36 + totalSamples * 2, true);
      this.writeString(view, 8, 'WAVE');
      this.writeString(view, 12, 'fmt ');
      view.setUint32(16, 16, true);
      view.setUint16(20, 1, true);
      view.setUint16(22, numChannels, true);
      view.setUint32(24, sampleRate, true);
      view.setUint32(28, sampleRate * numChannels * bytesPerSample, true);
      view.setUint16(32, numChannels * bytesPerSample, true);
      view.setUint16(34, 16, true);
      this.writeString(view, 36, 'data');
      view.setUint32(40, totalSamples * 2, true);
      
      let offset = 44;
      for (let i = 0; i < samples.length; i++) {
        for (let j = 0; j < samples[i].length; j++) {
          const s = Math.max(-1, Math.min(1, samples[i][j]));
          view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
          offset += 2;
        }
      }
      
      return buffer;
    },
    
    writeString(view, offset, string) {
      for (let i = 0; i < string.length; i++) {
        view.setUint8(offset + i, string.charCodeAt(i));
      }
    },
    
    arrayBufferToBase64(buffer) {
      let binary = '';
      const bytes = new Uint8Array(buffer);
      for (let i = 0; i < bytes.byteLength; i++) {
        binary += String.fromCharCode(bytes[i]);
      }
      return btoa(binary);
    },
    
    base64ToArrayBuffer(base64) {
      const binaryString = atob(base64);
      const bytes = new Uint8Array(binaryString.length);
      for (let i = 0; i < binaryString.length; i++) {
        bytes[i] = binaryString.charCodeAt(i);
      }
      return bytes.buffer;
    }
  },
  beforeUnmount() {
    if (this.callState === 'connected') {
      this.endCall();
    }
  }
};
</script>

<style scoped>
.live-call h1 {
  margin-bottom: 2rem;
  color: #2c3e50;
}

.call-container {
  background: white;
  padding: 2rem;
  border-radius: 12px;
  box-shadow: 0 2px 8px rgba(0,0,0,0.1);
}

.call-status {
  text-align: center;
  padding: 3rem;
  border-radius: 12px;
  margin-bottom: 2rem;
}

.call-status.idle {
  background: #f8f9fa;
}

.call-status.connected {
  background: #d4edda;
  animation: pulse 2s infinite;
}

.call-status.ended {
  background: #fff3cd;
}

@keyframes pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.7; }
}

.status-icon {
  font-size: 4rem;
  margin-bottom: 1rem;
}

.status-text {
  font-size: 1.5rem;
  font-weight: 600;
  color: #2c3e50;
}

.call-controls {
  text-align: center;
  margin-bottom: 2rem;
}

.btn-start, .btn-end {
  padding: 1rem 3rem;
  font-size: 1.2rem;
  font-weight: 600;
  border: none;
  border-radius: 8px;
  cursor: pointer;
  transition: all 0.3s;
}

.btn-start {
  background: #27ae60;
  color: white;
}

.btn-start:hover {
  background: #229954;
  transform: scale(1.05);
}

.btn-end {
  background: #e74c3c;
  color: white;
}

.btn-end:hover {
  background: #c0392b;
  transform: scale(1.05);
}

.conversation {
  margin-top: 2rem;
}

.conversation h3 {
  margin-bottom: 1rem;
  color: #2c3e50;
}

.messages {
  max-height: 400px;
  overflow-y: auto;
  padding: 1rem;
  background: #f8f9fa;
  border-radius: 8px;
}

.message {
  margin-bottom: 1rem;
  padding: 1rem;
  border-radius: 8px;
}

.message.user {
  background: #e3f2fd;
  margin-left: 2rem;
}

.message.assistant {
  background: #f3e5f5;
  margin-right: 2rem;
}

.message-role {
  font-weight: 600;
  margin-bottom: 0.5rem;
  color: #2c3e50;
}

.message-text {
  color: #34495e;
}

.call-result {
  margin-top: 2rem;
  padding: 2rem;
  background: #f8f9fa;
  border-radius: 8px;
}

.call-result h3 {
  margin-bottom: 1.5rem;
  color: #2c3e50;
}

.result-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
  gap: 1rem;
  margin-bottom: 1.5rem;
}

.result-item {
  padding: 1rem;
  background: white;
  border-radius: 6px;
}

.result-summary {
  padding: 1rem;
  background: white;
  border-radius: 6px;
}

.result-summary p {
  margin-top: 0.5rem;
  color: #34495e;
}

.sentiment-badge {
  padding: 0.25rem 0.75rem;
  border-radius: 12px;
  font-size: 0.85rem;
  font-weight: 600;
}

.sentiment-badge.positive {
  background: #d4edda;
  color: #155724;
}

.sentiment-badge.neutral {
  background: #fff3cd;
  color: #856404;
}

.sentiment-badge.negative {
  background: #f8d7da;
  color: #721c24;
}
</style>
