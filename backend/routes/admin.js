const express = require('express');
const { authenticateToken } = require('../middleware/auth');
const { query } = require('../services/database');
const { CallStateMachine, STATES } = require('../orchestrator/callStateMachine');
const { addCallJob, callQueue } = require('../services/queue');

const router = express.Router();
const stateMachine = new CallStateMachine();

// Get queue health
router.get('/queue/health', authenticateToken, async (req, res) => {
  try {
    const counts = await callQueue.getJobCounts(
      'waiting',
      'active',
      'completed',
      'failed',
      'delayed'
    );

    res.json({
      queue: {
        waiting: Number(counts.waiting || 0),
        active: Number(counts.active || 0),
        completed: Number(counts.completed || 0),
        failed: Number(counts.failed || 0),
        delayed: Number(counts.delayed || 0)
      },
      healthy: true
    });
  } catch (error) {
    console.error('Queue health error:', error);
    res.status(500).json({ error: 'Failed to get queue health' });
  }
});

// Get failed calls
router.get('/calls/failed', authenticateToken, async (req, res) => {
  try {
    const result = await query(`
      SELECT c.*, p.name as patient_name, p.phone, cam.name as campaign_name
      FROM calls c
      JOIN patients p ON c.patient_id = p.id
      JOIN campaigns cam ON p.campaign_id = cam.id
      WHERE cam.user_id = $1 AND c.state = $2
      ORDER BY c.updated_at DESC
    `, [req.user.id, STATES.FAILED]);

    res.json({ calls: result.rows });
  } catch (error) {
    console.error('Get failed calls error:', error);
    res.status(500).json({ error: 'Failed to fetch failed calls' });
  }
});

// Retry failed call
router.post('/calls/:id/retry', authenticateToken, async (req, res) => {
  try {
    const callId = req.params.id;

    // Verify ownership
    const callResult = await query(`
      SELECT c.*, p.id as patient_id, cam.user_id
      FROM calls c
      JOIN patients p ON c.patient_id = p.id
      JOIN campaigns cam ON p.campaign_id = cam.id
      WHERE c.id = $1
    `, [callId]);

    if (callResult.rows.length === 0 || callResult.rows[0].user_id !== req.user.id) {
      return res.status(404).json({ error: 'Call not found' });
    }

    const call = callResult.rows[0];

    // Check retry count
    if (call.retry_count >= 3) {
      return res.status(400).json({ error: 'Maximum retries exceeded' });
    }

    // Increment retry count
    await stateMachine.incrementRetry(callId);

    // Transition to queued
    await stateMachine.transition(callId, STATES.QUEUED, { retried: true });

    // Add back to queue
    await addCallJob(call.patient_id);

    res.json({ message: 'Call queued for retry', callId });
  } catch (error) {
    console.error('Retry call error:', error);
    res.status(500).json({ error: 'Failed to retry call' });
  }
});

// Get agent config
router.get('/agent-config/:campaignId', authenticateToken, async (req, res) => {
  try {
    const campaignId = req.params.campaignId;

    // Verify ownership
    const campaignResult = await query(
      'SELECT * FROM campaigns WHERE id = $1 AND user_id = $2',
      [campaignId, req.user.id]
    );

    if (campaignResult.rows.length === 0) {
      return res.status(404).json({ error: 'Campaign not found' });
    }

    // Get config
    const configResult = await query(
      'SELECT * FROM agent_configs WHERE campaign_id = $1',
      [campaignId]
    );

    if (configResult.rows.length === 0) {
      return res.json({ config: null });
    }

    res.json({ config: configResult.rows[0] });
  } catch (error) {
    console.error('Get agent config error:', error);
    res.status(500).json({ error: 'Failed to fetch agent config' });
  }
});

// Update agent config
router.put('/agent-config/:campaignId', authenticateToken, async (req, res) => {
  try {
    const campaignId = req.params.campaignId;
    const { max_turns, greeting_script, prompt_template, end_keywords, followup_keywords, confirmation_keywords } = req.body;

    // Verify ownership
    const campaignResult = await query(
      'SELECT * FROM campaigns WHERE id = $1 AND user_id = $2',
      [campaignId, req.user.id]
    );

    if (campaignResult.rows.length === 0) {
      return res.status(404).json({ error: 'Campaign not found' });
    }

    // Check if config exists
    const existingConfig = await query(
      'SELECT id FROM agent_configs WHERE campaign_id = $1',
      [campaignId]
    );

    let result;
    if (existingConfig.rows.length > 0) {
      // Update existing
      result = await query(
        `UPDATE agent_configs 
         SET max_turns = $1, greeting_script = $2, prompt_template = $3,
             end_keywords = $4, followup_keywords = $5, confirmation_keywords = $6,
             updated_at = CURRENT_TIMESTAMP
         WHERE campaign_id = $7
         RETURNING *`,
        [max_turns, greeting_script, prompt_template, end_keywords, followup_keywords, confirmation_keywords, campaignId]
      );
    } else {
      // Insert new
      result = await query(
        `INSERT INTO agent_configs 
         (organization_id, campaign_id, max_turns, greeting_script, prompt_template, end_keywords, followup_keywords, confirmation_keywords)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         RETURNING *`,
        [req.user.organizationId, campaignId, max_turns, greeting_script, prompt_template, end_keywords, followup_keywords, confirmation_keywords]
      );
    }

    res.json({ config: result.rows[0] });
  } catch (error) {
    console.error('Update agent config error:', error);
    res.status(500).json({ error: 'Failed to update agent config' });
  }
});

// Get dead letter queue
router.get('/dead-letter-queue', authenticateToken, async (req, res) => {
  try {
    const result = await query(`
      SELECT dlq.*, c.id as call_id, p.name as patient_name, cam.name as campaign_name
      FROM dead_letter_queue dlq
      JOIN calls c ON dlq.call_id = c.id
      JOIN patients p ON c.patient_id = p.id
      JOIN campaigns cam ON p.campaign_id = cam.id
      WHERE cam.user_id = $1
      ORDER BY dlq.created_at DESC
      LIMIT 100
    `, [req.user.id]);

    res.json({ items: result.rows });
  } catch (error) {
    console.error('Get dead letter queue error:', error);
    res.status(500).json({ error: 'Failed to fetch dead letter queue' });
  }
});

// Get call events
router.get('/calls/:id/events', authenticateToken, async (req, res) => {
  try {
    const callId = req.params.id;

    // Verify ownership
    const callResult = await query(`
      SELECT cam.user_id
      FROM calls c
      JOIN patients p ON c.patient_id = p.id
      JOIN campaigns cam ON p.campaign_id = cam.id
      WHERE c.id = $1
    `, [callId]);

    if (callResult.rows.length === 0 || callResult.rows[0].user_id !== req.user.id) {
      return res.status(404).json({ error: 'Call not found' });
    }

    // Get events
    const eventsResult = await query(
      'SELECT * FROM events WHERE call_id = $1 ORDER BY created_at ASC',
      [callId]
    );

    res.json({ events: eventsResult.rows });
  } catch (error) {
    console.error('Get call events error:', error);
    res.status(500).json({ error: 'Failed to fetch call events' });
  }
});

// Get realtime stats (for product admin dashboard)
router.get('/realtime-stats', authenticateToken, async (req, res) => {
  try {
    // Get active calls count
    const activeCalls = await query(`
      SELECT COUNT(*) as count
      FROM calls
      WHERE state IN ('in_progress', 'awaiting_response')
    `);

    // Get queue size
    const Redis = require('ioredis');
    const redis = new Redis({
      host: process.env.REDIS_HOST,
      port: process.env.REDIS_PORT
    });
    const queueSize = await redis.llen('bull:calls:wait');
    await redis.quit();

    // Get completed today
    const completedToday = await query(`
      SELECT COUNT(*) as count
      FROM calls
      WHERE state = 'completed'
      AND created_at >= CURRENT_DATE
    `);

    // Get average duration
    const avgDuration = await query(`
      SELECT AVG(duration) as avg
      FROM calls
      WHERE duration IS NOT NULL
      AND created_at >= CURRENT_DATE
    `);

    // Get recent events
    const recentEvents = await query(`
      SELECT *
      FROM events
      ORDER BY created_at DESC
      LIMIT 20
    `);

    res.json({
      stats: {
        activeCalls: parseInt(activeCalls.rows[0].count),
        queueSize: queueSize,
        completedToday: parseInt(completedToday.rows[0].count),
        avgDuration: Math.round(parseFloat(avgDuration.rows[0].avg) || 0)
      },
      recentEvents: recentEvents.rows
    });
  } catch (error) {
    console.error('Get realtime stats error:', error);
    res.status(500).json({ error: 'Failed to fetch realtime stats' });
  }
});

module.exports = router;
