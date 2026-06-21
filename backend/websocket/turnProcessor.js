const fs = require('fs');
const path = require('path');
const llmService = require('../services/ai/llmService');
const ttsService = require('../services/ai/ttsService');
const { detectEmergencyRisk, EMERGENCY_GUIDANCE } = require('../services/ai/healthcareSafety');
const { buildSlidingWindowMemory } = require('../services/ai/conversationMemory');
const { STATES } = require('../orchestrator/callStateMachine');
const { EVENTS } = require('../orchestrator/eventBus');
const { transitionToFinalState } = require('../orchestrator/stateHelpers');
const { CallStateMachine } = require('../orchestrator/callStateMachine');
const { query } = require('../services/database');
const postCallPipeline = require('../workflows/postCallPipeline');
const {
  getSession, deleteSession, loadPatientContext, maybeCompleteCampaign, normalizePatientId
} = require('./sessionManager');
const {
  sanitizeTranscriptText, isMeaningfulTranscript, sanitizeAssistantText,
  cleanupFile, clearSilenceTimer, safeSend, AUDIO_TMP_DIR
} = require('./audioHandler');

const stateMachine = new CallStateMachine();
const REQUIRE_SERVER_TTS = String(process.env.REQUIRE_SERVER_TTS || 'false').toLowerCase() === 'true';
const MAX_CONVERSATION_TURNS = parseInt(process.env.MAX_CONVERSATION_TURNS, 10) || 30;
const ASSISTANT_SPEECH_GUARD_MS = parseInt(process.env.ASSISTANT_SPEECH_GUARD_MS, 10) || 350;
const REALTIME_LLM_FAILURE_HANDOFF = String(process.env.LLM_FAILURE_HANDOFF || 'true').toLowerCase() === 'true';
const LLM_FAILURE_HANDOFF_REPLY = 'I am sorry, our connection is having trouble. A care team member will follow up with you shortly. Thank you for your time.';

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

async function ensureRealtimeLeaseReady(session) {
  if (!session || session.ended) return;
  if (session.realtimeRelease) return;
  if (!session.realtimeLeasePromise) {
    session.realtimeLeasePromise = llmService.acquireRealtimeSession()
      .then(release => { session.realtimeRelease = release; session.realtimeLeasePromise = null; return release; })
      .catch(error => { session.realtimeLeasePromise = null; throw error; });
  }
  await session.realtimeLeasePromise;
}

async function releaseRealtimeLease(session) {
  if (!session) return;
  try {
    if (!session.realtimeRelease && session.realtimeLeasePromise) {
      await session.realtimeLeasePromise.catch(() => null);
    }
  } catch (_) {}
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

function buildCampaignObjective(session) {
  return session?.patientContext?.campaign_prompt_template ||
    session?.patientContext?.campaign_script_template ||
    session?.patientContext?.campaign_name ||
    'Confirm appointment details and identify whether manual follow-up is needed.';
}

const MAX_CONSECUTIVE_FAILURES = 3;

// Safe fallback responses for when LLM fails — never end call on first failure
const SAFE_FALLBACKS = [
  "I want to make sure I heard you clearly. Could you say that once more?",
  "Could you repeat that once, please? I want to capture it correctly.",
  "I did not catch that clearly. Please say it one more time."
];

// Patterns that indicate prompt injection or non-conversational input
const SUSPICIOUS_INPUT_PATTERNS = [
  /\bignore (all |previous |above |your )?(instructions|rules|guidelines|prompt)\b/i,
  /\byou are now\b/i,
  /\bpretend (you are|to be)\b/i,
  /\bact as (a|an|if)\b/i,
  /\b(system prompt|system message|developer message)\b/i,
  /\bforget (everything|what|your)\b/i,
  /\bnew (instructions|rules|role)\b/i,
  /\bfrom now on you\b/i,
  /\bdo not (follow|obey|listen to)\b/i,
  /\boverride\b/i,
  /\bDEBUG\b/,
  /\b<\|.*\|>\b/,
  /\b\[SYSTEM\]\b/i
];

function isSuspiciousInput(transcript) {
  return SUSPICIOUS_INPUT_PATTERNS.some(p => p.test(transcript));
}

async function flushPendingUserTranscript(sessionId, force = false) {
  const session = getSession(sessionId);
  if (!session || session.ended || session.llmBusy) return;

  const assistantBusyForMs = (session.assistantSpeakingUntil || 0) - Date.now();
  if (assistantBusyForMs > 0) {
    if (!session.silenceTimer) {
      session.silenceTimer = setTimeout(() => {
        session.silenceTimer = null;
        flushPendingUserTranscript(sessionId, force).catch(err => {
          console.error('Deferred transcript flush failed:', err.message);
        });
      }, Math.min(assistantBusyForMs + 80, 1200));
    }
    return;
  }

  const transcript = sanitizeTranscriptText(session.pendingUserTranscript || '');
  if (!isMeaningfulTranscript(transcript)) {
    if (force) session.pendingUserTranscript = '';
    return;
  }

  session.pendingUserTranscript = '';
  session.llmBusy = true;

  try {
    session.turnCount += 1;
    const currentTurn = session.turnCount;
    if (session.turnCount > MAX_CONVERSATION_TURNS) {
      session.finalState = STATES.COMPLETED;
      safeSend(session.ws, { type: 'ai_response', transcript: 'Thank you for your time today. We will end this call now.', shouldEnd: true });
      setTimeout(() => {
        handleEndCall(sessionId, session.patientId).catch(err => console.error('Failed to end call after turn-limit:', err.message));
      }, 600);
      return;
    }

    session.conversation.push({ role: 'user', text: transcript, timestamp: new Date().toISOString() });
    safeSend(session.ws, { type: 'user_speech', transcript });

    // Guard: detect prompt injection or suspicious input
    if (isSuspiciousInput(transcript)) {
      console.warn(`[GUARD] Suspicious input detected in turn ${session.turnCount}, using safe fallback`);
      const fallbackIdx = ((session.consecutiveFailures || 0)) % SAFE_FALLBACKS.length;
      session.consecutiveFailures = (session.consecutiveFailures || 0) + 1;
      safeSend(session.ws, { type: 'ai_response', transcript: SAFE_FALLBACKS[fallbackIdx], shouldEnd: false });
      session.assistantSpeakingUntil = Date.now() + 2000;
      return;
    }

    if (session.callId) {
      await stateMachine.transition(session.callId, STATES.AWAITING_RESPONSE, { turnCount: session.turnCount });
    }

    if (global.eventBus) {
      await global.eventBus.emit(EVENTS.CALL_TRANSCRIBED, { callId: session.callId, sessionId, transcript, turnCount: session.turnCount });
    }

    let realtimeTurn = null;
    let chunkIndex = 0;
    const emergency = detectEmergencyRisk(transcript);
    if (emergency.detected) {
      realtimeTurn = {
        reply: emergency.guidance || EMERGENCY_GUIDANCE,
        action: 'transfer_human',
        goal_status: 'failed',
        risk_detected: true,
        confidence: 1,
        emergency_category: emergency.category,
        emergency_severity: emergency.severity
      };

      console.log(`[GUARD] Emergency risk detected. Transferring to human. Reply: "${realtimeTurn.reply}"`);

      const ttsPath = path.join(AUDIO_TMP_DIR, `output_${sessionId}_chunk_${chunkIndex}_${Date.now()}.wav`);
      const audioFile = await tryGenerateTTS(realtimeTurn.reply, ttsPath);

      if (audioFile) {
        const aiAudioData = fs.readFileSync(ttsPath);
        const audioBase64 = aiAudioData.toString('base64');
        const chunkDurationMs = estimateWavDurationMs(aiAudioData) || 1500;

        safeSend(session.ws, {
          type: 'ai_audio_chunk',
          data: audioBase64,
          transcript: realtimeTurn.reply,
          chunkIndex: chunkIndex++,
          isFinal: false
        });
        session.assistantSpeakingUntil = Date.now() + chunkDurationMs + ASSISTANT_SPEECH_GUARD_MS;
      } else {
        safeSend(session.ws, {
          type: 'ai_audio_chunk',
          transcript: realtimeTurn.reply,
          chunkIndex: chunkIndex++,
          isFinal: false
        });
        session.assistantSpeakingUntil = Date.now() + 3000;
      }
      cleanupFile(ttsPath);
    } else {
      await ensureRealtimeLeaseReady(session);
      const memory = buildSlidingWindowMemory(session.conversation, session.conversationSummary);
      session.conversationSummary = memory.summary;

      const llmStartedAt = Date.now();
      let chunkIndex = 0;
      let ttsPromiseChain = Promise.resolve();

      try {
        realtimeTurn = await llmService.generateRealtimeTurnStream(
          {
            campaignObjective: buildCampaignObjective(session),
            campaignType: session.patientContext?.campaign_type || 'appointment_confirmation',
            patient: session.patientContext || null,
            conversationSummary: memory.summary,
            recentTurns: memory.lastTurns,
            latestPatientMessage: transcript,
            emotionalState: memory.emotionalState,
            confirmedFacts: memory.confirmedFacts,
            goalProgress: memory.goalProgress
          },
          (sentence) => {
            ttsPromiseChain = ttsPromiseChain.then(async () => {
              if (session.ended || session.turnCount !== currentTurn) return;

              console.log(`[STREAMING] Sentence chunk derived and processing: "${sentence}"`);

              const ttsPath = path.join(AUDIO_TMP_DIR, `output_${sessionId}_chunk_${chunkIndex}_${Date.now()}.wav`);
              try {
                const audioFile = await tryGenerateTTS(sentence, ttsPath);

                if (session.ended || session.turnCount !== currentTurn) {
                  cleanupFile(ttsPath);
                  return;
                }

                if (audioFile) {
                  const aiAudioData = fs.readFileSync(ttsPath);
                  const audioBase64 = aiAudioData.toString('base64');
                  const chunkDurationMs = estimateWavDurationMs(aiAudioData) || 1500;

                  safeSend(session.ws, {
                    type: 'ai_audio_chunk',
                    data: audioBase64,
                    transcript: sentence,
                    chunkIndex: chunkIndex++,
                    isFinal: false
                  });

                  const now = Date.now();
                  if (session.assistantSpeakingUntil > now) {
                    session.assistantSpeakingUntil += chunkDurationMs;
                  } else {
                    session.assistantSpeakingUntil = now + chunkDurationMs + ASSISTANT_SPEECH_GUARD_MS;
                  }
                } else {
                  safeSend(session.ws, {
                    type: 'ai_audio_chunk',
                    transcript: sentence,
                    chunkIndex: chunkIndex++,
                    isFinal: false
                  });
                  session.assistantSpeakingUntil = Date.now() + 2000;
                }
              } catch (ttsErr) {
                console.error(`[STREAMING] tryGenerateTTS failed for "${sentence}":`, ttsErr.message);
                safeSend(session.ws, {
                  type: 'ai_audio_chunk',
                  transcript: sentence,
                  chunkIndex: chunkIndex++,
                  isFinal: false
                });
                session.assistantSpeakingUntil = Date.now() + 2000;
              } finally {
                cleanupFile(ttsPath);
              }
            });
            return ttsPromiseChain;
          }
        );
      } catch (llmError) {
        console.error(`[LLM-FAIL] Turn ${session.turnCount}: ${llmError.message}`);
        session.consecutiveFailures = (session.consecutiveFailures || 0) + 1;

        if (REALTIME_LLM_FAILURE_HANDOFF || session.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
          console.error(`[LLM-FAIL] Ending live turn safely after ${session.consecutiveFailures} realtime failure(s)`);
          realtimeTurn = {
            reply: LLM_FAILURE_HANDOFF_REPLY,
            action: 'transfer_human',
            goal_status: 'failed',
            risk_detected: false,
            confidence: 0,
            _fallback: true
          };
        } else {
          const fallbackIdx = (session.consecutiveFailures - 1) % SAFE_FALLBACKS.length;
          realtimeTurn = {
            reply: SAFE_FALLBACKS[fallbackIdx],
            action: 'continue',
            goal_status: 'pending',
            risk_detected: false,
            confidence: 0,
            _fallback: true
          };
        }

        safeSend(session.ws, {
          type: 'ai_audio_chunk',
          transcript: realtimeTurn.reply,
          chunkIndex: chunkIndex++,
          isFinal: false
        });
        session.assistantSpeakingUntil = Date.now() + 3000;
      }
      console.log(`[LATENCY][LLM] ${Date.now() - llmStartedAt}ms`);
    }

    if (session.ended || session.turnCount !== currentTurn) {
      console.log(`[INTERRUPT] Ignoring obsolete LLM response for turn ${currentTurn}`);
      return;
    }

    if (realtimeTurn && !realtimeTurn._fallback) {
      session.consecutiveFailures = 0;
    }

    const action = String(realtimeTurn.action || 'continue').toLowerCase();
    const farewellPattern = /\b(goodbye|good\s?bye|bye\s?bye|bye|gotta go|hang up|talk later|have to go|i('m|\s+am) done|that('s|\s+is) all)\b/i;
    let finalAction = String(realtimeTurn.action || 'continue').toLowerCase();
    if (finalAction === 'continue' && farewellPattern.test(transcript)) {
      finalAction = 'end_call';
      realtimeTurn.reply = 'Thank you for your time. Have a great day!';
      realtimeTurn.goal_status = session.goalStatus || 'pending';
    }

    const shouldEnd = finalAction !== 'continue';
    const aiResponse = sanitizeAssistantText(realtimeTurn.reply);
    session.goalStatus = realtimeTurn.goal_status || session.goalStatus || 'pending';

    if (finalAction === 'transfer_human') {
      session.finalState = STATES.REQUIRES_FOLLOWUP;
      session.requiresFollowup = true;
      if (global.eventBus) {
        await global.eventBus.emit(EVENTS.CALL_ESCALATED, {
          callId: session.callId, sessionId, patientId: session.patientId || null,
          reason: emergency.detected ? 'emergency_keywords_detected' : 'transfer_human',
          riskDetected: Boolean(realtimeTurn.risk_detected), confidence: realtimeTurn.confidence
        });
      }
    } else if (finalAction === 'end_call') {
      session.finalState = session.requiresFollowup ? STATES.REQUIRES_FOLLOWUP : STATES.COMPLETED;
    } else if (realtimeTurn.goal_status === 'achieved') {
      session.finalState = STATES.COMPLETED;
    }

    session.conversation.push({ role: 'assistant', text: aiResponse, timestamp: new Date().toISOString() });

    if (global.eventBus) {
      await global.eventBus.emit(EVENTS.CALL_RESPONSE_GENERATED, {
        callId: session.callId, sessionId, action: finalAction, response: aiResponse,
        goalStatus: realtimeTurn.goal_status, riskDetected: Boolean(realtimeTurn.risk_detected), confidence: realtimeTurn.confidence
      });
    }

    safeSend(session.ws, {
      type: 'ai_audio_chunk',
      isFinal: true,
      action: finalAction,
      shouldEnd,
      transcript: aiResponse,
      riskDetected: Boolean(realtimeTurn.risk_detected),
      confidence: realtimeTurn.confidence
    });

    if (!shouldEnd && session.callId) {
      await stateMachine.transition(session.callId, STATES.IN_PROGRESS, { turnCount: session.turnCount, goalStatus: session.goalStatus });
    }

    if (shouldEnd) {
      const waitMs = Math.max(1500, (session.assistantSpeakingUntil - Date.now()) + 200);
      setTimeout(() => {
        handleEndCall(sessionId, session.patientId).catch(err => console.error('Failed to auto-end call:', err.message));
      }, waitMs);
    }
  } catch (error) {
    console.error('Turn processing error:', error);
    session.consecutiveFailures = (session.consecutiveFailures || 0) + 1;

    if (session.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
      session.finalState = STATES.REQUIRES_FOLLOWUP;
      session.requiresFollowup = true;
      safeSend(session.ws, {
        type: 'ai_response',
        transcript: 'I apologize for the technical difficulty. A staff member will contact you shortly.',
        shouldEnd: true
      });
      setTimeout(() => {
        handleEndCall(sessionId, session.patientId).catch(() => {});
      }, 600);
      return;
    }

    const fallbackIdx = (session.consecutiveFailures - 1) % SAFE_FALLBACKS.length;
    safeSend(session.ws, { type: 'ai_response', transcript: SAFE_FALLBACKS[fallbackIdx], shouldEnd: false });
  } finally {
    session.llmBusy = false;
  }
}

async function handleEndCall(sessionId, patientId) {
  const session = getSession(sessionId);
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
      session.conversation.push({ role: 'user', text: pendingAtEnd, timestamp: new Date().toISOString() });
    }
    session.pendingUserTranscript = '';

    const fullTranscript = session.conversation
      .map(msg => `${msg.role === 'user' ? 'Patient' : 'Assistant'}: ${msg.text}`).join('\n');
    const duration = Math.floor((Date.now() - session.startTime) / 1000);

    const requestedPatientId = normalizePatientId(patientId) || normalizePatientId(session.patientId);
    const patientContext = await loadPatientContext(requestedPatientId);

    let callId = session.callId;
    if (callId) {
      await query(
        `UPDATE calls SET transcript = $1, duration = $2, requested_callback = $3, updated_at = CURRENT_TIMESTAMP WHERE id = $4`,
        [fullTranscript, duration, session.requiresFollowup, callId]
      );
    } else {
      const result = await query(
        `INSERT INTO calls (organization_id, patient_id, campaign_id, transcript, duration, state,
          sentiment, appointment_confirmed, requested_callback, summary)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id`,
        [patientContext?.organization_id || 1, patientContext?.id || null, patientContext?.campaign_id || null,
         fullTranscript, duration, STATES.IN_PROGRESS, 'neutral', false, session.requiresFollowup, '']
      );
      callId = result.rows[0].id;
      session.callId = callId;
    }

    const finalState = session.finalState || STATES.COMPLETED;
    await transitionToFinalState(callId, finalState, { duration, turnCount: session.turnCount, requiresFollowup: session.requiresFollowup });

    const patientIdForStatus = patientContext?.id || normalizePatientId(session.patientId);
    if (patientIdForStatus) {
      await query(
        `UPDATE patients SET status = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2`,
        [finalState === STATES.REQUIRES_FOLLOWUP ? 'followup_required' : 'completed', patientIdForStatus]
      );
    }

    await maybeCompleteCampaign(patientContext?.campaign_id || null);

    if (global.eventBus) {
      await global.eventBus.emit(EVENTS.CALL_COMPLETED, {
        callId, sessionId, patientId: patientIdForStatus || null, duration, state: finalState
      });
    }

    postCallPipeline.process(callId).catch(err => console.error('Post-call pipeline error:', err));

    safeSend(session.ws, {
      type: 'call_ended', transcript: fullTranscript, duration, callId, state: finalState,
      message: 'Analysis in progress...'
    });

    await releaseRealtimeLease(session);
    deleteSession(sessionId);
  } catch (error) {
    session.ended = false;
    console.error('End call error:', error);
    await releaseRealtimeLease(session);
    safeSend(session.ws, { type: 'error', message: 'Failed to process call end' });
  }
}

async function handleInterruption(sessionId) {
  const session = getSession(sessionId);
  if (!session || session.ended) return;

  console.log(`[INTERRUPT] Server received interruption for session ${sessionId}. Stopping assistant speech.`);

  // 1. Reset assistant speaking timer
  session.assistantSpeakingUntil = 0;

  // 2. Set LLM busy flag to false to accept new turns
  session.llmBusy = false;

  // 3. Clear any pending user transcripts and silence timers
  session.pendingUserTranscript = '';
  clearSilenceTimer(session);

  // 4. Update state machine back to IN_PROGRESS if it was AWAITING_RESPONSE
  if (session.callId) {
    try {
      const callResult = await query('SELECT state FROM calls WHERE id = $1', [session.callId]);
      const currentState = callResult.rows[0]?.state;
      if (currentState === STATES.AWAITING_RESPONSE) {
        await stateMachine.transition(session.callId, STATES.IN_PROGRESS, { turnCount: session.turnCount });
      }
    } catch (err) {
      console.warn('Failed to transition state machine on interruption:', err.message);
    }
  }
}

module.exports = {
  flushPendingUserTranscript, handleEndCall, tryGenerateTTS,
  ensureRealtimeLeaseReady, releaseRealtimeLease, estimateWavDurationMs,
  buildCampaignObjective, handleInterruption
};
