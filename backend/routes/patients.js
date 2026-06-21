const express = require('express');
const multer = require('multer');
const { parse } = require('csv-parse/sync');
const { authenticateToken, requireHospitalAdmin } = require('../middleware/auth');
const { query } = require('../services/database');
const { AccessToken } = require('livekit-server-sdk');
const postCallPipeline = require('../workflows/postCallPipeline');

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage() });
const PENDING_CALL_STATUSES = new Set(['pending', 'queued', 'ringing']);
const COMPLETED_CALL_STATUSES = new Set(['completed', 'followup_required']);

function resolveCallDisplayState(patientStatus, latestCallState) {
  const normalizedPatientStatus = String(patientStatus || '').toLowerCase();
  if (PENDING_CALL_STATUSES.has(normalizedPatientStatus)) return 'pending';
  if (COMPLETED_CALL_STATUSES.has(normalizedPatientStatus)) return 'completed';
  if (normalizedPatientStatus === 'calling') return 'in_progress';
  if (normalizedPatientStatus === 'missed') return 'missed';
  if (normalizedPatientStatus === 'rejected') return 'rejected';
  if (normalizedPatientStatus === 'failed') return 'failed';

  const normalizedCallState = String(latestCallState || '').toLowerCase();
  if (normalizedCallState === 'failed') return 'failed';
  if (['completed', 'requires_followup'].includes(normalizedCallState)) return 'completed';
  if (['in_progress', 'awaiting_response'].includes(normalizedCallState)) return 'in_progress';
  return 'not_scheduled';
}

function buildCallDisplayMessage(displayState, patientStatus) {
  if (displayState === 'pending') {
    return patientStatus === 'ringing'
      ? 'Incoming call is ready. You can accept now.'
      : 'This call is scheduled. Keep this page open.';
  }
  if (displayState === 'completed') {
    return 'This call has already been completed.';
  }
  if (displayState === 'missed') {
    return 'This call was missed.';
  }
  if (displayState === 'rejected') {
    return 'This call was declined.';
  }
  if (displayState === 'in_progress') {
    return 'This call is currently in progress.';
  }
  if (displayState === 'failed') {
    return 'This call ended due to a technical issue.';
  }
  return 'No pending call is scheduled for this link.';
}

// Public patient profile for mobile-call simulation links
router.get('/public/:id', async (req, res) => {
  try {
    const patientId = parseInt(req.params.id, 10);
    if (!Number.isInteger(patientId) || patientId <= 0) {
      return res.status(400).json({ error: 'Invalid patient ID' });
    }

    const result = await query(
      `SELECT id, name, phone, category, metadata, status, campaign_id
       FROM patients
       WHERE id = $1`,
      [patientId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Patient not found' });
    }

    res.json({ patient: result.rows[0] });
  } catch (error) {
    console.error('Get public patient error:', error);
    res.status(500).json({ error: 'Failed to fetch patient' });
  }
});

router.get('/public/:id/call-link-status', async (req, res) => {
  try {
    const patientId = parseInt(req.params.id, 10);
    if (!Number.isInteger(patientId) || patientId <= 0) {
      return res.status(400).json({ error: 'Invalid patient ID', code: 'INVALID_PATIENT_ID' });
    }

    const campaignParam = req.query.campaign;
    let requestedCampaignId = null;
    if (campaignParam !== undefined && campaignParam !== null && String(campaignParam).trim() !== '') {
      requestedCampaignId = parseInt(String(campaignParam), 10);
      if (!Number.isInteger(requestedCampaignId) || requestedCampaignId <= 0) {
        return res.status(400).json({ error: 'Invalid campaign ID', code: 'INVALID_CAMPAIGN_ID' });
      }
    }

    const patientResult = await query(
      `SELECT id, name, phone, category, metadata, status, campaign_id, organization_id
       FROM patients
       WHERE id = $1`,
      [patientId]
    );

    if (patientResult.rows.length === 0) {
      return res.status(404).json({ error: 'Invalid call URL: patient not found', code: 'PATIENT_NOT_FOUND' });
    }

    const patient = patientResult.rows[0];
    let campaign = null;
    let effectiveCampaignId = patient.campaign_id || null;

    if (requestedCampaignId !== null) {
      const campaignResult = await query(
        `SELECT id, organization_id, status, name
         FROM campaigns
         WHERE id = $1`,
        [requestedCampaignId]
      );

      if (campaignResult.rows.length === 0) {
        return res.status(404).json({ error: 'Invalid call URL: campaign not found', code: 'CAMPAIGN_NOT_FOUND' });
      }

      campaign = campaignResult.rows[0];
      if (campaign.organization_id !== patient.organization_id) {
        return res.status(404).json({ error: 'Invalid call URL: campaign not found', code: 'CAMPAIGN_NOT_FOUND' });
      }

      if (patient.campaign_id !== requestedCampaignId) {
        return res.status(409).json({
          error: 'Invalid call URL: patient is not assigned to this campaign',
          code: 'CAMPAIGN_PATIENT_MISMATCH'
        });
      }

      effectiveCampaignId = requestedCampaignId;
    } else if (effectiveCampaignId) {
      const campaignResult = await query(
        `SELECT id, organization_id, status, name
         FROM campaigns
         WHERE id = $1`,
        [effectiveCampaignId]
      );
      campaign = campaignResult.rows[0] || null;
    }

    const latestCallParams = [patientId];
    let latestCallSql = `
      SELECT id, state, summary, created_at, updated_at
      FROM calls
      WHERE patient_id = $1
    `;
    if (effectiveCampaignId) {
      latestCallParams.push(effectiveCampaignId);
      latestCallSql += ' AND campaign_id = $2';
    }
    latestCallSql += ' ORDER BY created_at DESC LIMIT 1';

    const latestCallResult = await query(latestCallSql, latestCallParams);
    const latestCall = latestCallResult.rows[0] || null;

    const displayState = resolveCallDisplayState(patient.status, latestCall?.state);
    const message = buildCallDisplayMessage(displayState, patient.status);

    return res.json({
      patient: {
        id: patient.id,
        name: patient.name,
        phone: patient.phone,
        category: patient.category,
        metadata: patient.metadata,
        status: patient.status,
        campaign_id: patient.campaign_id
      },
      callLink: {
        requestedCampaignId,
        campaignId: effectiveCampaignId,
        campaignStatus: campaign?.status || null,
        patientStatus: patient.status,
        displayState,
        canJoinWaitingRoom: displayState === 'pending',
        message,
        latestCall: latestCall
          ? {
              id: latestCall.id,
              state: latestCall.state,
              summary: latestCall.summary,
              created_at: latestCall.created_at,
              updated_at: latestCall.updated_at
            }
          : null
      }
    });
  } catch (error) {
    console.error('Get call-link status error:', error);
    return res.status(500).json({ error: 'Failed to validate call link', code: 'CALL_LINK_VALIDATION_FAILED' });
  }
});

// Get all patients for organization
router.get('/', authenticateToken, requireHospitalAdmin, async (req, res) => {
  try {
    const result = await query(
      `SELECT p.*, 
        (SELECT created_at FROM calls WHERE patient_id = p.id ORDER BY created_at DESC LIMIT 1) as last_contact
       FROM patients p
       WHERE p.organization_id = $1 AND p.campaign_id IS NULL
       ORDER BY p.created_at DESC`,
      [req.user.organizationId]
    );

    res.json({ patients: result.rows });
  } catch (error) {
    console.error('Get patients error:', error);
    res.status(500).json({ error: 'Failed to fetch patients' });
  }
});

const VALID_CATEGORIES = new Set(['diabetes', 'heart_disease', 'asthma', 'hypertension', 'other']);
const PHONE_REGEX = /^[+]?[\d\s()-]{7,20}$/;

function sanitizeString(value, maxLen = 255) {
  const str = String(value || '').trim().replace(/\s+/g, ' ');
  return str.slice(0, maxLen);
}

// Add single patient
router.post('/', authenticateToken, requireHospitalAdmin, async (req, res) => {
  try {
    const name = sanitizeString(req.body.name);
    const phone = sanitizeString(req.body.phone, 50);
    const category = sanitizeString(req.body.category, 50).toLowerCase();
    const metadata = req.body.metadata || {};

    if (!name || name.length < 2) {
      return res.status(400).json({ error: 'Valid patient name required (min 2 characters)' });
    }
    if (!phone || !PHONE_REGEX.test(phone)) {
      return res.status(400).json({ error: 'Valid phone number required' });
    }
    if (!VALID_CATEGORIES.has(category)) {
      return res.status(400).json({ error: `Invalid category. Must be one of: ${[...VALID_CATEGORIES].join(', ')}` });
    }

    const result = await query(
      `INSERT INTO patients (organization_id, name, phone, category, status, metadata)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [req.user.organizationId, name, phone, category, 'active', JSON.stringify(metadata)]
    );

    res.status(201).json({ patient: result.rows[0] });
  } catch (error) {
    console.error('Add patient error:', error);
    res.status(500).json({ error: 'Failed to add patient' });
  }
});

// Update patient
router.put('/:id', authenticateToken, requireHospitalAdmin, async (req, res) => {
  try {
    const patientId = parseInt(req.params.id, 10);
    if (!Number.isInteger(patientId) || patientId <= 0) {
      return res.status(400).json({ error: 'Invalid patient ID' });
    }

    const name = sanitizeString(req.body.name);
    const phone = sanitizeString(req.body.phone, 50);
    const category = sanitizeString(req.body.category, 50).toLowerCase();
    const metadata = req.body.metadata || {};
    const status = ['active', 'pending', 'inactive'].includes(req.body.status) ? req.body.status : 'active';

    if (!name || name.length < 2) {
      return res.status(400).json({ error: 'Valid patient name required' });
    }
    if (!phone || !PHONE_REGEX.test(phone)) {
      return res.status(400).json({ error: 'Valid phone number required' });
    }
    if (!VALID_CATEGORIES.has(category)) {
      return res.status(400).json({ error: `Invalid category. Must be one of: ${[...VALID_CATEGORIES].join(', ')}` });
    }

    const checkResult = await query(
      'SELECT id FROM patients WHERE id = $1 AND organization_id = $2',
      [patientId, req.user.organizationId]
    );

    if (checkResult.rows.length === 0) {
      return res.status(404).json({ error: 'Patient not found' });
    }

    const result = await query(
      `UPDATE patients 
       SET name = $1, phone = $2, category = $3, metadata = $4, status = $5, updated_at = CURRENT_TIMESTAMP
       WHERE id = $6 AND organization_id = $7
       RETURNING *`,
      [name, phone, category, JSON.stringify(metadata), status, patientId, req.user.organizationId]
    );

    res.json({ patient: result.rows[0] });
  } catch (error) {
    console.error('Update patient error:', error);
    res.status(500).json({ error: 'Failed to update patient' });
  }
});

// Delete patient
router.delete('/:id', authenticateToken, requireHospitalAdmin, async (req, res) => {
  try {
    const patientId = req.params.id;

    // Verify ownership
    const checkResult = await query(
      'SELECT id FROM patients WHERE id = $1 AND organization_id = $2',
      [patientId, req.user.organizationId]
    );

    if (checkResult.rows.length === 0) {
      return res.status(404).json({ error: 'Patient not found' });
    }

    await query(
      'DELETE FROM patients WHERE id = $1 AND organization_id = $2',
      [patientId, req.user.organizationId]
    );

    res.json({ message: 'Patient deleted' });
  } catch (error) {
    console.error('Delete patient error:', error);
    res.status(500).json({ error: 'Failed to delete patient' });
  }
});

// Import patients from CSV
router.post('/import', authenticateToken, requireHospitalAdmin, upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'CSV file required' });
    }

    // Parse CSV
    const csvData = req.file.buffer.toString('utf-8');
    const records = parse(csvData, {
      columns: true,
      skip_empty_lines: true,
      trim: true
    });

    // Insert patients
    const insertedPatients = [];
    for (const record of records) {
      if (record.name && record.phone && record.category) {
        // Parse metadata
        const metadata = {};
        Object.keys(record).forEach(key => {
          if (!['name', 'phone', 'category'].includes(key)) {
            metadata[key] = record[key];
          }
        });

        const result = await query(
          `INSERT INTO patients (organization_id, name, phone, category, status, metadata)
           VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
          [req.user.organizationId, record.name, record.phone, record.category, 'active', JSON.stringify(metadata)]
        );
        insertedPatients.push(result.rows[0]);
      }
    }

    res.json({
      message: `${insertedPatients.length} patients imported successfully`,
      patients: insertedPatients
    });
  } catch (error) {
    console.error('Import patients error:', error);
    res.status(500).json({ error: 'Failed to import patients' });
  }
});

// Get patients by category (for campaign creation)
router.get('/by-category/:category', authenticateToken, requireHospitalAdmin, async (req, res) => {
  try {
    const category = req.params.category;

    const result = await query(
      `SELECT * FROM patients 
       WHERE organization_id = $1 AND category = $2 AND campaign_id IS NULL AND status = 'active'
       ORDER BY created_at DESC`,
      [req.user.organizationId, category]
    );

    res.json({ patients: result.rows });
  } catch (error) {
    console.error('Get patients by category error:', error);
    res.status(500).json({ error: 'Failed to fetch patients' });
  }
});

// Public LiveKit room token generator
router.get('/public/livekit/token', async (req, res) => {
  try {
    const room = req.query.room;
    const identity = req.query.identity;

    if (!room || !identity) {
      return res.status(400).json({ error: 'room and identity query params are required' });
    }

    // Transition call to in_progress and patient to calling when joining WebRTC
    const callId = room.startsWith('call_') ? parseInt(room.split('_')[1], 10) : null;
    if (callId) {
      await query(
        `UPDATE calls
         SET state = 'in_progress',
             updated_at = CURRENT_TIMESTAMP
         WHERE id = $1`,
        [callId]
      );
      
      const callRes = await query(`SELECT patient_id FROM calls WHERE id = $1`, [callId]);
      if (callRes.rows.length > 0) {
        await query(
          `UPDATE patients
           SET status = 'calling',
               updated_at = CURRENT_TIMESTAMP
           WHERE id = $1`,
          [callRes.rows[0].patient_id]
        );
      }
    }

    const apiKey = process.env.LIVEKIT_API_KEY || 'devkey';
    const apiSecret = process.env.LIVEKIT_API_SECRET || 'devsecret';

    const at = new AccessToken(apiKey, apiSecret, {
      identity: identity,
      ttl: '1h'
    });

    at.addGrant({
      roomJoin: true,
      room: room,
      canPublish: true,
      canSubscribe: true,
      canPublishData: true
    });

    const token = await at.toJwt();
    res.json({ token });
  } catch (error) {
    console.error('Error generating LiveKit token:', error);
    res.status(500).json({ error: 'Failed to generate token' });
  }
});

// Public Webhook to complete call and start post-call pipeline
router.post('/public/livekit/calls/:id/complete', async (req, res) => {
  try {
    const callId = parseInt(req.params.id, 10);
    const { transcript } = req.body;

    if (!callId) {
      return res.status(400).json({ error: 'Invalid call ID' });
    }

    console.log(`LiveKit Agent completing call ${callId} with transcript...`);

    // 1. Update calls table with the transcript and mark completed
    await query(
      `UPDATE calls
       SET transcript = $1,
           state = 'completed',
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $2`,
      [transcript || '', callId]
    );

    // 2. Fetch patient details to update status
    const callResult = await query(
      `SELECT patient_id, campaign_id FROM calls WHERE id = $1`,
      [callId]
    );

    if (callResult.rows.length > 0) {
      const { patient_id, campaign_id } = callResult.rows[0];
      
      // Update patient status to completed
      await query(
        `UPDATE patients
         SET status = 'completed',
             updated_at = CURRENT_TIMESTAMP
         WHERE id = $1`,
        [patient_id]
      );

      // Check if campaign is completed
      if (campaign_id) {
        const pendingCount = await query(
          `SELECT COUNT(*) FROM patients
           WHERE campaign_id = $1 AND status IN ('pending', 'queued', 'ringing')`,
          [campaign_id]
        );
        if (parseInt(pendingCount.rows[0].count, 10) === 0) {
          await query(
            `UPDATE campaigns
             SET status = 'completed',
                 completed_at = CURRENT_TIMESTAMP,
                 updated_at = CURRENT_TIMESTAMP
             WHERE id = $1`,
            [campaign_id]
          );
        }
      }
    }

    // 3. Trigger asynchronous post-call pipeline analysis
    // (This parses the transcript using LLM and determines if appointment was confirmed, etc.)
    postCallPipeline.process(callId).catch((err) => {
      console.error(`Post-call pipeline error for call ${callId}:`, err);
    });

    res.json({ success: true, message: 'Call completed and post-call analysis started' });
  } catch (error) {
    console.error('Error completing LiveKit call:', error);
    res.status(500).json({ error: 'Failed to complete call' });
  }
});

module.exports = router;
