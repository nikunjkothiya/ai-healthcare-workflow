function extractJsonObject(rawText) {
  const text = String(rawText || '').trim();
  if (!text) {
    throw new Error('Empty model response');
  }

  // First try direct parse (handles already-clean JSON)
  const cleaned = text
    .replace(/```json\s*/gi, '')
    .replace(/```/g, '')
    .trim();

  try {
    return JSON.parse(cleaned);
  } catch (_) { }

  // Find the first { or [ and try to parse the substring until matching } or ]
  const firstBrace = cleaned.indexOf('{');
  const firstBracket = cleaned.indexOf('[');

  let startIdx = -1;
  let targetClose = '';

  if (firstBrace !== -1 && (firstBracket === -1 || firstBrace < firstBracket)) {
    startIdx = firstBrace;
    targetClose = '}';
  } else if (firstBracket !== -1) {
    startIdx = firstBracket;
    targetClose = ']';
  }

  if (startIdx !== -1) {
    // We found a starting point. Let's find the closing counterpart.
    let depth = 0;
    let inString = false;
    let isEscaped = false;

    for (let i = startIdx; i < cleaned.length; i++) {
      const char = cleaned[i];

      if (inString) {
        if (isEscaped) {
          isEscaped = false;
        } else if (char === '\\') {
          isEscaped = true;
        } else if (char === '"') {
          inString = false;
        }
        continue;
      }

      if (char === '"') {
        inString = true;
        continue;
      }

      if (char === (targetClose === '}' ? '{' : '[')) {
        depth++;
      } else if (char === targetClose) {
        depth--;
        if (depth === 0) {
          const candidate = cleaned.substring(startIdx, i + 1);
          try {
            return JSON.parse(candidate);
          } catch (_) {
            // Unparsable, break and throw later
            break;
          }
        }
      }
    }
  }

  throw new Error('No valid JSON object found in model output');
}

function requiredKeysPresent(payload, keys, schemaName) {
  for (const key of keys) {
    if (!Object.prototype.hasOwnProperty.call(payload, key)) {
      throw new Error(`${schemaName}: missing key "${key}"`);
    }
  }
}

function normalizeString(value, fallback = '') {
  const normalized = String(value === undefined || value === null ? '' : value).trim();
  return normalized || fallback;
}

function sanitizeOutputText(value) {
  return normalizeString(value)
    .replace(/\[(?:BLANK_AUDIO|SILENCE|NO_SPEECH|MUSIC)\]|\((?:SILENCE|NOISE|MUSIC)\)|<\|(?:nospeech|silence)\|>/gi, ' ')
    .replace(/\b(?:blank[_ ]audio|no[_ ]speech)\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function clampConfidence(value, fallback = 0.5) {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.max(0, Math.min(1, num));
}

function validateRealtimeTurn(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('Realtime schema: payload is not an object');
  }

  // Defensive fallback mapping for LLM keys
  const reply = payload.reply || payload.response || payload.message || payload.spoken_response || '';
  const actionRaw = String(payload.action || 'continue').toLowerCase();
  const goalStatusRaw = String(payload.goal_status || payload.goalStatus || 'pending').toLowerCase();
  const riskDetected = payload.risk_detected !== undefined ? payload.risk_detected : (payload.riskDetected !== undefined ? payload.riskDetected : false);
  const confidence = payload.confidence !== undefined ? payload.confidence : 0.8;

  const action = ['continue', 'end_call', 'transfer_human'].includes(actionRaw) ? actionRaw : 'continue';
  const goalStatus = ['pending', 'achieved', 'failed'].includes(goalStatusRaw) ? goalStatusRaw : 'pending';

  return {
    reply: normalizeString(reply, 'I understand. Could you please repeat that?').slice(0, 500),
    action,
    goal_status: goalStatus,
    risk_detected: Boolean(riskDetected),
    confidence: clampConfidence(confidence, 0.5)
  };
}

function normalizeNullableString(value) {
  if (value === null || value === undefined) return null;
  const normalized = String(value).trim();
  return normalized || null;
}

function validatePostCallAnalysis(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('Post-call schema: payload is not an object');
  }

  // Defensive fallback mapping for post-call analysis keys
  const summary = payload.summary || payload.text_summary || 'No summary available.';
  const campaignGoalAchieved = payload.campaign_goal_achieved !== undefined ? payload.campaign_goal_achieved : (payload.goal_achieved !== undefined ? payload.goal_achieved : false);
  const appointmentConfirmed = payload.appointment_confirmed !== undefined ? payload.appointment_confirmed : (payload.confirmed !== undefined ? payload.confirmed : false);
  const confirmedDate = payload.confirmed_date !== undefined ? payload.confirmed_date : (payload.date !== undefined ? payload.date : null);
  const confirmedTime = payload.confirmed_time !== undefined ? payload.confirmed_time : (payload.time !== undefined ? payload.time : null);
  const sentimentRaw = String(payload.sentiment || 'neutral').toLowerCase();
  const riskLevelRaw = String(payload.risk_level || 'low').toLowerCase();
  const riskFlags = Array.isArray(payload.risk_flags) ? payload.risk_flags : (Array.isArray(payload.flags) ? payload.flags : []);
  const requiresManualFollowup = payload.requires_manual_followup !== undefined ? payload.requires_manual_followup : (payload.requires_followup !== undefined ? payload.requires_followup : false);
  const followupReason = payload.followup_reason !== undefined ? payload.followup_reason : (payload.reason !== undefined ? payload.reason : null);
  const priorityRaw = String(payload.priority || 'low').toLowerCase();

  const sentiment = ['positive', 'neutral', 'negative'].includes(sentimentRaw) ? sentimentRaw : 'neutral';
  const riskLevel = ['low', 'medium', 'high'].includes(riskLevelRaw) ? riskLevelRaw : 'low';
  const priority = ['low', 'medium', 'high'].includes(priorityRaw) ? priorityRaw : 'low';

  const cleanedSummary = sanitizeOutputText(summary);

  return {
    summary: (cleanedSummary || 'No summary available.').slice(0, 1200),
    campaign_goal_achieved: Boolean(campaignGoalAchieved),
    appointment_confirmed: Boolean(appointmentConfirmed),
    confirmed_date: normalizeNullableString(confirmedDate),
    confirmed_time: normalizeNullableString(confirmedTime),
    sentiment,
    risk_level: riskLevel,
    risk_flags: riskFlags
      .map((flag) => sanitizeOutputText(flag))
      .filter(Boolean)
      .slice(0, 20),
    requires_manual_followup: Boolean(requiresManualFollowup),
    followup_reason: normalizeNullableString(followupReason),
    priority
  };
}

module.exports = {
  extractJsonObject,
  validateRealtimeTurn,
  validatePostCallAnalysis
};
