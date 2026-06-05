const { query } = require('../services/database');

const sessions = new Map();
const pendingRings = new Map();

function normalizePatientId(value) {
  const id = parseInt(value, 10);
  if (!Number.isInteger(id) || id <= 0) return null;
  return id;
}

function generateSessionId() {
  return `session_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
}

function createSession(ws, sessionId, audioDir) {
  const session = {
    ws,
    conversation: [],
    conversationSummary: '',
    startTime: Date.now(),
    turnCount: 0,
    callId: null,
    registeredPatientId: null,
    finalState: 'completed',
    requiresFollowup: false,
    pendingUserTranscript: '',
    silenceTimer: null,
    llmBusy: false,
    assistantSpeakingUntil: 0,
    realtimeRelease: null,
    realtimeLeasePromise: null,
    maxCallTimer: null,
    goalStatus: 'pending',
    ended: false,
    patientId: null,
    patientContext: null
  };
  sessions.set(sessionId, session);
  return session;
}

function getSession(sessionId) {
  return sessions.get(sessionId);
}

function deleteSession(sessionId) {
  sessions.delete(sessionId);
}

function notifyRegisteredPatient(patientId, payload) {
  for (const session of sessions.values()) {
    if (session.registeredPatientId === patientId) {
      try {
        if (session.ws.readyState === 1) {
          session.ws.send(JSON.stringify(payload));
        }
      } catch (_) {}
    }
  }
}

async function loadPatientContext(patientId) {
  if (!patientId) return null;
  try {
    const result = await query(
      `SELECT p.id, p.name, p.phone, p.category, p.metadata,
              p.organization_id, p.campaign_id,
              c.retry_limit, c.name AS campaign_name,
              c.campaign_type, c.script_template AS campaign_script_template,
              ac.prompt_template AS campaign_prompt_template
       FROM patients p
       LEFT JOIN campaigns c ON c.id = p.campaign_id
       LEFT JOIN agent_configs ac ON ac.campaign_id = p.campaign_id
       WHERE p.id = $1`,
      [patientId]
    );
    return result.rows[0] || null;
  } catch (error) {
    console.warn('Failed to load patient context:', error.message);
    return null;
  }
}

async function maybeCompleteCampaign(campaignId) {
  if (!campaignId) return;
  const remainingResult = await query(
    `SELECT COUNT(*)::int AS remaining FROM patients
     WHERE campaign_id = $1 AND status IN ('pending', 'queued', 'calling', 'ringing')`,
    [campaignId]
  );
  if ((remainingResult.rows[0]?.remaining || 0) === 0) {
    await query(
      `UPDATE campaigns SET status = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2`,
      ['completed', campaignId]
    );
  }
}

module.exports = {
  sessions,
  pendingRings,
  normalizePatientId,
  generateSessionId,
  createSession,
  getSession,
  deleteSession,
  notifyRegisteredPatient,
  loadPatientContext,
  maybeCompleteCampaign
};
