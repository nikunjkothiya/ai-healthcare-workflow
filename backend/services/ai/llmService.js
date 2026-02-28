const axios = require('axios');
const ModelRuntimeManager = require('./modelRuntimeManager');
const {
  extractJsonObject,
  validateRealtimeTurn,
  validatePostCallAnalysis
} = require('./jsonValidation');
const { formatTurnsForPrompt } = require('./conversationMemory');

const NON_SPEECH_ARTIFACT_REGEX = /\[(?:BLANK_AUDIO|SILENCE|NO_SPEECH|MUSIC)\]|\((?:SILENCE|NOISE|MUSIC)\)|<\|(?:nospeech|silence)\|>/gi;

class LLMService {
  constructor() {
    this.ollamaUrl = process.env.OLLAMA_URL || 'http://ollama:11434';
    // Model tags are managed internally; .env only provides local GGUF file paths.
    this.model = 'healthcare-base';
    this.chatModel = 'healthcare-chat';
    this.analysisModel = 'healthcare-analysis';
    this.decisionModel = 'healthcare-decision';
    this.analysisNumCtx = parseInt(process.env.LLM_NUM_CTX_ANALYSIS, 10) || 8192;
    this.analysisMaxTokens = parseInt(process.env.LLM_MAX_TOKENS_ANALYSIS, 10) || 1200;
    this.maxRetries = 2;
    this.retryDelayMs = 1500;
    this.available = null; // null = unknown, true/false = checked
    // Architectural change: central model lifecycle manager to avoid 3B/7B co-loading on CPU-only hosts.
    this.runtimeManager = new ModelRuntimeManager({
      ollamaUrl: this.ollamaUrl,
      realtimeModel: this.chatModel,
      analysisModel: this.analysisModel,
      maxRamGb: parseFloat(process.env.MAX_RUNTIME_RAM_GB || '14')
    });
    this.configError = this._validateModelConfig();
  }

  _uniqueModelList(items = []) {
    const seen = new Set();
    const models = [];
    for (const item of items) {
      const name = String(item || '').trim();
      if (!name || seen.has(name)) continue;
      seen.add(name);
      models.push(name);
    }
    return models;
  }

  _normalizeModelName(name) {
    return String(name || '').trim().toLowerCase();
  }

  _modelNameMatches(requiredModel, availableModel) {
    const required = this._normalizeModelName(requiredModel);
    const available = this._normalizeModelName(availableModel);
    if (!required || !available) return false;
    if (required === available) return true;

    // Accept alias tags that point to the same base name, e.g.
    // qwen2.5:3b <-> qwen2.5:3b-instruct-q4_K_M.
    return available.startsWith(required) || required.startsWith(available);
  }

  _requiredModels() {
    return this._uniqueModelList([
      this.model,
      this.chatModel,
      this.analysisModel,
      this.decisionModel
    ]);
  }

  _validateModelConfig() {
    if (!this.model || !this.chatModel || !this.analysisModel || !this.decisionModel) {
      return 'Internal Ollama model tags are not configured.';
    }

    const requiredModels = this._requiredModels();
    if (requiredModels.length === 0) {
      return 'No LLM models configured.';
    }

    return null;
  }

  /**
   * Check if Ollama is reachable and required models are available.
   * @returns {Promise<boolean>}
   */
  async checkAvailability() {
    if (this.configError) {
      console.error(`LLM configuration error: ${this.configError}`);
      this.available = false;
      return false;
    }

    try {
      const response = await axios.get(`${this.ollamaUrl}/api/tags`, { timeout: 5000 });
      const models = response.data.models || [];
      const availableModelNames = [...new Set(
        models
          .flatMap((m) => [m?.name, m?.model])
          .map((name) => this._normalizeModelName(name))
          .filter(Boolean)
      )];
      const requiredModels = this._requiredModels();

      const missingModels = [];
      for (const requiredModel of requiredModels) {
        const hasModel = availableModelNames.some((name) => this._modelNameMatches(requiredModel, name));
        if (hasModel) {
          continue;
        }

        console.warn(`LLM: Model "${requiredModel}" not found in Ollama. Available:`,
          availableModelNames.join(', ') || 'none');
        missingModels.push(requiredModel);
      }

      this.available = missingModels.length === 0;
      if (!this.available) {
        console.error(`LLM: Missing required model(s): ${missingModels.join(', ')}`);
        return false;
      }

      console.log(
        `LLM: Connected to Ollama (default=${this.model}, chat=${this.chatModel}, analysis=${this.analysisModel}, decision=${this.decisionModel})`
      );
      return true;
    } catch (error) {
      console.error(`LLM: Ollama not reachable at ${this.ollamaUrl}: ${error.message}`);
      this.available = false;
      return false;
    }
  }

  _sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  _truncate(value, maxLen = 400) {
    const str = String(value || '').trim();
    if (!str) return '';
    return str.length <= maxLen ? str : `${str.slice(0, maxLen - 3)}...`;
  }

  _sanitizeForPrompt(value, maxLen = 1600) {
    if (value === undefined || value === null) return '';
    if (typeof value === 'string') {
      return this._truncate(value.replace(/\s+/g, ' '), maxLen);
    }
    try {
      return this._truncate(JSON.stringify(value), maxLen);
    } catch (error) {
      return this._truncate(String(value), maxLen);
    }
  }

  _stripNonSpeechArtifacts(text = '') {
    const cleaned = String(text || '')
      .replace(NON_SPEECH_ARTIFACT_REGEX, ' ')
      .replace(/\b(?:blank[_ ]audio|no[_ ]speech)\b/gi, ' ')
      .replace(/\s+/g, ' ')
      .trim();

    if (!cleaned) return '';
    return cleaned.replace(/^[,.;:!?-]+|[,.;:!?-]+$/g, '').trim();
  }

  _formatConversationHistory(conversation, maxMessages = 14) {
    if (!Array.isArray(conversation) || conversation.length === 0) {
      return 'No prior turns.';
    }

    const recent = conversation.slice(-maxMessages);
    const lines = recent.map((msg) => {
      const role = msg?.role === 'assistant' ? 'Assistant' : 'Patient';
      return `${role}: ${this._sanitizeForPrompt(msg?.text || '', 260)}`;
    });
    return lines.join('\n');
  }

  _buildPatientContext(patient) {
    if (!patient) return 'No patient profile provided.';

    let metadata = {};
    if (typeof patient.metadata === 'string') {
      try {
        metadata = JSON.parse(patient.metadata);
      } catch (error) {
        metadata = {};
      }
    } else if (patient.metadata && typeof patient.metadata === 'object') {
      metadata = patient.metadata;
    }

    const context = {
      id: patient.id || null,
      name: patient.name || null,
      category: patient.category || null,
      phone: patient.phone || null,
      metadata
    };

    return this._sanitizeForPrompt(context, 2000);
  }

  _extractJsonObject(rawText) {
    return extractJsonObject(rawText);
  }

  _toStringArray(value, maxItems = 8, itemMaxLen = 220) {
    if (!Array.isArray(value)) return [];
    return value
      .map((item) => this._truncate(item, itemMaxLen))
      .filter((item) => {
        if (!item) return false;
        const normalized = String(item).toLowerCase().trim();
        return !['string', 'n/a', 'na', 'none', 'null', 'undefined'].includes(normalized);
      })
      .slice(0, maxItems);
  }

  _sanitizeConversationReply(text, fallback = 'I understand. Could you share a bit more?') {
    const raw = String(text || '').replace(/\r/g, '').trim();
    if (!raw) return fallback;

    const forbiddenHeaders = [
      'campaign instructions',
      'primary goals',
      'patient profile',
      'recent conversation',
      'latest patient message',
      'assistant:',
      'introduction:'
    ];

    const cleanedLines = raw
      .split('\n')
      .map((line) => line.replace(/^[\s>*-]+/, '').trim())
      .filter((line) => {
        if (!line) return false;
        const lower = line.toLowerCase();
        return !forbiddenHeaders.some((header) => lower.startsWith(header));
      });

    let cleaned = cleanedLines.join(' ').replace(/\s+/g, ' ').trim();
    cleaned = cleaned.replace(/^["'`]+|["'`]+$/g, '');
    cleaned = cleaned.replace(/^(assistant|agent)\s*:\s*/i, '');
    cleaned = cleaned.replace(/^introduction:\s*/i, '');
    cleaned = cleaned.replace(/>>/g, ' ').replace(/\s+/g, ' ').trim();

    if (/optional short spoken message/i.test(cleaned)) {
      return fallback;
    }

    // Collapse verbose list-style output into natural speech.
    if (/^\d+\./.test(cleaned) || cleaned.toLowerCase().includes('step 1')) {
      cleaned = cleaned
        .replace(/\b\d+\.\s*/g, ' ')
        .replace(/\s{2,}/g, ' ')
        .trim();
    }

    // Keep response short and conversational (max 2 sentences).
    const sentences = cleaned.match(/[^.!?]+[.!?]?/g) || [];
    const concise = sentences.slice(0, 2).join(' ').trim();
    const finalText = this._truncate(concise || cleaned, 260);

    return finalText || fallback;
  }

  _sanitizeAnalysisTranscript(transcript) {
    const maxChars = parseInt(process.env.LLM_ANALYSIS_TRANSCRIPT_MAX_CHARS, 10) || 18000;
    const raw = String(transcript || '').replace(/\r/g, '').trim();
    if (!raw) return '';

    const lines = raw
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
    const cleaned = [];

    for (const line of lines) {
      const match = line.match(/^(assistant|patient)\s*:\s*(.*)$/i);
      if (!match) {
        const normalized = this._stripNonSpeechArtifacts(line.replace(/>>/g, ' ').replace(/\s+/g, ' ').trim());
        if (normalized) cleaned.push(normalized);
        continue;
      }

      const speaker = match[1][0].toUpperCase() + match[1].slice(1).toLowerCase();
      let content = String(match[2] || '').trim();
      content = content.replace(/>>/g, ' ').replace(/\s+/g, ' ').trim();
      content = content.replace(/^introduction:\s*/i, '');
      content = this._stripNonSpeechArtifacts(content);
      content = content.replace(/\b(?:uh+|um+|hmm+|mmm+)\b/gi, ' ').replace(/\s+/g, ' ').trim();

      if (!content) continue;
      if (/optional short spoken message/i.test(content)) continue;

      // De-duplicate repeated short fragments common in noisy STT output.
      const fragments = content.split(/\s{2,}|\.\s+/).map((item) => item.trim()).filter(Boolean);
      const deduped = [];
      for (const fragment of fragments) {
        if (deduped.length === 0 || deduped[deduped.length - 1].toLowerCase() !== fragment.toLowerCase()) {
          deduped.push(fragment);
        }
      }

      const normalizedContent = deduped.join('. ').replace(/\s+/g, ' ').trim();
      if (!normalizedContent) continue;

      cleaned.push(`${speaker}: ${normalizedContent}`);
    }

    const compact = cleaned.join('\n').trim();
    return this._truncate(compact, maxChars);
  }

  async _generateAnalysisJson(prompt, repairKeyList) {
    const modelName = this.analysisModel;
    const response = await this.generate(prompt, {
      temperature: 0.1,
      max_tokens: this.analysisMaxTokens,
      timeout_ms: 180000,
      json: true,
      model: modelName,
      num_ctx: this.analysisNumCtx
    });

    try {
      const parsed = this._extractJsonObject(response);
      return { parsed, modelName };
    } catch (parseError) {
      const repairPrompt = `Convert the following model output into valid JSON.
Return JSON only, no markdown.

REQUIRED KEYS:
${repairKeyList}

MODEL OUTPUT:
${this._sanitizeForPrompt(response, 7000)}`;

      const repaired = await this.generate(repairPrompt, {
        temperature: 0.0,
        max_tokens: 900,
        timeout_ms: 120000,
        json: true,
        model: modelName,
        num_ctx: this.analysisNumCtx
      });
      const parsed = this._extractJsonObject(repaired);
      return { parsed, modelName };
    }
  }

  _isLowQualitySummary(summary) {
    const text = String(summary || '').trim();
    if (!text) return true;
    if (text.length < 40) return true;
    if (/assistant:|patient:|>>/i.test(text)) return true;
    if (/optional short spoken message|introduction:/i.test(text)) return true;
    if (/will be completed|within the specified time|scheduled for a medical consultation/i.test(text)) return true;
    return false;
  }

  _isUsefulInstructionText(value) {
    const text = String(value || '').trim();
    if (!text) return false;
    if (text.length < 20) return false;
    if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return false;

    const words = text.split(/\s+/).filter(Boolean);
    const alphaWords = words.filter((word) => /[a-z]/i.test(word));
    if (alphaWords.length < 4) return false;

    if (/^(appointment|follow[- ]?up|call|date|time)\b/i.test(text) && alphaWords.length < 6) {
      return false;
    }

    return true;
  }

  _hasUnseenTimeDetail(summary, transcript) {
    const summaryText = String(summary || '').toLowerCase();
    const transcriptText = String(transcript || '').toLowerCase();
    if (!summaryText || !transcriptText) return false;

    const timeMatches = summaryText.match(/\b\d{1,2}(?::\d{2})?\s?(?:am|pm)\b/g) || [];
    for (const match of timeMatches) {
      const compact = match.replace(/\s+/g, '');
      if (!transcriptText.includes(match) && !transcriptText.includes(compact)) {
        return true;
      }
    }
    return false;
  }

  _inferSignalsFromTranscript(transcript) {
    const raw = String(transcript || '');
    const patientLines = raw
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => /^patient\s*:/i.test(line))
      .map((line) => this._stripNonSpeechArtifacts(line.replace(/^patient\s*:\s*/i, '').trim()))
      .filter(Boolean);

    const patientText = this._stripNonSpeechArtifacts(patientLines.join(' ').replace(/\s+/g, ' ').trim()).toLowerCase();
    const fullText = this._stripNonSpeechArtifacts(raw).toLowerCase();

    const appointmentConfirmed = /\b(confirm|confirmed|yes|that works|sounds good|okay)\b/.test(patientText) &&
      /\bappointment|visit|time\b/.test(fullText);
    const requestedCallback = /\b(call back|callback|later|another time|not now|busy)\b/.test(patientText);
    const transportationBarrier = /\b(ride|transport|bus|no car|drive)\b/.test(patientText);
    const financialBarrier = /\b(afford|expensive|cost|money|insurance|pay)\b/.test(patientText);
    const schedulingBarrier = /\b(schedule|conflict|work|time issue|not a good time)\b/.test(patientText);
    const languageBarrier = /\b(language|translator|english)\b/.test(patientText);
    const politeClose = /\b(thank you|thanks|goodbye|bye)\b/.test(patientText);

    let barrierType = 'none';
    if (financialBarrier) barrierType = 'financial';
    else if (transportationBarrier) barrierType = 'transportation';
    else if (schedulingBarrier) barrierType = 'scheduling';
    else if (languageBarrier) barrierType = 'language';

    return {
      hasPatientSpeech: patientText.length > 0,
      appointmentConfirmed,
      requestedCallback,
      barrierType,
      politeClose
    };
  }

  _buildHeuristicSummary(signals) {
    const parts = [];
    parts.push(signals.hasPatientSpeech
      ? 'Patient engaged with the assistant during the call.'
      : 'Limited patient speech was captured during the call.');

    if (signals.appointmentConfirmed) {
      parts.push('Patient verbally indicated agreement with the appointment discussion.');
    } else {
      parts.push('No clear verbal appointment confirmation was captured.');
    }

    if (signals.requestedCallback) {
      parts.push('Patient requested a callback or alternate timing.');
    } else {
      parts.push('No callback request was captured.');
    }

    if (signals.barrierType !== 'none') {
      parts.push(`Potential ${signals.barrierType} barrier was mentioned.`);
    }

    return parts.join(' ');
  }

  /**
   * Generate text from LLM with retries.
   * @param {string} prompt
   * @param {object} options
   * @returns {Promise<string>}
   */
  async generate(prompt, options = {}) {
    const maxTokens = options.max_tokens ?? (parseInt(process.env.LLM_MAX_TOKENS, 10) || 150);
    const selectedModel = options.model || this.model;
    const timeoutMs = options.timeout_ms ?? (parseInt(process.env.LLM_TIMEOUT_MS, 10) || 45000);
    const numCtx = options.num_ctx ?? (parseInt(process.env.LLM_NUM_CTX, 10) || 512);

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      try {
        const payload = {
          model: selectedModel,
          prompt,
          stream: false,
          keep_alive: options.keep_alive || undefined,
          options: {
            temperature: options.temperature ?? 0.7,
            top_p: options.top_p ?? 0.9,
            num_predict: maxTokens,
            num_ctx: numCtx
          }
        };

        if (Array.isArray(options.stop) && options.stop.length > 0) {
          payload.options.stop = options.stop;
        }

        if (options.json) {
          payload.format = 'json';
        }

        const response = await axios.post(
          `${this.ollamaUrl}/api/generate`,
          payload,
          { timeout: timeoutMs }
        );

        if (response.data && response.data.response) {
          return response.data.response.trim();
        }

        throw new Error('Empty response from Ollama');
      } catch (error) {
        const statusCode = Number(error?.response?.status || 0);
        const isFatalClientError = statusCode >= 400 && statusCode < 500 && statusCode !== 429;
        const isLastAttempt = attempt === this.maxRetries;
        console.error(
          `LLM generation error (attempt ${attempt + 1}/${this.maxRetries + 1}):`,
          error.message
        );

        if (isFatalClientError || isLastAttempt) {
          const attemptsUsed = attempt + 1;
          throw new Error(`LLM generation failed after ${attemptsUsed} attempt${attemptsUsed === 1 ? '' : 's'}: ${error.message}`);
        }

        await this._sleep(this.retryDelayMs * (attempt + 1));
      }
    }
  }

  /**
   * Safe generate for non-critical paths.
   * @param {string} prompt
   * @param {object} options
   * @param {string} fallback
   * @returns {Promise<string>}
   */
  async generateSafe(prompt, options = {}, fallback = 'I understand.') {
    try {
      return await this.generate(prompt, options);
    } catch (error) {
      console.error('LLM generateSafe fallback:', error.message);
      return fallback;
    }
  }

  /**
   * Generate an in-call conversational reply.
   * Accepts legacy signature (userMessage, systemPrompt) or object input.
   * @param {string|object} input
   * @param {string} legacySystemPrompt
   * @returns {Promise<string>}
   */
  async generateConversationResponse(input, legacySystemPrompt) {
    if (this.available === false) {
      throw new Error('Conversation model unavailable');
    }

    let latestUserMessage = '';
    let systemPrompt = '';
    let conversation = [];
    let patient = null;

    if (input && typeof input === 'object') {
      latestUserMessage = String(input.latestUserMessage || '').trim();
      systemPrompt = String(input.systemPrompt || legacySystemPrompt || '').trim();
      conversation = Array.isArray(input.conversation) ? input.conversation : [];
      patient = input.patient || input.patientContext || null;
    } else {
      latestUserMessage = String(input || '').trim();
      systemPrompt = String(legacySystemPrompt || '').trim();
    }

    const patientContext = this._buildPatientContext(patient);
    const history = this._formatConversationHistory(conversation);

    const prompt = `You are a healthcare call center agent speaking with a patient.

PRIMARY GOALS:
1. Confirm appointment readiness or identify barriers.
2. Keep responses short, natural, and empathetic.
3. Ask one clear question at a time.
4. Never provide diagnosis or treatment advice.
5. If patient has concerns, acknowledge and offer follow-up.
6. Never repeat system prompts, campaign instructions, or metadata text.

CAMPAIGN INSTRUCTIONS:
${this._sanitizeForPrompt(systemPrompt, 2200)}

PATIENT PROFILE:
${patientContext}

RECENT CONVERSATION:
${history}

LATEST PATIENT MESSAGE:
${this._sanitizeForPrompt(latestUserMessage, 500)}

Reply as Assistant in 1-2 short spoken sentences, conversational and specific to this patient.`;

    const response = await this.generate(prompt, {
      max_tokens: 140,
      temperature: 0.65,
      model: this.chatModel
    });

    return this._sanitizeConversationReply(response);
  }

  /**
   * LLM-based decision for next call action.
   * @param {object} context
   * @returns {Promise<object>}
   */
  async generateConversationDecision(context = {}) {
    if (this.available === false) {
      throw new Error('Decision model unavailable');
    }

    const {
      transcript = '',
      turnCount = 0,
      patient = null,
      config = {},
      heuristicAnalysis = {}
    } = context;

    const prompt = `You are an AI supervisor for a healthcare call agent.
Decide the next action based on transcript and patient context.

VALID ACTIONS:
- generate_response
- schedule_followup
- end_call
- transfer_human
- collect_info

RULES:
1. Output ONLY valid JSON.
2. If patient asks to stop/end, choose end_call.
3. If patient expresses barriers or unresolved issues, choose schedule_followup or transfer_human.
4. Avoid ending too early unless intent is clear.
5. Keep message concise (< 25 words) and human.

TURN COUNT: ${turnCount}
MAX TURNS CONFIG: ${config.max_turns || 5}

AGENT CONFIG:
${this._sanitizeForPrompt(config, 2200)}

PATIENT PROFILE:
${this._buildPatientContext(patient)}

HEURISTIC SIGNALS:
${this._sanitizeForPrompt(heuristicAnalysis, 1200)}

TRANSCRIPT:
${this._sanitizeForPrompt(transcript, 3200)}

Return JSON with this shape:
{
  "action": "generate_response|schedule_followup|end_call|transfer_human|collect_info",
  "reason": "short reason",
  "message": "optional short spoken message for followup/end",
  "requires_followup": true|false,
  "barriers": [
    {"type":"financial|transportation|scheduling|language|none","priority":"low|medium|high","evidence":"text"}
  ],
  "confidence": 0.0
}`;

    const response = await this.generate(prompt, {
      temperature: 0.2,
      max_tokens: 280,
      json: true,
      model: this.decisionModel
    });

    const parsed = this._extractJsonObject(response);
    return this._normalizeDecision(parsed);
  }

  _normalizeDecision(decision) {
    const allowedActions = new Set([
      'generate_response',
      'schedule_followup',
      'end_call',
      'transfer_human',
      'collect_info'
    ]);

    let action = String(decision?.action || 'generate_response').toLowerCase().trim();
    if (!allowedActions.has(action)) {
      action = 'generate_response';
    }

    const rawBarriers = Array.isArray(decision?.barriers) ? decision.barriers : [];
    const barrierTypes = new Set(['financial', 'transportation', 'scheduling', 'language', 'none']);
    const priorities = new Set(['low', 'medium', 'high']);
    const barriers = rawBarriers
      .map((b) => {
        const type = String(b?.type || 'none').toLowerCase().trim();
        if (!barrierTypes.has(type) || type === 'none') return null;
        const priority = String(b?.priority || 'medium').toLowerCase().trim();
        return {
          type,
          priority: priorities.has(priority) ? priority : 'medium',
          evidence: this._truncate(b?.evidence || '', 180)
        };
      })
      .filter(Boolean);

    const rawConfidence = Number(decision?.confidence);
    const confidence = Number.isFinite(rawConfidence)
      ? Math.max(0, Math.min(1, rawConfidence))
      : 0.5;

    const reason = this._truncate(decision?.reason || 'llm_decision', 120) || 'llm_decision';
    const message = this._truncate(decision?.message || '', 240);
    const requiresFollowup =
      Boolean(decision?.requires_followup) ||
      action === 'schedule_followup' ||
      action === 'transfer_human' ||
      barriers.length > 0;

    return {
      action,
      reason,
      message,
      requires_followup: requiresFollowup,
      barriers,
      confidence
    };
  }

  /**
   * Generic structured extraction (kept for compatibility).
   * @param {string} text
   * @param {object} schema
   * @returns {Promise<object>}
   */
  async extractStructured(text, schema) {
    const schemaDesc = JSON.stringify(schema, null, 2);
    const prompt = `You are a healthcare call analysis AI.
Return ONLY valid JSON following this schema:
${schemaDesc}

Transcript:
${text}`;

    const response = await this.generate(prompt, {
      temperature: 0.1,
      max_tokens: 260,
      json: true,
      model: this.analysisModel
    });

    const parsed = this._extractJsonObject(response);
    return this._validateStructuredOutput(parsed, schema);
  }

  _validateStructuredOutput(output) {
    const validated = {};

    validated.appointment_confirmed = Boolean(output.appointment_confirmed);
    validated.requested_callback = Boolean(output.requested_callback);
    validated.requires_followup = Boolean(output.requires_followup);

    const sentiment = String(output.sentiment || 'neutral').toLowerCase().trim();
    validated.sentiment = ['positive', 'neutral', 'negative'].includes(sentiment) ? sentiment : 'neutral';

    const barrier = String(output.barrier_type || 'none').toLowerCase().trim();
    validated.barrier_type = ['financial', 'transportation', 'scheduling', 'language', 'none'].includes(barrier)
      ? barrier
      : 'none';

    const priority = String(output.priority || 'low').toLowerCase().trim();
    validated.priority = ['low', 'medium', 'high'].includes(priority) ? priority : 'low';

    validated.summary = this._truncate(output.summary || '', 220);
    return validated;
  }

  /**
   * Full post-call analysis using transcript + patient + campaign context.
   * @param {object} context
   * @returns {Promise<object>}
   */
  async generatePostCallAnalysis(context = {}) {
    if (this.available === false) {
      throw new Error('Analysis model unavailable');
    }

    const strict = await this.generatePostCallAnalysisStrict(context);

    // Backward-compatible projection for existing dashboard/stat routes.
    return {
      summary: strict.summary,
      sentiment: strict.sentiment,
      appointment_confirmed: strict.appointment_confirmed,
      requested_callback: Boolean(strict.requires_manual_followup),
      requires_followup: Boolean(strict.requires_manual_followup),
      barrier_type: 'none',
      barrier_notes: strict.risk_flags.join(', ').slice(0, 260),
      priority: strict.priority,
      followup_recommendation: strict.followup_reason || (strict.requires_manual_followup ? 'Manual follow-up required.' : 'No immediate follow-up required.'),
      next_best_action: strict.requires_manual_followup
        ? 'Route this call to care coordinator follow-up workflow.'
        : 'Document call outcome and proceed per workflow.',
      key_points: strict.risk_flags.slice(0, 6),
      patient_concerns: strict.risk_flags.slice(0, 6),
      confidence: strict.risk_level === 'high' ? 0.92 : strict.risk_level === 'medium' ? 0.78 : 0.65,
      campaign_goal_achieved: strict.campaign_goal_achieved,
      confirmed_date: strict.confirmed_date,
      confirmed_time: strict.confirmed_time,
      risk_level: strict.risk_level,
      risk_flags: strict.risk_flags,
      requires_manual_followup: strict.requires_manual_followup,
      followup_reason: strict.followup_reason,
      analysis_model_used: this.analysisModel
    };
  }

  _normalizePostCallAnalysis(output = {}, transcript = '') {
    const signals = this._inferSignalsFromTranscript(transcript);
    const sentiment = String(output.sentiment || 'neutral').toLowerCase().trim();
    const barrierType = String(output.barrier_type || 'none').toLowerCase().trim();
    const priority = String(output.priority || 'low').toLowerCase().trim();

    const compactTranscript = String(transcript || '').replace(/\s+/g, ' ').trim();
    const heuristicSummary = this._buildHeuristicSummary(signals);
    const fallbackSummary = compactTranscript ? this._truncate(compactTranscript, 220) : heuristicSummary;
    const rawSummary = this._truncate(output.summary || '', 320);

    const rawConfidence = Number(output.confidence);
    const confidence = Number.isFinite(rawConfidence)
      ? Math.max(0, Math.min(1, rawConfidence))
      : (signals.hasPatientSpeech ? 0.68 : 0.45);

    const normalizedBarrierType = ['financial', 'transportation', 'scheduling', 'language', 'none'].includes(barrierType)
      ? barrierType
      : signals.barrierType;
    const appointmentConfirmed = Boolean(output.appointment_confirmed) || signals.appointmentConfirmed;
    const callbackEvidence = /\b(call back|callback|later|another time|not now|busy)\b/i.test(compactTranscript);
    const requestedCallback = signals.requestedCallback || (Boolean(output.requested_callback) && callbackEvidence);

    const summaryLooksSuspicious =
      this._isLowQualitySummary(rawSummary) ||
      this._hasUnseenTimeDetail(rawSummary, compactTranscript);

    const normalized = {
      summary: summaryLooksSuspicious
        ? this._truncate(heuristicSummary || fallbackSummary, 320)
        : rawSummary,
      sentiment: ['positive', 'neutral', 'negative'].includes(sentiment) ? sentiment : 'neutral',
      appointment_confirmed: appointmentConfirmed,
      requested_callback: requestedCallback,
      requires_followup: Boolean(output.requires_followup),
      barrier_type: normalizedBarrierType,
      barrier_notes: this._truncate(output.barrier_notes || '', 260),
      priority: ['low', 'medium', 'high'].includes(priority) ? priority : 'low',
      followup_recommendation: this._truncate(
        output.followup_recommendation ||
        (Boolean(output.requires_followup) ? 'Care coordinator follow-up recommended.' : 'No immediate follow-up required.'),
        280
      ),
      next_best_action: this._truncate(output.next_best_action || 'Document call outcome and proceed per workflow.', 220),
      key_points: this._toStringArray(output.key_points, 8, 220),
      patient_concerns: this._toStringArray(output.patient_concerns, 8, 220),
      confidence
    };

    const hasBarrierEvidence = /\b(afford|expensive|cost|money|insurance|pay|ride|transport|bus|no car|drive|schedule|conflict|work|not a good time|language|translator|english)\b/i
      .test(compactTranscript);
    if (normalized.barrier_type !== 'none' && signals.barrierType === 'none' && !hasBarrierEvidence) {
      normalized.barrier_type = 'none';
      if (!normalized.barrier_notes || normalized.barrier_notes.length < 24) {
        normalized.barrier_notes = '';
      }
    }

    if (signals.hasPatientSpeech && normalized.confidence < 0.2) {
      normalized.confidence = 0.55;
    }

    if (normalized.key_points.length === 0) {
      normalized.key_points = [
        signals.hasPatientSpeech ? 'Patient participated in the conversation.' : 'Very limited patient speech captured.',
        normalized.appointment_confirmed
          ? 'Patient gave language consistent with appointment confirmation.'
          : 'No explicit appointment confirmation phrase was captured.',
        normalized.requested_callback
          ? 'Patient requested callback/alternate timing.'
          : 'No callback request was captured.'
      ];
      if (normalized.barrier_type !== 'none') {
        normalized.key_points.push(`Potential ${normalized.barrier_type} barrier detected from patient speech.`);
      } else if (signals.politeClose) {
        normalized.key_points.push('Patient ended the call politely.');
      }
    }

    if (normalized.key_points.length < 2) {
      normalized.key_points = [
        signals.hasPatientSpeech ? 'Patient participated in the conversation.' : 'Very limited patient speech captured.',
        normalized.appointment_confirmed
          ? 'Patient gave language consistent with appointment confirmation.'
          : 'No explicit appointment confirmation phrase was captured.',
        normalized.requested_callback
          ? 'Patient requested callback/alternate timing.'
          : 'No callback request was captured.'
      ];
    }

    if (normalized.patient_concerns.length === 0 && normalized.barrier_type !== 'none') {
      normalized.patient_concerns = [`Possible ${normalized.barrier_type} concern mentioned by patient.`];
    }

    if (!normalized.requires_followup) {
      normalized.requires_followup =
        normalized.requested_callback ||
        normalized.barrier_type !== 'none' ||
        normalized.priority === 'high';
    }

    if (normalized.barrier_type === 'none' && !normalized.requested_callback && normalized.priority === 'low') {
      normalized.requires_followup = false;
    }

    if (signals.appointmentConfirmed && signals.politeClose && normalized.barrier_type === 'none' && !normalized.requested_callback) {
      normalized.priority = 'low';
      normalized.requires_followup = false;
    }

    if (normalized.requires_followup && /no immediate follow-up required/i.test(normalized.followup_recommendation)) {
      normalized.followup_recommendation = 'Care coordinator follow-up recommended based on patient response.';
    }

    if (!this._isUsefulInstructionText(normalized.followup_recommendation)) {
      normalized.followup_recommendation = normalized.requires_followup
        ? 'Care coordinator follow-up recommended based on patient response.'
        : 'No immediate follow-up required.';
    }

    if (!this._isUsefulInstructionText(normalized.next_best_action)) {
      normalized.next_best_action = normalized.requires_followup
        ? 'Route this call to care coordinator follow-up workflow.'
        : 'Document call outcome and proceed per workflow.';
    }

    if (!normalized.requires_followup) {
      normalized.followup_recommendation = 'No immediate follow-up required.';
      normalized.next_best_action = 'Document call outcome and proceed per workflow.';
    } else if (normalized.barrier_type !== 'none' || normalized.requested_callback) {
      normalized.next_best_action = 'Route this call to care coordinator follow-up workflow.';
    }

    return normalized;
  }

  // Architectural change: explicit realtime model lease for safe 3B/7B swapping.
  async acquireRealtimeSession() {
    return this.runtimeManager.acquireRealtimeSession();
  }

  async ensureAnalysisModel(options = {}) {
    return this.runtimeManager.ensureAnalysisModel(options);
  }

  async releaseAnalysisModel() {
    return this.runtimeManager.releaseAnalysisModel();
  }

  getRuntimeState() {
    return this.runtimeManager.getState();
  }

  async _generateValidatedJson({
    prompt,
    model,
    validator,
    generationOptions = {},
    schemaHelp = ''
  }) {
    let activePrompt = String(prompt || '').trim();
    let lastError = null;
    let lastRaw = '';

    for (let attempt = 0; attempt < 2; attempt++) {
      const raw = await this.generate(activePrompt, {
        model,
        json: true,
        ...generationOptions
      });

      lastRaw = raw;
      try {
        const parsed = this._extractJsonObject(raw);
        return validator(parsed);
      } catch (error) {
        lastError = error;
        if (attempt === 0) {
          activePrompt = `${prompt}

Your previous output was invalid. Return ONLY valid JSON.
${schemaHelp ? `\nJSON REQUIREMENTS:\n${schemaHelp}` : ''}`;
        }
      }
    }

    throw new Error(
      `Model JSON validation failed after retry: ${lastError?.message || 'unknown error'}; raw=${this._truncate(lastRaw, 260)}`
    );
  }

  _buildCampaignRealtimePrompt(context = {}) {
    const patient = context.patient || {};
    const patientMetadata = patient?.metadata && typeof patient.metadata === 'object'
      ? patient.metadata
      : (() => {
        try {
          return patient?.metadata ? JSON.parse(patient.metadata) : {};
        } catch (_) {
          return {};
        }
      })();

    const patientName = this._sanitizeForPrompt(patient?.name || 'Unknown', 120);
    const age = patientMetadata?.age || patient?.age || 'Unknown';
    const conditionGroup = patient?.category || patientMetadata?.medical_condition || 'Unknown';
    const appointmentDate = patientMetadata?.appointment_date || 'Not specified';
    const appointmentType = patientMetadata?.appointment_type || '';
    const doctorName = patientMetadata?.doctor_name || patientMetadata?.doctor || '';
    const campaignObjective = this._sanitizeForPrompt(context.campaignObjective || '', 2000) || 'Confirm appointment details and identify follow-up needs.';
    const conversationSummary = this._sanitizeForPrompt(context.conversationSummary || '', 1000);
    const recentTurns = formatTurnsForPrompt(context.recentTurns || []);
    const latestPatientMessage = this._sanitizeForPrompt(context.latestPatientMessage || '', 500);

    return `ROLE: You are a healthcare outreach assistant on a live phone call.

YOUR PRIMARY TASK (follow this strictly):
${campaignObjective}

Your reply MUST directly advance this task. Do NOT introduce unrelated topics, do NOT suggest follow-ups unless the patient raises concerns, and do NOT repeat what you already said in earlier turns.

PATIENT DETAILS:
- Name: ${patientName}
- Age: ${age}
- Condition: ${this._sanitizeForPrompt(conditionGroup, 120)}
- Appointment: ${this._sanitizeForPrompt(appointmentType, 120)} on ${this._sanitizeForPrompt(appointmentDate, 60)}${doctorName ? ` with ${this._sanitizeForPrompt(doctorName, 100)}` : ''}

RULES:
1. Keep reply to 1-2 SHORT spoken sentences only
2. If patient confirms the appointment, thank them briefly and set action to "end_call". Do NOT keep talking after they confirm
3. If patient says goodbye, bye, I have to go, hang up, talk later, or any farewell — respond with a brief polite closing and set action to "end_call" immediately
4. NEVER repeat a sentence you already said. Check the conversation history and say something different each time
5. If the patient's message is unclear or hard to understand, ask a SPECIFIC clarifying question related to the appointment instead of saying "I didn't catch that"
6. If patient has questions or concerns, address them directly
7. Never provide medical diagnosis or treatment advice
8. Be polite, warm, and natural — speak like a real person, not a robot
9. Return ONLY valid JSON

${conversationSummary ? `CONVERSATION SUMMARY:\n${conversationSummary}\n` : ''}
RECENT CONVERSATION:
${recentTurns}

LATEST PATIENT MESSAGE:
${latestPatientMessage}

Return ONLY JSON:
{
  "reply": "your spoken response",
  "action": "continue | end_call | transfer_human",
  "goal_status": "pending | achieved | failed",
  "risk_detected": false,
  "confidence": 0.0
}`;
  }

  async generateRealtimeTurn(context = {}) {
    if (this.available === false) {
      throw new Error('Realtime model unavailable');
    }

    const prompt = this._buildCampaignRealtimePrompt(context);
    const schemaHelp = `"reply" (string), "action" (continue|end_call|transfer_human), "goal_status" (pending|achieved|failed), "risk_detected" (boolean), "confidence" (0..1)`;

    const result = await this._generateValidatedJson({
      prompt,
      model: this.chatModel,
      validator: validateRealtimeTurn,
      generationOptions: {
        temperature: 0.3,
        top_p: 0.85,
        max_tokens: 200,
        num_ctx: parseInt(process.env.LLM_NUM_CTX_REALTIME, 10) || 1536,
        stop: ['```', '\nPatient:', '\nAssistant:'],
        keep_alive: '30m',
        timeout_ms: parseInt(process.env.LLM_REALTIME_TIMEOUT_MS, 10) || 60000
      },
      schemaHelp
    });

    // Ensure spoken reply is always clean conversational text.
    result.reply = this._sanitizeConversationReply(result.reply, 'Thank you for sharing that.');
    return result;
  }

  async generatePostCallAnalysisStrict(context = {}) {
    if (this.available === false) {
      throw new Error('Analysis model unavailable');
    }

    const transcript = this._sanitizeForPrompt(this._sanitizeAnalysisTranscript(context.transcript || ''), 18000);
    const patient = this._buildPatientContext(context.patient || null);
    const campaign = this._sanitizeForPrompt(context.campaign || {}, 1800);
    const callMeta = this._sanitizeForPrompt(context.callMeta || {}, 900);

    const prompt = `You are a senior healthcare quality analyst.
Analyze the completed call transcript and return ONLY valid JSON.

CRITICAL RULES:
1. Evidence-grounded analysis only. Never invent facts, dates, or times not in the transcript.
2. Ignore non-speech tokens like [BLANK_AUDIO], [SILENCE], noise markers, and filler artifacts.
3. Set "appointment_confirmed" to true if patient gives ANY verbal agreement to the appointment. Agreement includes: "yes", "sure", "okay", "that works", "sounds good", "I can make it", "confirmed", "I'll be there", or similar affirmative responses when discussing the appointment.
4. "campaign_goal_achieved" and "appointment_confirmed" must be consistent: if the campaign goal is confirming an appointment and patient agreed, BOTH should be true.
5. "requires_manual_followup" should be false if appointment is confirmed and no barriers or risks were identified.
6. If transcript lacks explicit date/time spoken by patient, return null for confirmed_date/confirmed_time.
7. Keep "summary" concise (1-2 sentences) and clinically meaningful.
8. Do not provide medical diagnosis.

Return ONLY JSON:
{
  "summary": "short clinical summary",
  "campaign_goal_achieved": true,
  "appointment_confirmed": false,
  "confirmed_date": null,
  "confirmed_time": null,
  "sentiment": "positive | neutral | negative",
  "risk_level": "low | medium | high",
  "risk_flags": [],
  "requires_manual_followup": false,
  "followup_reason": null,
  "priority": "low | medium | high"
}

PATIENT:
${patient}

CAMPAIGN:
${campaign}

CALL META:
${callMeta}

TRANSCRIPT:
${transcript}`;

    return this._generateValidatedJson({
      prompt,
      model: this.analysisModel,
      validator: validatePostCallAnalysis,
      generationOptions: {
        temperature: 0.1,
        top_p: 0.8,
        max_tokens: 768,
        num_ctx: this.analysisNumCtx,
        stop: ['```'],
        keep_alive: '15m',
        timeout_ms: parseInt(process.env.LLM_ANALYSIS_TIMEOUT_MS, 10) || 180000
      },
      schemaHelp: `"summary"(string), "campaign_goal_achieved"(bool), "appointment_confirmed"(bool), "confirmed_date"(string|null), "confirmed_time"(string|null), "sentiment"(positive|neutral|negative), "risk_level"(low|medium|high), "risk_flags"(array), "requires_manual_followup"(bool), "followup_reason"(string|null), "priority"(low|medium|high)`
    });
  }

  /**
   * Classify sentiment from transcript.
   * @param {string} text
   * @returns {Promise<string>}
   */
  async classifySentiment(text) {
    const prompt = `You are a sentiment analysis AI for healthcare calls.
Respond with exactly one word: positive, neutral, or negative.

Transcript:
${text}`;

    const response = await this.generate(prompt, {
      temperature: 0.1,
      max_tokens: 10,
      model: this.analysisModel
    });

    const sentiment = response.toLowerCase().trim().replace(/[^a-z]/g, '');
    if (['positive', 'neutral', 'negative'].includes(sentiment)) {
      return sentiment;
    }
    if (response.toLowerCase().includes('positive')) return 'positive';
    if (response.toLowerCase().includes('negative')) return 'negative';
    return 'neutral';
  }
}

module.exports = new LLMService();
