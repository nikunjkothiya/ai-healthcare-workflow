function extractJsonObject(rawText) {
  const text = String(rawText || '').trim();
  if (!text) {
    throw new Error('Empty model response');
  }

  const cleaned = text
    .replace(/```json\s*/gi, '')
    .replace(/```/g, '')
    .trim();

  try {
    return JSON.parse(cleaned);
  } catch (_) {
    // continue with extraction fallback
  }

  for (let start = 0; start < cleaned.length; start++) {
    if (cleaned[start] !== '{') continue;

    let depth = 0;
    let inString = false;
    let escaped = false;

    for (let end = start; end < cleaned.length; end++) {
      const ch = cleaned[end];

      if (inString) {
        if (escaped) {
          escaped = false;
        } else if (ch === '\\') {
          escaped = true;
        } else if (ch === '"') {
          inString = false;
        }
        continue;
      }

      if (ch === '"') {
        inString = true;
        continue;
      }

      if (ch === '{') depth += 1;
      if (ch === '}') depth -= 1;

      if (depth === 0) {
        const candidate = cleaned.slice(start, end + 1);
        try {
          return JSON.parse(candidate);
        } catch (_) {
          // keep searching
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

  requiredKeysPresent(
    payload,
    ['reply', 'action', 'goal_status', 'risk_detected', 'confidence'],
    'Realtime schema'
  );

  const action = normalizeString(payload.action).toLowerCase();
  const goalStatus = normalizeString(payload.goal_status).toLowerCase();

  if (!['continue', 'end_call', 'transfer_human'].includes(action)) {
    throw new Error('Realtime schema: invalid action');
  }

  if (!['pending', 'achieved', 'failed'].includes(goalStatus)) {
    throw new Error('Realtime schema: invalid goal_status');
  }

  return {
    reply: normalizeString(payload.reply, 'I understand. Could you please repeat that?').slice(0, 500),
    action,
    goal_status: goalStatus,
    risk_detected: Boolean(payload.risk_detected),
    confidence: clampConfidence(payload.confidence, 0.5)
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

  requiredKeysPresent(
    payload,
    [
      'summary',
      'campaign_goal_achieved',
      'appointment_confirmed',
      'confirmed_date',
      'confirmed_time',
      'sentiment',
      'risk_level',
      'risk_flags',
      'requires_manual_followup',
      'followup_reason',
      'priority'
    ],
    'Post-call schema'
  );

  const sentiment = normalizeString(payload.sentiment).toLowerCase();
  if (!['positive', 'neutral', 'negative'].includes(sentiment)) {
    throw new Error('Post-call schema: invalid sentiment');
  }

  const riskLevel = normalizeString(payload.risk_level).toLowerCase();
  if (!['low', 'medium', 'high'].includes(riskLevel)) {
    throw new Error('Post-call schema: invalid risk_level');
  }

  const priority = normalizeString(payload.priority).toLowerCase();
  if (!['low', 'medium', 'high'].includes(priority)) {
    throw new Error('Post-call schema: invalid priority');
  }

  if (!Array.isArray(payload.risk_flags)) {
    throw new Error('Post-call schema: risk_flags must be an array');
  }

  const cleanedSummary = sanitizeOutputText(payload.summary);

  return {
    summary: (cleanedSummary || 'No summary available.').slice(0, 1200),
    campaign_goal_achieved: Boolean(payload.campaign_goal_achieved),
    appointment_confirmed: Boolean(payload.appointment_confirmed),
    confirmed_date: normalizeNullableString(payload.confirmed_date),
    confirmed_time: normalizeNullableString(payload.confirmed_time),
    sentiment,
    risk_level: riskLevel,
    risk_flags: payload.risk_flags
      .map((flag) => sanitizeOutputText(flag))
      .filter(Boolean)
      .slice(0, 20),
    requires_manual_followup: Boolean(payload.requires_manual_followup),
    followup_reason: normalizeNullableString(payload.followup_reason),
    priority
  };
}

module.exports = {
  extractJsonObject,
  validateRealtimeTurn,
  validatePostCallAnalysis
};
