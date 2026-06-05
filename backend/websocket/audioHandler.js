const fs = require('fs');
const path = require('path');
const sttService = require('../services/ai/sttService');
const { getSession } = require('./sessionManager');

const AUDIO_TMP_DIR = process.env.AUDIO_TMP_DIR || '/tmp/healthcare_audio';
const STT_REALTIME_CHUNK_MS = parseInt(process.env.STT_REALTIME_CHUNK_MS, 10) || 1000;
const SILENCE_FINALIZE_MS = parseInt(process.env.STT_SILENCE_MS, 10) || 500;
const REQUIRE_SERVER_TTS = String(process.env.REQUIRE_SERVER_TTS || 'false').toLowerCase() === 'true';

const NON_SPEECH_MARKERS = [
  '[BLANK_AUDIO]', '[SILENCE]', '(SILENCE)', '[NO_SPEECH]', '[MUSIC]',
  '<|NOSPEECH|>', '<|SILENCE|>', '(beep)', '[beep]', '(BEEP)', '[BEEP]'
];

function escapeRegex(value) {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const NON_SPEECH_MARKER_REGEX = new RegExp(
  NON_SPEECH_MARKERS.map(m => escapeRegex(m)).join('|'), 'gi'
);

function sanitizeTranscriptText(input) {
  let text = String(input || '')
    .replace(/^\s*(patient|assistant)\s*:\s*/i, '')
    .replace(NON_SPEECH_MARKER_REGEX, ' ')
    .replace(/\b(?:blank[_ ]audio|no[_ ]speech|beep)\b/gi, ' ')
    .replace(/\s+/g, ' ').trim();
  if (text) text = text.replace(/^[,.;:!?-]+|[,.;:!?-]+$/g, '').trim();
  if (!text || NON_SPEECH_MARKERS.includes(text.toUpperCase())) return '';
  return text;
}

function isMeaningfulTranscript(input) {
  const text = sanitizeTranscriptText(input);
  if (!text) return false;
  const words = text.toLowerCase().split(/\s+/).filter(Boolean);
  return words.some(w => w.replace(/[^a-z]/g, '').length >= 2);
}

function sanitizeAssistantText(input) {
  const text = sanitizeTranscriptText(input);
  return text || 'Could you please repeat that?';
}

function cleanupFile(filePath) {
  try {
    if (filePath && fs.existsSync(filePath)) fs.unlinkSync(filePath);
  } catch (err) {
    console.warn('File cleanup error:', err.message);
  }
}

function clearSilenceTimer(session) {
  if (session?.silenceTimer) {
    clearTimeout(session.silenceTimer);
    session.silenceTimer = null;
  }
}

function safeSend(ws, data) {
  try {
    if (ws.readyState === 1) ws.send(JSON.stringify(data));
  } catch (err) {
    console.error('WebSocket send error:', err.message);
  }
}

async function handleAudioChunk(sessionId, audioData, flushCallback) {
  const session = getSession(sessionId);
  if (!session || session.ended) return;
  let audioPath = null;

  try {
    if (Date.now() < (session.assistantSpeakingUntil || 0) || session.llmBusy) return;

    const audioBuffer = Buffer.from(audioData, 'base64');
    if (!audioBuffer || audioBuffer.length < 1024) return;

    audioPath = path.join(AUDIO_TMP_DIR, `input_${sessionId}_${Date.now()}.wav`);
    fs.writeFileSync(audioPath, audioBuffer);

    const sttStartedAt = Date.now();
    const sttResult = await sttService.transcribeRealtime(audioPath, {
      chunkMs: STT_REALTIME_CHUNK_MS,
      silenceThresholdMs: SILENCE_FINALIZE_MS
    });
    console.log(`[LATENCY][STT] ${Date.now() - sttStartedAt}ms`);
    cleanupFile(audioPath);
    audioPath = null;

    const transcript = sanitizeTranscriptText(sttResult.transcript || '');
    if (isMeaningfulTranscript(transcript)) {
      const pending = sanitizeTranscriptText(session.pendingUserTranscript || '');
      if (!pending) {
        session.pendingUserTranscript = transcript;
      } else if (transcript.toLowerCase().startsWith(pending.toLowerCase())) {
        session.pendingUserTranscript = transcript;
      } else {
        session.pendingUserTranscript = `${pending} ${transcript}`.replace(/\s+/g, ' ').trim();
      }
      safeSend(session.ws, { type: 'partial_transcript', transcript: session.pendingUserTranscript });
    }

    clearSilenceTimer(session);
    if (sttResult.isFinal) {
      await flushCallback(sessionId, true);
      return;
    }

    const trailingSilenceMs = Number(sttResult.trailingSilenceMs || 0);
    if (trailingSilenceMs > 0) {
      const waitMs = Math.max(80, SILENCE_FINALIZE_MS - trailingSilenceMs);
      session.silenceTimer = setTimeout(() => {
        session.silenceTimer = null;
        flushCallback(sessionId, true).catch(err => {
          console.error('Silence-triggered flush failed:', err.message);
        });
      }, waitMs);
    }
  } catch (error) {
    console.error('Audio processing error:', error);
    if (REQUIRE_SERVER_TTS && error?.code === 'TTS_REQUIRED_UNAVAILABLE') {
      safeSend(session.ws, { type: 'error', message: 'Voice service unavailable. Please try again shortly.' });
      if (typeof flushCallback === 'function') {
        flushCallback(sessionId, session.patientId).catch(() => {});
      }
      return;
    }
    safeSend(session.ws, { type: 'audio_warning', message: 'Audio chunk could not be processed. Please continue speaking.' });
  } finally {
    cleanupFile(audioPath);
  }
}

module.exports = {
  sanitizeTranscriptText, isMeaningfulTranscript, sanitizeAssistantText,
  cleanupFile, clearSilenceTimer, safeSend, handleAudioChunk,
  AUDIO_TMP_DIR
};
