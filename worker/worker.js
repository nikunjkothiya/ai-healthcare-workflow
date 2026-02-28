const { Worker } = require('bullmq');
const Redis = require('ioredis');
const { Pool } = require('pg');
const fs = require('fs');
const axios = require('axios');

require('dotenv').config();

// Import orchestrator components
const { CallStateMachine, STATES } = require('./backend/orchestrator/callStateMachine');
const { EventBus, EVENTS } = require('./backend/orchestrator/eventBus');
const { AgentController, ACTIONS } = require('./backend/orchestrator/agentController');

// Import AI services
const sttService = require('./backend/services/ai/sttService');
const llmService = require('./backend/services/ai/llmService');
const { detectEmergencyRisk, EMERGENCY_GUIDANCE } = require('./backend/services/ai/healthcareSafety');

// Database connection
const pool = new Pool({
  host: process.env.DB_HOST,
  port: process.env.DB_PORT,
  user: process.env.DB_USER,
  password: process.env.DB_PASS,
  database: process.env.DB_NAME,
});

// Redis connection
const connection = new Redis({
  host: process.env.REDIS_HOST,
  port: process.env.REDIS_PORT,
  maxRetriesPerRequest: null,
});

// Initialize orchestrator components
const stateMachine = new CallStateMachine();
const eventBus = new EventBus();
const agentController = new AgentController();
const POLL_INTERVAL_MS = parseInt(process.env.WEBSOCKET_CALL_POLL_MS, 10) || 2000;
const WEBSOCKET_CALL_MAX_WAIT_MS = parseInt(process.env.WEBSOCKET_CALL_MAX_WAIT_MS, 10) || 12 * 60 * 1000;
const POST_CALL_ANALYSIS_MAX_WAIT_MS = parseInt(process.env.POST_CALL_ANALYSIS_MAX_WAIT_MS, 10) || 90 * 1000;

// Helper function to query database
async function query(sql, params) {
  const result = await pool.query(sql, params);
  return result;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function hasAnalysisCompleted(callId) {
  if (!callId) return false;

  const eventResult = await query(
    `SELECT 1
     FROM events
     WHERE call_id = $1
       AND event_type = $2
     LIMIT 1`,
    [callId, EVENTS.CALL_ANALYSIS_COMPLETED]
  );

  if (eventResult.rows.length > 0) {
    return true;
  }

  const callResult = await query(
    `SELECT structured_output, summary, transcript
     FROM calls
     WHERE id = $1`,
    [callId]
  );

  if (callResult.rows.length === 0) return false;

  const call = callResult.rows[0];
  const transcriptLength = typeof call.transcript === 'string' ? call.transcript.trim().length : 0;
  const hasStructuredOutput = call.structured_output && call.structured_output !== null;
  const hasSummary = typeof call.summary === 'string' && call.summary.trim().length > 0;

  if (transcriptLength > 0 && transcriptLength < 10) {
    return true;
  }

  return Boolean(hasStructuredOutput && hasSummary);
}

async function waitForPostCallAnalysis(callId) {
  if (!callId) return false;

  const deadline = Date.now() + POST_CALL_ANALYSIS_MAX_WAIT_MS;
  while (Date.now() < deadline) {
    if (await hasAnalysisCompleted(callId)) {
      return true;
    }

    const callResult = await query(
      `SELECT state, transcript
       FROM calls
       WHERE id = $1`,
      [callId]
    );

    const state = callResult.rows[0]?.state;
    const transcript = callResult.rows[0]?.transcript || '';
    if (state === STATES.FAILED) {
      return true;
    }

    if (typeof transcript === 'string' && transcript.trim().length > 0 && transcript.trim().length < 10) {
      return true;
    }

    await sleep(POLL_INTERVAL_MS);
  }

  return false;
}

async function waitForWebsocketCallResolution({ patientId, campaignId, startedAt }) {
  const deadline = Date.now() + WEBSOCKET_CALL_MAX_WAIT_MS;
  let lastStatus = null;
  let lastCallId = null;

  while (Date.now() < deadline) {
    const patientResult = await query(
      `SELECT status
       FROM patients
       WHERE id = $1`,
      [patientId]
    );
    const status = patientResult.rows[0]?.status || null;
    lastStatus = status;

    const callResult = await query(
      `SELECT id, state
       FROM calls
       WHERE patient_id = $1
         AND ($2::int IS NULL OR campaign_id = $2)
         AND created_at >= $3
       ORDER BY created_at DESC
       LIMIT 1`,
      [patientId, campaignId || null, startedAt]
    );
    const call = callResult.rows[0] || null;
    if (call?.id) {
      lastCallId = call.id;
    }

    if (status === 'queued' || status === 'missed') {
      return {
        resolved: true,
        status,
        callId: lastCallId,
        analysisCompleted: false
      };
    }

    if (['completed', 'followup_required', 'failed'].includes(status)) {
      const analysisCompleted = await waitForPostCallAnalysis(lastCallId);
      return {
        resolved: true,
        status,
        callId: lastCallId,
        analysisCompleted
      };
    }

    await sleep(POLL_INTERVAL_MS);
  }

  return {
    resolved: false,
    status: lastStatus,
    callId: lastCallId,
    analysisCompleted: false
  };
}

/**
 * Wait for Ollama endpoint to be reachable before processing calls.
 * Model-level validation/pull is handled by llmService.checkAvailability().
 */
async function waitForOllama() {
  const ollamaUrl = process.env.OLLAMA_URL || 'http://ollama:11434';
  const maxAttempts = 30;
  const delayMs = 5000;
  console.log(`Worker: Checking Ollama endpoint availability at ${ollamaUrl}`);

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      await axios.get(`${ollamaUrl}/api/tags`, { timeout: 5000 });
      console.log('Worker: Ollama endpoint is reachable');
      return true;
    } catch (error) {
      console.log(`Worker: Ollama endpoint not ready (attempt ${attempt}/${maxAttempts}): ${error.message}`);
    }

    if (attempt < maxAttempts) {
      await new Promise(resolve => setTimeout(resolve, delayMs));
    }
  }

  console.warn('Worker: Ollama endpoint not available after all attempts. Calls requiring LLM may fail until Ollama is healthy.');
  return false;
}

// Helper function to extract structured data from call transcript
async function extractStructuredData(fullTranscript, patient = null, campaign = null, callMeta = {}) {
  try {
    const analysis = await llmService.generatePostCallAnalysis({
      transcript: fullTranscript,
      patient,
      campaign,
      callMeta
    });

    const normalized = {
      appointment_confirmed: Boolean(analysis.appointment_confirmed),
      requested_callback: Boolean(analysis.requested_callback),
      sentiment: ['positive', 'neutral', 'negative'].includes(analysis.sentiment)
        ? analysis.sentiment
        : 'neutral',
      summary: String(analysis.summary || '').trim(),
      barrier_type: ['financial', 'transportation', 'scheduling', 'language', 'none'].includes(analysis.barrier_type)
        ? analysis.barrier_type
        : 'none',
      priority: ['low', 'medium', 'high'].includes(analysis.priority)
        ? analysis.priority
        : 'low',
      requires_followup: Boolean(analysis.requires_followup || analysis.requested_callback),
      barrier_notes: String(analysis.barrier_notes || '').trim(),
      followup_recommendation: String(analysis.followup_recommendation || '').trim(),
      next_best_action: String(analysis.next_best_action || '').trim(),
      key_points: Array.isArray(analysis.key_points) ? analysis.key_points : [],
      patient_concerns: Array.isArray(analysis.patient_concerns) ? analysis.patient_concerns : [],
      confidence: Number.isFinite(Number(analysis.confidence)) ? Number(analysis.confidence) : 0.5
    };

    console.log('Structured data extracted successfully:', normalized);
    return normalized;
  } catch (error) {
    console.error('CRITICAL: Structured extraction failed:', error.message);
    console.error('This call will be marked as failed due to missing AI analysis');
    // Re-throw to mark call as failed - don't hide LLM failures
    throw new Error(`AI analysis failed: ${error.message}`);
  }
}

async function transitionToFinalState(callId, finalState, metadata = {}) {
  let transitioned = await stateMachine.transition(callId, finalState, metadata);
  if (transitioned) return;

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

// Process patient call with orchestration
async function processPatientCall(patientId, jobData = {}) {
  console.log(`Processing call for patient ${patientId}`);
  let callId = null;
  let releaseRealtimeLease = null;

  try {
    // Get patient info
    const patientResult = await query(
      'SELECT * FROM patients WHERE id = $1',
      [patientId]
    );

    if (patientResult.rows.length === 0) {
      throw new Error(`Patient not found: ${patientId}`);
    }

    const patient = patientResult.rows[0];
    const jobCampaignId = Number.isInteger(parseInt(jobData.campaignId, 10))
      ? parseInt(jobData.campaignId, 10)
      : null;

    // Skip stale jobs after campaign deletion/reassignment.
    if (jobCampaignId !== null && Number(patient.campaign_id) !== jobCampaignId) {
      console.warn(
        `Skipping stale job ${jobData.jobId || 'unknown'} for patient ${patientId}: ` +
        `job campaign=${jobCampaignId}, current campaign=${patient.campaign_id || 'none'}`
      );
      return {
        success: true,
        skipped: true,
        reason: 'stale_campaign_job',
        patientId,
        jobCampaignId,
        currentCampaignId: patient.campaign_id || null
      };
    }

    console.log(`Calling patient: ${patient.name} (${patient.phone})`);

    // Mark campaign as running when the first scheduled job starts execution
    if (patient.campaign_id) {
      await query(
        `UPDATE campaigns
         SET status = $1, updated_at = CURRENT_TIMESTAMP
         WHERE id = $2 AND status != $3`,
        ['running', patient.campaign_id, 'completed']
      );
    }

    // Get campaign info for organization_id + retry config
    const campaignResult = await query(
      'SELECT organization_id, retry_limit FROM campaigns WHERE id = $1',
      [patient.campaign_id]
    );
    const organizationId = campaignResult.rows[0]?.organization_id || 1;
    const retryLimit = campaignResult.rows[0]?.retry_limit ?? 3;
    const callMode = jobData.callMode || 'simulation';
    console.log(`[CALL MODE] Patient ${patientId}: callMode from jobData = "${jobData.callMode}", using: "${callMode}"`);
    const retryAttempt = Number.isInteger(parseInt(jobData.retryAttempt, 10))
      ? parseInt(jobData.retryAttempt, 10)
      : 0;

    if (callMode === 'websocket') {
      const waitStartedAt = new Date().toISOString();

      await query(
        'UPDATE patients SET status = $1 WHERE id = $2',
        ['ringing', patientId]
      );

      await eventBus.emit(EVENTS.CALL_RINGING, {
        callId: null,
        patientId,
        patientName: patient.name,
        organizationId,
        campaignId: patient.campaign_id,
        jobId: jobData.jobId || null,
        scheduledFor: jobData.scheduledFor || null,
        callMode,
        retryAttempt,
        maxRetries: Number.isInteger(parseInt(jobData.maxRetries, 10))
          ? parseInt(jobData.maxRetries, 10)
          : retryLimit
      });

      const resolution = await waitForWebsocketCallResolution({
        patientId,
        campaignId: patient.campaign_id || null,
        startedAt: waitStartedAt
      });

      if (!resolution.resolved) {
        console.warn(
          `WebSocket call wait timed out for patient ${patientId}. Last status: ${resolution.status || 'unknown'}`
        );
      }

      return {
        success: true,
        patientId,
        mode: 'websocket_ringing',
        resolution
      };
    }

    // Create call record with initial state
    const callResult = await query(`
      INSERT INTO calls (organization_id, patient_id, campaign_id, state, transcript, structured_output, sentiment, 
                        appointment_confirmed, requested_callback, summary, duration)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
      RETURNING id
    `, [
      organizationId,
      patientId,
      patient.campaign_id,
      STATES.QUEUED,
      '',
      '{}',
      'neutral',
      false,
      false,
      '',
      0
    ]);

    callId = callResult.rows[0].id;

    // Update patient status
    await query(
      'UPDATE patients SET status = $1 WHERE id = $2',
      ['calling', patientId]
    );

    // Transition to IN_PROGRESS
    await stateMachine.transition(callId, STATES.IN_PROGRESS, { patientId });
    await eventBus.emit(EVENTS.CALL_STARTED, {
      callId,
      patientId,
      patientName: patient.name,
      organizationId,
      campaignId: patient.campaign_id,
      jobId: jobData.jobId || null,
      scheduledFor: jobData.scheduledFor || null,
      callMode
    });

    // Get greeting from agent controller
    const greeting = await agentController.getGreeting(patientId);
    // Architectural change: reserve realtime model for in-call dialogue.
    releaseRealtimeLease = await llmService.acquireRealtimeSession();

    // SIMULATION MODE: For batch/API testing without real WebSocket calls
    // This mode processes calls with sample audio or generates minimal transcript for testing
    // Real WebSocket calls happen through websocket.js, not here
    
    let conversation = [];
    const systemPrompt = `You are a friendly healthcare assistant calling ${patient.name} to confirm their appointment. Keep responses brief and natural. Respond in 1-2 short sentences.`;
    let agentRequestedFollowup = false;

    // Add greeting
    conversation.push({
      role: 'assistant',
      text: greeting
    });

    let turnCount = 0;
    const maxTurns = 5;

    // Check for sample audio files for testing
    let sampleAudioFiles = [];
    try {
      sampleAudioFiles = fs.readdirSync('/sample_audio').filter(f => f.endsWith('.wav'));
    } catch (err) {
      console.log('No sample audio directory found');
    }

    if (sampleAudioFiles.length > 0) {
      // Process sample audio files
      const numTurns = Math.min(maxTurns, sampleAudioFiles.length);

      for (let i = 0; i < numTurns; i++) {
        const audioFile = sampleAudioFiles[i % sampleAudioFiles.length];
        const audioPath = `/sample_audio/${audioFile}`;

        console.log(`Processing audio file: ${audioFile}`);

        // Transcribe patient audio
        const transcript = await sttService.transcribe(audioPath);

        if (!transcript || transcript.length < 3) {
          console.log(`Skipping turn - empty transcription for ${audioFile}`);
          continue;
        }

        console.log(`Patient said: ${transcript}`);

        conversation.push({
          role: 'patient',
          text: transcript
        });

        turnCount++;

        const emergency = detectEmergencyRisk(transcript);
        if (emergency.detected) {
          agentRequestedFollowup = true;
          conversation.push({
            role: 'assistant',
            text: EMERGENCY_GUIDANCE
          });
          await eventBus.emit(EVENTS.CALL_RESPONSE_GENERATED, {
            callId,
            response: EMERGENCY_GUIDANCE,
            action: ACTIONS.TRANSFER_HUMAN
          });
          await eventBus.emit(EVENTS.CALL_ESCALATED, {
            callId,
            patientId,
            organizationId,
            campaignId: patient.campaign_id,
            reason: 'emergency_keywords_detected',
            riskMatches: emergency.matches
          });
          break;
        }

        await eventBus.emit(EVENTS.CALL_TRANSCRIBED, { callId, transcript });

        // Build current transcript for agent decision
        const currentTranscript = conversation
          .map(msg => `${msg.role === 'patient' ? 'Patient' : 'Assistant'}: ${msg.text}`)
          .join('\n');

        // Agent decides next action
        const decision = await agentController.decide({
          callId,
          transcript: currentTranscript,
          turnCount,
          patientId
        });

        console.log(`Agent decision:`, decision);

        // Handle decision
        if (decision.action === ACTIONS.SCHEDULE_FOLLOWUP || decision.action === ACTIONS.TRANSFER_HUMAN) {
          agentRequestedFollowup = true;
          if (decision.message) {
            conversation.push({
              role: 'assistant',
              text: decision.message
            });
            await eventBus.emit(EVENTS.CALL_RESPONSE_GENERATED, { callId, response: decision.message, action: decision.action });
          }
          await eventBus.emit(EVENTS.CALL_ESCALATED, {
            callId,
            patientId,
            organizationId,
            campaignId: patient.campaign_id,
            reason: decision.reason || 'followup_required',
            barriers: decision.barriers || []
          });
          break;
        }

        if (decision.action === ACTIONS.END_CALL) {
          if (decision.message) {
            conversation.push({
              role: 'assistant',
              text: decision.message
            });
            await eventBus.emit(EVENTS.CALL_RESPONSE_GENERATED, { callId, response: decision.message, action: decision.action });
          }
          break;
        }

        // Generate AI response
        const aiResponse = await llmService.generateConversationResponse(
          transcript,
          decision.promptTemplate || systemPrompt
        );
        console.log(`AI response: ${aiResponse}`);

        conversation.push({
          role: 'assistant',
          text: aiResponse
        });

        await eventBus.emit(EVENTS.CALL_RESPONSE_GENERATED, { callId, response: aiResponse, action: decision.action });

        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    } else {
      // NO SAMPLE AUDIO: Create minimal transcript for simulation mode testing
      // This is ONLY for API/batch testing - real calls use WebSocket with live audio
      console.log('Simulation mode: Creating minimal test transcript');
      
      const testPatientResponse = "Yes, I can confirm my appointment";
      conversation.push({
        role: 'patient',
        text: testPatientResponse
      });
      
      turnCount++;

      const emergency = detectEmergencyRisk(testPatientResponse);
      if (emergency.detected) {
        agentRequestedFollowup = true;
        conversation.push({
          role: 'assistant',
          text: EMERGENCY_GUIDANCE
        });
        await eventBus.emit(EVENTS.CALL_RESPONSE_GENERATED, {
          callId,
          response: EMERGENCY_GUIDANCE,
          action: ACTIONS.TRANSFER_HUMAN
        });
        await eventBus.emit(EVENTS.CALL_ESCALATED, {
          callId,
          patientId,
          organizationId,
          campaignId: patient.campaign_id,
          reason: 'emergency_keywords_detected',
          riskMatches: emergency.matches
        });
      } else {
        const currentTranscript = conversation
          .map(msg => `${msg.role === 'patient' ? 'Patient' : 'Assistant'}: ${msg.text}`)
          .join('\n');

        const decision = await agentController.decide({
          callId,
          transcript: currentTranscript,
          turnCount,
          patientId
        });

        if (decision.action === ACTIONS.SCHEDULE_FOLLOWUP || decision.action === ACTIONS.TRANSFER_HUMAN) {
          agentRequestedFollowup = true;
          if (decision.message) {
            conversation.push({
              role: 'assistant',
              text: decision.message
            });
            await eventBus.emit(EVENTS.CALL_RESPONSE_GENERATED, { callId, response: decision.message, action: decision.action });
          }
          await eventBus.emit(EVENTS.CALL_ESCALATED, {
            callId,
            patientId,
            organizationId,
            campaignId: patient.campaign_id,
            reason: decision.reason || 'followup_required',
            barriers: decision.barriers || []
          });
        } else {
          const aiResponse = await llmService.generateConversationResponse(
            testPatientResponse,
            decision.promptTemplate || systemPrompt
          );

          conversation.push({
            role: 'assistant',
            text: aiResponse
          });
          
          await eventBus.emit(EVENTS.CALL_RESPONSE_GENERATED, { callId, response: aiResponse, action: decision.action });
        }
      }
    }

    // Build full transcript
    const fullTranscript = conversation
      .map(msg => `${msg.role === 'patient' ? 'Patient' : 'Assistant'}: ${msg.text}`)
      .join('\n');

    console.log('Full conversation transcript:', fullTranscript);

    // Extract structured data - CRITICAL: This must succeed for valid call analysis
    let structured;
    try {
      if (releaseRealtimeLease) {
        await releaseRealtimeLease();
        releaseRealtimeLease = null;
      }
      await llmService.ensureAnalysisModel({ waitForRealtime: true, timeoutMs: 180000 });

      structured = await extractStructuredData(
        fullTranscript,
        patient,
        { id: patient.campaign_id },
        { callId, turnCount, mode: 'simulation' }
      );
      console.log('Structured data:', structured);
      await eventBus.emit(EVENTS.CALL_ANALYSIS_COMPLETED, { callId, structured });
    } catch (extractError) {
      console.error('CRITICAL: AI analysis failed for call', callId, ':', extractError.message);
      
      // Mark call as failed due to AI analysis failure
      await query(`
        UPDATE calls SET 
          transcript = $1,
          summary = $2,
          duration = $3,
          updated_at = CURRENT_TIMESTAMP
        WHERE id = $4
      `, [
        fullTranscript,
        `AI analysis failed: ${extractError.message}`,
        turnCount * 10,
        callId
      ]);
      
      await transitionToFinalState(callId, STATES.FAILED, { 
        error: 'ai_analysis_failed',
        message: extractError.message 
      });
      
      await query(
        'UPDATE patients SET status = $1 WHERE id = $2',
        ['failed', patientId]
      );
      
      await eventBus.emit(EVENTS.CALL_FAILED, {
        callId,
        patientId,
        organizationId,
        campaignId: patient.campaign_id,
        reason: 'ai_analysis_failed',
        error: extractError.message
      });
      
      throw new Error(`Call ${callId} failed: AI analysis unavailable - ${extractError.message}`);
    } finally {
      llmService.releaseAnalysisModel().catch((releaseError) => {
        console.warn('Worker analysis model release warning:', releaseError.message);
      });
    }

    // Calculate duration (based on turns, simulated delay)
    const duration = turnCount * 10;

    // Update call with final data
    await query(`
      UPDATE calls SET 
        transcript = $1, 
        structured_output = $2, 
        sentiment = $3,
        appointment_confirmed = $4, 
        requested_callback = $5, 
        summary = $6, 
        duration = $7,
        updated_at = CURRENT_TIMESTAMP
      WHERE id = $8
    `, [
      fullTranscript,
      JSON.stringify(structured),
      structured.sentiment,
      structured.appointment_confirmed,
      structured.requested_callback,
      structured.summary,
      duration,
      callId
    ]);

    const needsFollowup = Boolean(
      structured.requested_callback ||
      structured.requires_followup ||
      (structured.barrier_type && structured.barrier_type !== 'none') ||
      agentRequestedFollowup
    );

    // Transition to final state
    const finalState = needsFollowup ? STATES.REQUIRES_FOLLOWUP : STATES.COMPLETED;
    await transitionToFinalState(callId, finalState, { structured });

    // Update patient status
    await query(
      'UPDATE patients SET status = $1 WHERE id = $2',
      [needsFollowup ? 'followup_required' : 'completed', patientId]
    );

    // Auto-complete campaign when all assigned patients are no longer pending/queued/calling
    if (patient.campaign_id) {
      const remainingResult = await query(
        `SELECT COUNT(*)::int AS remaining
         FROM patients
         WHERE campaign_id = $1
         AND status IN ('pending', 'queued', 'calling')`,
        [patient.campaign_id]
      );

      if ((remainingResult.rows[0]?.remaining || 0) === 0) {
        await query(
          `UPDATE campaigns
           SET status = $1, updated_at = CURRENT_TIMESTAMP
           WHERE id = $2`,
          ['completed', patient.campaign_id]
        );
      }
    }

    if (needsFollowup) {
      await eventBus.emit(EVENTS.CALL_ESCALATED, {
        callId,
        patientId,
        organizationId,
        campaignId: patient.campaign_id,
        reason: 'followup_required',
        barrierType: structured.barrier_type || 'none'
      });
    }

    await eventBus.emit(EVENTS.CALL_COMPLETED, { callId, patientId, structured });

    console.log(`Call ${callId} completed for patient ${patientId}`);

    return {
      success: true,
      callId,
      patientId,
      structured
    };
  } catch (error) {
    console.error(`Error processing patient ${patientId}:`, error.message);

    // Update patient status to failed
    try {
      await query(
        'UPDATE patients SET status = $1 WHERE id = $2',
        ['failed', patientId]
      );
    } catch (dbErr) {
      console.error('Failed to update patient status:', dbErr.message);
    }

    if (callId) {
      try {
        // Transition to failed state
        await stateMachine.transition(callId, STATES.FAILED, { error: error.message });
        await eventBus.emit(EVENTS.CALL_FAILED, { callId, patientId, error: error.message });

        // Check retry count
        const retryCount = await stateMachine.incrementRetry(callId);
        const maxRetries = 3;

        if (retryCount < maxRetries) {
          console.log(`Scheduling retry ${retryCount}/${maxRetries} for call ${callId}`);
          await eventBus.emit(EVENTS.CALL_RETRY_SCHEDULED, { callId, patientId, retryCount });
        }
      } catch (stateErr) {
        console.error('State transition error during failure handling:', stateErr.message);
      }
    }

    throw error;
  } finally {
    if (releaseRealtimeLease) {
      await releaseRealtimeLease();
      releaseRealtimeLease = null;
    }
  }
}

// Startup sequence
async function startWorker() {
  console.log('Worker starting up...');

  // Start event bus listener
  try {
    await eventBus.listen();
    console.log('EventBus initialized');
  } catch (err) {
    console.error('EventBus init failed:', err.message);
  }

  // Wait for Ollama and required stage models to be ready.
  while (true) {
    const ollamaReady = await waitForOllama();
    const llmReady = ollamaReady ? await llmService.checkAvailability() : false;

    if (ollamaReady && llmReady) {
      break;
    }

    console.warn('Worker: LLM prerequisites are not ready. Retrying startup checks in 30 seconds...');
    await sleep(30000);
  }

  // Read concurrency from environment
  const concurrency = parseInt(process.env.WORKER_CONCURRENCY) || 1;

  // Create worker
  const worker = new Worker('calls', async (job) => {
    console.log(`Processing job ${job.id}:`, job.data);

    const { patientId } = job.data;
    const result = await processPatientCall(patientId, {
      ...job.data,
      jobId: job.id
    });

    return result;
  }, {
    connection,
    concurrency: concurrency,
    limiter: {
      max: 5,
      duration: 60000
    }
  });

  worker.on('completed', (job, result) => {
    console.log(`Job ${job.id} completed successfully`);
  });

  worker.on('failed', (job, err) => {
    console.error(`Job ${job.id} failed:`, err.message);
  });

  worker.on('error', (err) => {
    console.error('Worker error:', err.message);
  });

  console.log(`Worker ready (concurrency: ${concurrency}). Waiting for jobs...`);

  // Graceful shutdown
  process.on('SIGTERM', async () => {
    console.log('SIGTERM received, closing worker...');
    await worker.close();
    await eventBus.close();
    await pool.end();
    await connection.quit();
    process.exit(0);
  });

  process.on('SIGINT', async () => {
    console.log('SIGINT received, closing worker...');
    await worker.close();
    await eventBus.close();
    await pool.end();
    await connection.quit();
    process.exit(0);
  });
}

// Start the worker
startWorker().catch(err => {
  console.error('Worker startup failed:', err);
  process.exit(1);
});
