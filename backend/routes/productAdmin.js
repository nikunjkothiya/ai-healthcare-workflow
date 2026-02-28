const express = require('express');
const bcrypt = require('bcrypt');
const { query, pool } = require('../services/database');
const { callQueue } = require('../services/queue');

const router = express.Router();

function toInt(value) {
  return Number.parseInt(value, 10) || 0;
}

// Middleware to check if user is product admin
const requireProductAdmin = (req, res, next) => {
  if (!req.user) {
    return res.status(401).json({ error: 'Authentication required' });
  }
  if (req.user.role !== 'product_admin') {
    return res.status(403).json({ error: 'Access denied. Product admin only.' });
  }
  next();
};

async function removeQueuedJobsForOrganization(orgId, campaignIds = []) {
  const jobStates = ['waiting', 'delayed', 'paused', 'prioritized'];
  const jobs = await callQueue.getJobs(jobStates, 0, 5000, true);
  const campaignIdSet = new Set(campaignIds.map((id) => Number(id)));
  let removed = 0;

  for (const job of jobs) {
    const jobOrgId = Number(job.data?.organizationId);
    const jobCampaignId = Number(job.data?.campaignId);
    const shouldRemove = jobOrgId === Number(orgId) || campaignIdSet.has(jobCampaignId);

    if (shouldRemove) {
      try {
        await job.remove();
        removed++;
      } catch (error) {
        console.warn(`Failed to remove queued job ${job.id} for organization ${orgId}:`, error.message);
      }
    }
  }

  return removed;
}

// Get all organizations (hospitals)
router.get('/organizations', requireProductAdmin, async (req, res) => {
  try {
    const result = await query(`
      SELECT 
        o.id,
        o.name,
        o.created_at,
        COUNT(DISTINCT u.id)::int as user_count,
        COUNT(DISTINCT c.id)::int as campaign_count,
        COUNT(DISTINCT p.id)::int as patient_count,
        COUNT(DISTINCT ca.id)::int as call_count
      FROM organizations o
      LEFT JOIN users u ON u.organization_id = o.id
      LEFT JOIN campaigns c ON c.organization_id = o.id
      LEFT JOIN patients p ON p.organization_id = o.id
      LEFT JOIN calls ca ON ca.organization_id = o.id
      GROUP BY o.id, o.name, o.created_at
      ORDER BY o.created_at DESC
    `);

    res.json({ organizations: result.rows });
  } catch (error) {
    console.error('Get organizations error:', error);
    res.status(500).json({ error: 'Failed to fetch organizations' });
  }
});

// Create new organization (hospital)
router.post('/organizations', requireProductAdmin, async (req, res) => {
  try {
    const name = String(req.body?.name || '').trim();
    if (!name) {
      return res.status(400).json({ error: 'Organization name required' });
    }
    if (name.length < 2 || name.length > 255) {
      return res.status(400).json({ error: 'Organization name must be between 2 and 255 characters' });
    }

    const result = await query(
      'INSERT INTO organizations (name) VALUES ($1) RETURNING *',
      [name]
    );

    res.status(201).json({
      message: 'Organization created successfully',
      organization: result.rows[0]
    });
  } catch (error) {
    console.error('Create organization error:', error);
    res.status(500).json({ error: 'Failed to create organization' });
  }
});

// Update organization (hospital)
router.put('/organizations/:orgId', requireProductAdmin, async (req, res) => {
  try {
    const orgId = Number.parseInt(req.params.orgId, 10);
    if (!Number.isInteger(orgId) || orgId <= 0) {
      return res.status(400).json({ error: 'Invalid organization ID' });
    }

    const name = String(req.body?.name || '').trim();
    if (!name) {
      return res.status(400).json({ error: 'Organization name required' });
    }
    if (name.length < 2 || name.length > 255) {
      return res.status(400).json({ error: 'Organization name must be between 2 and 255 characters' });
    }

    const result = await query(
      'UPDATE organizations SET name = $1 WHERE id = $2 RETURNING *',
      [name, orgId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Organization not found' });
    }

    res.json({
      message: 'Organization updated successfully',
      organization: result.rows[0]
    });
  } catch (error) {
    console.error('Update organization error:', error);
    res.status(500).json({ error: 'Failed to update organization' });
  }
});

// Delete organization and all hospital data
router.delete('/organizations/:orgId', requireProductAdmin, async (req, res) => {
  const orgId = Number.parseInt(req.params.orgId, 10);
  if (!Number.isInteger(orgId) || orgId <= 0) {
    return res.status(400).json({ error: 'Invalid organization ID' });
  }

  const client = await pool.connect();
  let campaignIds = [];

  try {
    await client.query('BEGIN');

    const org = await client.query(
      'SELECT id, name FROM organizations WHERE id = $1 FOR UPDATE',
      [orgId]
    );
    if (org.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Organization not found' });
    }

    const campaigns = await client.query(
      'SELECT id FROM campaigns WHERE organization_id = $1',
      [orgId]
    );
    campaignIds = campaigns.rows.map((row) => row.id);

    const deletedData = await client.query(
      `SELECT
         (SELECT COUNT(*) FROM users WHERE organization_id = $1)::int AS users,
         (SELECT COUNT(*) FROM campaigns WHERE organization_id = $1)::int AS campaigns,
         (SELECT COUNT(*) FROM patients WHERE organization_id = $1)::int AS patients,
         (SELECT COUNT(*) FROM calls WHERE organization_id = $1)::int AS calls,
         (SELECT COUNT(*) FROM events WHERE organization_id = $1)::int AS events,
         (SELECT COUNT(*) FROM agent_configs WHERE organization_id = $1)::int AS agent_configs,
         (SELECT COUNT(*) FROM dead_letter_queue WHERE organization_id = $1)::int AS dead_letter_queue`,
      [orgId]
    );

    await client.query('DELETE FROM organizations WHERE id = $1', [orgId]);

    await client.query('COMMIT');

    let removedQueuedJobs = 0;
    try {
      removedQueuedJobs = await removeQueuedJobsForOrganization(orgId, campaignIds);
    } catch (queueCleanupError) {
      console.warn(`Queue cleanup failed for organization ${orgId}:`, queueCleanupError.message);
    }

    res.json({
      message: 'Organization deleted successfully',
      organizationId: orgId,
      organizationName: org.rows[0].name,
      removedQueuedJobs,
      deletedData: deletedData.rows[0]
    });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Delete organization error:', error);
    res.status(500).json({ error: 'Failed to delete organization' });
  } finally {
    client.release();
  }
});

// Create hospital admin user
router.post('/organizations/:orgId/admins', requireProductAdmin, async (req, res) => {
  try {
    const { orgId } = req.params;
    const { email, password, fullName } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password required' });
    }

    const passwordHash = await bcrypt.hash(password, 10);

    const result = await query(
      `INSERT INTO users (organization_id, email, password_hash, role, full_name) 
       VALUES ($1, $2, $3, 'hospital_admin', $4) 
       RETURNING id, email, role, full_name, created_at`,
      [orgId, email, passwordHash, fullName]
    );

    res.status(201).json({
      message: 'Hospital admin created successfully',
      user: result.rows[0]
    });
  } catch (error) {
    console.error('Create admin error:', error);
    if (error.code === '23505') {
      return res.status(400).json({ error: 'Email already exists' });
    }
    res.status(500).json({ error: 'Failed to create admin' });
  }
});

// Get system-wide analytics
router.get('/analytics', requireProductAdmin, async (req, res) => {
  try {
    const totalStats = await query(`
      SELECT 
        COUNT(DISTINCT o.id) as total_organizations,
        COUNT(DISTINCT u.id) as total_users,
        COUNT(DISTINCT c.id) as total_campaigns,
        COUNT(DISTINCT p.id) as total_patients,
        COUNT(DISTINCT ca.id) as total_calls
      FROM organizations o
      LEFT JOIN users u ON u.organization_id = o.id
      LEFT JOIN campaigns c ON c.organization_id = o.id
      LEFT JOIN patients p ON p.organization_id = o.id
      LEFT JOIN calls ca ON ca.organization_id = o.id
    `);

    const callStates = await query(`
      SELECT 
        state,
        COUNT(*) as count
      FROM calls
      GROUP BY state
    `);

    const sentiments = await query(`
      SELECT 
        sentiment,
        COUNT(*) as count
      FROM calls
      WHERE sentiment IS NOT NULL
      GROUP BY sentiment
    `);

    const orgActivity = await query(`
      SELECT 
        o.name as organization_name,
        COUNT(DISTINCT ca.id) as calls_today,
        COUNT(DISTINCT CASE WHEN ca.state = 'completed' THEN ca.id END) as completed_today,
        COUNT(DISTINCT CASE WHEN ca.state = 'requires_followup' THEN ca.id END) as followup_today
      FROM organizations o
      LEFT JOIN calls ca ON ca.organization_id = o.id 
        AND ca.created_at >= CURRENT_DATE
      GROUP BY o.id, o.name
      ORDER BY calls_today DESC
      LIMIT 10
    `);

    res.json({
      totalStats: totalStats.rows[0],
      callStates: callStates.rows,
      sentiments: sentiments.rows,
      organizationActivity: orgActivity.rows
    });
  } catch (error) {
    console.error('Analytics error:', error);
    res.status(500).json({ error: 'Failed to fetch analytics' });
  }
});

// Get organization details (read-only operations visibility)
router.get('/organizations/:orgId', requireProductAdmin, async (req, res) => {
  try {
    const orgId = Number.parseInt(req.params.orgId, 10);
    if (!Number.isInteger(orgId) || orgId <= 0) {
      return res.status(400).json({ error: 'Invalid organization ID' });
    }

    const org = await query('SELECT * FROM organizations WHERE id = $1', [orgId]);
    if (org.rows.length === 0) {
      return res.status(404).json({ error: 'Organization not found' });
    }

    const users = await query(
      'SELECT id, email, role, full_name, created_at FROM users WHERE organization_id = $1 ORDER BY created_at DESC',
      [orgId]
    );

    const campaigns = await query(
      'SELECT id, name, status, created_at, updated_at FROM campaigns WHERE organization_id = $1 ORDER BY created_at DESC LIMIT 15',
      [orgId]
    );

    const recentPatients = await query(
      `SELECT id, name, phone, category, status, campaign_id, created_at, updated_at
       FROM patients
       WHERE organization_id = $1
       ORDER BY updated_at DESC
       LIMIT 15`,
      [orgId]
    );

    const recentCalls = await query(
      `SELECT 
         c.id,
         c.state,
         c.sentiment,
         c.duration,
         c.created_at,
         c.updated_at,
         p.name AS patient_name,
         cam.name AS campaign_name
       FROM calls c
       LEFT JOIN patients p ON p.id = c.patient_id
       LEFT JOIN campaigns cam ON cam.id = c.campaign_id
       WHERE c.organization_id = $1
       ORDER BY c.updated_at DESC
       LIMIT 15`,
      [orgId]
    );

    const patientStatuses = await query(
      `SELECT status, COUNT(*)::int AS count
       FROM patients
       WHERE organization_id = $1
       GROUP BY status
       ORDER BY count DESC`,
      [orgId]
    );

    const callStates = await query(
      `SELECT state, COUNT(*)::int AS count
       FROM calls
       WHERE organization_id = $1
       GROUP BY state
       ORDER BY count DESC`,
      [orgId]
    );

    const recentEvents = await query(
      `SELECT id, event_type, created_at
       FROM events
       WHERE organization_id = $1
       ORDER BY created_at DESC
       LIMIT 15`,
      [orgId]
    );

    const stats = await query(
      `SELECT
         (SELECT COUNT(*) FROM campaigns WHERE organization_id = $1)::int AS total_campaigns,
         (SELECT COUNT(*) FROM patients WHERE organization_id = $1)::int AS total_patients,
         (SELECT COUNT(*) FROM calls WHERE organization_id = $1)::int AS total_calls,
         (SELECT COUNT(*) FROM calls WHERE organization_id = $1 AND state = 'completed')::int AS completed_calls,
         (SELECT COUNT(*) FROM calls WHERE organization_id = $1 AND state = 'requires_followup')::int AS followup_calls,
         (SELECT COUNT(*) FROM calls WHERE organization_id = $1 AND state IN ('queued', 'scheduled', 'in_progress', 'awaiting_response'))::int AS running_calls,
         (SELECT COUNT(*) FROM events WHERE organization_id = $1)::int AS total_events`,
      [orgId]
    );

    const normalizedStats = {
      total_campaigns: toInt(stats.rows[0]?.total_campaigns),
      total_patients: toInt(stats.rows[0]?.total_patients),
      total_calls: toInt(stats.rows[0]?.total_calls),
      completed_calls: toInt(stats.rows[0]?.completed_calls),
      followup_calls: toInt(stats.rows[0]?.followup_calls),
      running_calls: toInt(stats.rows[0]?.running_calls),
      total_events: toInt(stats.rows[0]?.total_events)
    };

    res.json({
      organization: {
        ...org.rows[0],
        user_count: users.rows.length,
        campaign_count: normalizedStats.total_campaigns,
        call_count: normalizedStats.total_calls
      },
      users: users.rows,
      campaigns: campaigns.rows, // Backward-compatible alias
      recentCampaigns: campaigns.rows,
      recentPatients: recentPatients.rows,
      recentCalls: recentCalls.rows,
      patientStatuses: patientStatuses.rows,
      callStates: callStates.rows,
      recentEvents: recentEvents.rows,
      stats: normalizedStats
    });
  } catch (error) {
    console.error('Get organization details error:', error);
    res.status(500).json({ error: 'Failed to fetch organization details' });
  }
});

module.exports = router;
