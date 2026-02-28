const WebSocket = require('ws');
const fs = require('fs');
const path = require('path');
const sttService = require('./services/ai/sttService');
const llmService = require('./services/ai/llmService');
const ttsService = require('./services/ai/ttsService');
const { detectEmergencyRisk, EMERGENCY_GUIDANCE } = require('./services/ai/healthcareSafety');
const { buildSlidingWindowMemory } = require('./services/ai/conversationMemory');
const { query } = require('./services/database');
const { CallStateMachine, STATES } = require('./orchestrator/callStateMachine');
const { AgentController } = require('./orchestrator/agentController');
const { EVENTS } = require('./orchestrator/eventBus');
const postCallPipeline = require('./workflows/postCallPipeline');

const sessions = new Map();
const pendingRings = new Map();
const stateMachine = new CallStateMachine();
const agentController = new AgentController();
let callStartListenerRegistered = false;
const RING_TIMEOUT_MS = parseInt(process.env.RING_TIMEOUT_MS, 10) || 30000;
const CALL_SPACING_MS = parseInt(process.env.CALL_SPACING_MS, 10) || 15000;
const AUDIO_TMP_DIR = process.env.AUDIO_TMP_DIR || '/tmp/healthcare_audio';
const REQUIRE_SERVER_TTS = String(process.env.REQUIRE_SERVER_TTS || 'false').toLowerCase() === 'true';
const MAX_CALL_DURATION_MS = parseInt(process.env.MAX_CALL_DURATION_MS, 10) || 10 * 60 * 1000;
const MAX_CONVERSATION_TURNS = parseInt(process.env.MAX_CONVERSATION_TURNS, 10) || 30;
const SILENCE_FINALIZE_MS = parseInt(process.env.STT_SILENCE_MS, 10) || 800;
const ASSISTANT_SPEECH_GUARD_MS = parseInt(process.env.ASSISTANT_SPEECH_GUARD_MS, 10) || 300;
const NON_SPEECH_MARKERS = [
  '[BLANK_AUDIO]',
  '[SILENCE]',
  '(SILENCE)',
  '[NO_SPEECH]',
  '[MUSIC]',
  '<|NOSPEECH|>',
  '<|SILENCE|>'
];

function escapeRegex(value) {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const NON_SPEECH_MARKER_REGEX = new RegExp(
  NON_SPEECH_MARKERS.map((marker) => escapeRegex(marker)).join('|'),
  'gi'
);

function sanitizeTranscriptText(input) {
  let text = String(input || '')
    .replace(/^\s*(patient|assistant)\s*:\s*/i, '')
    .replace(NON_SPEECH_MARKER_REGEX, ' ')
    .replace(/\b(?:blank[_ ]audio|no[_ ]speech)\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (text) {
    text = text.replace(/^[,.;:!?-]+|[,.;:!?-]+$/g, '').trim();
  }

  if (!text) return '';
  if (NON_SPEECH_MARKERS.includes(text.toUpperCase())) return '';
  return text;
}

function isMeaningfulTranscript(input) {
  const text = sanitizeTranscriptText(input);
  if (!text) return false;

  // Require at least one word with >= 2 letters to avoid pure filler/noise tokens.
  const words = text.toLowerCase().split(/\s+/).filter(Boolean);
  return words.some((word) => word.replace(/[^a-z]/g, '').length >= 2);
}

function sanitizeAssistantText(input) {
  const text = sanitizeTranscriptText(input);
  return text || 'Could you please repeat that?';
}

function logLatency(label, startedAt) {
  const duration = Date.now() - startedAt;
  console.log(`[LATENCY][${label}] ${duration}ms`);
}

function clearSilenceTimer(session) {
  if (session?.silenceTimer) {
    clearTimeout(session.silenceTimer);
    session.silenceTimer = null;
  }
}

async function ensureRealtimeLeaseReady(session) {
  if (!session || session.ended) return;
  if (session.realtimeRelease) return;

  if (!session.realtimeLeasePromise) {
    session.realtimeLeasePromise = llmService.acquireRealtimeSession()
      .then((release) => {
        session.realtimeRelease = release;
        session.realtimeLeasePromise = null;
        return release;
      })
      .catch((error) => {
        session.realtimeLeasePromise = null;
        throw error;
      });
  }

  await session.realtimeLeasePromise;
}

async function releaseRealtimeLease(session) {
  if (!session) return;

  try {
    if (!session.realtimeRelease && session.realtimeLeasePromise) {
      await session.realtimeLeasePromise.catch(() => null);
    }
  } catch (_) {
    // Best effort: release handler below covers the successful acquisition path.
  }

  try {
    if (session.realtimeRelease) {
      const release = session.realtimeRelease;
      session.realtimeRelease = null;
      await release();
    }
  } finally {
    session.realtimeLeasePromise = null;
  }
}

function estimateWavDurationMs(audioBuffer) {
  if (!Buffer.isBuffer(audioBuffer) || audioBuffer.length < 44) return 0;
  if (audioBuffer.toString('ascii', 0, 4) !== 'RIFF' || audioBuffer.toString('ascii', 8, 12) !== 'WAVE') return 0;

  const channels = audioBuffer.readUInt16LE(22) || 1;
  const sampleRate = audioBuffer.readUInt32LE(24) || 16000;
  const bitsPerSample = audioBuffer.readUInt16LE(34) || 16;
  const dataBytes = Math.max(0, audioBuffer.length - 44);
  const bytesPerSecond = sampleRate * channels * (bitsPerSample / 8);
  if (!bytesPerSecond) return 0;
  return Math.floor((dataBytes / bytesPerSecond) * 1000);
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
            type: 'incoming_call',
            sessionId,
            patientId: targetPatientId,
            campaignId: payload.campaignId || null,
            callId: payload.callId || null,
            scheduledFor: payload.scheduledFor || null,
            timeoutMs: RING_TIMEOUT_MS,
            retryAttempt: payload.retryAttempt || 0
          });
        }
      }

      const timeoutHandle = setTimeout(() => {
        handleRingTimeout({
          patientId: targetPatientId,
          campaignId: payload.campaignId || null,
          organizationId: payload.organizationId || null,
          retryAttempt: payload.retryAttempt || 0,
          maxRetries: payload.maxRetries || 3
        }).catch((err) => {
          console.error('Ring timeout handler error:', err);
        });
      }, RING_TIMEOUT_MS);

      pendingRings.set(String(targetPatientId), {
        timeoutHandle,
        campaignId: payload.campaignId || null,
        organizationId: payload.organizationId || null,
        retryAttempt: payload.retryAttempt || 0,
        maxRetries: payload.maxRetries || 3,
        greetingText: null,
        greetingAudioBase64: null,
        greetingReady: false
      });

      // Pre-generate greeting + TTS audio while patient sees the ring screen
      (async () => {
        try {
          const greetingText = await agentController.getGreeting(targetPatientId);
          const pending = pendingRings.get(String(targetPatientId));
          if (!pending) return; // patient already answered or timed out

          const ttsPath = path.join(AUDIO_TMP_DIR, `pregreet_${targetPatientId}_${Date.now()}.wav`);
          const audioFile = await tryGenerateTTS(greetingText, ttsPath);
          let audioBase64 = null;
          if (audioFile) {
            const audioData = fs.readFileSync(ttsPath);
            audioBase64 = audioData.toString('base64');
            cleanupFile(ttsPath);
          }

          // Store on pending ring entry
          const stillPending = pendingRings.get(String(targetPatientId));
          if (stillPending) {
            stillPending.greetingText = greetingText;
            stillPending.greetingAudioBase64 = audioBase64;
            stillPending.greetingReady = true;
            console.log(`[GREETING-CACHE] Pre-generated greeting for patient ${targetPatientId}`);
          } else {
            cleanupFile(ttsPath);
          }
        } catch (err) {
          console.warn(`[GREETING-CACHE] Pre-generation failed for patient ${targetPatientId}: ${err.message}`);
        }
      })();
    });
    callStartListenerRegistered = true;
  }

  wss.on('connection', (ws) => {
    console.log('WebSocket client connected');

    const sessionId = generateSessionId();
    const audioDir = AUDIO_TMP_DIR;

    // Ensure audio directory exists
    if (!fs.existsSync(audioDir)) {
      fs.mkdirSync(audioDir, { recursive: true });
    }

    sessions.set(sessionId, {
      ws,
      conversation: [],
      conversationSummary: '',
      startTime: Date.now(),
      turnCount: 0,
      callId: null,
      registeredPatientId: null,
      finalState: STATES.COMPLETED,
      requiresFollowup: false,
      pendingUserTranscript: '',
      silenceTimer: null,
      llmBusy: false,
      assistantSpeakingUntil: 0,
      realtimeRelease: null,
      realtimeLeasePromise: null,
      maxCallTimer: null,
      goalStatus: 'pending',
      ended: false
    });

    ws.on('message', async (message, isBinary) => {
      try {
        const data = decodeIncomingMessage(message, isBinary);
        if (!data) {
          return;
        }

        if (data.type === 'start_call') {
          const session = sessions.get(sessionId);
          if (!session) {
            safeSend(ws, {
              type: 'error',
              message: 'Session not found'
            });
            return;
          }

          // Validate session is registered for this patient
          const requestedPatientId = normalizePatientId(data.patientId);
          if (session.registeredPatientId && session.registeredPatientId !== requestedPatientId) {
            console.error(`Session validation failed: registered=${session.registeredPatientId}, requested=${requestedPatientId}`);
            safeSend(ws, {
              type: 'error',
              message: 'Session not authorized for this patient'
            });
            return;
          }

          await handleStartCall(sessionId, data.patientId);
        } else if (data.type === 'register_patient') {
          const session = sessions.get(sessionId);
          if (session) {
            session.registeredPatientId = normalizePatientId(data.patientId);
          }
          safeSend(ws, {
            type: 'patient_registered',
            patientId: normalizePatientId(data.patientId)
          });
        } else if (data.type === 'reject_call') {
          await handleRingRejection(normalizePatientId(data.patientId));
        } else if (data.type === 'audio_chunk') {
          await handleAudioChunk(sessionId, data.data);
        } else if (data.type === 'end_call') {
          await handleEndCall(sessionId, data.patientId);
        } else {
          // Ignore unknown message types to keep call session resilient.
          console.warn(`Unknown WebSocket message type received: ${data.type}`);
        }
      } catch (error) {
        console.error('WebSocket message error:', error);
        safeSend(ws, {
          type: 'error',
          message: 'Failed to process message'
        });
      }
    });

    ws.on('close', () => {
      console.log('WebSocket client disconnected');
      const session = sessions.get(sessionId);

      if (session?.callId && !session.ended) {
        handleEndCall(sessionId, session.patientId).catch((err) => {
          console.error('Failed to auto-end call on socket close:', err);
          sessions.delete(sessionId);
        });
        return;
      }

      sessions.delete(sessionId);
    });

    safeSend(ws, {
      type: 'connected',
      sessionId
    });
  });

  console.log('WebSocket server initialized');
}

/**
 * Safely send a JSON message to a WebSocket client
 * @param {WebSocket} ws - WebSocket connection
 * @param {object} data - Data to send
 */
function safeSend(ws, data) {
  try {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(data));
    }
  } catch (err) {
    console.error('WebSocket send error:', err.message);
  }
}

/**
 * Parse incoming ws payloads.
 * Supports JSON control messages and binary/raw audio frames for compatibility.
 */
function decodeIncomingMessage(message, isBinary) {
  if (isBinary) {
    const chunk = Buffer.isBuffer(message) ? message : Buffer.from(message);
    return {
      type: 'audio_chunk',
      data: chunk.toString('base64')
    };
  }

  const raw = typeof message === 'string'
    ? message
    : Buffer.isBuffer(message)
      ? message.toString('utf8')
      : String(message || '');
  const trimmed = raw.trim();

  if (!trimmed) {
    return null;
  }

  try {
    return JSON.parse(trimmed);
  } catch (error) {
    // Legacy clients may send base64 audio frames directly without JSON wrapper.
    const looksLikeBase64 = /^[A-Za-z0-9+/=\s]+$/.test(trimmed) && trimmed.length > 128;
    if (looksLikeBase64) {
      return {
        type: 'audio_chunk',
        data: trimmed
      };
    }
    throw error;
  }
}

/**
 * Generate TTS audio.
 * In production mode (REQUIRE_SERVER_TTS=true), failure is fatal.
 * @param {string} text - Text to synthesize
 * @param {string} outputPath - Where to save audio
 * @returns {Promise<string|null>} Audio file path or null
 */
async function tryGenerateTTS(text, outputPath) {
  try {
    await ttsService.synthesize(text, outputPath);
    return outputPath;
  } catch (error) {
    if (REQUIRE_SERVER_TTS) {
      const err = new Error('Server TTS is required but unavailable');
      err.code = 'TTS_REQUIRED_UNAVAILABLE';
      throw err;
    }
    console.warn('TTS unavailable, sending text-only response:', error.message);
    return null;
  }
}

/**
 * Handle call start - send personalized greeting
 * @param {string} sessionId - Session ID
 * @param {number} patientId - Patient ID
 */
async function handleStartCall(sessionId, patientId) {
  const session = sessions.get(sessionId);
  if (!session) return;

  try {
    session.patientId = normalizePatientId(patientId);

    // Save pre-generated greeting cache BEFORE clearing the pending ring
    const cachedRing = pendingRings.get(String(session.patientId));
    const cachedGreeting = cachedRing?.greetingReady ? {
      text: cachedRing.greetingText,
      audioBase64: cachedRing.greetingAudioBase64
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

    // Warm realtime model at call start without blocking first greeting audio.
    ensureRealtimeLeaseReady(session).catch((error) => {
      console.error('Realtime model warm-up failed at call start:', error.message);
    });

    if (session.maxCallTimer) {
      clearTimeout(session.maxCallTimer);
    }
    session.maxCallTimer = setTimeout(() => {
      const liveSession = sessions.get(sessionId);
      if (!liveSession || liveSession.ended) return;
      liveSession.finalState = liveSession.requiresFollowup ? STATES.REQUIRES_FOLLOWUP : STATES.COMPLETED;
      handleEndCall(sessionId, liveSession.patientId).catch((error) => {
        console.error('Failed to enforce max call duration timeout:', error.message);
      });
    }, MAX_CALL_DURATION_MS);

    const patientContext = await loadPatientContext(session.patientId);
    session.patientContext = patientContext;

    // Create call record at start so events/transcript share one call ID
    if (!session.callId) {
      const organizationId = patientContext?.organization_id || 1;
      const campaignId = patientContext?.campaign_id || null;
      const validPatientId = patientContext?.id || null;

      const callResult = await query(
        `INSERT INTO calls (
          organization_id, patient_id, campaign_id, transcript, duration, state,
          sentiment, appointment_confirmed, requested_callback, summary
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
        RETURNING id`,
        [
          organizationId,
          validPatientId,
          campaignId,
          '',
          0,
          STATES.IN_PROGRESS,
          'neutral',
          false,
          false,
          ''
        ]
      );
      session.callId = callResult.rows[0].id;
    }

    if (patientContext?.id) {
      await query(
        `UPDATE patients SET status = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2`,
        ['calling', patientContext.id]
      );
    }

    // Use pre-generated greeting saved before clearPendingRing
    let greeting;
    let greetingAudioBase64 = null;

    if (cachedGreeting?.text) {
      greeting = cachedGreeting.text;
      greetingAudioBase64 = cachedGreeting.audioBase64;
      console.log('[GREETING-CACHE] Using pre-generated greeting (instant delivery)');
    } else {
      // Fallback: generate greeting now (only if cache missed)
      console.log('[GREETING-CACHE] Cache miss, generating greeting now...');
      greeting = await agentController.getGreeting(session.patientId);
    }

    console.log('Starting call with greeting:', greeting);

    // Add greeting to conversation
    session.conversation.push({
      role: 'assistant',
      text: greeting,
      timestamp: new Date().toISOString()
    });

    if (greetingAudioBase64) {
      // Use pre-generated audio (ultra-fast path)
      const audioBuffer = Buffer.from(greetingAudioBase64, 'base64');
      const durationMs = estimateWavDurationMs(audioBuffer);
      session.assistantSpeakingUntil = Date.now() + durationMs + ASSISTANT_SPEECH_GUARD_MS;

      safeSend(session.ws, {
        type: 'ai_audio',
        data: greetingAudioBase64,
        transcript: greeting,
        greeting: true
      });
    } else {
      // Generate TTS now (fallback path)
      const ttsPath = path.join(AUDIO_TMP_DIR, `greeting_${sessionId}_${Date.now()}.wav`);
      const audioFile = await tryGenerateTTS(greeting, ttsPath);

      if (audioFile) {
        const audioData = fs.readFileSync(ttsPath);
        const audioBase64 = audioData.toString('base64');
        const durationMs = estimateWavDurationMs(audioData);
        session.assistantSpeakingUntil = Date.now() + durationMs + ASSISTANT_SPEECH_GUARD_MS;

        safeSend(session.ws, {
          type: 'ai_audio',
          data: audioBase64,
          transcript: greeting,
          greeting: true
        });

        cleanupFile(ttsPath);
      } else {
        // Text-only greeting when TTS unavailable
        safeSend(session.ws, {
          type: 'ai_response',
          transcript: greeting,
          greeting: true
        });
        session.assistantSpeakingUntil = Date.now() + 2500;
      }
    }

    // Emit call started event
    if (global.eventBus) {
      await global.eventBus.emit(EVENTS.CALL_STARTED, {
        callId: session.callId,
        sessionId,
        organizationId: patientContext?.organization_id || 1,
        patientId: session.patientId,
        timestamp: new Date().toISOString()
      });
    }

  } catch (error) {
    console.error('Start call error:', error);
    safeSend(session.ws, {
      type: 'error',
      message: REQUIRE_SERVER_TTS
        ? 'Voice service unavailable. Please try again shortly.'
        : 'Failed to start call'
    });

    // Ensure runtime state is finalized when call cannot start.
    await handleEndCall(sessionId, patientId).catch((endErr) => {
      console.error('Failed to finalize call after start failure:', endErr);
    });
  }
}

function buildCampaignObjective(session) {
  return (
    session?.patientContext?.campaign_script_template ||
    session?.patientContext?.campaign_name ||
    'Confirm appointment details and identify whether manual follow-up is needed.'
  );
}

async function flushPendingUserTranscript(sessionId, force = false) {
  const session = sessions.get(sessionId);
  if (!session || session.ended || session.llmBusy) return;

  const assistantBusyForMs = (session.assistantSpeakingUntil || 0) - Date.now();
  if (assistantBusyForMs > 0) {
    if (!session.silenceTimer) {
      session.silenceTimer = setTimeout(() => {
        session.silenceTimer = null;
        flushPendingUserTranscript(sessionId, force).catch((error) => {
          console.error('Deferred transcript flush failed:', error.message);
        });
      }, Math.min(assistantBusyForMs + 80, 1200));
    }
    return;
  }

  const transcript = sanitizeTranscriptText(session.pendingUserTranscript || '');
  if (!isMeaningfulTranscript(transcript)) {
    if (force) {
      session.pendingUserTranscript = '';
    }
    return;
  }

  session.pendingUserTranscript = '';
  session.llmBusy = true;

  try {
    session.turnCount += 1;

    if (session.turnCount > MAX_CONVERSATION_TURNS) {
      session.finalState = STATES.COMPLETED;
      safeSend(session.ws, {
        type: 'ai_response',
        transcript: 'Thank you for your time today. We will end this call now.',
        shouldEnd: true
      });
      setTimeout(() => {
        handleEndCall(sessionId, session.patientId).catch((error) => {
          console.error('Failed to end call after turn-limit cap:', error.message);
        });
      }, 600);
      return;
    }

    session.conversation.push({
      role: 'user',
      text: transcript,
      timestamp: new Date().toISOString()
    });

    safeSend(session.ws, {
      type: 'user_speech',
      transcript
    });

    if (session.callId) {
      await stateMachine.transition(session.callId, STATES.AWAITING_RESPONSE, {
        turnCount: session.turnCount
      });
    }

    if (global.eventBus) {
      await global.eventBus.emit(EVENTS.CALL_TRANSCRIBED, {
        callId: session.callId,
        sessionId,
        transcript,
        turnCount: session.turnCount
      });
    }

    let realtimeTurn = null;
    const emergency = detectEmergencyRisk(transcript);
    if (emergency.detected) {
      realtimeTurn = {
        reply: EMERGENCY_GUIDANCE,
        action: 'transfer_human',
        goal_status: 'failed',
        risk_detected: true,
        confidence: 1
      };
    } else {
      await ensureRealtimeLeaseReady(session);
      const memory = buildSlidingWindowMemory(session.conversation, session.conversationSummary);
      session.conversationSummary = memory.summary;

      const llmStartedAt = Date.now();
      realtimeTurn = await llmService.generateRealtimeTurn({
        campaignObjective: buildCampaignObjective(session),
        patient: session.patientContext || null,
        conversationSummary: memory.summary,
        recentTurns: memory.lastTurns,
        latestPatientMessage: transcript
      });
      logLatency('LLM', llmStartedAt);
    }

    const action = String(realtimeTurn.action || 'continue').toLowerCase();

    // Farewell safety net — if patient clearly says goodbye but LLM didn't catch it
    const farewellPattern = /\b(goodbye|good\s?bye|bye\s?bye|bye|gotta go|hang up|talk later|have to go|i('m|\s+am) done|that('s|\s+is) all)\b/i;
    if (action === 'continue' && farewellPattern.test(transcript)) {
      realtimeTurn.action = 'end_call';
      realtimeTurn.reply = 'Thank you for your time. Have a great day!';
      realtimeTurn.goal_status = session.goalStatus || 'pending';
    }

    const finalAction = String(realtimeTurn.action || 'continue').toLowerCase();
    const shouldEnd = finalAction !== 'continue';
    const aiResponse = sanitizeAssistantText(realtimeTurn.reply);
    session.goalStatus = realtimeTurn.goal_status || session.goalStatus || 'pending';

    if (finalAction === 'transfer_human') {
      session.finalState = STATES.REQUIRES_FOLLOWUP;
      session.requiresFollowup = true;

      if (global.eventBus) {
        await global.eventBus.emit(EVENTS.CALL_ESCALATED, {
          callId: session.callId,
          sessionId,
          patientId: session.patientId || null,
          reason: emergency.detected ? 'emergency_keywords_detected' : 'transfer_human',
          riskDetected: Boolean(realtimeTurn.risk_detected),
          confidence: realtimeTurn.confidence
        });
      }
    } else if (finalAction === 'end_call') {
      session.finalState = session.requiresFollowup ? STATES.REQUIRES_FOLLOWUP : STATES.COMPLETED;
    } else if (realtimeTurn.goal_status === 'achieved') {
      session.finalState = STATES.COMPLETED;
    }

    session.conversation.push({
      role: 'assistant',
      text: aiResponse,
      timestamp: new Date().toISOString()
    });

    if (global.eventBus) {
      await global.eventBus.emit(EVENTS.CALL_RESPONSE_GENERATED, {
        callId: session.callId,
        sessionId,
        action,
        response: aiResponse,
        goalStatus: realtimeTurn.goal_status,
        riskDetected: Boolean(realtimeTurn.risk_detected),
        confidence: realtimeTurn.confidence
      });
    }

    const ttsStartedAt = Date.now();
    const ttsPath = path.join(AUDIO_TMP_DIR, `output_${sessionId}_${Date.now()}.wav`);
    const audioFile = await tryGenerateTTS(aiResponse, ttsPath);
    let playbackDurationMs = 1800;

    if (audioFile) {
      const aiAudioData = fs.readFileSync(ttsPath);
      playbackDurationMs = estimateWavDurationMs(aiAudioData) || playbackDurationMs;

      safeSend(session.ws, {
        type: 'ai_audio',
        data: aiAudioData.toString('base64'),
        transcript: aiResponse,
        shouldEnd,
        action,
        riskDetected: Boolean(realtimeTurn.risk_detected),
        confidence: realtimeTurn.confidence
      });
    } else {
      safeSend(session.ws, {
        type: 'ai_response',
        transcript: aiResponse,
        shouldEnd,
        action,
        riskDetected: Boolean(realtimeTurn.risk_detected),
        confidence: realtimeTurn.confidence
      });
    }

    logLatency('TTS', ttsStartedAt);
    cleanupFile(ttsPath);
    session.assistantSpeakingUntil = Date.now() + playbackDurationMs + ASSISTANT_SPEECH_GUARD_MS;

    if (!shouldEnd && session.callId) {
      await stateMachine.transition(session.callId, STATES.IN_PROGRESS, {
        turnCount: session.turnCount,
        goalStatus: session.goalStatus
      });
    }

    if (shouldEnd) {
      const waitMs = Math.max(1200, playbackDurationMs + 120);
      setTimeout(() => {
        handleEndCall(sessionId, session.patientId).catch((error) => {
          console.error('Failed to auto-end call:', error.message);
        });
      }, waitMs);
    }
  } catch (error) {
    console.error('Turn processing error:', error);
    if (/Model JSON validation failed/i.test(error.message || '')) {
      session.finalState = STATES.FAILED;
      safeSend(session.ws, {
        type: 'error',
        message: 'AI response format invalid. Ending this call for safety.'
      });
      setTimeout(() => {
        handleEndCall(sessionId, session.patientId).catch((endError) => {
          console.error('Failed to end call after invalid AI JSON:', endError.message);
        });
      }, 200);
      return;
    }

    safeSend(session.ws, {
      type: 'audio_warning',
      message: 'I could not process that. Please repeat your response.'
    });
  } finally {
    session.llmBusy = false;
  }
}

async function handleAudioChunk(sessionId, audioData) {
  const session = sessions.get(sessionId);
  if (!session || session.ended) return;
  let audioPath = null;

  try {
    if (Date.now() < (session.assistantSpeakingUntil || 0) || session.llmBusy) {
      return;
    }

    const audioBuffer = Buffer.from(audioData, 'base64');
    if (!audioBuffer || audioBuffer.length < 1024) {
      return;
    }

    audioPath = path.join(AUDIO_TMP_DIR, `input_${sessionId}_${Date.now()}.wav`);
    fs.writeFileSync(audioPath, audioBuffer);

    const sttStartedAt = Date.now();
    const sttResult = await sttService.transcribeRealtime(audioPath, {
      chunkMs: 1800,
      silenceThresholdMs: SILENCE_FINALIZE_MS
    });
    logLatency('STT', sttStartedAt);
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

      safeSend(session.ws, {
        type: 'partial_transcript',
        transcript: session.pendingUserTranscript
      });
    }

    clearSilenceTimer(session);
    if (sttResult.isFinal) {
      await flushPendingUserTranscript(sessionId, true);
      return;
    }

    const trailingSilenceMs = Number(sttResult.trailingSilenceMs || 0);
    if (trailingSilenceMs > 0) {
      const waitMs = Math.max(120, SILENCE_FINALIZE_MS - trailingSilenceMs);
      session.silenceTimer = setTimeout(() => {
        session.silenceTimer = null;
        flushPendingUserTranscript(sessionId, true).catch((error) => {
          console.error('Silence-triggered transcript flush failed:', error.message);
        });
      }, waitMs);
    }
  } catch (error) {
    console.error('Audio processing error:', error);

    if (REQUIRE_SERVER_TTS && error?.code === 'TTS_REQUIRED_UNAVAILABLE') {
      safeSend(session.ws, {
        type: 'error',
        message: 'Voice service unavailable. Please try again shortly.'
      });
      await handleEndCall(sessionId, session.patientId).catch((endErr) => {
        console.error('Failed to end call after TTS failure:', endErr);
      });
      return;
    }

    safeSend(session.ws, {
      type: 'audio_warning',
      message: 'Audio chunk could not be processed. Please continue speaking.'
    });
  } finally {
    cleanupFile(audioPath);
  }
}

async function handleEndCall(sessionId, patientId) {
  const session = sessions.get(sessionId);
  if (!session || session.ended) return;
  session.ended = true;
  clearSilenceTimer(session);
  if (session.maxCallTimer) {
    clearTimeout(session.maxCallTimer);
    session.maxCallTimer = null;
  }

  try {
    const pendingAtEnd = sanitizeTranscriptText(session.pendingUserTranscript || '');
    if (isMeaningfulTranscript(pendingAtEnd)) {
      session.conversation.push({
        role: 'user',
        text: pendingAtEnd,
        timestamp: new Date().toISOString()
      });
    }
    session.pendingUserTranscript = '';

    // Build full transcript
    const fullTranscript = session.conversation
      .map(msg => `${msg.role === 'user' ? 'Patient' : 'Assistant'}: ${msg.text}`)
      .join('\n');

    console.log('Full transcript:', fullTranscript);

    // Calculate duration
    const duration = Math.floor((Date.now() - session.startTime) / 1000);

    // Get default organization_id (1 = Demo Healthcare Organization)
    const defaultOrgId = 1;
    const requestedPatientId = normalizePatientId(patientId) || normalizePatientId(session.patientId);
    const patientContext = await loadPatientContext(requestedPatientId);

    // Save/update database call record
    let callId = session.callId;
    if (callId) {
      await query(
        `UPDATE calls
         SET transcript = $1,
             duration = $2,
             requested_callback = $3,
             updated_at = CURRENT_TIMESTAMP
         WHERE id = $4`,
        [fullTranscript, duration, session.requiresFollowup, callId]
      );
    } else {
      const result = await query(
        `INSERT INTO calls (
          organization_id, patient_id, campaign_id, transcript, duration, state,
          sentiment, appointment_confirmed, requested_callback, summary
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
        RETURNING id`,
        [
          patientContext?.organization_id || defaultOrgId,
          patientContext?.id || null,
          patientContext?.campaign_id || null,
          fullTranscript,
          duration,
          STATES.IN_PROGRESS,
          'neutral',
          false,
          session.requiresFollowup,
          ''
        ]
      );
      callId = result.rows[0].id;
      session.callId = callId;
    }

    const finalState = session.finalState || STATES.COMPLETED;
    await transitionToFinalState(callId, finalState, {
      duration,
      turnCount: session.turnCount,
      requiresFollowup: session.requiresFollowup
    });

    const patientIdForStatus = patientContext?.id || normalizePatientId(session.patientId);
    if (patientIdForStatus) {
      await query(
        `UPDATE patients SET status = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2`,
        [finalState === STATES.REQUIRES_FOLLOWUP ? 'followup_required' : 'completed', patientIdForStatus]
      );
    }

    const campaignIdForCompletion = patientContext?.campaign_id || null;
    await maybeCompleteCampaign(campaignIdForCompletion);

    // Emit call completed event
    if (global.eventBus) {
      await global.eventBus.emit(EVENTS.CALL_COMPLETED, {
        callId,
        sessionId,
        patientId: patientIdForStatus || null,
        duration,
        state: finalState
      });
    }

    // Trigger post-call pipeline asynchronously
    postCallPipeline.process(callId).catch(err => {
      console.error('Post-call pipeline error:', err);
    });

    safeSend(session.ws, {
      type: 'call_ended',
      transcript: fullTranscript,
      duration,
      callId,
      state: finalState,
      message: 'Analysis in progress...'
    });

    await releaseRealtimeLease(session);

    sessions.delete(sessionId);
  } catch (error) {
    session.ended = false;
    console.error('End call error:', error);
    await releaseRealtimeLease(session);
    safeSend(session.ws, {
      type: 'error',
      message: 'Failed to process call end'
    });
  }
}

/**
 * Safely delete a temp file
 * @param {string} filePath - File to delete
 */
function cleanupFile(filePath) {
  try {
    if (filePath && fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
  } catch (err) {
    console.warn('File cleanup error:', err.message);
  }
}

async function loadPatientContext(patientId) {
  if (!patientId) {
    return null;
  }

  try {
    const result = await query(
      `SELECT
         p.id,
         p.name,
         p.phone,
         p.category,
         p.metadata,
         p.organization_id,
         p.campaign_id,
         c.retry_limit,
         c.name AS campaign_name,
         c.script_template AS campaign_script_template
       FROM patients p
       LEFT JOIN campaigns c ON c.id = p.campaign_id
       WHERE p.id = $1`,
      [patientId]
    );
    return result.rows[0] || null;
  } catch (error) {
    console.warn('Failed to load patient context:', error.message);
    return null;
  }
}

function notifyRegisteredPatient(patientId, payload) {
  for (const session of sessions.values()) {
    if (session.registeredPatientId === patientId) {
      safeSend(session.ws, payload);
    }
  }
}

async function calculateQueueTailDelay(campaignId, patientId) {
  if (!campaignId) return CALL_SPACING_MS;

  try {
    const result = await query(
      `SELECT COUNT(*)::int AS queue_count
       FROM patients
       WHERE campaign_id = $1
         AND id != $2
         AND status IN ('pending', 'queued', 'ringing', 'calling')`,
      [campaignId, patientId]
    );

    const queueCount = result.rows[0]?.queue_count || 0;
    return Math.max(CALL_SPACING_MS, queueCount * CALL_SPACING_MS);
  } catch (error) {
    console.warn('Failed to calculate queue-tail delay:', error.message);
    return CALL_SPACING_MS;
  }
}

function clearPendingRing(patientId) {
  const key = String(patientId || '');
  if (!key || !pendingRings.has(key)) return;

  const pending = pendingRings.get(key);
  clearTimeout(pending.timeoutHandle);
  pendingRings.delete(key);
}

async function handleRingTimeout({ patientId, campaignId, organizationId, retryAttempt = 0, maxRetries = 3, reason = 'no_answer_timeout' }) {
  const normalizedPatientId = normalizePatientId(patientId);
  if (!normalizedPatientId) return;

  const key = String(normalizedPatientId);
  if (!pendingRings.has(key)) return;
  pendingRings.delete(key);

  const patientStatusResult = await query(
    'SELECT status FROM patients WHERE id = $1',
    [normalizedPatientId]
  );
  const patientStatus = patientStatusResult.rows[0]?.status;

  // If the patient already accepted or completed flow, do nothing.
  if (patientStatus && !['ringing', 'queued', 'pending'].includes(patientStatus)) {
    return;
  }

  const patientContext = await loadPatientContext(normalizedPatientId);
  if (!patientContext?.id) return;

  // Mark patient as missed or rejected (NO RETRY)
  const finalStatus = reason === 'patient_rejected' ? 'rejected' : 'missed';
  await query(
    `UPDATE patients
     SET status = $1, updated_at = CURRENT_TIMESTAMP
     WHERE id = $2`,
    [finalStatus, normalizedPatientId]
  );

  const missedCallResult = await query(
    `INSERT INTO calls (
      organization_id, patient_id, campaign_id, transcript, duration, state,
      sentiment, appointment_confirmed, requested_callback, summary
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
    RETURNING id`,
    [
      patientContext.organization_id || organizationId || 1,
      normalizedPatientId,
      patientContext.campaign_id || campaignId || null,
      'No answer from patient',
      0,
      STATES.FAILED,
      'neutral',
      false,
      false,
      reason === 'patient_rejected'
        ? 'Call declined by patient'
        : 'No answer - patient did not pick up within ring timeout'
    ]
  );
  const missedCallId = missedCallResult.rows[0].id;

  if (global.eventBus) {
    await global.eventBus.emit(EVENTS.CALL_FAILED, {
      callId: missedCallId,
      patientId: normalizedPatientId,
      campaignId: patientContext.campaign_id || campaignId || null,
      organizationId: patientContext.organization_id || organizationId || 1,
      reason,
      retryAttempt
    });
  }

  // NO RETRY - just mark as missed/rejected and move to next patient
  await maybeCompleteCampaign(patientContext.campaign_id || campaignId || null);

  notifyRegisteredPatient(normalizedPatientId, {
    type: 'incoming_call_missed',
    patientId: normalizedPatientId,
    reason,
    retryAttempt,
    willRetry: false,  // Never retry
    nextRetryAt: null,
    nextRetryDelayMs: null,
    timeoutMs: RING_TIMEOUT_MS
  });
}

async function handleRingRejection(patientId) {
  const normalizedPatientId = normalizePatientId(patientId);
  if (!normalizedPatientId) return;

  const pending = pendingRings.get(String(normalizedPatientId));
  if (!pending) return;

  clearTimeout(pending.timeoutHandle);
  await handleRingTimeout({
    patientId: normalizedPatientId,
    campaignId: pending.campaignId,
    organizationId: pending.organizationId,
    retryAttempt: pending.retryAttempt || 0,
    maxRetries: pending.maxRetries || 3,
    reason: 'patient_rejected'
  });
}

async function maybeCompleteCampaign(campaignId) {
  if (!campaignId) return;

  const remainingResult = await query(
    `SELECT COUNT(*)::int AS remaining
     FROM patients
     WHERE campaign_id = $1
     AND status IN ('pending', 'queued', 'calling', 'ringing')`,
    [campaignId]
  );

  if ((remainingResult.rows[0]?.remaining || 0) === 0) {
    await query(
      `UPDATE campaigns SET status = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2`,
      ['completed', campaignId]
    );
  }
}

async function transitionToFinalState(callId, finalState, metadata = {}) {
  if (!callId) return;

  let transitioned = await stateMachine.transition(callId, finalState, metadata);
  if (transitioned) return;

  // If direct transition is invalid, bridge through a valid state path.
  const currentState = await stateMachine.getCurrentState(callId);
  if (finalState === STATES.REQUIRES_FOLLOWUP && currentState === STATES.IN_PROGRESS) {
    await stateMachine.transition(callId, STATES.AWAITING_RESPONSE, metadata);
    transitioned = await stateMachine.transition(callId, STATES.REQUIRES_FOLLOWUP, metadata);
    if (transitioned) return;
  }

  await stateMachine.transition(callId, STATES.COMPLETED, metadata);
  if (finalState === STATES.REQUIRES_FOLLOWUP) {
    await stateMachine.transition(callId, STATES.REQUIRES_FOLLOWUP, metadata);
  }
}

function normalizePatientId(value) {
  const id = parseInt(value, 10);
  if (!Number.isInteger(id) || id <= 0) {
    return null;
  }
  return id;
}

function generateSessionId() {
  return `session_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
}

module.exports = { initWebSocket };
