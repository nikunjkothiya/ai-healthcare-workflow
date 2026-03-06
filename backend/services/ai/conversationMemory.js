// Conversation Memory — Sliding Window + Fact Tracking + Emotional State

function compactText(value, maxLength = 240) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (!text) return '';
  return text.length <= maxLength ? text : `${text.slice(0, maxLength - 3)}...`;
}

function buildSummarySnippet(olderTurns = []) {
  const userSignals = [];
  const assistantSignals = [];

  for (const turn of olderTurns) {
    const role = turn?.role === 'assistant' ? 'assistant' : 'user';
    const text = compactText(turn?.text, 180);
    if (!text) continue;

    if (role === 'user') {
      userSignals.push(text);
    } else {
      assistantSignals.push(text);
    }
  }

  const selected = [];
  if (userSignals.length > 0) {
    selected.push(`Patient context: ${userSignals.slice(-3).join(' | ')}`);
  }
  if (assistantSignals.length > 0) {
    selected.push(`Assistant context: ${assistantSignals.slice(-2).join(' | ')}`);
  }

  return compactText(selected.join(' ; '), 900);
}

/**
 * Build sliding window memory with fact tracking.
 * Keeps last 10 turns verbatim and summarizes older turns.
 * Also tracks confirmed facts and patient emotional state.
 */
function buildSlidingWindowMemory(conversation = [], previousSummary = '') {
  const turns = Array.isArray(conversation) ? conversation : [];
  const lastTurns = turns.slice(-10);

  // Extract confirmed facts from conversation
  const confirmedFacts = extractConfirmedFacts(turns);
  const emotionalState = detectEmotionalState(turns);
  const goalProgress = assessGoalProgress(turns);

  if (turns.length <= 14) {
    return {
      summary: compactText(previousSummary, 900),
      lastTurns,
      confirmedFacts,
      emotionalState,
      goalProgress
    };
  }

  const olderTurns = turns.slice(0, -10);
  const newSnippet = buildSummarySnippet(olderTurns);
  const mergedSummary = compactText(
    [compactText(previousSummary, 500), newSnippet].filter(Boolean).join(' || '),
    900
  );

  return {
    summary: mergedSummary,
    lastTurns,
    confirmedFacts,
    emotionalState,
    goalProgress
  };
}

/**
 * Extract confirmed facts from conversation turns.
 * Identifies information that has been explicitly confirmed by the patient.
 */
function extractConfirmedFacts(turns = []) {
  const facts = {
    appointmentConfirmed: false,
    dateConfirmed: false,
    timeConfirmed: false,
    doctorMentioned: false,
    barriersIdentified: [],
    patientConcerns: [],
    callbackRequested: false
  };

  const patientText = turns
    .filter(t => t?.role === 'user')
    .map(t => String(t?.text || '').toLowerCase())
    .join(' ');

  // Check for appointment confirmation
  if (/\b(yes|confirm|correct|sure|okay|sounds good|that works|i('ll| will) be there)\b/.test(patientText) &&
    /\b(appointment|visit|time|date)\b/.test(patientText)) {
    facts.appointmentConfirmed = true;
  }

  // Check for callback request
  if (/\b(call back|callback|later|another time|not now|busy|not a good time)\b/.test(patientText)) {
    facts.callbackRequested = true;
  }

  // Identify barriers
  if (/\b(afford|expensive|cost|money|insurance|pay|financial)\b/.test(patientText)) {
    facts.barriersIdentified.push('financial');
  }
  if (/\b(ride|transport|bus|no car|drive|get there)\b/.test(patientText)) {
    facts.barriersIdentified.push('transportation');
  }
  if (/\b(schedule|conflict|work|time issue|too busy)\b/.test(patientText)) {
    facts.barriersIdentified.push('scheduling');
  }

  // Extract concerns
  const concernPatterns = [
    /worried about (.{5,60}?)[.!?,]/gi,
    /concerned about (.{5,60}?)[.!?,]/gi,
    /problem with (.{5,60}?)[.!?,]/gi,
    /issue with (.{5,60}?)[.!?,]/gi
  ];

  for (const pattern of concernPatterns) {
    const matches = patientText.matchAll(pattern);
    for (const match of matches) {
      if (match[1]) {
        facts.patientConcerns.push(compactText(match[1], 120));
      }
    }
  }

  return facts;
}

/**
 * Detect patient emotional state from conversation.
 * Returns: cooperative, concerned, frustrated, confused, or neutral
 */
function detectEmotionalState(turns = []) {
  const recentPatientTurns = turns
    .filter(t => t?.role === 'user')
    .slice(-3)
    .map(t => String(t?.text || '').toLowerCase())
    .join(' ');

  if (!recentPatientTurns) return 'neutral';

  // Frustrated signals
  if (/\b(frustrated|annoyed|angry|ridiculous|waste of time|stop calling|leave me alone)\b/.test(recentPatientTurns)) {
    return 'frustrated';
  }

  // Confused signals
  if (/\b(confused|don't understand|what do you mean|unclear|lost|what are you saying)\b/.test(recentPatientTurns)) {
    return 'confused';
  }

  // Concerned/worried signals
  if (/\b(worried|anxious|scared|concern|nervous|afraid|pain|hurting)\b/.test(recentPatientTurns)) {
    return 'concerned';
  }

  // Cooperative signals
  if (/\b(sure|okay|yes|great|sounds good|perfect|wonderful|absolutely|of course)\b/.test(recentPatientTurns)) {
    return 'cooperative';
  }

  return 'neutral';
}

/**
 * Assess how much progress has been made toward the call goal.
 * Returns: not_started, in_progress, nearly_complete, achieved, failed
 */
function assessGoalProgress(turns = []) {
  if (!turns || turns.length === 0) return 'not_started';
  if (turns.length <= 2) return 'not_started';

  const patientText = turns
    .filter(t => t?.role === 'user')
    .map(t => String(t?.text || '').toLowerCase())
    .join(' ');

  // Goal achieved: explicit confirmation
  if (/\b(yes|confirm|correct|sure|sounds good|that works|i('ll| will) be there|okay.*confirm)\b/.test(patientText)) {
    return 'achieved';
  }

  // Goal failed: explicit rejection
  if (/\b(cancel|don't want|not coming|won't be there|refuse|no way)\b/.test(patientText)) {
    return 'failed';
  }

  // In progress
  if (turns.length > 4) return 'nearly_complete';
  return 'in_progress';
}

function formatTurnsForPrompt(turns = []) {
  if (!Array.isArray(turns) || turns.length === 0) {
    return 'No recent turns.';
  }

  return turns
    .map((turn) => {
      const role = turn?.role === 'assistant' ? 'Assistant' : 'Patient';
      return `${role}: ${compactText(turn?.text, 260)}`;
    })
    .join('\n');
}

module.exports = {
  buildSlidingWindowMemory,
  formatTurnsForPrompt,
  extractConfirmedFacts,
  detectEmotionalState,
  assessGoalProgress
};
