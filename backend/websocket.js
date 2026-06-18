const WebSocket = require('ws');
const fs = require('fs');
const path = require('path');
const { query } = require('./services/database');
const llmService = require('./services/ai/llmService');
const { AgentController } = require('./orchestrator/agentController');
const { EVENTS } = require('./orchestrator/eventBus');
const { STATES } = require('./orchestrator/callStateMachine');

const {
  sessions, pendingRings, normalizePatientId, generateSessionId,
  createSession, getSession, deleteSession, loadPatientContext
} = require('./websocket/sessionManager');

const {
  clearPendingRing, handleRingTimeout, handleRingRejection, RING_TIMEOUT_MS
} = require('./websocket/ringManager');

const {
  safeSend, handleAudioChunk, clearSilenceTimer, AUDIO_TMP_DIR
} = require('./websocket/audioHandler');

const {
  flushPendingUserTranscript, handleEndCall, tryGenerateTTS,
  ensureRealtimeLeaseReady, estimateWavDurationMs
} = require('./websocket/turnProcessor');

const agentController = new AgentController();
let callStartListenerRegistered = false;
const MAX_CALL_DURATION_MS = parseInt(process.env.MAX_CALL_DURATION_MS, 10) || 10 * 60 * 1000;
const ASSISTANT_SPEECH_GUARD_MS = parseInt(process.env.ASSISTANT_SPEECH_GUARD_MS, 10) || 350;

async function buildGreetingCache(patientId) {
  const greetingText = await agentController.getGreeting(patientId);
  const ttsPath = path.join(AUDIO_TMP_DIR, `pregreet_${patientId}_${Date.now()}.wav`);
  let audioBase64 = null;

  try {
    const audioFile = await tryGenerateTTS(greetingText, ttsPath);
    if (audioFile) {
      audioBase64 = fs.readFileSync(ttsPath).toString('base64');
    }
  } finally {
    try { if (fs.existsSync(ttsPath)) fs.unlinkSync(ttsPath); } catch (_) {}
  }

  return { text: greetingText, audioBase64 };
}

function initWebSocket(server) {
  const wss = new WebSocket.Server({ server, path: '/ws' });

  if (global.eventBus && !callStartListenerRegistered) {
    global.eventBus.on(EVENTS.CALL_RINGING, async (payload) => {
      const targetPatientId = normalizePatientId(payload.patientId);
      if (!targetPatientId) return;

      clearPendingRing(targetPatientId);

      for (const [sessionId, session] of sessions.entries()) {
        if (session.registeredPatientId === targetPatientId) {
          safeSend(session.ws, {
            type: 'incoming_call', sessionId, patientId: targetPatientId,
            campaignId: payload.campaignId || null, callId: payload.callId || null,
            scheduledFor: payload.scheduledFor || null,
            timeoutMs: RING_TIMEOUT_MS, retryAttempt: payload.retryAttempt || 0
          });
        }
      }

      const timeoutHandle = setTimeout(() => {
        handleRingTimeout({
          patientId: targetPatientId, campaignId: payload.campaignId || null,
          organizationId: payload.organizationId || null,
          retryAttempt: payload.retryAttempt || 0, maxRetries: payload.maxRetries || 3
        }).catch(err => console.error('Ring timeout handler error:', err));
      }, RING_TIMEOUT_MS);

      const ringState = {
        timeoutHandle, campaignId: payload.campaignId || null,
        organizationId: payload.organizationId || null,
        retryAttempt: payload.retryAttempt || 0, maxRetries: payload.maxRetries || 3,
        greetingText: null, greetingAudioBase64: null, greetingReady: false,
        greetingPromise: null
      };

      pendingRings.set(String(targetPatientId), ringState);

      ringState.greetingPromise = (async () => {
        try {
          const cached = await buildGreetingCache(targetPatientId);
          const pending = pendingRings.get(String(targetPatientId));

          if (pending === ringState) {
            pending.greetingText = cached.text;
            pending.greetingAudioBase64 = cached.audioBase64;
            pending.greetingReady = true;
          }
          return cached;
        } catch (err) {
          console.warn(`[GREETING-CACHE] Pre-generation failed for patient ${targetPatientId}: ${err.message}`);
          return null;
        }
      })();
    });
    callStartListenerRegistered = true;
  }

  wss.on('connection', (ws) => {
    const sessionId = generateSessionId();
    if (!fs.existsSync(AUDIO_TMP_DIR)) fs.mkdirSync(AUDIO_TMP_DIR, { recursive: true });
    createSession(ws, sessionId, AUDIO_TMP_DIR);

    ws.on('message', async (message, isBinary) => {
      try {
        const data = decodeIncomingMessage(message, isBinary);
        if (!data) return;

        if (data.type === 'start_call') {
          const session = getSession(sessionId);
          if (!session) { safeSend(ws, { type: 'error', message: 'Session not found' }); return; }

          const requestedPatientId = normalizePatientId(data.patientId);
          if (session.registeredPatientId && session.registeredPatientId !== requestedPatientId) {
            safeSend(ws, { type: 'error', message: 'Session not authorized for this patient' });
            return;
          }
          await handleStartCall(sessionId, data.patientId);
        } else if (data.type === 'register_patient') {
          const session = getSession(sessionId);
          if (session) session.registeredPatientId = normalizePatientId(data.patientId);
          safeSend(ws, { type: 'patient_registered', patientId: normalizePatientId(data.patientId) });
        } else if (data.type === 'reject_call') {
          await handleRingRejection(normalizePatientId(data.patientId));
        } else if (data.type === 'audio_chunk') {
          await handleAudioChunk(sessionId, data.data, flushPendingUserTranscript);
        } else if (data.type === 'end_call') {
          await handleEndCall(sessionId, data.patientId);
        } else {
          console.warn(`Unknown WebSocket message type: ${data.type}`);
        }
      } catch (error) {
        console.error('WebSocket message error:', error);
        safeSend(ws, { type: 'error', message: 'Failed to process message' });
      }
    });

    ws.on('close', () => {
      const session = getSession(sessionId);
      if (session?.callId && !session.ended) {
        handleEndCall(sessionId, session.patientId).catch(err => {
          console.error('Failed to auto-end call on socket close:', err);
          deleteSession(sessionId);
        });
        return;
      }
      deleteSession(sessionId);
    });

    safeSend(ws, { type: 'connected', sessionId });
  });

  console.log('WebSocket server initialized');
}

function decodeIncomingMessage(message, isBinary) {
  if (isBinary) {
    const chunk = Buffer.isBuffer(message) ? message : Buffer.from(message);
    return { type: 'audio_chunk', data: chunk.toString('base64') };
  }

  const raw = typeof message === 'string' ? message :
    Buffer.isBuffer(message) ? message.toString('utf8') : String(message || '');
  const trimmed = raw.trim();
  if (!trimmed) return null;

  try {
    return JSON.parse(trimmed);
  } catch (_) {
    const looksLikeBase64 = /^[A-Za-z0-9+/=\s]+$/.test(trimmed) && trimmed.length > 128;
    if (looksLikeBase64) return { type: 'audio_chunk', data: trimmed };
    throw new Error('Invalid message format');
  }
}

async function handleStartCall(sessionId, patientId) {
  const session = getSession(sessionId);
  if (!session) return;

  try {
    if (llmService.available === null) {
      try { await llmService.checkAvailability(); } catch (e) { console.warn('LLM availability check failed:', e.message); }
    }
    if (llmService.available === false) {
      safeSend(session.ws, { type: 'error', message: 'Our AI assistant is temporarily unavailable. Please try again shortly.' });
      session.finalState = STATES.FAILED;
      await handleEndCall(sessionId, patientId).catch(() => {});
      return;
    }

    session.patientId = normalizePatientId(patientId);

    const cachedRing = pendingRings.get(String(session.patientId));
    let cachedGreeting = cachedRing?.greetingReady ? {
      text: cachedRing.greetingText, audioBase64: cachedRing.greetingAudioBase64
    } : null;

    clearPendingRing(session.patientId);
    session.startTime = Date.now();
    session.finalState = STATES.COMPLETED;
    session.requiresFollowup = false;
    session.pendingUserTranscript = '';
    session.conversationSummary = '';
    session.turnCount = 0;
    session.goalStatus = 'pending';
    session.ended = false;
    session.llmBusy = false;

    clearSilenceTimer(session);

    ensureRealtimeLeaseReady(session).catch(err => console.error('Realtime model warm-up failed:', err.message));

    if (session.maxCallTimer) clearTimeout(session.maxCallTimer);
    session.maxCallTimer = setTimeout(() => {
      const liveSession = getSession(sessionId);
      if (!liveSession || liveSession.ended) return;
      liveSession.finalState = liveSession.requiresFollowup ? STATES.REQUIRES_FOLLOWUP : STATES.COMPLETED;
      handleEndCall(sessionId, liveSession.patientId).catch(err => console.error('Max call duration timeout:', err.message));
    }, MAX_CALL_DURATION_MS);

    const patientContext = await loadPatientContext(session.patientId);
    session.patientContext = patientContext;

    if (!session.callId) {
      const callResult = await query(
        `INSERT INTO calls (organization_id, patient_id, campaign_id, transcript, duration, state,
          sentiment, appointment_confirmed, requested_callback, summary)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id`,
        [patientContext?.organization_id || 1, patientContext?.id || null,
         patientContext?.campaign_id || null, '', 0, STATES.IN_PROGRESS,
         'neutral', false, false, '']
      );
      session.callId = callResult.rows[0].id;
    }

    if (patientContext?.id) {
      await query(`UPDATE patients SET status = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2`,
        ['calling', patientContext.id]);
    }

    if (!cachedGreeting?.text && cachedRing?.greetingPromise) {
      cachedGreeting = await cachedRing.greetingPromise.catch((err) => {
        console.warn(`[GREETING-CACHE] Await failed for patient ${session.patientId}: ${err.message}`);
        return null;
      });
    }

    let greeting, greetingAudioBase64 = null;
    if (cachedGreeting?.text) {
      greeting = cachedGreeting.text;
      greetingAudioBase64 = cachedGreeting.audioBase64;
    } else {
      greeting = await agentController.getGreeting(session.patientId);
    }

    session.conversation.push({ role: 'assistant', text: greeting, timestamp: new Date().toISOString() });

    if (greetingAudioBase64) {
      const audioBuffer = Buffer.from(greetingAudioBase64, 'base64');
      session.assistantSpeakingUntil = Date.now() + estimateWavDurationMs(audioBuffer) + ASSISTANT_SPEECH_GUARD_MS;
      safeSend(session.ws, { type: 'ai_audio', data: greetingAudioBase64, transcript: greeting, greeting: true });
    } else {
      const ttsPath = path.join(AUDIO_TMP_DIR, `greeting_${sessionId}_${Date.now()}.wav`);
      const audioFile = await tryGenerateTTS(greeting, ttsPath);
      if (audioFile) {
        const audioData = fs.readFileSync(ttsPath);
        session.assistantSpeakingUntil = Date.now() + estimateWavDurationMs(audioData) + ASSISTANT_SPEECH_GUARD_MS;
        safeSend(session.ws, { type: 'ai_audio', data: audioData.toString('base64'), transcript: greeting, greeting: true });
        try { if (fs.existsSync(ttsPath)) fs.unlinkSync(ttsPath); } catch (_) {}
      } else {
        safeSend(session.ws, { type: 'ai_response', transcript: greeting, greeting: true });
        session.assistantSpeakingUntil = Date.now() + 2500;
      }
    }

    if (global.eventBus) {
      await global.eventBus.emit(EVENTS.CALL_STARTED, {
        callId: session.callId, sessionId, organizationId: patientContext?.organization_id || 1,
        patientId: session.patientId, timestamp: new Date().toISOString()
      });
    }
  } catch (error) {
    console.error('Start call error:', error);
    safeSend(session.ws, { type: 'error', message: 'Failed to start call' });
    await handleEndCall(sessionId, patientId).catch(() => {});
  }
}

module.exports = { initWebSocket };
