const { query } = require('../services/database');
const { EVENTS } = require('../orchestrator/eventBus');
const { STATES } = require('../orchestrator/callStateMachine');
const {
  pendingRings, normalizePatientId, notifyRegisteredPatient,
  loadPatientContext, maybeCompleteCampaign
} = require('./sessionManager');

const RING_TIMEOUT_MS = parseInt(process.env.RING_TIMEOUT_MS, 10) || 30000;

function clearPendingRing(patientId) {
  const key = String(patientId || '');
  if (!key || !pendingRings.has(key)) return;
  clearTimeout(pendingRings.get(key).timeoutHandle);
  pendingRings.delete(key);
}

async function handleRingTimeout({ patientId, campaignId, organizationId, retryAttempt = 0, maxRetries = 3, reason = 'no_answer_timeout' }) {
  const normalizedPatientId = normalizePatientId(patientId);
  if (!normalizedPatientId) return;

  const key = String(normalizedPatientId);
  if (!pendingRings.has(key)) return;
  pendingRings.delete(key);

  const patientStatusResult = await query(
    'SELECT status FROM patients WHERE id = $1', [normalizedPatientId]
  );
  const patientStatus = patientStatusResult.rows[0]?.status;
  if (patientStatus && !['ringing', 'queued', 'pending'].includes(patientStatus)) return;

  const patientContext = await loadPatientContext(normalizedPatientId);
  if (!patientContext?.id) return;

  const finalStatus = reason === 'patient_rejected' ? 'rejected' : 'missed';
  await query(
    `UPDATE patients SET status = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2`,
    [finalStatus, normalizedPatientId]
  );

  const missedCallResult = await query(
    `INSERT INTO calls (organization_id, patient_id, campaign_id, transcript, duration, state,
      sentiment, appointment_confirmed, requested_callback, summary)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id`,
    [
      patientContext.organization_id || organizationId || 1,
      normalizedPatientId,
      patientContext.campaign_id || campaignId || null,
      'No answer from patient', 0, STATES.FAILED,
      'neutral', false, false,
      reason === 'patient_rejected' ? 'Call declined by patient' : 'No answer - patient did not pick up within ring timeout'
    ]
  );
  const missedCallId = missedCallResult.rows[0].id;

  if (global.eventBus) {
    await global.eventBus.emit(EVENTS.CALL_FAILED, {
      callId: missedCallId, patientId: normalizedPatientId,
      campaignId: patientContext.campaign_id || campaignId || null,
      organizationId: patientContext.organization_id || organizationId || 1,
      reason, retryAttempt
    });
  }

  await maybeCompleteCampaign(patientContext.campaign_id || campaignId || null);

  notifyRegisteredPatient(normalizedPatientId, {
    type: 'incoming_call_missed', patientId: normalizedPatientId,
    reason, retryAttempt, willRetry: false, nextRetryAt: null,
    nextRetryDelayMs: null, timeoutMs: RING_TIMEOUT_MS
  });
}

async function handleRingRejection(patientId) {
  const normalizedPatientId = normalizePatientId(patientId);
  if (!normalizedPatientId) return;

  const pending = pendingRings.get(String(normalizedPatientId));
  if (!pending) return;

  clearTimeout(pending.timeoutHandle);
  await handleRingTimeout({
    patientId: normalizedPatientId, campaignId: pending.campaignId,
    organizationId: pending.organizationId,
    retryAttempt: pending.retryAttempt || 0,
    maxRetries: pending.maxRetries || 3, reason: 'patient_rejected'
  });
}

module.exports = { clearPendingRing, handleRingTimeout, handleRingRejection, RING_TIMEOUT_MS };
