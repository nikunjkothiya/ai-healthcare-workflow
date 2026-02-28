const Redis = require('ioredis');
const { query } = require('../services/database');

// Event types
const EVENTS = {
  CALL_QUEUED: 'call.queued',
  CALL_RINGING: 'call.ringing',
  CALL_STARTED: 'call.started',
  CALL_TRANSCRIBED: 'call.transcribed',
  CALL_RESPONSE_GENERATED: 'call.response.generated',
  CALL_COMPLETED: 'call.completed',
  CALL_ESCALATED: 'call.escalated',
  CALL_FAILED: 'call.failed',
  CALL_ANALYSIS_COMPLETED: 'call.analysis.completed',
  CALL_RETRY_SCHEDULED: 'call.retry.scheduled'
};

class EventBus {
  constructor() {
    this.publisher = new Redis({
      host: process.env.REDIS_HOST,
      port: process.env.REDIS_PORT,
      maxRetriesPerRequest: null
    });

    this.subscriber = new Redis({
      host: process.env.REDIS_HOST,
      port: process.env.REDIS_PORT,
      maxRetriesPerRequest: null
    });

    this.handlers = new Map();
    this.CHANNEL = 'healthcare:events';
  }

  /**
   * Emit an event
   * @param {string} eventType - Event type
   * @param {object} payload - Event payload
   * @returns {Promise<void>}
   */
  async emit(eventType, payload) {
    try {
      const event = {
        type: eventType,
        payload,
        timestamp: new Date().toISOString(),
        id: `${eventType}_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`
      };

      // Publish to Redis
      await this.publisher.publish(this.CHANNEL, JSON.stringify(event));

      // Persist to database
      await this.persistEvent(event);

      console.log(`Event emitted: ${eventType}`, payload);
    } catch (error) {
      console.error('Event emit error:', error);
    }
  }

  /**
   * Subscribe to events
   * @param {string} eventType - Event type to listen for
   * @param {function} handler - Handler function
   */
  on(eventType, handler) {
    if (!this.handlers.has(eventType)) {
      this.handlers.set(eventType, []);
    }
    this.handlers.get(eventType).push(handler);
  }

  /**
   * Start listening to events
   */
  async listen() {
    await this.subscriber.subscribe(this.CHANNEL);

    this.subscriber.on('message', async (channel, message) => {
      try {
        const event = JSON.parse(message);
        const handlers = this.handlers.get(event.type) || [];

        for (const handler of handlers) {
          try {
            await handler(event.payload);
          } catch (error) {
            console.error(`Handler error for ${event.type}:`, error);
          }
        }
      } catch (error) {
        console.error('Event processing error:', error);
      }
    });

    console.log('EventBus listening on channel:', this.CHANNEL);
  }

  /**
   * Persist event to database
   * @param {object} event - Event object
   */
  async persistEvent(event) {
    try {
      // Get organization_id from call if available
      let organizationId = event.payload.organizationId || null;
      
      if (!organizationId && event.payload.callId) {
        const result = await query(
          'SELECT organization_id FROM calls WHERE id = $1',
          [event.payload.callId]
        );
        organizationId = result.rows[0]?.organization_id || null;
      }

      await query(
        `INSERT INTO events (organization_id, call_id, event_type, payload, created_at) 
         VALUES ($1, $2, $3, $4, $5)`,
        [
          organizationId,
          event.payload.callId || null,
          event.type,
          JSON.stringify(event.payload),
          event.timestamp
        ]
      );
    } catch (error) {
      console.error('Event persistence error:', error);
    }
  }

  /**
   * Get events for a call
   * @param {number} callId - Call ID
   * @returns {Promise<Array>} Events
   */
  async getCallEvents(callId) {
    try {
      const result = await query(
        'SELECT * FROM events WHERE call_id = $1 ORDER BY created_at ASC',
        [callId]
      );
      return result.rows;
    } catch (error) {
      console.error('Get call events error:', error);
      return [];
    }
  }

  /**
   * Close connections
   */
  async close() {
    await this.publisher.quit();
    await this.subscriber.quit();
  }
}

module.exports = {
  EventBus,
  EVENTS
};
