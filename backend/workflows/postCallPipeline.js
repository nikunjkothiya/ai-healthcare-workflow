const { query } = require('../services/database');
const llmService = require('../services/ai/llmService');
const { EventBus, EVENTS } = require('../orchestrator/eventBus');

class PostCallPipeline {
  constructor() {
    this.eventBus = new EventBus();
    this.minTranscriptLength = 20;
    this.analysisWaitTimeoutMs = parseInt(process.env.ANALYSIS_MODEL_WAIT_TIMEOUT_MS, 10) || 180000;
  }

  /**
   * Run post-call AI analysis.
   * @param {number} callId
   * @returns {Promise<object|null>}
   */
  async process(callId) {
    console.log(`Starting post-call pipeline for call ${callId}`);

    try {
      const context = await this.loadCallContext(callId);
      const transcript = String(context.call.transcript || '').trim();

      // Architectural change: enforce model swap (no 3B+7B co-load) before analysis.
      await llmService.ensureAnalysisModel({
        waitForRealtime: true,
        timeoutMs: this.analysisWaitTimeoutMs
      });

      let strictAnalysis;
      if (transcript.length < this.minTranscriptLength) {
        strictAnalysis = this.buildInsufficientDataResult(transcript);
      } else {
        strictAnalysis = await llmService.generatePostCallAnalysisStrict({
          transcript,
          patient: context.patient,
          campaign: context.campaign,
          callMeta: {
            callId,
            state: context.call.state || null
          }
        });
      }

      const result = this.mapAnalysisToResult(strictAnalysis, transcript);
      await this.storeResults(callId, result);

      if (result.requires_followup) {
        await query(
          `UPDATE calls
           SET state = $1,
               updated_at = CURRENT_TIMESTAMP
           WHERE id = $2`,
          ['requires_followup', callId]
        );

        if (context.patient?.id) {
          await query(
            `UPDATE patients
             SET status = $1,
                 updated_at = CURRENT_TIMESTAMP
             WHERE id = $2`,
            ['followup_required', context.patient.id]
          );
        }
      }

      await this.eventBus.emit(EVENTS.CALL_ANALYSIS_COMPLETED, {
        callId,
        sentiment: result.sentiment,
        appointmentConfirmed: result.appointment_confirmed,
        requiresFollowup: result.requires_followup,
        riskLevel: strictAnalysis.risk_level,
        riskFlags: strictAnalysis.risk_flags,
        priority: strictAnalysis.priority,
        analysisStatus: result.structured_output.analysis_status
      });

      console.log(`Post-call pipeline completed for call ${callId}`);
      return result;
    } catch (error) {
      console.error(`CRITICAL: Post-call pipeline failed for call ${callId}:`, error.message);
      await this.markFailure(callId, error);
      throw error;
    } finally {
      // Keep memory bounded; realtime calls will reacquire 3B when needed.
      llmService.releaseAnalysisModel().catch((releaseError) => {
        console.warn(`Analysis model release warning for call ${callId}: ${releaseError.message}`);
      });
    }
  }

  /**
   * Load call, patient, and campaign context in one query.
   * @param {number} callId
   * @returns {Promise<object>}
   */
  async loadCallContext(callId) {
    const result = await query(
      `SELECT
         c.id AS call_id,
         c.transcript,
         c.duration,
         c.state,
         c.created_at,
         p.id AS patient_id,
         p.name AS patient_name,
         p.phone AS patient_phone,
         p.category AS patient_category,
         p.metadata AS patient_metadata,
         cam.id AS campaign_id,
         cam.name AS campaign_name,
         cam.script_template AS campaign_script_template,
         cam.schedule_time AS campaign_schedule_time
       FROM calls c
       LEFT JOIN patients p ON p.id = c.patient_id
       LEFT JOIN campaigns cam ON cam.id = c.campaign_id
       WHERE c.id = $1
       LIMIT 1`,
      [callId]
    );

    if (result.rows.length === 0) {
      throw new Error('Call not found');
    }

    const row = result.rows[0];
    return {
      call: {
        id: row.call_id,
        transcript: row.transcript || '',
        duration: row.duration || 0,
        state: row.state || null,
        created_at: row.created_at || null
      },
      patient: {
        id: row.patient_id,
        name: row.patient_name,
        phone: row.patient_phone,
        category: row.patient_category,
        metadata: row.patient_metadata || {}
      },
      campaign: {
        id: row.campaign_id,
        name: row.campaign_name,
        script_template: row.campaign_script_template || '',
        schedule_time: row.campaign_schedule_time || null
      }
    };
  }

  buildInsufficientDataResult(transcript) {
    const compact = String(transcript || '').replace(/\s+/g, ' ').trim();
    const summary = compact
      ? compact.slice(0, 240)
      : 'Insufficient transcript for deterministic call analysis.';

    return {
      summary,
      campaign_goal_achieved: false,
      appointment_confirmed: false,
      confirmed_date: null,
      confirmed_time: null,
      sentiment: 'neutral',
      risk_level: 'low',
      risk_flags: [],
      requires_manual_followup: false,
      followup_reason: null,
      priority: 'low'
    };
  }

  mapAnalysisToResult(strict, transcript) {
    // Consistency fix: if campaign goal achieved and transcript has confirmation
    // phrases, override appointment_confirmed to true
    const compactTranscript = String(transcript || '').toLowerCase().replace(/\s+/g, ' ');
    const hasConfirmationPhrase = /\b(yes|sure|okay|that works|sounds good|confirm|i can make it|i'll be there)\b/i.test(compactTranscript);

    let appointmentConfirmed = strict.appointment_confirmed;
    if (strict.campaign_goal_achieved && hasConfirmationPhrase && !appointmentConfirmed) {
      appointmentConfirmed = true;
      console.log('[POST-CALL] Consistency fix: campaign_goal_achieved=true + confirmation phrase → appointment_confirmed=true');
    }

    // If appointment confirmed with no barriers/risks, no manual followup needed
    let requiresManualFollowup = Boolean(strict.requires_manual_followup);
    if (appointmentConfirmed && strict.risk_level === 'low' && strict.risk_flags.length === 0) {
      requiresManualFollowup = false;
    }

    const requestedCallback = requiresManualFollowup;
    const requiresFollowup = Boolean(requiresManualFollowup || strict.risk_level === 'high');
    const analysisStatus = transcript.length < this.minTranscriptLength ? 'insufficient_data' : 'completed';

    return {
      structured_output: {
        ...strict,
        appointment_confirmed: appointmentConfirmed,
        analysis_status: analysisStatus,
        analysis_model: llmService.analysisModel,

        // Backward-compatible keys used by existing dashboards/routes.
        requested_callback: requestedCallback,
        requires_followup: requiresFollowup,
        requires_manual_followup: requiresManualFollowup,
        barrier_type: 'none',
        barrier_notes: strict.risk_flags.join(', ').slice(0, 260)
      },
      sentiment: strict.sentiment,
      summary: strict.summary,
      appointment_confirmed: appointmentConfirmed,
      requested_callback: requestedCallback,
      requires_followup: requiresFollowup
    };
  }

  /**
   * Persist analysis to calls table.
   * @param {number} callId
   * @param {object} result
   */
  async storeResults(callId, result) {
    await query(
      `UPDATE calls
       SET structured_output = $1,
           sentiment = $2,
           summary = $3,
           appointment_confirmed = $4,
           requested_callback = $5,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $6`,
      [
        JSON.stringify(result.structured_output || {}),
        result.sentiment || 'neutral',
        result.summary || '',
        Boolean(result.appointment_confirmed),
        Boolean(result.requested_callback),
        callId
      ]
    );
  }

  async markFailure(callId, error) {
    try {
      await query(
        `UPDATE calls
         SET state = $1,
             state_metadata = $2,
             summary = $3,
             updated_at = CURRENT_TIMESTAMP
         WHERE id = $4`,
        [
          'failed',
          JSON.stringify({
            error: error.message,
            reason: 'post_call_analysis_failed',
            timestamp: new Date().toISOString()
          }),
          `Analysis failed: ${error.message}`,
          callId
        ]
      );

      await this.eventBus.emit(EVENTS.CALL_FAILED, {
        callId,
        reason: 'analysis_failed',
        error: error.message
      });
    } catch (dbError) {
      console.error('Failed to persist analysis failure state:', dbError.message);
    }
  }
}

module.exports = new PostCallPipeline();
