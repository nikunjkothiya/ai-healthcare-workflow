const { query } = require('../services/database');

// Call states
const STATES = {
  SCHEDULED: 'scheduled',
  QUEUED: 'queued',
  IN_PROGRESS: 'in_progress',
  AWAITING_RESPONSE: 'awaiting_response',
  COMPLETED: 'completed',
  FAILED: 'failed',
  REQUIRES_FOLLOWUP: 'requires_followup'
};

// Valid state transitions
const TRANSITIONS = {
  [STATES.SCHEDULED]: [STATES.QUEUED, STATES.FAILED],
  [STATES.QUEUED]: [STATES.IN_PROGRESS, STATES.FAILED],
  [STATES.IN_PROGRESS]: [STATES.AWAITING_RESPONSE, STATES.COMPLETED, STATES.FAILED],
  [STATES.AWAITING_RESPONSE]: [STATES.IN_PROGRESS, STATES.COMPLETED, STATES.REQUIRES_FOLLOWUP, STATES.FAILED],
  [STATES.COMPLETED]: [STATES.REQUIRES_FOLLOWUP],
  [STATES.FAILED]: [STATES.QUEUED], // Allow retry
  [STATES.REQUIRES_FOLLOWUP]: [STATES.SCHEDULED]
};

class CallStateMachine {
  /**
   * Transition a call to a new state
   * @param {number} callId - Call ID
   * @param {string} newState - Target state
   * @param {object} metadata - Additional metadata
   * @returns {Promise<boolean>} Success status
   */
  async transition(callId, newState, metadata = {}) {
    try {
      // Get current state
      const currentState = await this.getCurrentState(callId);
      
      // Validate transition
      if (!this.isValidTransition(currentState, newState)) {
        const error = `Invalid state transition: ${currentState} -> ${newState} for call ${callId}`;
        console.error(error);
        throw new Error(error);  // Throw instead of returning false
      }

      // Update call state
      await query(
        `UPDATE calls SET state = $1, state_metadata = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $3`,
        [newState, JSON.stringify(metadata), callId]
      );

      console.log(`Call ${callId} transitioned: ${currentState} -> ${newState}`);
      return true;
    } catch (error) {
      console.error(`State transition error for call ${callId}:`, error.message);
      throw error;  // Propagate error instead of returning false
    }
  }

  /**
   * Get current state of a call
   * @param {number} callId - Call ID
   * @returns {Promise<string>} Current state
   */
  async getCurrentState(callId) {
    try {
      const result = await query(
        'SELECT state FROM calls WHERE id = $1',
        [callId]
      );

      if (result.rows.length === 0) {
        return null;
      }

      return result.rows[0].state || STATES.SCHEDULED;
    } catch (error) {
      console.error('Get state error:', error);
      return null;
    }
  }

  /**
   * Check if transition is valid
   * @param {string} currentState - Current state
   * @param {string} newState - Target state
   * @returns {boolean} Is valid
   */
  isValidTransition(currentState, newState) {
    if (!currentState) return true; // Allow initial state
    
    const allowedTransitions = TRANSITIONS[currentState] || [];
    return allowedTransitions.includes(newState);
  }

  /**
   * Get all calls in a specific state
   * @param {string} state - State to filter by
   * @returns {Promise<Array>} Calls in state
   */
  async getCallsByState(state) {
    try {
      const result = await query(
        'SELECT * FROM calls WHERE state = $1 ORDER BY created_at DESC',
        [state]
      );
      return result.rows;
    } catch (error) {
      console.error('Get calls by state error:', error);
      return [];
    }
  }

  /**
   * Increment retry count for a call
   * @param {number} callId - Call ID
   * @returns {Promise<number>} New retry count
   */
  async incrementRetry(callId) {
    try {
      const result = await query(
        `UPDATE calls SET retry_count = COALESCE(retry_count, 0) + 1 WHERE id = $1 RETURNING retry_count`,
        [callId]
      );
      return result.rows[0]?.retry_count || 0;
    } catch (error) {
      console.error('Increment retry error:', error);
      return 0;
    }
  }
}

module.exports = {
  CallStateMachine,
  STATES
};
