const express = require('express');
const { authenticateToken } = require('../middleware/auth');
const { query } = require('../services/database');

const router = express.Router();

// Get all calls
router.get('/', authenticateToken, async (req, res) => {
  try {
    const { state, campaignId, limit, offset } = req.query;
    
    // Build WHERE clause
    let whereClause = 'WHERE cam.user_id = $1';
    const params = [req.user.id];
    let paramIndex = 2;
    
    if (state) {
      whereClause += ` AND c.state = $${paramIndex}`;
      params.push(state);
      paramIndex++;
    }
    
    if (campaignId) {
      whereClause += ` AND cam.id = $${paramIndex}`;
      params.push(campaignId);
      paramIndex++;
    }
    
    const limitValue = parseInt(limit) || 50;
    const offsetValue = parseInt(offset) || 0;
    
    // Get total count
    const countResult = await query(`
      SELECT COUNT(*) as count
      FROM calls c
      JOIN patients p ON c.patient_id = p.id
      JOIN campaigns cam ON p.campaign_id = cam.id
      ${whereClause}
    `, params);
    
    // Get calls
    const result = await query(`
      SELECT c.*, p.name as patient_name, p.phone, cam.name as campaign_name
      FROM calls c
      JOIN patients p ON c.patient_id = p.id
      JOIN campaigns cam ON p.campaign_id = cam.id
      ${whereClause}
      ORDER BY c.created_at DESC
      LIMIT $${paramIndex} OFFSET $${paramIndex + 1}
    `, [...params, limitValue, offsetValue]);

    res.json({ 
      calls: result.rows,
      total: parseInt(countResult.rows[0].count),
      limit: limitValue,
      offset: offsetValue
    });
  } catch (error) {
    console.error('Get calls error:', error);
    res.status(500).json({ error: 'Failed to fetch calls' });
  }
});

// Get call by ID
router.get('/:id', authenticateToken, async (req, res) => {
  try {
    const callId = req.params.id;

    const result = await query(`
      SELECT c.*, p.name as patient_name, p.phone, cam.name as campaign_name
      FROM calls c
      JOIN patients p ON c.patient_id = p.id
      JOIN campaigns cam ON p.campaign_id = cam.id
      WHERE c.id = $1 AND cam.user_id = $2
    `, [callId, req.user.id]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Call not found' });
    }

    res.json({ call: result.rows[0] });
  } catch (error) {
    console.error('Get call error:', error);
    res.status(500).json({ error: 'Failed to fetch call' });
  }
});

module.exports = router;
