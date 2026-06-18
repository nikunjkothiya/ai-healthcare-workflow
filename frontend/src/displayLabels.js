const CALL_STATE_LABELS = {
  scheduled: 'Scheduled',
  queued: 'Ready to call',
  in_progress: 'In progress',
  awaiting_response: 'Patient responding',
  completed: 'Completed',
  requires_followup: 'Needs follow-up',
  failed: 'Not reached',
  missed: 'Missed',
  rejected: 'Declined'
};

const CAMPAIGN_STATUS_LABELS = {
  pending: 'Preparing',
  scheduled: 'Scheduled',
  running: 'Calling patients',
  completed: 'Completed',
  failed: 'Needs attention',
  missed: 'Missed',
  rejected: 'Declined'
};

const PATIENT_STATUS_LABELS = {
  active: 'Active',
  inactive: 'Inactive',
  pending: 'Call scheduled',
  queued: 'Queued',
  ringing: 'Calling now',
  calling: 'Calling now',
  completed: 'Completed',
  followup_required: 'Needs follow-up',
  missed: 'Missed',
  rejected: 'Declined',
  failed: 'Not reached'
};

const TONE_LABELS = {
  positive: 'Positive',
  neutral: 'No clear response',
  negative: 'Concern raised'
};

const PRIORITY_LABELS = {
  low: 'Routine',
  routine: 'Routine',
  medium: 'Needs attention',
  needs_attention: 'Needs attention',
  priority: 'Needs attention',
  high: 'Urgent',
  urgent: 'Urgent',
  critical: 'Critical'
};

function normalize(value) {
  return String(value || '').trim().toLowerCase();
}

function humanize(value, fallback = 'Not available') {
  const normalized = normalize(value);
  if (!normalized) return fallback;
  return normalized
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

export function isNoAnswerCall(call = {}) {
  const state = normalize(call.state);
  const transcript = normalize(call.transcript);
  const summary = normalize(call.summary);
  const text = `${transcript} ${summary}`;
  return (
    (Number(call.duration || 0) === 0 && state === 'failed') ||
    text.includes('no answer') ||
    text.includes('did not pick up') ||
    text.includes('ring timeout')
  );
}

export function formatCallState(state) {
  return CALL_STATE_LABELS[normalize(state)] || humanize(state);
}

export function formatCampaignStatus(status) {
  return CAMPAIGN_STATUS_LABELS[normalize(status)] || humanize(status);
}

export function formatPatientStatus(status) {
  return PATIENT_STATUS_LABELS[normalize(status)] || humanize(status);
}

export function formatConversationTone(tone, call = {}) {
  if (isNoAnswerCall(call)) return 'No conversation';
  return TONE_LABELS[normalize(tone)] || humanize(tone, 'Not captured');
}

export function formatPriority(priority) {
  return PRIORITY_LABELS[normalize(priority)] || humanize(priority, 'Routine');
}

export function priorityClass(priority) {
  const normalized = normalize(priority);
  if (normalized === 'critical') return 'critical';
  if (['urgent', 'high'].includes(normalized)) return 'urgent';
  if (['needs_attention', 'medium', 'priority'].includes(normalized)) return 'needs_attention';
  return 'routine';
}

export function toneClass(tone, call = {}) {
  if (isNoAnswerCall(call)) return 'neutral';
  const normalized = normalize(tone);
  return ['positive', 'neutral', 'negative'].includes(normalized) ? normalized : 'neutral';
}

export function formatCallDuration(seconds, call = {}) {
  const totalSeconds = Number(seconds || 0);
  if (totalSeconds <= 0 && isNoAnswerCall(call)) return 'Not connected';
  if (totalSeconds <= 0) return 'Less than 1 sec';
  const minutes = Math.floor(totalSeconds / 60);
  const remainder = totalSeconds % 60;
  if (minutes === 0) return `${totalSeconds} sec`;
  return remainder ? `${minutes} min ${remainder} sec` : `${minutes} min`;
}

export function formatSummary(summary, call = {}) {
  const text = String(summary || '').trim();
  if (isNoAnswerCall(call)) return 'Patient did not answer before the call timed out.';
  if (!text) return 'No summary available yet.';
  if (text === 'No answer - patient did not pick up within ring timeout') {
    return 'Patient did not answer before the call timed out.';
  }
  if (text === 'No answer from patient') return 'Patient did not answer.';
  if (text === 'Call declined by patient') return 'Patient declined the call.';
  if (text === 'Insufficient transcript for deterministic call analysis.') {
    return 'Not enough conversation was captured for a reliable summary.';
  }
  if (text.startsWith('Manual review required. Automated analysis failed')) {
    return 'Care-team review is needed before using this call summary.';
  }
  return text;
}

export function formatTranscript(transcript, call = {}) {
  const text = String(transcript || '').trim();
  if (isNoAnswerCall(call)) return 'Patient did not answer before the call timed out.';
  if (!text) return 'No conversation captured.';
  if (text === 'No answer from patient') return 'Patient did not answer.';
  return text;
}

export function formatAppointmentOutcome(call = {}) {
  if (call.appointment_confirmed) return 'Confirmed';
  if (isNoAnswerCall(call)) return 'Not reached';
  return 'Not confirmed';
}

export function formatFollowupOutcome(call = {}) {
  if (call.requested_callback) return 'Follow-up needed';
  if (isNoAnswerCall(call)) return 'Try again later';
  return 'No follow-up requested';
}

export function formatGoalOutcome(call = {}) {
  if (call.campaign_goal_achieved) return 'Completed';
  if (isNoAnswerCall(call)) return 'Not reached';
  return 'Not completed';
}

export function formatRecentCallOutcome(call = {}) {
  const state = normalize(call.state);
  if (call.appointment_confirmed) return 'Appointment confirmed';
  if (isNoAnswerCall(call)) return 'Not reached';
  if (state === 'requires_followup') return 'Needs follow-up';
  if (['in_progress', 'awaiting_response'].includes(state)) return 'In progress';
  if (state === 'completed') return 'Completed';
  return formatCallState(state);
}

export function recentCallOutcomeClass(call = {}) {
  const state = normalize(call.state);
  if (call.appointment_confirmed) return 'confirmed';
  if (isNoAnswerCall(call) || state === 'failed') return 'not-reached';
  if (state === 'requires_followup') return 'followup';
  if (['in_progress', 'awaiting_response'].includes(state)) return 'in-progress';
  return 'completed';
}
