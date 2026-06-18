const axios = require('axios');
const {
  extractJsonObject,
  validateRealtimeTurn,
  validatePostCallAnalysis
} = require('./jsonValidation');
const { formatTurnsForPrompt } = require('./conversationMemory');

const NON_SPEECH_ARTIFACT_REGEX = /\[(?:BLANK_AUDIO|SILENCE|NO_SPEECH|MUSIC)\]|\((?:SILENCE|NOISE|MUSIC)\)|<\|(?:nospeech|silence)\|>/gi;

// ── Campaign-type prompt templates ──────────────────────────────────────
const CAMPAIGN_PROMPTS = {
  appointment_confirmation: {
    objective: 'Confirm the patient\'s upcoming appointment. Verify date, time, and doctor. Identify any barriers to attendance.',
    rules: [
      'Ask the patient to confirm their appointment details',
      'If they confirm, thank them and end the call',
      'If they need to reschedule, collect preferred date/time and set action to transfer_human',
      'Ask about transportation, childcare, or other barriers if they hesitate'
    ]
  },
  medicine_reminder: {
    objective: 'Remind the patient about their medication schedule and check adherence.',
    rules: [
      'Confirm the patient is taking their prescribed medications',
      'Ask if they are experiencing any side effects',
      'Check if they need medication refills',
      'If they report missed doses or side effects, flag for follow-up',
      'Be understanding — never shame patients for non-adherence'
    ]
  },
  health_report: {
    objective: 'Inform the patient about their recent health report or test results at a high level.',
    rules: [
      'Summarize the key findings in simple, non-medical language',
      'Do NOT provide detailed diagnosis or treatment advice',
      'If results are concerning, recommend scheduling a follow-up appointment',
      'Ask if the patient has questions about their results',
      'For abnormal results, transfer to human staff immediately'
    ]
  },
  feedback_collection: {
    objective: 'Collect feedback on the patient\'s recent healthcare experience.',
    rules: [
      'Ask about their overall satisfaction with care received',
      'Ask about specific aspects: wait time, staff friendliness, facility cleanliness',
      'If they have complaints, listen empathetically and note specifics',
      'Thank them for their feedback regardless of sentiment',
      'Do not argue or defend — just listen and acknowledge'
    ]
  },
  post_discharge_followup: {
    objective: 'Check on the patient\'s recovery after hospital discharge.',
    rules: [
      'Ask how they are feeling since discharge',
      'Check if they are following discharge instructions',
      'Ask about pain levels, medication adherence, wound care if applicable',
      'If they report worsening symptoms, escalate immediately',
      'Schedule follow-up appointment if needed'
    ]
  },
  general_outreach: {
    objective: 'Conduct a general health check-in with the patient.',
    rules: [
      'Ask about their overall health and wellbeing',
      'Check if they have any upcoming healthcare needs',
      'Offer to help schedule appointments if needed',
      'Be warm and conversational — this is a wellness check, not an interrogation'
    ]
  }
};

class LLMService {
  constructor() {
    this.provider = 'openrouter';
    this.chatProvider = 'openrouter';
    this.realtimeProvider = 'openrouter';
    this.decisionProvider = 'openrouter';
    this.analysisProvider = 'openrouter';

    // OpenRouter-only configuration. Use openrouter/free by default so a
    // no-billing OpenRouter key can route to available free model variants.
    this.openRouterApiKey = process.env.OPENROUTER_API_KEY || '';
    this.openRouterUrl = process.env.OPENROUTER_URL || 'https://openrouter.ai/api/v1';
    this.openRouterHttpReferer = process.env.OPENROUTER_HTTP_REFERER || 'http://localhost:3000';
    this.openRouterAppTitle = process.env.OPENROUTER_APP_TITLE || 'Care Outreach Assistant';
    this.openRouterModel = process.env.OPENROUTER_MODEL || 'openrouter/free';
    this.openRouterChatModel = process.env.OPENROUTER_MODEL_CHAT || this.openRouterModel;
    this.openRouterRealtimeModel = process.env.OPENROUTER_MODEL_REALTIME || this.openRouterChatModel;
    this.openRouterDecisionModel = process.env.OPENROUTER_MODEL_DECISION || this.openRouterChatModel;
    this.openRouterAnalysisModel = process.env.OPENROUTER_MODEL_ANALYSIS || this.openRouterModel;

    this.maxTokens = parseInt(process.env.LLM_MAX_TOKENS, 10) || 150;
    this.numCtx = parseInt(process.env.LLM_NUM_CTX, 10) || 1024;
    this.timeoutMs = parseInt(process.env.LLM_TIMEOUT_MS, 10) || 15000;
    this.analysisNumCtx = parseInt(process.env.LLM_NUM_CTX_ANALYSIS, 10) || 4096;
    this.analysisMaxTokens = parseInt(process.env.LLM_MAX_TOKENS_ANALYSIS, 10) || 768;
    const configuredMaxRetries = parseInt(process.env.LLM_MAX_RETRIES, 10);
    const configuredRetryDelayMs = parseInt(process.env.LLM_RETRY_DELAY_MS, 10);
    this.maxRetries = Number.isFinite(configuredMaxRetries) ? Math.max(0, configuredMaxRetries) : 1;
    this.retryDelayMs = Number.isFinite(configuredRetryDelayMs) ? Math.max(0, configuredRetryDelayMs) : 800;
    this.available = null;
    this.providerAvailability = {
      openrouter: null
    };

    // Model-specific parameter overrides based on model family
    this._modelConfigs = {
      'qwen3':    { temperature: 0.3, top_p: 0.85, repeat_penalty: 1.05 },
      'phi':      { temperature: 0.2, top_p: 0.9,  repeat_penalty: 1.0  },
      'llama3.2': { temperature: 0.25, top_p: 0.9, repeat_penalty: 1.1  },
      'gemma3':   { temperature: 0.3, top_p: 0.9,  repeat_penalty: 1.0  },
      'mistral':  { temperature: 0.3, top_p: 0.85, repeat_penalty: 1.05 },
      'default':  { temperature: 0.3, top_p: 0.85, repeat_penalty: 1.05 }
    };

    this.configErrors = this._validateModelConfig();
    this.configError = this.configErrors[0] || null;
  }

  _normalizeProviderName() {
    return 'openrouter';
  }

  _resolveStageProvider() {
    return 'openrouter';
  }

  _configuredStageProviders() {
    return {
      default: this.provider,
      chat: this.chatProvider,
      realtime: this.realtimeProvider,
      decision: this.decisionProvider,
      analysis: this.analysisProvider
    };
  }

  getProviderForStage(stage = 'default') {
    const providers = this._configuredStageProviders();
    return providers[stage] || this.provider;
  }

  usesProvider(provider) {
    const normalized = this._normalizeProviderName(provider, '');
    return Object.values(this._configuredStageProviders()).includes(normalized);
  }

  _validateModelConfig() {
    const errors = [];

    if (!this.openRouterApiKey || this.openRouterApiKey === 'YOUR_OPENROUTER_API_KEY_HERE') {
      errors.push('OPENROUTER_API_KEY not set. Add your OpenRouter key to .env.');
    }

    return errors;
  }

  getAnalysisModelIdentifier() {
    return this.openRouterAnalysisModel || this.openRouterModel || 'openrouter/free';
  }

  // ── Availability Check ─────────────────────────────────────────────────

  async _checkOpenRouterAvailability() {
    if (!this.openRouterApiKey || this.openRouterApiKey === 'YOUR_OPENROUTER_API_KEY_HERE') {
      console.error('LLM: OpenRouter API key is missing for a stage that requires OpenRouter.');
      this.providerAvailability.openrouter = false;
      return false;
    }

    // Avoid spending scarce free-model quota on startup probes. Actual request
    // failures are still surfaced by generate(), and callers keep their existing
    // safe response behavior.
    console.log(
      `LLM: OpenRouter configured (chat=${this.openRouterChatModel}, realtime=${this.openRouterRealtimeModel}, decision=${this.openRouterDecisionModel}, analysis=${this.openRouterAnalysisModel})`
    );
    this.providerAvailability.openrouter = true;
    return true;
  }

  async _ensureProviderAvailable(provider, label = 'LLM') {
    const normalized = 'openrouter';
    const known = this.providerAvailability.openrouter;
    if (known === true) {
      return normalized;
    }

    const ok = await this._checkOpenRouterAvailability();

    if (!ok) {
      throw new Error(`${label} provider unavailable (${normalized})`);
    }
    return normalized;
  }

  async checkAvailability() {
    if (this.configErrors.length > 0) {
      for (const message of this.configErrors) {
        console.error(`LLM configuration error: ${message}`);
      }
      this.available = false;
      return false;
    }

    this.available = await this._checkOpenRouterAvailability();
    if (this.available) {
      console.log(
        `LLM routing: chat=${this.chatProvider}, realtime=${this.realtimeProvider}, decision=${this.decisionProvider}, analysis=${this.analysisProvider}`
      );
    }
    return this.available;
  }

  // ── Utility Methods ────────────────────────────────────────────────────

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
    return available.startsWith(required) || required.startsWith(available);
  }

  _requiredModels() {
    return this._uniqueModelList([
      this.model, this.chatModel, this.analysisModel, this.decisionModel
    ]);
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
    return recent.map((msg) => {
      const role = msg?.role === 'assistant' ? 'Assistant' : 'Patient';
      return `${role}: ${this._sanitizeForPrompt(msg?.text || '', 260)}`;
    }).join('\n');
  }

  _buildPatientContext(patient) {
    if (!patient) return 'No patient profile provided.';

    let metadata = {};
    if (typeof patient.metadata === 'string') {
      try { metadata = JSON.parse(patient.metadata); } catch (error) { metadata = {}; }
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

    // Forbidden headers — prompt leakage patterns
    const forbiddenHeaders = [
      'campaign instructions', 'primary goals', 'patient profile',
      'recent conversation', 'latest patient message', 'assistant:',
      'introduction:', 'your primary task', 'rules:', 'patient details:',
      'conversation rules', 'guidelines:', 'role:', 'system:',
      'you are a', 'your reply must', 'return only json',
      'json requirements', 'schema', '```json', '```'
    ];

    // Forbidden content patterns — AI disclosure, medical advice, inappropriate
    const forbiddenPatterns = [
      /\bas an (AI|artificial intelligence|language model|LLM|model)\b/i,
      /\bI('?m| am) (an |the )?(AI|artificial intelligence|language model|bot|assistant robot)\b/i,
      /\bdiagnos(e|is|ed|ing)\b/i,
      /\byou (have|may have|might have|probably have|are suffering from)\b/i,
      /\b(take|prescribe|recommend) (this |the |a )?(medication|medicine|drug|pill|dose)\b/i,
      /\b(you should|I recommend you|you need to) (take|get|undergo|have)\b/i,
      /\bJSON\s*(response|output|format|schema|object)\b/i,
      /\{\s*"reply"\s*:/i,
      /^\s*\{.*\}\s*$/,
      /optional short spoken message/i,
      /ROLE\s*:/i,
      /CAMPAIGN/i
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
    cleaned = cleaned.replace(/^(assistant|agent|ai|bot)\s*:\s*/i, '');
    cleaned = cleaned.replace(/^introduction:\s*/i, '');
    cleaned = cleaned.replace(/>>/g, ' ').replace(/\s+/g, ' ').trim();

    // Check forbidden patterns
    for (const pattern of forbiddenPatterns) {
      if (pattern.test(cleaned)) {
        console.warn(`[SANITIZE] Blocked forbidden pattern in reply: "${this._truncate(cleaned, 80)}"`);
        return fallback;
      }
    }

    // Collapse verbose list-style output
    if (/^\d+\./.test(cleaned) || cleaned.toLowerCase().includes('step 1')) {
      cleaned = cleaned.replace(/\b\d+\.\s*/g, ' ').replace(/\s{2,}/g, ' ').trim();
    }

    // Keep response conversational (max 2 sentences)
    const sentences = cleaned.match(/[^.!?]+[.!?]?/g) || [];
    const concise = sentences.slice(0, 2).join(' ').trim();
    const finalText = this._truncate(concise || cleaned, 260);
    return finalText || fallback;
  }

  _sanitizeAnalysisTranscript(transcript) {
    const maxChars = parseInt(process.env.LLM_ANALYSIS_TRANSCRIPT_MAX_CHARS, 10) || 18000;
    const raw = String(transcript || '').replace(/\r/g, '').trim();
    if (!raw) return '';

    const lines = raw.split('\n').map((line) => line.trim()).filter(Boolean);
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

      const fragments = content.split(/\s{2,}|\.\s+/).map((item) => item.trim()).filter(Boolean);
      const deduped = [];
      for (const fragment of fragments) {
        if (deduped.length === 0 || deduped[deduped.length - 1].toLowerCase() !== fragment.toLowerCase()) {
          deduped.push(fragment);
        }
      }

      const normalizedContent = deduped.join('. ').replace(/\s+/g, ' ').trim();
      if (normalizedContent) cleaned.push(`${speaker}: ${normalizedContent}`);
    }

    return this._truncate(cleaned.join('\n').trim(), maxChars);
  }

  // ── Core Generation Methods ────────────────────────────────────────────

  /**
   * Generate text from OpenRouter with retries.
   */
  _getModelConfig(modelName) {
    const key = Object.keys(this._modelConfigs).find(k => 
      k !== 'default' && String(modelName || '').toLowerCase().startsWith(k)
    );
    return this._modelConfigs[key || 'default'];
  }

  _getOpenRouterModelForStage(stage = 'chat') {
    switch (stage) {
      case 'realtime':
        return this.openRouterRealtimeModel;
      case 'decision':
        return this.openRouterDecisionModel;
      case 'analysis':
        return this.openRouterAnalysisModel;
      case 'chat':
      default:
        return this.openRouterChatModel;
    }
  }

  _extractOpenRouterContent(message) {
    const content = message?.content;
    if (typeof content === 'string') {
      return content;
    }
    if (Array.isArray(content)) {
      return content
        .map((part) => {
          if (typeof part === 'string') return part;
          return part?.text || part?.content || '';
        })
        .filter(Boolean)
        .join('');
    }
    return '';
  }

  async generate(prompt, options = {}) {
    return this._generateOpenRouter(prompt, {
      ...options,
      provider: 'openrouter'
    });
  }

  async _generateOpenRouter(prompt, options = {}) {
    if (!this.openRouterApiKey || this.openRouterApiKey === 'YOUR_OPENROUTER_API_KEY_HERE') {
      throw new Error('OpenRouter API key not configured');
    }

    const maxTokens = options.max_tokens ?? this.maxTokens;
    const selectedModel = options.openrouterModel || options.model || this._getOpenRouterModelForStage(options.stage || 'chat');
    const timeoutMs = options.timeout_ms ?? this.timeoutMs;
    const maxRetries = Math.max(0, parseInt(options.max_retries ?? this.maxRetries, 10) || 0);
    const retryDelayMs = Math.max(0, parseInt(options.retry_delay_ms ?? this.retryDelayMs, 10) || 0);
    const modelConfig = this._getModelConfig(selectedModel);
    const headers = {
      Authorization: `Bearer ${this.openRouterApiKey}`,
      'Content-Type': 'application/json'
    };

    if (this.openRouterHttpReferer) {
      headers['HTTP-Referer'] = this.openRouterHttpReferer;
    }
    if (this.openRouterAppTitle) {
      headers['X-OpenRouter-Title'] = this.openRouterAppTitle;
    }

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const payload = {
          model: selectedModel,
          messages: [{ role: 'user', content: prompt }],
          stream: false,
          temperature: options.temperature ?? modelConfig.temperature,
          top_p: options.top_p ?? modelConfig.top_p,
          max_tokens: maxTokens
        };

        if (Array.isArray(options.stop) && options.stop.length > 0) {
          payload.stop = options.stop;
        }

        if (options.json) {
          payload.response_format = { type: 'json_object' };
        }

        const response = await axios.post(
          `${this.openRouterUrl.replace(/\/+$/, '')}/chat/completions`,
          payload,
          { headers, timeout: timeoutMs }
        );

        const message = response.data?.choices?.[0]?.message;
        const text = this._extractOpenRouterContent(message);
        if (text) {
          return text.trim();
        }
        throw new Error('Empty response from OpenRouter');
      } catch (error) {
        const statusCode = Number(error?.response?.status || 0);
        const isFatalClientError = statusCode >= 400 && statusCode < 500 && statusCode !== 429;
        const isLastAttempt = attempt === maxRetries;
        const details = error?.response?.data?.error?.message || error.message;
        console.error(`LLM OpenRouter error (attempt ${attempt + 1}/${maxRetries + 1}):`, details);

        if (isFatalClientError || isLastAttempt) {
          throw new Error(`LLM generation failed after ${attempt + 1} attempts: ${details}`);
        }
        await this._sleep(retryDelayMs * (attempt + 1));
      }
    }
  }

  /**
   * Safe generate for non-critical paths.
   */
  async generateSafe(prompt, options = {}, fallback = 'I understand.') {
    try {
      return await this.generate(prompt, options);
    } catch (error) {
      console.error('LLM generateSafe fallback:', error.message);
      return fallback;
    }
  }

  // ── Conversation Response ──────────────────────────────────────────────

  /**
   * Generate an in-call conversational reply.
   */
  async generateConversationResponse(input, legacySystemPrompt) {
    const provider = await this._ensureProviderAvailable(this.getProviderForStage('chat'), 'Conversation');

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

    const prompt = `Healthcare assistant on live call. Reply in 1-2 short sentences.

TASK: ${this._sanitizeForPrompt(systemPrompt, 800)}

PATIENT: ${patientContext}

HISTORY:
${history}

PATIENT SAID: ${this._sanitizeForPrompt(latestUserMessage, 300)}

Your reply (1-2 sentences only):`;

    const response = await this.generate(prompt, {
      max_tokens: 140,
      temperature: 0.55,
      provider,
      stage: 'chat'
    });

    return this._sanitizeConversationReply(response);
  }

  // ── Conversation Decision ──────────────────────────────────────────────

  /**
   * LLM-based decision for next call action.
   */
  async generateConversationDecision(context = {}) {
    const provider = await this._ensureProviderAvailable(this.getProviderForStage('decision'), 'Decision');

    const { transcript = '', turnCount = 0, patient = null, config = {}, heuristicAnalysis = {} } = context;

    const prompt = `You are an AI supervisor for a healthcare call agent.
Decide the next action based on transcript and patient context.

VALID ACTIONS:
- generate_response — Continue the conversation
- schedule_followup — Patient needs a follow-up call
- end_call — Conversation is naturally complete or patient wants to end
- transfer_human — Escalate to a human agent
- collect_info — Need more information from patient

RULES:
1. Output ONLY valid JSON.
2. If patient says goodbye, bye, thanks that's all, etc — choose end_call.
3. If patient expresses barriers or unresolved issues — choose schedule_followup or transfer_human.
4. Avoid ending too early unless patient's intent to end is clear.
5. Keep message concise (< 25 words) and human.
6. After appointment is confirmed and patient says goodbye — always end_call.

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

Return JSON:
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
      model: this.decisionModel,
      provider,
      stage: 'decision'
    });

    const parsed = this._extractJsonObject(response);
    return this._normalizeDecision(parsed);
  }

  _normalizeDecision(decision) {
    const allowedActions = new Set([
      'generate_response', 'schedule_followup', 'end_call',
      'transfer_human', 'collect_info'
    ]);

    let action = String(decision?.action || 'generate_response').toLowerCase().trim();
    if (!allowedActions.has(action)) action = 'generate_response';

    const rawBarriers = Array.isArray(decision?.barriers) ? decision.barriers : [];
    const barrierTypes = new Set(['financial', 'transportation', 'scheduling', 'language', 'none']);
    const priorities = new Set(['low', 'medium', 'high']);
    const barriers = rawBarriers.map((b) => {
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
    const confidence = Number.isFinite(rawConfidence) ? Math.max(0, Math.min(1, rawConfidence)) : 0.5;

    return {
      action,
      reason: this._truncate(decision?.reason || 'llm_decision', 120) || 'llm_decision',
      message: this._truncate(decision?.message || '', 240),
      requires_followup: Boolean(decision?.requires_followup) || action === 'schedule_followup' || action === 'transfer_human' || barriers.length > 0,
      barriers,
      confidence
    };
  }

  // ── Structured Extraction ──────────────────────────────────────────────

  async extractStructured(text, schema) {
    const provider = await this._ensureProviderAvailable(this.getProviderForStage('analysis'), 'Analysis');
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
      model: this.analysisModel,
      provider,
      stage: 'analysis'
    });

    const parsed = this._extractJsonObject(response);
    return this._validateStructuredOutput(parsed);
  }

  _validateStructuredOutput(output) {
    return {
      appointment_confirmed: Boolean(output.appointment_confirmed),
      requested_callback: Boolean(output.requested_callback),
      requires_followup: Boolean(output.requires_followup),
      sentiment: ['positive', 'neutral', 'negative'].includes(String(output.sentiment || 'neutral').toLowerCase().trim())
        ? String(output.sentiment).toLowerCase().trim() : 'neutral',
      barrier_type: ['financial', 'transportation', 'scheduling', 'language', 'none'].includes(String(output.barrier_type || 'none').toLowerCase().trim())
        ? String(output.barrier_type).toLowerCase().trim() : 'none',
      priority: ['low', 'medium', 'high'].includes(String(output.priority || 'low').toLowerCase().trim())
        ? String(output.priority).toLowerCase().trim() : 'low',
      summary: this._truncate(output.summary || '', 220)
    };
  }

  // ── Post-Call Analysis ─────────────────────────────────────────────────

  /**
   * Full post-call analysis using transcript + patient + campaign context.
   */
  async generatePostCallAnalysis(context = {}) {
    const strict = await this.generatePostCallAnalysisStrict(context);

    // Generalize manual follow-up logic consistently across all campaign types
    let requiresManualFollowup = Boolean(strict.requires_manual_followup);
    const goalAchievedOrConfirmed = Boolean(strict.appointment_confirmed) || Boolean(strict.campaign_goal_achieved);
    if (goalAchievedOrConfirmed && strict.risk_level === 'low' && (!strict.risk_flags || strict.risk_flags.length === 0)) {
      requiresManualFollowup = false;
    }

    const requiresFollowup = Boolean(requiresManualFollowup || strict.risk_level === 'high');

    // Backward-compatible projection for existing dashboard/stat routes.
    return {
      summary: strict.summary,
      sentiment: strict.sentiment,
      appointment_confirmed: strict.appointment_confirmed,
      requested_callback: requiresManualFollowup,
      requires_followup: requiresFollowup,
      barrier_type: strict.barrier_type || 'none',
      barrier_notes: Array.isArray(strict.risk_flags) ? strict.risk_flags.join(', ').slice(0, 260) : '',
      priority: strict.priority,
      followup_recommendation: strict.followup_reason || (requiresManualFollowup ? 'Manual follow-up required.' : 'No immediate follow-up required.'),
      next_best_action: requiresManualFollowup
        ? 'Route this call to care coordinator follow-up workflow.'
        : 'Document call outcome and proceed per workflow.',
      key_points: Array.isArray(strict.risk_flags) ? strict.risk_flags.slice(0, 6) : [],
      patient_concerns: Array.isArray(strict.patient_concerns) ? strict.patient_concerns.slice(0, 6) : [],
      confidence: strict.confidence || 0.75,
      campaign_goal_achieved: strict.campaign_goal_achieved,
      confirmed_date: strict.confirmed_date,
      confirmed_time: strict.confirmed_time,
      risk_level: strict.risk_level,
      risk_flags: strict.risk_flags,
      requires_manual_followup: requiresManualFollowup,
      followup_reason: strict.followup_reason,
      action_items: strict.action_items || [],
      urgency: strict.urgency || 'routine',
      analysis_model_used: this.getAnalysisModelIdentifier()
    };
  }

  async generatePostCallAnalysisStrict(context = {}) {
    const provider = await this._ensureProviderAvailable(this.getProviderForStage('analysis'), 'Analysis');

    const transcript = this._sanitizeForPrompt(this._sanitizeAnalysisTranscript(context.transcript || ''), 18000);
    const patient = this._buildPatientContext(context.patient || null);
    const campaign = this._sanitizeForPrompt(context.campaign || {}, 1800);
    const callMeta = this._sanitizeForPrompt(context.callMeta || {}, 900);

    const prompt = `You are a senior healthcare quality analyst reviewing a completed phone call transcript.
Analyze the call and return ONLY valid JSON in the exact schema below.

CRITICAL RULES:
1. Evidence-grounded analysis only. Never invent facts, dates, or times not spoken in the transcript.
2. Ignore non-speech tokens like [BLANK_AUDIO], [SILENCE], noise markers, and filler artifacts.
3. Set "appointment_confirmed" to true if patient gives ANY verbal agreement. Agreement includes: "yes", "sure", "okay", "that works", "sounds good", "I can make it", "confirmed", "I'll be there", or similar affirmative responses.
4. "campaign_goal_achieved" and "appointment_confirmed" must be consistent: if the goal is confirming an appointment and patient agreed, BOTH should be true.
5. "requires_manual_followup" should be false if appointment is confirmed and no barriers or risks were identified.
6. If transcript lacks explicit date/time spoken by patient, return null for confirmed_date/confirmed_time.
7. Keep "summary" concise (2-3 sentences) and clinically meaningful.
8. Do not provide medical diagnosis.
9. "action_items" should list specific tasks for hospital staff to do after this call.
10. "urgency" should reflect how quickly staff needs to act on this call.
11. "patient_concerns" should capture specific worries or issues the patient raised.
12. "barrier_type" should identify the primary barrier to care if any was mentioned.

Return ONLY JSON:
{
  "summary": "concise clinical summary of the call",
  "campaign_goal_achieved": true,
  "appointment_confirmed": false,
  "confirmed_date": null,
  "confirmed_time": null,
  "sentiment": "positive | neutral | negative",
  "risk_level": "low | medium | high",
  "risk_flags": [],
  "requires_manual_followup": false,
  "followup_reason": null,
  "priority": "low | medium | high",
  "barrier_type": "none | financial | transportation | scheduling | language",
  "patient_concerns": [],
  "action_items": [],
  "urgency": "routine | needs_attention | urgent | critical",
  "confidence": 0.85
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
      provider,
      validator: (parsed) => this._validatePostCallResult(parsed, context.transcript || ''),
      generationOptions: {
        temperature: 0.1,
        top_p: 0.8,
        max_tokens: 900,
        num_ctx: this.analysisNumCtx,
        stop: ['\nPatient:', '\nAssistant:'],
        keep_alive: '15m',
        timeout_ms: parseInt(process.env.LLM_ANALYSIS_TIMEOUT_MS, 10) || 180000
      },
      schemaHelp: `"summary"(string), "campaign_goal_achieved"(bool), "appointment_confirmed"(bool), "confirmed_date"(string|null), "confirmed_time"(string|null), "sentiment"(positive|neutral|negative), "risk_level"(low|medium|high), "risk_flags"(array), "requires_manual_followup"(bool), "followup_reason"(string|null), "priority"(low|medium|high), "barrier_type"(none|financial|transportation|scheduling|language), "patient_concerns"(array), "action_items"(array), "urgency"(routine|needs_attention|urgent|critical), "confidence"(number)`
    });
  }

  _validatePostCallResult(parsed, rawTranscript = '') {
    // First run through the standard validator
    const validated = validatePostCallAnalysis(parsed);

    // Enhance with additional fields
    validated.barrier_type = ['financial', 'transportation', 'scheduling', 'language', 'none']
      .includes(String(parsed.barrier_type || 'none').toLowerCase().trim())
      ? String(parsed.barrier_type).toLowerCase().trim() : 'none';

    validated.patient_concerns = this._toStringArray(parsed.patient_concerns, 8, 220);
    validated.action_items = this._toStringArray(parsed.action_items, 8, 220);

    const urgencyValues = ['routine', 'needs_attention', 'urgent', 'critical'];
    validated.urgency = urgencyValues.includes(String(parsed.urgency || 'routine').toLowerCase().trim())
      ? String(parsed.urgency).toLowerCase().trim() : 'routine';

    const rawConfidence = Number(parsed.confidence);
    validated.confidence = Number.isFinite(rawConfidence) ? Math.max(0, Math.min(1, rawConfidence)) : 0.75;

    // Evidence cross-check: ensure confirmed_date/time actually appear in transcript
    if (validated.confirmed_date && rawTranscript) {
      const dateStr = String(validated.confirmed_date);
      if (!rawTranscript.toLowerCase().includes(dateStr.toLowerCase())) {
        validated.confirmed_date = null;
      }
    }

    if (validated.confirmed_time && rawTranscript) {
      const timeStr = String(validated.confirmed_time);
      if (!rawTranscript.toLowerCase().includes(timeStr.toLowerCase())) {
        validated.confirmed_time = null;
      }
    }

    // Default action items if empty
    if (validated.action_items.length === 0) {
      if (validated.requires_manual_followup) {
        validated.action_items.push('Schedule follow-up call with patient');
      }
      if (validated.appointment_confirmed) {
        validated.action_items.push('Confirm appointment in scheduling system');
      }
      if (validated.barrier_type !== 'none') {
        validated.action_items.push(`Address ${validated.barrier_type} barrier reported by patient`);
      }
    }

    return validated;
  }

  // ── Realtime Turn (WebSocket Live Calls) ───────────────────────────────

  _getCampaignPromptTemplate(campaignType) {
    return CAMPAIGN_PROMPTS[campaignType] || CAMPAIGN_PROMPTS.general_outreach;
  }

  _buildCampaignRealtimePrompt(context = {}) {
    const patient = context.patient || {};
    const patientMetadata = patient?.metadata && typeof patient.metadata === 'object'
      ? patient.metadata
      : (() => { try { return patient?.metadata ? JSON.parse(patient.metadata) : {}; } catch (_) { return {}; } })();

    const patientName = this._sanitizeForPrompt(patient?.name || 'Unknown', 120);
    const age = patientMetadata?.age || patient?.age || 'Unknown';
    const conditionGroup = patient?.category || patientMetadata?.medical_condition || 'Unknown';
    const appointmentDate = patientMetadata?.appointment_date || 'Not specified';
    const appointmentType = patientMetadata?.appointment_type || '';
    const doctorName = patientMetadata?.doctor_name || patientMetadata?.doctor || '';

    // Get campaign-type-specific instructions
    const campaignType = context.campaignType || patient?.campaign_type || 'appointment_confirmation';
    const template = this._getCampaignPromptTemplate(campaignType);
    const campaignObjective = this._sanitizeForPrompt(context.campaignObjective || template.objective, 2000);
    const campaignRules = template.rules.map((r, i) => `${i + 1}. ${r}`).join('\n');

    const conversationSummary = this._sanitizeForPrompt(context.conversationSummary || '', 1000);
    const recentTurns = formatTurnsForPrompt(context.recentTurns || []);
    const latestPatientMessage = this._sanitizeForPrompt(context.latestPatientMessage || '', 500);

    // Dynamic Emotional/Sentimental Calling Calibration
    const emotionalState = context.emotionalState || 'neutral';
    let emotionalGuideline = '';
    switch (emotionalState) {
      case 'frustrated':
        emotionalGuideline = 'PATIENT EMOTION: FRUSTRATED. Speak in a highly calming, gentle, and reassuring tone. Apologize for any frustration. Prioritize de-escalation over campaign rules. Never sound defensive.';
        break;
      case 'confused':
        emotionalGuideline = 'PATIENT EMOTION: CONFUSED. Slow down and simplify. Explain details clearly in layman terms. Acknowledge and validate their confusion, offering reassurance.';
        break;
      case 'concerned':
        emotionalGuideline = 'PATIENT EMOTION: CONCERNED/ANXIOUS. Speak with deep clinical empathy and warmth. Acknowledge their concern immediately and validate their feelings. Reassure them that the hospital is here to help.';
        break;
      case 'cooperative':
        emotionalGuideline = 'PATIENT EMOTION: COOPERATIVE. Keep the call moving efficiently, maintaining a pleasant, warm, and highly professional conversational pace.';
        break;
      default:
        emotionalGuideline = 'PATIENT EMOTION: NEUTRAL. Speak like a warm, caring, clear, and professional hospital representative.';
    }

    // Dynamic Confirmed Facts Injection (preventing repetitiveness)
    const confirmedFacts = context.confirmedFacts || {};
    let factsGuideline = 'CONFIRMED FACTS SO FAR:\n';
    if (confirmedFacts.appointmentConfirmed) factsGuideline += '- Patient has confirmed the appointment.\n';
    if (confirmedFacts.callbackRequested) factsGuideline += '- Patient requested a callback.\n';
    if (Array.isArray(confirmedFacts.barriersIdentified) && confirmedFacts.barriersIdentified.length > 0) {
      factsGuideline += `- Identified barriers: ${confirmedFacts.barriersIdentified.join(', ')}\n`;
    }
    if (Array.isArray(confirmedFacts.patientConcerns) && confirmedFacts.patientConcerns.length > 0) {
      factsGuideline += `- Known concerns: ${confirmedFacts.patientConcerns.join(', ')}\n`;
    }
    if (factsGuideline === 'CONFIRMED FACTS SO FAR:\n') {
      factsGuideline = '';
    }

    return `You are a healthcare assistant on a live phone call. Be warm, empathetic, and professional.

TASK: ${campaignObjective}

RULES:
${campaignRules}

PATIENT: ${patientName}, age ${age}, ${this._sanitizeForPrompt(conditionGroup, 80)}
Appointment: ${this._sanitizeForPrompt(appointmentType, 80)} on ${this._sanitizeForPrompt(appointmentDate, 40)}${doctorName ? ` with ${this._sanitizeForPrompt(doctorName, 60)}` : ''}

${emotionalGuideline}

${factsGuideline}
GUIDELINES:
- Reply in 1-2 short spoken sentences only (sound natural, not scripted)
- If patient confirms, say thanks and set action to "end_call"
- If patient says goodbye/bye/hang up, set action to "end_call" immediately
- Never repeat yourself — check HISTORY before responding
- Never provide medical diagnosis or treatment advice
- Never mention you are an AI, a model, or a language model
- Never output anything except the JSON object

${conversationSummary ? `SUMMARY: ${conversationSummary}\n` : ''}
HISTORY:
${recentTurns}

PATIENT: ${latestPatientMessage}

You MUST return ONLY a valid JSON object. No markdown, no explanation, no code fences:
{"reply":"<your 1-2 sentence spoken response>","action":"continue","goal_status":"pending","risk_detected":false,"confidence":0.85}`;
  }

  async generateRealtimeTurn(context = {}) {
    const provider = await this._ensureProviderAvailable(this.getProviderForStage('realtime'), 'Realtime');

    const prompt = this._buildCampaignRealtimePrompt(context);
    const schemaHelp = `"reply" (string), "action" (continue|end_call|transfer_human), "goal_status" (pending|achieved|failed), "risk_detected" (boolean), "confidence" (0..1)`;

    const result = await this._generateValidatedJson({
      prompt,
      provider,
      validator: validateRealtimeTurn,
      generationOptions: {
        temperature: 0.3,
        top_p: 0.85,
        max_tokens: 400,
        stop: ['\nPatient:', '\nAssistant:'],
        timeout_ms: parseInt(process.env.LLM_REALTIME_TIMEOUT_MS, 10) || 8000,
        max_retries: Math.max(0, parseInt(process.env.LLM_REALTIME_MAX_RETRIES, 10) || 0)
      },
      schemaHelp
    });

    // Ensure spoken reply is always clean conversational text.
    result.reply = this._sanitizeConversationReply(result.reply, 'Thank you for sharing that.');
    return result;
  }

  // ── Sentiment Classification ───────────────────────────────────────────

  async classifySentiment(text) {
    const provider = await this._ensureProviderAvailable(this.getProviderForStage('analysis'), 'Analysis');
    const prompt = `You are a sentiment analysis AI for healthcare calls.
Respond with exactly one word: positive, neutral, or negative.

Transcript:
${text}`;

    const response = await this.generate(prompt, {
      temperature: 0.1,
      max_tokens: 10,
      model: this.analysisModel,
      provider,
      stage: 'analysis'
    });

    const sentiment = response.toLowerCase().trim().replace(/[^a-z]/g, '');
    if (['positive', 'neutral', 'negative'].includes(sentiment)) return sentiment;
    if (response.toLowerCase().includes('positive')) return 'positive';
    if (response.toLowerCase().includes('negative')) return 'negative';
    return 'neutral';
  }

  // ── Validated JSON Generation ──────────────────────────────────────────

  async _generateValidatedJson({ prompt, model, provider, validator, generationOptions = {}, schemaHelp = '' }) {
    let activePrompt = String(prompt || '').trim();
    let lastError = null;
    let lastRaw = '';

    for (let attempt = 0; attempt < 2; attempt++) {
      const raw = await this.generate(activePrompt, {
        model,
        provider,
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
          activePrompt = `${prompt}\n\nYour previous output was invalid. Return ONLY valid JSON.\n${schemaHelp ? `\nJSON REQUIREMENTS:\n${schemaHelp}` : ''}`;
        }
      }
    }

    throw new Error(
      `Model JSON validation failed after retry: ${lastError?.message || 'unknown error'}; raw=${this._truncate(lastRaw, 260)}`
    );
  }

  async _generateAnalysisJson(prompt, repairKeyList) {
    const modelName = this.analysisModel;
    const provider = await this._ensureProviderAvailable(this.getProviderForStage('analysis'), 'Analysis');
    const response = await this.generate(prompt, {
      temperature: 0.1,
      max_tokens: this.analysisMaxTokens,
      timeout_ms: 180000,
      json: true,
      model: modelName,
      num_ctx: this.analysisNumCtx,
      provider,
      stage: 'analysis'
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
        num_ctx: this.analysisNumCtx,
        provider,
        stage: 'analysis'
      });
      const parsed = this._extractJsonObject(repaired);
      return { parsed, modelName };
    }
  }

  // ── Heuristic Fallbacks ────────────────────────────────────────────────

  _inferSignalsFromTranscript(transcript) {
    const raw = String(transcript || '');
    const patientLines = raw.split('\n')
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

    return { hasPatientSpeech: patientText.length > 0, appointmentConfirmed, requestedCallback, barrierType, politeClose };
  }

  // ── Model Runtime Management (OpenRouter-only no-ops) ──────────────────

  async acquireRealtimeSession() {
    return async () => { };
  }

  async ensureAnalysisModel(options = {}) {
    return undefined;
  }

  async releaseAnalysisModel() {
    return undefined;
  }

  getRuntimeState() {
    const providers = this._configuredStageProviders();
    const runtimeState = {
      stage: 'openrouter',
      activeRealtimeSessions: 0,
      realtimeModel: this.openRouterRealtimeModel,
      analysisModel: this.openRouterAnalysisModel
    };

    return {
      ...runtimeState,
      providers,
      analysisModelIdentifier: this.getAnalysisModelIdentifier()
    };
  }
}

module.exports = new LLMService();
