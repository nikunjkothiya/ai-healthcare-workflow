const { query } = require('../services/database');
const llmService = require('../services/ai/llmService');

// Action types
const ACTIONS = {
  GENERATE_RESPONSE: 'generate_response',
  SCHEDULE_FOLLOWUP: 'schedule_followup',
  END_CALL: 'end_call',
  TRANSFER_HUMAN: 'transfer_human',
  COLLECT_INFO: 'collect_info'
};

class AgentController {
  /**
   * Decide next action based on conversation context
   * @param {object} context - Conversation context
   * @returns {Promise<object>} Action decision
   */
  async decide(context) {
    const { callId, transcript, turnCount, patientId } = context;

    try {
      // Load patient information
      const patient = await this.loadPatientInfo(patientId);

      // Load agent configuration
      const config = await this.loadAgentConfig(patientId);

      // Analyze conversation state (heuristics still used as guardrails)
      const analysis = this.analyzeConversation(transcript, turnCount, config, patient);
      const promptTemplate = this.buildContextualPrompt(patient, config);

      // Hard safety guardrail: end very long calls.
      if (analysis.exceedsMaxTurns) {
        const capped = {
          action: ACTIONS.END_CALL,
          reason: 'max_turns_exceeded',
          message: 'Thank you for your time. A care coordinator will follow up if needed.',
          nextState: 'completed'
        };
        console.log(`Agent decision for call ${callId}:`, capped);
        return capped;
      }

      // Primary decision path: LLM-driven action selection.
      try {
        const llmDecision = await llmService.generateConversationDecision({
          transcript,
          turnCount,
          patient,
          config,
          heuristicAnalysis: analysis
        });

        const mapped = this.mapLLMDecisionToAction(llmDecision, analysis, promptTemplate);
        if (mapped) {
          console.log(`Agent decision for call ${callId} (LLM):`, mapped);
          return mapped;
        }
      } catch (llmError) {
        console.warn(`LLM decision failed for call ${callId}, using rule fallback:`, llmError.message);
      }

      // Fallback: deterministic rules.
      const fallbackAction = this.determineAction(analysis, config, patient);
      console.log(`Agent decision for call ${callId} (fallback):`, fallbackAction);
      return fallbackAction;
    } catch (error) {
      console.error('Agent decision error:', error);
      return {
        action: ACTIONS.END_CALL,
        reason: 'error',
        nextState: 'failed'
      };
    }
  }

  /**
   * Load patient information from database
   * @param {number} patientId - Patient ID
   * @returns {Promise<object>} Patient info
   */
  async loadPatientInfo(patientId) {
    try {
      const result = await query(
        'SELECT * FROM patients WHERE id = $1',
        [patientId]
      );

      if (result.rows.length > 0) {
        return result.rows[0];
      }

      return null;
    } catch (error) {
      console.error('Load patient error:', error);
      return null;
    }
  }

  /**
   * Load agent configuration from database
   * @param {number} patientId - Patient ID
   * @returns {Promise<object>} Agent config
   */
  async loadAgentConfig(patientId) {
    try {
      // Try to load patient-specific config
      const result = await query(
        `SELECT ac.* FROM agent_configs ac
         JOIN patients p ON p.campaign_id = ac.campaign_id
         WHERE p.id = $1`,
        [patientId]
      );

      if (result.rows.length > 0) {
        return result.rows[0];
      }

      // Return default config
      return this.getDefaultConfig();
    } catch (error) {
      console.error('Load config error:', error);
      return this.getDefaultConfig();
    }
  }

  /**
   * Get default agent configuration
   * @returns {object} Default config
   */
  getDefaultConfig() {
    return {
      max_turns: 5,
      greeting_script: "Hello, I'm calling from the healthcare center to confirm your upcoming appointment.",
      prompt_template: `You are a professional healthcare appointment coordinator making an outbound call.

YOUR ROLE:
- Confirm patient appointments
- Answer basic scheduling questions
- Identify and escalate concerns to care coordinators
- Maintain a warm, professional, empathetic tone

COMMUNICATION STYLE:
- Speak naturally and conversationally
- Keep responses brief (1-2 sentences maximum)
- Be patient and understanding
- Listen actively and acknowledge patient responses
- Never rush the patient

WHAT YOU CAN DO:
- Confirm appointment date, time, and doctor
- Reschedule appointments
- Answer questions about appointment location and preparation
- Take notes about patient concerns for care coordinator

WHAT YOU CANNOT DO:
- Give medical advice or diagnoses
- Discuss test results or medical conditions in detail
- Make promises about treatment outcomes
- Discuss billing in detail (refer to billing department)

REMEMBER: You are here to help, not to pressure. If patient is busy or uncomfortable, offer to call back.`,
      end_keywords: ['goodbye', 'thank you', 'bye', 'thanks', 'have a good day', 'talk later'],
      followup_keywords: ['call back', 'later', 'not now', 'busy', 'another time', 'not good time'],
      confirmation_keywords: ['yes', 'confirm', 'correct', 'sure', 'okay', 'sounds good', 'that works']
    };
  }

  /**
   * Analyze conversation to determine state
   * @param {string} transcript - Full transcript
   * @param {number} turnCount - Number of turns
   * @param {object} config - Agent config
   * @param {object} patient - Patient info
   * @returns {object} Analysis result
   */
  analyzeConversation(transcript, turnCount, config, patient) {
    const lowerTranscript = transcript.toLowerCase();
    const endKeywords = Array.isArray(config.end_keywords) ? config.end_keywords : [];
    const followupKeywords = Array.isArray(config.followup_keywords) ? config.followup_keywords : [];
    const confirmationKeywords = Array.isArray(config.confirmation_keywords) ? config.confirmation_keywords : [];

    // Detect barriers and concerns
    const barriers = this.detectBarriers(lowerTranscript, patient);

    const maxTurns = Number.isInteger(parseInt(config.max_turns, 10)) ? parseInt(config.max_turns, 10) : 5;

    return {
      hasEndKeyword: endKeywords.some((kw) => lowerTranscript.includes(String(kw).toLowerCase())),
      hasFollowupKeyword: followupKeywords.some((kw) => lowerTranscript.includes(String(kw).toLowerCase())),
      hasConfirmation: confirmationKeywords.some((kw) => lowerTranscript.includes(String(kw).toLowerCase())),
      exceedsMaxTurns: turnCount >= maxTurns,
      isEmpty: transcript.trim().length < 10,
      barriers: barriers,
      hasBarrier: barriers.length > 0
    };
  }

  /**
   * Detect barriers from conversation
   * @param {string} transcript - Transcript text
   * @param {object} patient - Patient info
   * @returns {Array} Detected barriers
   */
  detectBarriers(transcript, patient) {
    const barriers = [];

    // Financial barriers
    if (transcript.includes('afford') || transcript.includes('expensive') ||
      transcript.includes('cost') || transcript.includes('money') ||
      transcript.includes('insurance') || transcript.includes('pay')) {
      barriers.push({
        type: 'financial',
        priority: 'high',
        detected_text: 'financial concern mentioned'
      });
    }

    // Transportation barriers
    if (transcript.includes('ride') || transcript.includes('transport') ||
      transcript.includes('get there') || transcript.includes('no car') ||
      transcript.includes('bus') || transcript.includes('drive')) {
      barriers.push({
        type: 'transportation',
        priority: 'medium',
        detected_text: 'transportation issue mentioned'
      });
    }

    // Scheduling barriers
    if (transcript.includes('busy') || transcript.includes('work') ||
      transcript.includes('time') || transcript.includes('schedule') ||
      transcript.includes('conflict')) {
      barriers.push({
        type: 'scheduling',
        priority: 'medium',
        detected_text: 'scheduling conflict mentioned'
      });
    }

    // Language barriers
    if (transcript.includes('understand') || transcript.includes('english') ||
      transcript.includes('language') || transcript.includes('translator')) {
      barriers.push({
        type: 'language',
        priority: 'high',
        detected_text: 'language barrier mentioned'
      });
    }

    // Check patient metadata for known barriers
    if (patient && patient.metadata) {
      let metadata = {};
      try {
        metadata = typeof patient.metadata === 'string'
          ? JSON.parse(patient.metadata)
          : patient.metadata || {};
      } catch (error) {
        metadata = {};
      }

      if (metadata.transportation_issue === 'Yes') {
        barriers.push({
          type: 'transportation',
          priority: 'high',
          detected_text: 'known transportation issue from records'
        });
      }

      if (metadata.financial_concern === 'Yes') {
        barriers.push({
          type: 'financial',
          priority: 'high',
          detected_text: 'known financial concern from records'
        });
      }
    }

    return barriers;
  }

  /**
   * Determine next action based on analysis
   * @param {object} analysis - Conversation analysis
   * @param {object} config - Agent config
   * @param {object} patient - Patient info
   * @returns {object} Action decision
   */
  determineAction(analysis, config, patient) {
    // If barriers detected, escalate to follow-up
    if (analysis.hasBarrier) {
      const barrierTypes = analysis.barriers.map(b => b.type).join(', ');
      return {
        action: ACTIONS.SCHEDULE_FOLLOWUP,
        reason: 'barriers_detected',
        message: `I understand you have some concerns. A care coordinator will call you back to help with ${barrierTypes} assistance.`,
        nextState: 'requires_followup',
        barriers: analysis.barriers
      };
    }

    // End call if goodbye detected
    if (analysis.hasEndKeyword) {
      return {
        action: ACTIONS.END_CALL,
        reason: 'end_keyword_detected',
        message: 'Thank you for your time. Have a great day!',
        nextState: 'completed'
      };
    }

    // Schedule followup if requested
    if (analysis.hasFollowupKeyword) {
      return {
        action: ACTIONS.SCHEDULE_FOLLOWUP,
        reason: 'followup_requested',
        message: 'I understand. We will call you back at a better time.',
        nextState: 'requires_followup'
      };
    }

    // End if max turns exceeded
    if (analysis.exceedsMaxTurns) {
      return {
        action: ACTIONS.END_CALL,
        reason: 'max_turns_exceeded',
        message: 'Thank you for your time. We will follow up if needed.',
        nextState: 'completed'
      };
    }

    // Continue conversation with context-aware prompt
    const promptTemplate = this.buildContextualPrompt(patient, config);

    return {
      action: ACTIONS.GENERATE_RESPONSE,
      reason: 'continue_conversation',
      promptTemplate: promptTemplate,
      nextState: 'awaiting_response'
    };
  }

  /**
   * Convert LLM decision payload into orchestrator action.
   * @param {object} llmDecision
   * @param {object} analysis
   * @param {string} promptTemplate
   * @returns {object|null}
   */
  mapLLMDecisionToAction(llmDecision, analysis, promptTemplate) {
    if (!llmDecision || !llmDecision.action) {
      return null;
    }

    const action = String(llmDecision.action).toLowerCase().trim();
    const message = this.sanitizeDecisionMessage(llmDecision.message);
    const barriers = Array.isArray(llmDecision.barriers) ? llmDecision.barriers : analysis.barriers;

    // Preserve deterministic stop signal when patient explicitly ends call.
    if (analysis.hasEndKeyword) {
      return {
        action: ACTIONS.END_CALL,
        reason: 'end_keyword_detected',
        message: message || 'Thank you for your time. Have a great day!',
        nextState: 'completed'
      };
    }

    if (action === ACTIONS.END_CALL) {
      return {
        action: ACTIONS.END_CALL,
        reason: llmDecision.reason || 'llm_end_call',
        message: message || 'Thank you for your time. Have a great day!',
        nextState: 'completed'
      };
    }

    if (action === ACTIONS.SCHEDULE_FOLLOWUP || action === ACTIONS.TRANSFER_HUMAN) {
      return {
        action: action === ACTIONS.TRANSFER_HUMAN ? ACTIONS.TRANSFER_HUMAN : ACTIONS.SCHEDULE_FOLLOWUP,
        reason: llmDecision.reason || 'llm_followup',
        message: message || 'Thank you. A care coordinator will follow up with you shortly.',
        nextState: 'requires_followup',
        barriers
      };
    }

    if (action === ACTIONS.COLLECT_INFO || action === ACTIONS.GENERATE_RESPONSE) {
      return {
        action: ACTIONS.GENERATE_RESPONSE,
        reason: llmDecision.reason || 'llm_continue',
        promptTemplate,
        nextState: 'awaiting_response'
      };
    }

    return null;
  }

  sanitizeDecisionMessage(message) {
    const text = String(message || '').trim();
    if (!text) return null;

    if (/optional short spoken message/i.test(text)) {
      return null;
    }

    const cleaned = text
      .replace(/^introduction:\s*/i, '')
      .replace(/^(assistant|agent)\s*:\s*/i, '')
      .replace(/\s+/g, ' ')
      .trim();

    if (!cleaned) return null;
    return cleaned.length > 220 ? `${cleaned.slice(0, 217)}...` : cleaned;
  }

  /**
   * Build contextual prompt based on patient info
   * @param {object} patient - Patient info
   * @param {object} config - Agent config
   * @returns {string} Contextual prompt
   */
  buildContextualPrompt(patient, config) {
    let prompt = config.prompt_template || this.getDefaultConfig().prompt_template;

    // Add patient-specific context
    prompt += '\n\nCURRENT PATIENT CONTEXT:';

    if (patient && patient.metadata) {
      let metadata = {};
      try {
        metadata = typeof patient.metadata === 'string'
          ? JSON.parse(patient.metadata)
          : patient.metadata || {};
      } catch (error) {
        metadata = {};
      }

      // Appointment details
      if (metadata.appointment_type) {
        prompt += `\n- Appointment Type: ${metadata.appointment_type}`;
      }

      if (metadata.appointment_date) {
        prompt += `\n- Scheduled Date: ${metadata.appointment_date}`;
      }

      if (metadata.doctor) {
        prompt += `\n- Doctor: ${metadata.doctor}`;
      }

      // Medical context (for awareness, not discussion)
      if (metadata.medical_condition) {
        prompt += `\n- Medical Condition: ${metadata.medical_condition} (DO NOT discuss in detail, just be aware)`;
      }

      // Special considerations
      if (metadata.age) {
        const age = parseInt(metadata.age);
        if (age < 18) {
          prompt += '\n- IMPORTANT: You are speaking with a parent/guardian about their child. Be extra clear and patient.';
        } else if (age > 65) {
          prompt += '\n- IMPORTANT: Patient is elderly. Speak clearly, slowly, and be extra patient. Repeat information if needed.';
        }
      }

      if (metadata.language && metadata.language !== 'English') {
        prompt += `\n- IMPORTANT: Patient's primary language is ${metadata.language}. Use simple English, speak slowly, avoid idioms.`;
      }

      if (metadata.previous_no_show === 'Yes') {
        prompt += '\n- NOTE: Patient has missed appointments before. Gently emphasize importance of attending and offer reminders.';
      }

      // Known barriers (be proactive)
      if (metadata.transportation_issue === 'Yes') {
        prompt += '\n- KNOWN ISSUE: Patient has transportation challenges. Proactively offer transportation assistance information.';
      }

      if (metadata.financial_concern === 'Yes') {
        prompt += '\n- KNOWN ISSUE: Patient has financial concerns. Be sensitive, offer to connect with billing/financial assistance.';
      }
    }

    prompt += '\n\nREMEMBER: Keep your response brief (1-2 sentences), natural, and focused on helping the patient.';

    return prompt;
  }

  /**
   * Get greeting message for call start.
   * Uses the campaign's script_template as primary greeting, with patient variable substitution.
   * Falls back to metadata-based greeting only when no campaign script exists.
   * @param {number} patientId - Patient ID
   * @returns {Promise<string>} Greeting message
   */
  async getGreeting(patientId) {
    const patient = await this.loadPatientInfo(patientId);

    let metadata = {};
    let patientName = '';
    if (patient) {
      patientName = patient.name ? patient.name.split(' ')[0] : '';
      try {
        metadata = patient.metadata && typeof patient.metadata === 'string'
          ? JSON.parse(patient.metadata)
          : patient.metadata || {};
      } catch (_) {
        metadata = {};
      }
    }

    // Try to load campaign script_template for this patient
    let campaignScript = '';
    try {
      if (patient?.campaign_id) {
        const campaignResult = await query(
          'SELECT script_template FROM campaigns WHERE id = $1',
          [patient.campaign_id]
        );
        if (campaignResult.rows.length > 0) {
          campaignScript = String(campaignResult.rows[0].script_template || '').trim();
        }
      }
    } catch (err) {
      console.warn('Failed to load campaign script for greeting:', err.message);
    }

    // If campaign has a script_template, use it with variable substitution
    if (campaignScript) {
      const substitutions = {
        '{name}': patientName || patient?.name || '',
        '{doctor}': metadata.doctor_name || metadata.doctor || '',
        '{appointment_date}': metadata.appointment_date || '',
        '{appointment_type}': metadata.appointment_type || '',
        '{condition}': metadata.medical_condition || patient?.category || '',
        '{phone}': patient?.phone || ''
      };

      let greeting = campaignScript;
      for (const [placeholder, value] of Object.entries(substitutions)) {
        greeting = greeting.replace(new RegExp(placeholder.replace(/[{}]/g, '\\$&'), 'gi'), value);
      }

      return greeting.trim();
    }

    // Fallback: build greeting from patient metadata when no campaign script
    if (metadata.appointment_type && metadata.appointment_date && metadata.doctor) {
      return `Hello${patientName ? ' ' + patientName : ''}, this is the healthcare center calling about your ${metadata.appointment_type} appointment with ${metadata.doctor} on ${metadata.appointment_date}. Do you have a moment to confirm?`;
    } else if (metadata.appointment_date && metadata.doctor) {
      return `Hello${patientName ? ' ' + patientName : ''}, I'm calling from the healthcare center to confirm your appointment with ${metadata.doctor} on ${metadata.appointment_date}. Is now a good time?`;
    } else if (metadata.appointment_date) {
      return `Hello${patientName ? ' ' + patientName : ''}, I'm calling from the healthcare center about your upcoming appointment on ${metadata.appointment_date}. Can we confirm your appointment?`;
    }

    return `Hello${patientName ? ' ' + patientName : ''}, I'm calling from the healthcare center to confirm your upcoming appointment. Do you have a quick moment?`;
  }
}

module.exports = {
  AgentController,
  ACTIONS
};
