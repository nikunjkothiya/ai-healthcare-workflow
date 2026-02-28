<template>
  <div class="mobile-call">
    <div v-if="callState === 'loading'" class="call-status-screen">
      <div class="ended-icon">⏳</div>
      <h2>Validating Call Link</h2>
      <p class="ended-message">Please wait...</p>
    </div>

    <!-- Incoming Call Screen -->
    <div v-if="callState === 'incoming'" class="incoming-call">
      <div class="caller-info">
        <div class="avatar">🏥</div>
        <h2>Healthcare Center</h2>
        <p class="phone-number">{{ patient?.phone || 'Unknown' }}</p>
        <p class="call-type">Voice Call</p>
      </div>

      <div class="patient-details" v-if="patient">
        <p class="patient-name">{{ patient.name }}</p>
        <p class="appointment-info" v-if="patient.metadata">
          {{ patient.metadata.appointment_type }}
        </p>
        <p class="appointment-date" v-if="patient.metadata">
          {{ patient.metadata.appointment_date }}
        </p>
      </div>

      <div class="incoming-animation">
        <div class="ring"></div>
        <div class="ring"></div>
        <div class="ring"></div>
      </div>

      <div class="call-actions">
        <button @click="rejectCall" class="btn-reject">
          <span class="icon">📵</span>
          <span class="label">Decline</span>
        </button>
        <button @click="acceptCall" class="btn-accept" :disabled="!incomingReady">
          <span class="icon">📞</span>
          <span class="label">Accept</span>
        </button>
      </div>

      <p v-if="!incomingReady" class="waiting-note">
        {{ incomingStatusText }}
      </p>

      <p v-if="ringSecondsLeft !== null && incomingReady" class="waiting-note">
        Auto timeout in {{ ringSecondsLeft }}s
      </p>

      <div class="test-info">
        <p>🔗 Share this link: <code>{{ testLink }}</code></p>
        <button @click="copyLink" class="btn-copy-small">Copy</button>
      </div>
    </div>

    <!-- Active Call Screen -->
    <div v-if="callState === 'active'" class="call-active">
      <div class="call-header">
        <div class="status-indicator"></div>
        <span>Call in Progress</span>
      </div>

      <div class="call-timer">{{ formatDuration(callDuration) }}</div>

      <div class="conversation-display">
        <div 
          v-for="(msg, index) in conversation" 
          :key="index" 
          :class="['message-bubble', msg.role]"
        >
          <div class="speaker">{{ msg.role === 'assistant' ? '🤖 AI Agent' : '👤 You' }}</div>
          <div class="text">{{ msg.text }}</div>
          <div class="timestamp">{{ msg.timestamp }}</div>
        </div>
      </div>

      <div class="call-controls">
        <button @click="toggleMute" :class="['control-btn', { active: isMuted }]">
          <span class="icon">{{ isMuted ? '🔇' : '🎤' }}</span>
          <span class="label">{{ isMuted ? 'Unmute' : 'Mute' }}</span>
        </button>
        
        <button @click="endCall" class="control-btn end-call">
          <span class="icon">📵</span>
          <span class="label">End Call</span>
        </button>
      </div>

      <div class="audio-indicator" v-if="showListeningIndicator">
        <div class="wave"></div>
        <div class="wave"></div>
        <div class="wave"></div>
        <span>Listening...</span>
      </div>
    </div>

    <div v-if="callState === 'status'" class="call-status-screen">
      <div :class="['ended-icon', statusVariant]">{{ statusIcon }}</div>
      <h2>{{ statusTitle }}</h2>
      <p class="ended-message">{{ statusMessage }}</p>

      <div class="ended-info" v-if="linkStatus?.latestCall">
        <p><strong>Call ID:</strong> #{{ linkStatus.latestCall.id }}</p>
        <p><strong>Call State:</strong> {{ linkStatus.latestCall.state }}</p>
        <p><strong>Updated:</strong> {{ formatDateTime(linkStatus.latestCall.updated_at || linkStatus.latestCall.created_at) }}</p>
      </div>
    </div>

    <div v-if="callState === 'invalid'" class="call-status-screen">
      <div class="ended-icon invalid">!</div>
      <h2>Incorrect Call URL</h2>
      <p class="ended-message">{{ invalidMessage }}</p>

      <div class="ended-info">
        <p>Please check the patient/campaign link and try again.</p>
      </div>
    </div>

    <!-- Call Ended Screen -->
    <div v-if="callState === 'ended'" class="call-ended">
      <div class="ended-icon">✓</div>
      <h2>Call Ended</h2>
      <p class="ended-message">Thank you for your time.</p>
      <p class="ended-duration">Duration: {{ formatDuration(callDuration) }}</p>
      
      <div class="ended-info">
        <p>Your responses have been recorded.</p>
        <p>A care coordinator will follow up if needed.</p>
      </div>

      <button @click="closeWindow" class="btn-close">
        Close
      </button>
    </div>
  </div>
</template>

<script>
export default {
  name: 'MobileCall',
  data() {
    return {
      callState: 'loading', // loading, incoming, active, status, invalid, ended
      callDuration: 0,
      conversation: [],
      patient: null,
      linkStatus: null,
      ws: null,
      mediaRecorder: null,
      audioContext: null,
      isMuted: false,
      isRecording: false,
      timerInterval: null,
      testLink: '',
      patientId: null,
      campaignId: null,
      ringtoneInterval: null,
      isSocketConnected: false,
      incomingReady: false,
      incomingStatusText: 'Waiting for scheduled AI call...',
      ringSecondsLeft: null,
      ringCountdownInterval: null,
      turnState: 'assistant', // assistant | patient
      assistantSpeaking: false,
      currentAudio: null,
      statusTitle: '',
      statusMessage: '',
      statusVariant: 'neutral',
      statusIcon: 'i',
      invalidMessage: 'This call link is invalid or expired.',
      requireServerTts: String(import.meta.env.VITE_REQUIRE_SERVER_TTS || 'false').toLowerCase() === 'true'
    };
  },
  computed: {
    showListeningIndicator() {
      return this.callState === 'active' &&
        this.isRecording &&
        this.turnState === 'patient' &&
        !this.assistantSpeaking &&
        !this.isMuted;
    }
  },
  async mounted() {
    const urlParams = new URLSearchParams(window.location.search);
    const parsedPatientId = this.parsePositiveInt(urlParams.get('patient'));
    const parsedCampaignId = urlParams.has('campaign')
      ? this.parsePositiveInt(urlParams.get('campaign'))
      : null;

    if (!parsedPatientId) {
      this.setInvalidCallUrl('Missing or invalid patient ID in the call link.');
      return;
    }

    if (urlParams.has('campaign') && !parsedCampaignId) {
      this.setInvalidCallUrl('Invalid campaign ID in the call link.');
      return;
    }

    this.patientId = String(parsedPatientId);
    this.campaignId = parsedCampaignId ? String(parsedCampaignId) : null;

    this.testLink = this.campaignId
      ? `${window.location.origin}/mobile-call?patient=${this.patientId}&campaign=${this.campaignId}`
      : `${window.location.origin}/mobile-call?patient=${this.patientId}`;

    const isPendingLink = await this.loadCallLinkContext();
    if (!isPendingLink) return;

    try {
      await this.connectWebSocket();
    } catch (error) {
      console.error('Initial socket connection failed:', error);
      this.incomingStatusText = 'Unable to connect to call service. Please refresh this page.';
    }
  },
  beforeUnmount() {
    if (this.timerInterval) {
      clearInterval(this.timerInterval);
    }
    if (this.ringtoneInterval) {
      clearInterval(this.ringtoneInterval);
    }
    if (this.ringCountdownInterval) {
      clearInterval(this.ringCountdownInterval);
    }
    if (this.ws) {
      this.ws.close();
    }
    this.stopAssistantSpeech();
    this.stopRecording();
  },
  methods: {
    cleanDisplayText(value) {
      return String(value || '')
        .replace(/\[(?:BLANK_AUDIO|SILENCE|NO_SPEECH|MUSIC)\]|\((?:SILENCE|NOISE|MUSIC)\)|<\|(?:nospeech|silence)\|>/gi, ' ')
        .replace(/\b(?:blank[_ ]audio|no[_ ]speech)\b/gi, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    },
    parsePositiveInt(value) {
      const id = Number.parseInt(value, 10);
      return Number.isInteger(id) && id > 0 ? id : null;
    },
    closeSocket() {
      if (this.ws) {
        this.ws.close();
        this.ws = null;
      }
      this.isSocketConnected = false;
    },
    setInvalidCallUrl(message) {
      this.stopRingtone();
      this.stopRingCountdown();
      this.stopAssistantSpeech();
      this.stopRecording();
      this.closeSocket();
      this.incomingReady = false;
      this.invalidMessage = message || 'This call link is invalid or expired.';
      this.callState = 'invalid';
    },
    applyStatusScreen(callLink) {
      const displayState = callLink?.displayState || 'not_scheduled';
      const message = callLink?.message || 'No pending call is scheduled for this link.';

      const statusConfig = {
        completed: { title: 'Call Completed', variant: 'success', icon: '✓' },
        missed: { title: 'Call Missed', variant: 'warning', icon: '!' },
        rejected: { title: 'Call Declined', variant: 'warning', icon: '!' },
        failed: { title: 'Call Failed', variant: 'danger', icon: '!' },
        in_progress: { title: 'Call In Progress', variant: 'neutral', icon: 'i' },
        not_scheduled: { title: 'No Active Call', variant: 'neutral', icon: 'i' }
      };

      const selected = statusConfig[displayState] || statusConfig.not_scheduled;
      this.statusTitle = selected.title;
      this.statusVariant = selected.variant;
      this.statusIcon = selected.icon;
      this.statusMessage = message;
      this.linkStatus = callLink || null;

      this.stopRingtone();
      this.stopRingCountdown();
      this.stopAssistantSpeech();
      this.stopRecording();
      this.closeSocket();
      this.incomingReady = false;
      this.callState = 'status';
    },
    async loadCallLinkContext() {
      try {
        const apiUrl = import.meta.env.VITE_API_URL || 'http://localhost:4000';
        const query = this.campaignId
          ? `?campaign=${encodeURIComponent(this.campaignId)}`
          : '';
        const response = await fetch(
          `${apiUrl}/patients/public/${encodeURIComponent(this.patientId)}/call-link-status${query}`
        );

        let payload = null;
        try {
          payload = await response.json();
        } catch (parseError) {
          payload = null;
        }

        if (!response.ok) {
          const serverMessage = payload?.error || `Unable to validate call link (HTTP ${response.status}).`;
          if ([400, 404, 409].includes(response.status)) {
            this.setInvalidCallUrl(serverMessage);
          } else {
            this.setInvalidCallUrl(`Call link validation failed (HTTP ${response.status}).`);
          }
          return false;
        }

        this.patient = payload?.patient || null;
        this.linkStatus = payload?.callLink || null;

        if ((this.linkStatus?.displayState || 'not_scheduled') === 'pending') {
          this.callState = 'incoming';
          this.incomingReady = false;
          this.incomingStatusText = this.linkStatus?.message || 'Waiting for scheduled AI call...';
          return true;
        }

        this.applyStatusScreen(this.linkStatus);
        return false;
      } catch (error) {
        console.error('Failed to validate call link:', error);
        this.setInvalidCallUrl('Failed to validate this call link. Please check your connection.');
        return false;
      }
    },
    formatDateTime(dateString) {
      if (!dateString) return 'N/A';
      const parsed = new Date(dateString);
      if (Number.isNaN(parsed.getTime())) return 'N/A';
      return parsed.toLocaleString();
    },
    async connectWebSocket() {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        if (!this.isSocketConnected) {
          this.ws.send(JSON.stringify({
            type: 'register_patient',
            patientId: this.patientId
          }));
          this.isSocketConnected = true;
        }
        return;
      }

      const wsUrl = import.meta.env.VITE_WS_URL || 'ws://localhost:4000';
      this.ws = new WebSocket(`${wsUrl}/ws`);

      await new Promise((resolve, reject) => {
        let settled = false;

        this.ws.onopen = () => {
          this.isSocketConnected = true;
          this.ws.send(JSON.stringify({
            type: 'register_patient',
            patientId: this.patientId
          }));
          if (!settled) {
            settled = true;
            resolve();
          }
        };

        this.ws.onmessage = (event) => {
          const data = JSON.parse(event.data);
          this.handleSocketMessage(data);
        };

        this.ws.onerror = (error) => {
          console.error('WebSocket error:', error);
          if (!settled) {
            settled = true;
            reject(error);
          }
        };

        this.ws.onclose = () => {
          this.isSocketConnected = false;
          if (this.callState === 'active') {
            this.handleCallEnd();
          } else if (this.callState === 'incoming') {
            this.incomingStatusText = 'Connection lost. Please refresh this page.';
          }
        };
      });
    },
    handleSocketMessage(data) {
      if (data.type === 'connected' || data.type === 'patient_registered') {
        return;
      }

      if (data.type === 'incoming_call') {
        if (String(data.patientId) === String(this.patientId)) {
          this.incomingReady = true;
          this.callState = 'incoming';
          this.turnState = 'assistant';
          this.incomingStatusText = 'Incoming AI call. Accept to talk now.';
          this.startRingCountdown(data.timeoutMs || 30000);
          this.playRingtone();
        }
        return;
      }

      if (data.type === 'incoming_call_missed') {
        const displayState = data.reason === 'patient_rejected' ? 'rejected' : 'missed';
        this.applyStatusScreen({
          ...(this.linkStatus || {}),
          displayState,
          message: displayState === 'rejected'
            ? 'This call was declined.'
            : 'This call was missed.'
        });
        return;
      }

      if (data.type === 'ai_response' || data.type === 'ai_audio') {
        const transcript = this.cleanDisplayText(data.transcript || '');
        if (transcript) {
          this.conversation.push({
            role: 'assistant',
            text: transcript,
            timestamp: new Date().toLocaleTimeString()
          });
        }
        this.handleAssistantResponse(data).catch((error) => {
          console.error('Assistant response handling failed:', error);
        });
        return;
      }

      if (data.type === 'user_speech') {
        const transcript = this.cleanDisplayText(data.transcript);
        if (transcript) {
          this.conversation.push({
            role: 'user',
            text: transcript,
            timestamp: new Date().toLocaleTimeString()
          });
        }
        return;
      }

      if (data.type === 'call_ended') {
        this.handleCallEnd(data);
        return;
      }

      if (data.type === 'error') {
        console.error('WebSocket error:', data.message);
        alert('Error: ' + data.message);
        this.callState = 'ended';
        return;
      }

      if (data.type === 'audio_warning') {
        console.warn('Audio warning:', data.message);
        if (this.callState === 'active' && !this.assistantSpeaking) {
          this.turnState = 'patient';
          this.incomingStatusText = data.message || 'Could not hear clearly. Please speak again.';
        }
        return;
      }
    },
    isPatientTurn() {
      return this.callState === 'active' &&
        this.turnState === 'patient' &&
        !this.assistantSpeaking &&
        !this.isMuted;
    },
    calculateRms(frame) {
      if (!frame || frame.length === 0) return 0;
      let sum = 0;
      for (let i = 0; i < frame.length; i++) {
        const sample = frame[i];
        sum += sample * sample;
      }
      return Math.sqrt(sum / frame.length);
    },
    async handleAssistantResponse(data) {
      const transcript = this.cleanDisplayText(data.transcript || '');
      this.turnState = 'assistant';
      this.assistantSpeaking = true;
      this.incomingStatusText = 'AI is speaking...';

      if (data.data) {
        await this.playAudio(data.data);
      } else if (transcript && !this.requireServerTts) {
        await this.speakAssistantText(transcript);
      } else if (transcript && this.requireServerTts) {
        console.error('Expected ai_audio in production mode but received ai_response');
        alert('Voice service unavailable. Please retry the call.');
        this.handleCallEnd(data);
        return;
      }

      this.assistantSpeaking = false;

      if (data.shouldEnd) {
        setTimeout(() => this.handleCallEnd(data), 2000);
        return;
      }

      await new Promise((resolve) => setTimeout(resolve, 250));
      if (this.callState === 'active') {
        this.turnState = 'patient';
        this.incomingStatusText = 'Listening... Speak now.';
      }
    },
    playRingtone() {
      // Create a simple ringtone using Web Audio API
      try {
        if (this.ringtoneInterval) return;
        const audioContext = new (window.AudioContext || window.webkitAudioContext)();
        const oscillator = audioContext.createOscillator();
        const gainNode = audioContext.createGain();
        
        oscillator.connect(gainNode);
        gainNode.connect(audioContext.destination);
        
        oscillator.frequency.value = 440;
        gainNode.gain.value = 0.1;
        
        oscillator.start();
        
        // Stop after 2 seconds and repeat
        this.ringtoneInterval = setInterval(() => {
          if (this.callState === 'incoming') {
            oscillator.frequency.value = 440;
            setTimeout(() => {
              oscillator.frequency.value = 0;
            }, 500);
          } else {
            clearInterval(this.ringtoneInterval);
            oscillator.stop();
          }
        }, 2000);
      } catch (error) {
        console.error('Failed to play ringtone:', error);
      }
    },
    stopRingtone() {
      if (this.ringtoneInterval) {
        clearInterval(this.ringtoneInterval);
        this.ringtoneInterval = null;
      }
    },
    startRingCountdown(timeoutMs) {
      this.stopRingCountdown();
      const totalSeconds = Math.max(1, Math.ceil((timeoutMs || 30000) / 1000));
      this.ringSecondsLeft = totalSeconds;

      this.ringCountdownInterval = setInterval(() => {
        if (this.ringSecondsLeft === null) return;

        if (this.ringSecondsLeft > 0) {
          this.ringSecondsLeft -= 1;
          return;
        }

        this.stopRingCountdown();
      }, 1000);
    },
    stopRingCountdown() {
      if (this.ringCountdownInterval) {
        clearInterval(this.ringCountdownInterval);
        this.ringCountdownInterval = null;
      }
      this.ringSecondsLeft = null;
    },
    rejectCall() {
      if (!this.incomingReady) {
        alert('Call is not ringing yet. Please wait.');
        return;
      }

      let sent = false;
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({
          type: 'reject_call',
          patientId: this.patientId
        }));
        sent = true;
      }
      const applyRejectedStatus = () => {
        this.applyStatusScreen({
          ...(this.linkStatus || {}),
          displayState: 'rejected',
          message: 'You declined this call.'
        });
      };
      if (sent) {
        setTimeout(applyRejectedStatus, 150);
      } else {
        applyRejectedStatus();
      }
    },
    async acceptCall() {
      if (!this.incomingReady) {
        alert('Call is not ready yet. Please wait for incoming ring.');
        return;
      }

      try {
        await this.connectWebSocket();
      } catch (error) {
        console.error('Failed to connect WebSocket:', error);
        alert('Connection error. Please try again.');
        return;
      }

      this.stopRingtone();
      this.stopRingCountdown();
      this.callState = 'active';
      this.callDuration = 0;
      this.conversation = [];
      this.incomingReady = false;
      this.incomingStatusText = 'AI is preparing the greeting...';
      this.turnState = 'assistant';
      this.assistantSpeaking = false;
      
      // Start timer
      this.timerInterval = setInterval(() => {
        this.callDuration++;
      }, 1000);

      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({
          type: 'start_call',
          patientId: this.patientId
        }));
      }

      await this.startRecording();
    },
    async startRecording() {
      if (this.isRecording) return;

      try {
        const stream = await navigator.mediaDevices.getUserMedia({ 
          audio: {
            channelCount: 1,
            sampleRate: 16000
          } 
        });
        
        this.isRecording = true;
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
        const vadConfig = {
          speechThreshold: 0.008,
          silenceThreshold: 0.004,
          minSpeechMs: 400,
          endSilenceMs: 1100,
          maxUtteranceMs: 15000
        };

        const state = {
          active: false,
          frames: [],
          speechMs: 0,
          silenceMs: 0,
          totalMs: 0
        };

        const resetUtterance = () => {
          state.active = false;
          state.frames = [];
          state.speechMs = 0;
          state.silenceMs = 0;
          state.totalMs = 0;
        };

        const flush = (allowSend = true) => {
          if (!state.active || state.frames.length === 0) {
            resetUtterance();
            return;
          }

          const hasSpeech = state.speechMs >= vadConfig.minSpeechMs;
          const canSend = allowSend &&
            hasSpeech &&
            this.isPatientTurn() &&
            this.ws &&
            this.ws.readyState === WebSocket.OPEN;

          if (!canSend) {
            resetUtterance();
            return;
          }

          const audioData = this.encodeWAV(state.frames, sampleRate);
          const base64Audio = this.arrayBufferToBase64(audioData);

          this.ws.send(JSON.stringify({
            type: 'audio_chunk',
            data: base64Audio
          }));

          // Wait for the next AI turn before capturing more.
          this.turnState = 'assistant';
          this.incomingStatusText = 'AI is processing your response...';
          resetUtterance();
        };

        captureNode.port.onmessage = (event) => {
          const frame = new Float32Array(event.data);
          if (!frame.length) return;

          if (!this.isPatientTurn()) {
            if (state.active) {
              resetUtterance();
            }
            return;
          }

          const frameMs = (frame.length / sampleRate) * 1000;
          const rms = this.calculateRms(frame);

          if (!state.active) {
            if (rms >= vadConfig.speechThreshold) {
              state.active = true;
              state.frames.push(frame);
              state.speechMs += frameMs;
              state.totalMs += frameMs;
              state.silenceMs = 0;
              this.incomingStatusText = 'Listening...';
            }
            return;
          }

          state.frames.push(frame);
          state.totalMs += frameMs;

          if (rms >= vadConfig.speechThreshold) {
            state.speechMs += frameMs;
            state.silenceMs = 0;
          } else if (rms <= vadConfig.silenceThreshold) {
            state.silenceMs += frameMs;
          } else {
            state.silenceMs = Math.max(0, state.silenceMs - frameMs * 0.5);
          }

          if (state.silenceMs >= vadConfig.endSilenceMs || state.totalMs >= vadConfig.maxUtteranceMs) {
            flush(true);
          }
        };
        
        this.mediaRecorder = { stream, source, captureNode, silentGain, flush, resetUtterance };
      } catch (error) {
        console.error('Failed to start recording:', error);
        alert('Microphone access denied. Please allow microphone access.');
        this.resetCall();
      }
    },
    stopRecording() {
      this.isRecording = false;
      if (this.mediaRecorder) {
        if (this.mediaRecorder.flush) {
          this.mediaRecorder.flush(false);
        }
        if (this.mediaRecorder.resetUtterance) {
          this.mediaRecorder.resetUtterance();
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
      }
      if (this.audioContext) {
        this.audioContext.close();
        this.audioContext = null;
      }
    },
    toggleMute() {
      this.isMuted = !this.isMuted;
    },
    endCall() {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({
          type: 'end_call',
          patientId: this.patient?.id || this.patientId
        }));
      }
      this.handleCallEnd();
    },
    handleCallEnd(data) {
      this.callState = 'ended';
      this.incomingReady = false;
      this.turnState = 'assistant';
      this.assistantSpeaking = false;
      this.stopRingCountdown();
      this.stopAssistantSpeech();
      
      if (this.timerInterval) {
        clearInterval(this.timerInterval);
      }

      this.stopRingtone();
      
      this.stopRecording();
      
      this.closeSocket();
      
      // Data is saved to database by backend
      // Patient doesn't see analysis - only hospital staff see it in dashboard
    },
    resetCall() {
      if (this.timerInterval) {
        clearInterval(this.timerInterval);
        this.timerInterval = null;
      }
      if (this.ringtoneInterval) {
        this.stopRingtone();
      }
      this.stopRingCountdown();
      this.stopAssistantSpeech();

      this.stopRecording();

      this.closeSocket();

      this.callState = 'loading';
      this.callDuration = 0;
      this.conversation = [];
      this.incomingReady = false;
      this.incomingStatusText = 'Waiting for scheduled AI call...';
      this.turnState = 'assistant';
      this.assistantSpeaking = false;
      this.loadCallLinkContext().then((isPending) => {
        if (!isPending) return;
        this.connectWebSocket().catch((error) => {
          console.error('Reconnection failed:', error);
          this.incomingStatusText = 'Unable to reconnect. Please refresh the page.';
        });
      });
    },
    closeWindow() {
      window.close();
      // If window.close() doesn't work (some browsers block it), show message
      setTimeout(() => {
        this.callState = 'loading';
        this.callDuration = 0;
        this.conversation = [];
        this.loadCallLinkContext();
      }, 100);
    },
    playAudio(base64Audio) {
      return new Promise((resolve) => {
        try {
          const audioData = this.base64ToArrayBuffer(base64Audio);
          const blob = new Blob([audioData], { type: 'audio/wav' });
          const url = URL.createObjectURL(blob);
          const audio = new Audio(url);
          this.currentAudio = audio;

          const finalize = () => {
            URL.revokeObjectURL(url);
            if (this.currentAudio === audio) {
              this.currentAudio = null;
            }
            resolve();
          };

          audio.onended = finalize;
          audio.onerror = finalize;

          const playPromise = audio.play();
          if (playPromise && typeof playPromise.catch === 'function') {
            playPromise.catch((error) => {
              console.warn('Audio playback failed:', error);
              finalize();
            });
          }
        } catch (error) {
          console.warn('playAudio failed:', error);
          resolve();
        }
      });
    },
    speakAssistantText(text) {
      return new Promise((resolve) => {
        if (!('speechSynthesis' in window) || !text) {
          resolve();
          return;
        }

        try {
          window.speechSynthesis.cancel();
          const utterance = new SpeechSynthesisUtterance(text);
          utterance.rate = 1.0;
          utterance.pitch = 1.0;
          utterance.onend = () => resolve();
          utterance.onerror = () => resolve();
          window.speechSynthesis.speak(utterance);
        } catch (error) {
          console.warn('Speech synthesis fallback failed:', error);
          resolve();
        }
      });
    },
    stopAssistantSpeech() {
      if (this.currentAudio) {
        this.currentAudio.pause();
        this.currentAudio = null;
      }
      if ('speechSynthesis' in window) {
        window.speechSynthesis.cancel();
      }
    },
    encodeWAV(samples, sampleRate = 16000) {
      const totalSamples = samples.reduce((sum, frame) => sum + frame.length, 0);
      const buffer = new ArrayBuffer(44 + totalSamples * 2);
      const view = new DataView(buffer);
      
      const numChannels = 1;
      const bytesPerSample = 2;
      
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
    },
    formatDuration(seconds) {
      const mins = Math.floor(seconds / 60);
      const secs = seconds % 60;
      return `${mins}:${secs.toString().padStart(2, '0')}`;
    },
    copyLink() {
      navigator.clipboard.writeText(this.testLink);
      alert('Link copied! Open on your mobile device to test.');
    }
  }
};
</script>

<style scoped>
.mobile-call {
  min-height: 100vh;
  background: #000;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0;
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
}

/* Incoming Call Screen */
.incoming-call {
  background: linear-gradient(180deg, #1a1a1a 0%, #000 100%);
  width: 100%;
  max-width: 500px;
  min-height: 100vh;
  display: flex;
  flex-direction: column;
  justify-content: space-between;
  padding: 3rem 2rem 2rem;
  color: white;
}

.caller-info {
  text-align: center;
  margin-top: 2rem;
}

.avatar {
  width: 100px;
  height: 100px;
  background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 3rem;
  margin: 0 auto 1.5rem;
  box-shadow: 0 10px 40px rgba(102, 126, 234, 0.4);
}

.caller-info h2 {
  font-size: 1.75rem;
  font-weight: 600;
  margin-bottom: 0.5rem;
  color: white;
}

.phone-number {
  font-size: 1.1rem;
  color: #999;
  margin-bottom: 0.5rem;
}

.call-type {
  font-size: 0.95rem;
  color: #666;
  text-transform: uppercase;
  letter-spacing: 1px;
}

.patient-details {
  text-align: center;
  margin: 2rem 0;
  padding: 1.5rem;
  background: rgba(255,255,255,0.05);
  border-radius: 16px;
  backdrop-filter: blur(10px);
}

.patient-name {
  font-size: 1.3rem;
  font-weight: 600;
  margin-bottom: 0.75rem;
  color: white;
}

.appointment-info {
  font-size: 1rem;
  color: #aaa;
  margin-bottom: 0.5rem;
}

.appointment-date {
  font-size: 0.95rem;
  color: #888;
}

.incoming-animation {
  position: relative;
  width: 120px;
  height: 120px;
  margin: 2rem auto;
}

.ring {
  position: absolute;
  width: 100%;
  height: 100%;
  border: 3px solid rgba(102, 126, 234, 0.5);
  border-radius: 50%;
  animation: ripple 2s infinite;
}

.ring:nth-child(2) {
  animation-delay: 0.5s;
}

.ring:nth-child(3) {
  animation-delay: 1s;
}

@keyframes ripple {
  0% {
    transform: scale(0.8);
    opacity: 1;
  }
  100% {
    transform: scale(1.5);
    opacity: 0;
  }
}

.call-actions {
  display: flex;
  justify-content: space-around;
  gap: 2rem;
  margin: 2rem 0;
}

.btn-reject, .btn-accept {
  width: 70px;
  height: 70px;
  border-radius: 50%;
  border: none;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  transition: all 0.3s;
  box-shadow: 0 4px 20px rgba(0,0,0,0.3);
}

.btn-reject {
  background: #ef4444;
}

.btn-reject:hover {
  background: #dc2626;
  transform: scale(1.1);
}

.btn-accept {
  background: #10b981;
}

.btn-accept:hover {
  background: #059669;
  transform: scale(1.1);
}

.btn-accept:disabled {
  background: #4b5563;
  cursor: not-allowed;
  transform: none;
}

.waiting-note {
  text-align: center;
  color: #9ca3af;
  font-size: 0.9rem;
  margin-bottom: 1rem;
}

.btn-reject .icon, .btn-accept .icon {
  font-size: 2rem;
}

.btn-reject .label, .btn-accept .label {
  font-size: 0.75rem;
  color: white;
  margin-top: 0.25rem;
  font-weight: 600;
}

.test-info {
  text-align: center;
  padding: 1rem;
  background: rgba(255,255,255,0.05);
  border-radius: 12px;
  font-size: 0.85rem;
  color: #666;
}

.test-info code {
  display: block;
  margin: 0.5rem 0;
  padding: 0.5rem;
  background: rgba(0,0,0,0.3);
  border-radius: 6px;
  font-size: 0.75rem;
  word-break: break-all;
  color: #999;
}

.btn-copy-small {
  padding: 0.5rem 1rem;
  background: #667eea;
  color: white;
  border: none;
  border-radius: 6px;
  cursor: pointer;
  font-size: 0.85rem;
  margin-top: 0.5rem;
}

/* Active Call Screen */
.call-active {
  background: linear-gradient(180deg, #1a1a1a 0%, #000 100%);
  width: 100%;
  max-width: 500px;
  min-height: 100vh;
  padding: 2rem;
  color: white;
}

.call-header {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 0.5rem;
  margin-bottom: 1rem;
  color: #10b981;
  font-weight: 600;
  font-size: 0.95rem;
}

.status-indicator {
  width: 10px;
  height: 10px;
  background: #10b981;
  border-radius: 50%;
  animation: pulse 2s infinite;
}

@keyframes pulse {
  0%, 100% { opacity: 1; transform: scale(1); }
  50% { opacity: 0.5; transform: scale(1.2); }
}

.call-timer {
  text-align: center;
  font-size: 2.5rem;
  font-weight: 300;
  color: white;
  margin-bottom: 2rem;
  font-variant-numeric: tabular-nums;
}

.conversation-display {
  max-height: 50vh;
  overflow-y: auto;
  margin-bottom: 2rem;
  padding: 1rem;
  background: rgba(255,255,255,0.05);
  border-radius: 16px;
  backdrop-filter: blur(10px);
}

.conversation-display::-webkit-scrollbar {
  width: 4px;
}

.conversation-display::-webkit-scrollbar-track {
  background: rgba(255,255,255,0.05);
}

.conversation-display::-webkit-scrollbar-thumb {
  background: rgba(255,255,255,0.2);
  border-radius: 2px;
}

.message-bubble {
  margin-bottom: 1rem;
  padding: 1rem;
  border-radius: 16px;
  animation: slideIn 0.3s ease-out;
}

@keyframes slideIn {
  from {
    opacity: 0;
    transform: translateY(10px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}

.message-bubble.assistant {
  background: rgba(102, 126, 234, 0.2);
  margin-right: 2rem;
  border-bottom-left-radius: 4px;
}

.message-bubble.user {
  background: rgba(16, 185, 129, 0.2);
  margin-left: 2rem;
  border-bottom-right-radius: 4px;
}

.message-bubble .speaker {
  font-weight: 600;
  font-size: 0.85rem;
  margin-bottom: 0.5rem;
  color: #aaa;
}

.message-bubble .text {
  color: white;
  line-height: 1.5;
  font-size: 0.95rem;
}

.message-bubble .timestamp {
  font-size: 0.75rem;
  color: #666;
  margin-top: 0.5rem;
  text-align: right;
}

.call-controls {
  display: flex;
  gap: 1rem;
  margin-bottom: 1rem;
}

.control-btn {
  flex: 1;
  padding: 1rem;
  border: 2px solid rgba(255,255,255,0.1);
  background: rgba(255,255,255,0.05);
  border-radius: 16px;
  cursor: pointer;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 0.5rem;
  transition: all 0.2s;
  color: white;
}

.control-btn:hover {
  border-color: rgba(255,255,255,0.3);
  background: rgba(255,255,255,0.1);
  transform: translateY(-2px);
}

.control-btn.active {
  background: rgba(239, 68, 68, 0.2);
  border-color: #ef4444;
}

.control-btn.end-call {
  background: #ef4444;
  border-color: #ef4444;
}

.control-btn.end-call:hover {
  background: #dc2626;
  transform: translateY(-2px);
}

.control-btn .icon {
  font-size: 1.5rem;
}

.control-btn .label {
  font-size: 0.9rem;
  font-weight: 600;
}

.audio-indicator {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 0.5rem;
  padding: 1rem;
  background: rgba(16, 185, 129, 0.1);
  border-radius: 12px;
  color: #10b981;
  font-weight: 600;
  font-size: 0.9rem;
}

.wave {
  width: 3px;
  height: 20px;
  background: #10b981;
  border-radius: 2px;
  animation: wave 1s infinite;
}

.wave:nth-child(2) {
  animation-delay: 0.2s;
}

.wave:nth-child(3) {
  animation-delay: 0.4s;
}

@keyframes wave {
  0%, 100% { height: 20px; }
  50% { height: 40px; }
}

/* Call Ended Screen */
.call-ended,
.call-status-screen {
  background: linear-gradient(180deg, #1a1a1a 0%, #000 100%);
  width: 100%;
  max-width: 500px;
  min-height: 100vh;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 2rem;
  color: white;
  text-align: center;
}

.ended-icon {
  width: 100px;
  height: 100px;
  background: #10b981;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 3rem;
  margin-bottom: 2rem;
  color: white;
}

.ended-icon.success {
  background: #10b981;
}

.ended-icon.warning {
  background: #f59e0b;
}

.ended-icon.danger,
.ended-icon.invalid {
  background: #ef4444;
}

.ended-icon.neutral {
  background: #4b5563;
}

.call-ended h2 {
  font-size: 1.75rem;
  margin-bottom: 0.5rem;
  color: white;
}

.ended-message {
  font-size: 1.1rem;
  color: #aaa;
  margin-bottom: 1rem;
}

.ended-duration {
  font-size: 1rem;
  color: #666;
  margin-bottom: 2rem;
}

.ended-info {
  background: rgba(255,255,255,0.05);
  padding: 1.5rem;
  border-radius: 16px;
  margin-bottom: 2rem;
  max-width: 350px;
}

.ended-info p {
  color: #999;
  font-size: 0.95rem;
  line-height: 1.6;
  margin-bottom: 0.5rem;
}

.ended-info p:last-child {
  margin-bottom: 0;
}

.btn-close {
  padding: 1rem 3rem;
  background: rgba(255,255,255,0.1);
  color: white;
  border: 2px solid rgba(255,255,255,0.2);
  border-radius: 50px;
  font-size: 1rem;
  font-weight: 600;
  cursor: pointer;
  transition: all 0.3s;
}

.btn-close:hover {
  background: rgba(255,255,255,0.2);
  border-color: rgba(255,255,255,0.4);
  transform: scale(1.05);
}

@media (max-width: 640px) {
  .incoming-call, .call-active {
    padding: 2rem 1.5rem;
  }
  
  .call-ended,
  .call-status-screen {
    padding: 1.5rem;
  }
  
  .call-actions {
    gap: 3rem;
  }
}
</style>
