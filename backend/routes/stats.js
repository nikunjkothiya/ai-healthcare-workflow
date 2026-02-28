const express = require('express');
const { authenticateToken } = require('../middleware/auth');
const { query } = require('../services/database');

const router = express.Router();

// Get dashboard statistics
router.get('/', authenticateToken, async (req, res) => {
  try {
    const { campaignId } = req.query;
    
    // Build WHERE clause
    let whereClause = 'WHERE cam.user_id = $1';
    const params = [req.user.id];
    
    if (campaignId) {
      whereClause += ' AND cam.id = $2';
      params.push(campaignId);
    }

    // Total campaigns
    const campaignsResult = await query(
      'SELECT COUNT(*) as count FROM campaigns WHERE user_id = $1',
      [req.user.id]
    );

    // Total calls
    const callsResult = await query(`
      SELECT COUNT(*) as count FROM calls c
      JOIN patients p ON c.patient_id = p.id
      JOIN campaigns cam ON p.campaign_id = cam.id
      ${whereClause}
    `, params);

    // Calls by state
    const stateResult = await query(`
      SELECT state, COUNT(*) as count FROM calls c
      JOIN patients p ON c.patient_id = p.id
      JOIN campaigns cam ON p.campaign_id = cam.id
      ${whereClause}
      GROUP BY state
    `, params);

    // Confirmed appointments
    const confirmedResult = await query(`
      SELECT COUNT(*) as count FROM calls c
      JOIN patients p ON c.patient_id = p.id
      JOIN campaigns cam ON p.campaign_id = cam.id
      ${whereClause} AND c.appointment_confirmed = true
    `, params);

    // Sentiment breakdown
    const sentimentResult = await query(`
      SELECT sentiment, COUNT(*) as count FROM calls c
      JOIN patients p ON c.patient_id = p.id
      JOIN campaigns cam ON p.campaign_id = cam.id
      ${whereClause}
      GROUP BY sentiment
    `, params);

    // Barrier analysis (from structured_output)
    const barrierResult = await query(`
      SELECT 
        structured_output->>'barrier_type' as barrier_type,
        COUNT(*) as count
      FROM calls c
      JOIN patients p ON c.patient_id = p.id
      JOIN campaigns cam ON p.campaign_id = cam.id
      ${whereClause}
      AND structured_output->>'barrier_type' IS NOT NULL
      AND structured_output->>'barrier_type' != 'none'
      GROUP BY structured_output->>'barrier_type'
    `, params);

    // Recent calls
    const recentCallsResult = await query(`
      SELECT c.id, c.sentiment, c.appointment_confirmed, c.state, c.created_at,
             p.name as patient_name, cam.name as campaign_name
      FROM calls c
      JOIN patients p ON c.patient_id = p.id
      JOIN campaigns cam ON p.campaign_id = cam.id
      ${whereClause}
      ORDER BY c.created_at DESC
      LIMIT 10
    `, params);

    const sentimentBreakdown = {
      positive: 0,
      neutral: 0,
      negative: 0
    };

    sentimentResult.rows.forEach(row => {
      if (row.sentiment) {
        sentimentBreakdown[row.sentiment] = parseInt(row.count);
      }
    });

    const stateBreakdown = {};
    stateResult.rows.forEach(row => {
      stateBreakdown[row.state] = parseInt(row.count);
    });

    const barriers = {};
    barrierResult.rows.forEach(row => {
      if (row.barrier_type) {
        barriers[row.barrier_type] = parseInt(row.count);
      }
    });

    res.json({
      totalCampaigns: parseInt(campaignsResult.rows[0].count),
      totalCalls: parseInt(callsResult.rows[0].count),
      completed: stateBreakdown.completed || 0,
      requiresFollowup: stateBreakdown.requires_followup || 0,
      failed: stateBreakdown.failed || 0,
      inProgress: stateBreakdown.in_progress || 0,
      confirmedAppointments: parseInt(confirmedResult.rows[0].count),
      sentimentBreakdown,
      barriers,
      recentCalls: recentCallsResult.rows
    });
  } catch (error) {
    console.error('Get stats error:', error);
    res.status(500).json({ error: 'Failed to fetch statistics' });
  }
});

module.exports = router;
