const express = require('express');
const multer = require('multer');
const { parse } = require('csv-parse/sync');
const { authenticateToken } = require('../middleware/auth');
const { query, pool } = require('../services/database');
const { addCallJob, callQueue } = require('../services/queue');
const { EventBus, EVENTS } = require('../orchestrator/eventBus');

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage() });

// Initialize orchestrator components
const eventBus = new EventBus();

async function removeQueuedJobsForCampaign(campaignId) {
  const jobStates = ['waiting', 'delayed', 'paused', 'prioritized'];
  const jobs = await callQueue.getJobs(jobStates, 0, 5000, true);
  let removed = 0;

  for (const job of jobs) {
    if (Number(job.data?.campaignId) === Number(campaignId)) {
      try {
        await job.remove();
        removed++;
      } catch (error) {
        console.warn(`Failed to remove job ${job.id} for campaign ${campaignId}:`, error.message);
      }
    }
  }

  return removed;
}

// Get all campaigns
router.get('/', authenticateToken, async (req, res) => {
  try {
    const result = await query(
      'SELECT * FROM campaigns WHERE user_id = $1 ORDER BY created_at DESC',
      [req.user.id]
    );

    res.json({ campaigns: result.rows });
  } catch (error) {
    console.error('Get campaigns error:', error);
    res.status(500).json({ error: 'Failed to fetch campaigns' });
  }
});

// Create campaign
router.post('/', authenticateToken, async (req, res) => {
  try {
    const { name, script_template, opening_prompt, schedule_time, retry_limit } = req.body;

    // Input validation
    if (!name || typeof name !== 'string') {
      return res.status(400).json({ error: 'Campaign name required and must be a string' });
    }
    
    if (name.length < 3 || name.length > 255) {
      return res.status(400).json({ error: 'Campaign name must be between 3 and 255 characters' });
    }
    
    if (opening_prompt && (opening_prompt.length < 10 || opening_prompt.length > 500)) {
      return res.status(400).json({ error: 'Opening prompt must be between 10 and 500 characters' });
    }
    
    if (retry_limit !== undefined && retry_limit !== null && (typeof retry_limit !== 'number' || retry_limit < 0 || retry_limit > 10)) {
      return res.status(400).json({ error: 'Retry limit must be a number between 0 and 10' });
    }

    // Default opening prompt if not provided
    const defaultOpening = "Hello, I'm calling from the healthcare center to confirm your upcoming appointment.";
    const defaultEndKeywords = ['goodbye', 'thank you', 'bye', 'thanks', 'have a good day', 'talk later'];
    const defaultFollowupKeywords = ['call back', 'later', 'not now', 'busy', 'another time', 'not good time'];
    const defaultConfirmationKeywords = ['yes', 'confirm', 'correct', 'sure', 'okay', 'sounds good', 'that works'];

    const result = await query(
      `INSERT INTO campaigns (organization_id, user_id, name, status, script_template, schedule_time, retry_limit) 
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
      [
        req.user.organizationId, 
        req.user.id, 
        name, 
        'pending',
        opening_prompt || defaultOpening,
        schedule_time || null,
        retry_limit ?? 3
      ]
    );

    // Create default agent config for this campaign
    await query(
      `INSERT INTO agent_configs (
        organization_id, campaign_id, greeting_script, prompt_template,
        end_keywords, followup_keywords, confirmation_keywords
      )
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        req.user.organizationId,
        result.rows[0].id,
        opening_prompt || defaultOpening,
        script_template || "You are a friendly healthcare assistant calling to confirm appointments. Keep responses brief, natural, and empathetic.",
        defaultEndKeywords,
        defaultFollowupKeywords,
        defaultConfirmationKeywords
      ]
    );

    res.status(201).json({ campaign: result.rows[0] });
  } catch (error) {
    console.error('Create campaign error:', error);
    res.status(500).json({ error: 'Failed to create campaign' });
  }
});

// Assign patients to campaign by category
router.post('/:id/assign-patients', authenticateToken, async (req, res) => {
  try {
    const campaignId = req.params.id;
    const { categories } = req.body;

    if (!categories || !Array.isArray(categories) || categories.length === 0) {
      return res.status(400).json({ error: 'Categories array required' });
    }

    // Verify campaign ownership
    const campaignResult = await query(
      'SELECT * FROM campaigns WHERE id = $1 AND user_id = $2',
      [campaignId, req.user.id]
    );

    if (campaignResult.rows.length === 0) {
      return res.status(404).json({ error: 'Campaign not found' });
    }

    // Get patients from selected categories with organization isolation and row locking
    const placeholders = categories.map((_, i) => `$${i + 2}`).join(',');
    const patientsResult = await query(
      `SELECT * FROM patients 
       WHERE organization_id = $1 
       AND category IN (${placeholders})
       AND campaign_id IS NULL
       AND status = 'active'
       FOR UPDATE`,  /* Lock rows to prevent race conditions */
      [req.user.organizationId, ...categories]
    );

    if (patientsResult.rows.length === 0) {
      return res.status(400).json({ error: 'No active patients found in selected categories' });
    }

    // Assign patients to campaign
    const patientIds = patientsResult.rows.map(p => p.id);
    await query(
      `UPDATE patients 
       SET campaign_id = $1, status = 'pending', updated_at = CURRENT_TIMESTAMP
       WHERE id = ANY($2::int[])`,
      [campaignId, patientIds]
    );

    res.json({
      message: `${patientIds.length} patients assigned to campaign`,
      patientCount: patientIds.length,
      assigned: patientIds.length
    });
  } catch (error) {
    console.error('Assign patients error:', error);
    res.status(500).json({ error: 'Failed to assign patients' });
  }
});

// Upload patients CSV
router.post('/:id/patients', authenticateToken, upload.single('file'), async (req, res) => {
  try {
    const campaignId = req.params.id;

    // Verify campaign ownership
    const campaignResult = await query(
      'SELECT * FROM campaigns WHERE id = $1 AND user_id = $2',
      [campaignId, req.user.id]
    );

    if (campaignResult.rows.length === 0) {
      return res.status(404).json({ error: 'Campaign not found' });
    }

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
      if (record.name && record.phone) {
        // Parse metadata if exists
        const metadata = {};
        Object.keys(record).forEach(key => {
          if (key !== 'name' && key !== 'phone') {
            metadata[key] = record[key];
          }
        });

        const result = await query(
          'INSERT INTO patients (organization_id, campaign_id, name, phone, status, metadata) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *',
          [req.user.organizationId, campaignId, record.name, record.phone, 'pending', JSON.stringify(metadata)]
        );
        insertedPatients.push(result.rows[0]);
      }
    }

    res.json({
      message: `${insertedPatients.length} patients uploaded successfully`,
      patients: insertedPatients
    });
  } catch (error) {
    console.error('Upload patients error:', error);
    res.status(500).json({ error: 'Failed to upload patients' });
  }
});

// Start campaign
router.post('/:id/start', authenticateToken, async (req, res) => {
  try {
    const campaignId = req.params.id;
    const callMode = req.body?.callMode === 'websocket' ? 'websocket' : 'simulation';
    console.log(`[CAMPAIGN START] Campaign ${campaignId}: callMode from request = "${req.body?.callMode}", using: "${callMode}"`);

    // Verify campaign ownership
    const campaignResult = await query(
      'SELECT * FROM campaigns WHERE id = $1 AND user_id = $2',
      [campaignId, req.user.id]
    );

    if (campaignResult.rows.length === 0) {
      return res.status(404).json({ error: 'Campaign not found' });
    }

    // Get pending patients
    const patientsResult = await query(
      'SELECT * FROM patients WHERE campaign_id = $1 AND status = $2',
      [campaignId, 'pending']
    );

    if (patientsResult.rows.length === 0) {
      return res.status(400).json({ error: 'No pending patients in campaign' });
    }

    const campaign = campaignResult.rows[0];

    // Resolve scheduling
    const now = Date.now();
    const scheduleAtMs = campaign.schedule_time ? new Date(campaign.schedule_time).getTime() : now;
    const baseDelayMs = Number.isFinite(scheduleAtMs) ? Math.max(0, scheduleAtMs - now) : 0;
    const spacingMs = parseInt(process.env.CALL_SPACING_MS, 10) || 15000; // 15s between queued calls
    const scheduledStart = new Date(now + baseDelayMs).toISOString();

    // Update campaign status with race condition prevention
    await query(
      `UPDATE campaigns 
       SET status = $1, updated_at = CURRENT_TIMESTAMP 
       WHERE id = $2 AND status IN ('pending', 'scheduled')`,
      [baseDelayMs > 0 ? 'scheduled' : 'running', campaignId]
    );
    
    // Check if update succeeded
    const statusCheck = await query(
      'SELECT status FROM campaigns WHERE id = $1',
      [campaignId]
    );
    
    if (statusCheck.rows[0]?.status === 'running' && baseDelayMs === 0) {
      // Campaign already running, check if it was just started by us or by another request
      const existingJobs = await query(
        `SELECT COUNT(*) as count FROM patients 
         WHERE campaign_id = $1 AND status = 'queued'`,
        [campaignId]
      );
      
      if (existingJobs.rows[0]?.count > 0) {
        return res.status(400).json({ 
          error: 'Campaign already started',
          message: 'This campaign is already running. Please wait for it to complete.'
        });
      }
    }

    // Mark patients as queued for this run
    await query(
      'UPDATE patients SET status = $1, updated_at = CURRENT_TIMESTAMP WHERE campaign_id = $2 AND status = $3',
      ['queued', campaignId, 'pending']
    );

    // Add jobs to queue with event-based scheduling
    const jobs = [];
    const callLinks = [];
    for (let i = 0; i < patientsResult.rows.length; i++) {
      const patient = patientsResult.rows[i];
      const delayMs = baseDelayMs + i * spacingMs;
      const scheduledFor = new Date(now + delayMs).toISOString();

      const job = await addCallJob(
        patient.id,
        {
          campaignId: parseInt(campaignId, 10),
          organizationId: req.user.organizationId,
          scheduledFor,
          callMode,
          retryAttempt: 0,
          maxRetries: campaign.retry_limit ?? 3
        },
        delayMs
      );
      jobs.push(job.id);
      callLinks.push({
        patientId: patient.id,
        patientName: patient.name,
        path: `/mobile-call?patient=${patient.id}&campaign=${campaignId}`
      });
      
      // Emit queued event
      await eventBus.emit(EVENTS.CALL_QUEUED, {
        campaignId,
        organizationId: req.user.organizationId,
        patientId: patient.id,
        patientName: patient.name,
        jobId: job.id,
        scheduledFor,
        callMode
      });
    }

    res.json({
      message: baseDelayMs > 0 ? 'Campaign scheduled' : 'Campaign started',
      patientsQueued: patientsResult.rows.length,
      jobIds: jobs,
      scheduledStart,
      spacingMs,
      callMode,
      callLinks
    });
  } catch (error) {
    console.error('Start campaign error:', error);
    res.status(500).json({ error: 'Failed to start campaign' });
  }
});

// Delete campaign and related runtime data
router.delete('/:id', authenticateToken, async (req, res) => {
  const campaignId = parseInt(req.params.id, 10);
  if (!Number.isInteger(campaignId) || campaignId <= 0) {
    return res.status(400).json({ error: 'Invalid campaign ID' });
  }

  const client = await pool.connect();
  let releasedPatients = 0;
  try {
    await client.query('BEGIN');

    const campaignResult = await client.query(
      'SELECT id, name FROM campaigns WHERE id = $1 AND user_id = $2 FOR UPDATE',
      [campaignId, req.user.id]
    );

    if (campaignResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Campaign not found' });
    }

    // Keep patient master records, detach from campaign for reuse.
    const resetPatientsResult = await client.query(
      `UPDATE patients
       SET campaign_id = NULL, status = 'active', updated_at = CURRENT_TIMESTAMP
       WHERE campaign_id = $1 AND organization_id = $2`,
      [campaignId, req.user.organizationId]
    );
    releasedPatients = resetPatientsResult.rowCount;

    // Deleting campaign cascades calls/events/agent configs via FK.
    await client.query(
      'DELETE FROM campaigns WHERE id = $1 AND user_id = $2',
      [campaignId, req.user.id]
    );

    await client.query('COMMIT');

    let removedQueuedJobs = 0;
    try {
      removedQueuedJobs = await removeQueuedJobsForCampaign(campaignId);
    } catch (queueCleanupError) {
      console.warn(`Queue cleanup failed for campaign ${campaignId}:`, queueCleanupError.message);
    }

    res.json({
      message: 'Campaign deleted successfully',
      campaignId,
      releasedPatients,
      removedQueuedJobs
    });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Delete campaign error:', error);
    res.status(500).json({ error: 'Failed to delete campaign' });
  } finally {
    client.release();
  }
});

// Get campaign details
router.get('/:id', authenticateToken, async (req, res) => {
  try {
    const campaignId = req.params.id;

    const campaignResult = await query(
      'SELECT * FROM campaigns WHERE id = $1 AND user_id = $2',
      [campaignId, req.user.id]
    );

    if (campaignResult.rows.length === 0) {
      return res.status(404).json({ error: 'Campaign not found' });
    }

    const patientsResult = await query(
      'SELECT * FROM patients WHERE campaign_id = $1',
      [campaignId]
    );

    res.json({
      campaign: campaignResult.rows[0],
      patients: patientsResult.rows
    });
  } catch (error) {
    console.error('Get campaign error:', error);
    res.status(500).json({ error: 'Failed to fetch campaign' });
  }
});

module.exports = router;
