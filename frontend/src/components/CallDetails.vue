<template>
  <div class="call-details">
    <div class="header">
      <button @click="$router.back()" class="btn-back">← Back</button>
      <h1>Patient Call Summary</h1>
    </div>
    
    <div v-if="loading" class="loading">Loading patient call summary...</div>
    
    <div v-else-if="call" class="details-container">
      <div class="info-section">
        <h2>Patient & Call</h2>
        <div class="info-grid">
          <div class="info-item">
            <strong>Patient:</strong> {{ call.patient_name }}
          </div>
          <div class="info-item">
            <strong>Phone:</strong> {{ call.phone }}
          </div>
          <div class="info-item">
            <strong>Outreach Program:</strong> {{ call.campaign_name }}
          </div>
          <div class="info-item">
            <strong>Date:</strong> {{ formatDate(call.created_at) }}
          </div>
          <div class="info-item">
            <strong>Duration:</strong> {{ formatCallDuration(call.duration, call) }}
          </div>
          <div class="info-item">
            <strong>Call Status:</strong>
            <span :class="'call-state-badge ' + call.state">
              {{ formatCallState(call.state) }}
            </span>
          </div>
          <div class="info-item">
            <strong>Conversation Tone:</strong>
            <span :class="'tone-badge ' + toneClass(call.sentiment, call)">
              {{ formatConversationTone(call.sentiment, call) }}
            </span>
          </div>
        </div>
      </div>
      
      <div class="structured-section">
        <h2>Outcome Summary</h2>
        <div class="structured-grid">
          <div class="structured-item">
            <strong>Appointment Status:</strong>
            <span :class="['outcome-value', { success: call.appointment_confirmed }]">
              {{ formatAppointmentOutcome(call) }}
            </span>
          </div>
          <div class="structured-item">
            <strong>Follow-up Needed:</strong>
            <span :class="['outcome-value', { warning: call.requested_callback }]">
              {{ formatFollowupOutcome(call) }}
            </span>
          </div>
          <div class="structured-item">
            <strong>Outreach Goal:</strong>
            <span :class="['outcome-value', { success: call.campaign_goal_achieved }]">
              {{ formatGoalOutcome(call) }}
            </span>
          </div>
          <div class="structured-item">
            <strong>Priority:</strong>
            <span :class="'priority-badge ' + priorityClass(call.urgency)">
              {{ formatPriority(call.urgency) }}
            </span>
          </div>
        </div>
        <div v-if="parsedActionItems.length > 0" class="action-items-box">
          <strong>Care Team Actions:</strong>
          <ul>
            <li v-for="(item, index) in parsedActionItems" :key="index">{{ item }}</li>
          </ul>
        </div>
        <div class="summary-box">
          <strong>Call Summary:</strong>
          <p>{{ formatSummary(call.summary, call) }}</p>
        </div>
      </div>
      
      <div class="transcript-section">
        <h2>Conversation Notes</h2>
        <div class="transcript-box">
          <pre>{{ formatTranscript(call.transcript, call) }}</pre>
        </div>
      </div>
    </div>
  </div>
</template>

<script>
import api from '../api.js';
import {
  formatAppointmentOutcome,
  formatCallDuration,
  formatCallState,
  formatConversationTone,
  formatFollowupOutcome,
  formatGoalOutcome,
  formatPriority,
  formatSummary,
  formatTranscript,
  priorityClass,
  toneClass
} from '../displayLabels.js';

export default {
  name: 'CallDetails',
  data() {
    return {
      call: null,
      loading: true
    };
  },
  computed: {
    parsedActionItems() {
      if (!this.call) return [];
      let items = this.call.action_items;
      if (typeof items === 'string') {
        try { items = JSON.parse(items); } catch (e) { return []; }
      }
      return Array.isArray(items) ? items : [];
    }
  },
  async mounted() {
    await this.loadCall();
  },
  methods: {
    formatAppointmentOutcome,
    formatCallDuration,
    formatCallState,
    formatConversationTone,
    formatFollowupOutcome,
    formatGoalOutcome,
    formatPriority,
    formatSummary,
    formatTranscript,
    priorityClass,
    toneClass,
    async loadCall() {
      try {
        const callId = this.$route.params.id;
        const response = await api.get(`/calls/${callId}`);
        this.call = response.data.call;
      } catch (error) {
        console.error('Failed to load call:', error);
        this.$toastError('Failed to load call details');
        this.$router.back();
      } finally {
        this.loading = false;
      }
    },
    
    formatDate(dateString) {
      return new Date(dateString).toLocaleString();
    }
  }
};
</script>

<style scoped>
.call-details .header {
  display: flex;
  align-items: center;
  gap: 1rem;
  margin-bottom: 2rem;
}

.btn-back {
  padding: 0.5rem 1rem;
  background: #95a5a6;
  color: white;
  border: none;
  border-radius: 6px;
  cursor: pointer;
  font-size: 1rem;
}

.btn-back:hover {
  background: #7f8c8d;
}

.call-details h1 {
  color: #2c3e50;
  margin: 0;
}

.loading {
  text-align: center;
  padding: 3rem;
  color: #7f8c8d;
  background: white;
  border-radius: 12px;
}

.details-container {
  display: flex;
  flex-direction: column;
  gap: 2rem;
}

.info-section,
.structured-section,
.transcript-section {
  background: white;
  padding: 2rem;
  border-radius: 12px;
  box-shadow: 0 2px 8px rgba(0,0,0,0.1);
}

h2 {
  color: #2c3e50;
  margin-bottom: 1.5rem;
  font-size: 1.5rem;
}

.info-grid,
.structured-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(250px, 1fr));
  gap: 1rem;
}

.info-item,
.structured-item {
  padding: 1rem;
  background: #f8f9fa;
  border-radius: 6px;
}

.info-item strong,
.structured-item strong {
  display: block;
  margin-bottom: 0.5rem;
  color: #7f8c8d;
  font-size: 0.9rem;
}

.tone-badge,
.call-state-badge {
  padding: 0.25rem 0.75rem;
  border-radius: 12px;
  font-size: 0.85rem;
  font-weight: 600;
}

.tone-badge.positive,
.call-state-badge.completed,
.call-state-badge.requires_followup {
  background: #d4edda;
  color: #155724;
}

.tone-badge.neutral,
.call-state-badge.scheduled,
.call-state-badge.queued,
.call-state-badge.in_progress,
.call-state-badge.awaiting_response {
  background: #fff3cd;
  color: #856404;
}

.tone-badge.negative,
.call-state-badge.failed {
  background: #f8d7da;
  color: #721c24;
}

.summary-box {
  margin-top: 1.5rem;
  padding: 1rem;
  background: #f8f9fa;
  border-radius: 6px;
}

.summary-box strong {
  display: block;
  margin-bottom: 0.5rem;
  color: #2c3e50;
}

.summary-box p {
  color: #34495e;
  line-height: 1.6;
  margin: 0;
}

.transcript-box {
  background: #f8f9fa;
  color: #34495e;
  padding: 1.5rem;
  border-radius: 6px;
  overflow-x: auto;
}

.transcript-box pre {
  margin: 0;
  white-space: pre-wrap;
  word-wrap: break-word;
  font-family: inherit;
  font-size: 0.95rem;
  line-height: 1.6;
}

.priority-badge,
.outcome-value {
  padding: 0.2rem 0.6rem;
  border-radius: 12px;
  font-size: 0.85rem;
  font-weight: 600;
}

.priority-badge.routine,
.outcome-value.success {
  background: #d4edda;
  color: #155724;
}

.priority-badge.needs_attention,
.priority-badge.urgent,
.outcome-value.warning {
  background: #fff3cd;
  color: #856404;
}

.priority-badge.critical {
  background: #f8d7da;
  color: #721c24;
}

.action-items-box {
  margin-top: 1.5rem;
  padding: 1rem;
  background: #fff8e1;
  border-radius: 6px;
  border-left: 4px solid #ffa000;
}

.action-items-box strong {
  display: block;
  margin-bottom: 0.75rem;
  color: #e65100;
}

.action-items-box ul {
  margin: 0;
  padding-left: 1.5rem;
}

.action-items-box li {
  padding: 0.25rem 0;
  color: #34495e;
  line-height: 1.5;
}
</style>
