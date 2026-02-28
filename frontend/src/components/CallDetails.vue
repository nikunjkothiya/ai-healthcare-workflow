<template>
  <div class="call-details">
    <div class="header">
      <button @click="$router.back()" class="btn-back">← Back</button>
      <h1>Call Details</h1>
    </div>
    
    <div v-if="loading" class="loading">Loading call details...</div>
    
    <div v-else-if="call" class="details-container">
      <div class="info-section">
        <h2>Call Information</h2>
        <div class="info-grid">
          <div class="info-item">
            <strong>Patient:</strong> {{ call.patient_name }}
          </div>
          <div class="info-item">
            <strong>Phone:</strong> {{ call.phone }}
          </div>
          <div class="info-item">
            <strong>Campaign:</strong> {{ call.campaign_name }}
          </div>
          <div class="info-item">
            <strong>Date:</strong> {{ formatDate(call.created_at) }}
          </div>
          <div class="info-item">
            <strong>Duration:</strong> {{ call.duration }}s
          </div>
          <div class="info-item">
            <strong>Sentiment:</strong>
            <span :class="'sentiment-badge ' + call.sentiment">
              {{ call.sentiment }}
            </span>
          </div>
        </div>
      </div>
      
      <div class="structured-section">
        <h2>Structured Output</h2>
        <div class="structured-grid">
          <div class="structured-item">
            <strong>Appointment Confirmed:</strong>
            {{ call.appointment_confirmed ? '✅ Yes' : '❌ No' }}
          </div>
          <div class="structured-item">
            <strong>Callback Requested:</strong>
            {{ call.requested_callback ? '✅ Yes' : '❌ No' }}
          </div>
        </div>
        <div class="summary-box">
          <strong>Summary:</strong>
          <p>{{ call.summary }}</p>
        </div>
      </div>
      
      <div class="transcript-section">
        <h2>Full Transcript</h2>
        <div class="transcript-box">
          <pre>{{ call.transcript }}</pre>
        </div>
      </div>
      
      <div class="json-section">
        <h2>Raw JSON Output</h2>
        <div class="json-box">
          <pre>{{ formatJSON(call.structured_output) }}</pre>
        </div>
      </div>
    </div>
  </div>
</template>

<script>
import api from '../api.js';

export default {
  name: 'CallDetails',
  data() {
    return {
      call: null,
      loading: true
    };
  },
  async mounted() {
    await this.loadCall();
  },
  methods: {
    async loadCall() {
      try {
        const callId = this.$route.params.id;
        const response = await api.get(`/calls/${callId}`);
        this.call = response.data.call;
      } catch (error) {
        console.error('Failed to load call:', error);
        alert('Failed to load call details');
        this.$router.back();
      } finally {
        this.loading = false;
      }
    },
    
    formatDate(dateString) {
      return new Date(dateString).toLocaleString();
    },
    
    formatJSON(json) {
      if (typeof json === 'string') {
        try {
          json = JSON.parse(json);
        } catch (e) {
          return json;
        }
      }
      return JSON.stringify(json, null, 2);
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
.transcript-section,
.json-section {
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

.sentiment-badge {
  padding: 0.25rem 0.75rem;
  border-radius: 12px;
  font-size: 0.85rem;
  font-weight: 600;
}

.sentiment-badge.positive {
  background: #d4edda;
  color: #155724;
}

.sentiment-badge.neutral {
  background: #fff3cd;
  color: #856404;
}

.sentiment-badge.negative {
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

.transcript-box,
.json-box {
  background: #2c3e50;
  color: #ecf0f1;
  padding: 1.5rem;
  border-radius: 6px;
  overflow-x: auto;
}

.transcript-box pre,
.json-box pre {
  margin: 0;
  white-space: pre-wrap;
  word-wrap: break-word;
  font-family: 'Courier New', monospace;
  font-size: 0.9rem;
  line-height: 1.6;
}
</style>
