<template>
  <div class="call-links">
    <div class="header">
      <h1>📱 Patient Call Links</h1>
      <p class="subtitle">{{ subtitleText }}</p>
    </div>

    <div class="instructions">
      <h3>How to Test:</h3>
      <ol>
        <li>Start a campaign from the Campaigns page</li>
        <li>Open patient links below in different browsers/tabs</li>
        <li>When AI calls, you'll see incoming call screen</li>
        <li>Click "Accept" to answer like a real patient</li>
        <li>Have natural conversation with AI agent</li>
        <li>View full transcript and analysis after call ends</li>
      </ol>
    </div>

    <div class="patients-grid">
      <div v-for="patient in patients" :key="patient.id" class="patient-card">
        <div class="patient-header">
          <div class="patient-icon">{{ patient.icon }}</div>
          <div class="patient-info">
            <h3>{{ patient.name }}</h3>
            <p class="condition">{{ patient.condition }}</p>
            <p class="phone">{{ patient.phone }}</p>
          </div>
        </div>

        <div class="patient-details">
          <div class="detail-item">
            <span class="label">Appointment:</span>
            <span class="value">{{ patient.appointment }}</span>
          </div>
          <div class="detail-item">
            <span class="label">Doctor:</span>
            <span class="value">{{ patient.doctor }}</span>
          </div>
          <div class="detail-item">
            <span class="label">Age:</span>
            <span class="value">{{ patient.age }}</span>
          </div>
          <div class="detail-item" v-if="patient.barriers">
            <span class="label">Barriers:</span>
            <span class="value barriers">{{ patient.barriers }}</span>
          </div>
        </div>

        <div class="call-link">
          <input 
            :value="getCallLink(patient.id)" 
            readonly 
            @click="selectLink"
            class="link-input"
          />
          <div class="link-actions">
            <button @click="copyLink(patient.id)" class="btn-copy">
              📋 Copy
            </button>
            <button @click="openLink(patient.id)" class="btn-open">
              🔗 Open
            </button>
          </div>
        </div>
      </div>
    </div>

    <div class="quick-test">
      <h3>Quick Test - Open All Patients</h3>
      <p>Opens call screens for all available patients in new tabs</p>
      <button @click="openAllLinks" class="btn-open-all">
        🚀 Open All Patient Screens
      </button>
    </div>
  </div>
</template>

<script>
import api from '../api.js';

export default {
  name: 'CallLinks',
  data() {
    return {
      patients: [],
      campaignId: null
    };
  },
  computed: {
    subtitleText() {
      if (this.campaignId) {
        return `Campaign ${this.campaignId} patient links. Open each link in a separate tab/browser.`;
      }
      return 'Open each link in a separate browser/tab to simulate patient phones';
    }
  },
  async mounted() {
    const params = new URLSearchParams(window.location.search);
    this.campaignId = params.get('campaign');
    await this.loadPatients();
  },
  methods: {
    async loadPatients() {
      try {
        if (this.campaignId) {
          const response = await api.get(`/campaigns/${encodeURIComponent(this.campaignId)}`);
          this.patients = (response.data.patients || []).map((patient) => this.mapPatient(patient));
          return;
        }

        const response = await api.get('/patients');
        this.patients = (response.data.patients || []).map((patient) => this.mapPatient(patient));
      } catch (error) {
        console.error('Failed to load patients for call links:', error);
        alert('Failed to load patient links');
      }
    },
    mapPatient(patient) {
      const metadata = patient.metadata || {};
      return {
        id: patient.id,
        name: patient.name,
        phone: patient.phone,
        condition: metadata.medical_condition || patient.category || 'Healthcare follow-up',
        appointment: metadata.appointment_type || 'Follow-up',
        doctor: metadata.doctor || 'Assigned provider',
        age: metadata.age || '-',
        icon: 'P',
        barriers: this.getBarriers(metadata)
      };
    },
    getBarriers(metadata) {
      const barriers = [];
      if (metadata.transportation_issue === 'Yes') barriers.push('Transportation');
      if (metadata.financial_concern === 'Yes') barriers.push('Financial');
      if (metadata.previous_no_show === 'Yes') barriers.push('Previous No-Show');
      return barriers.length ? barriers.join(', ') : null;
    },
    getCallLink(patientId) {
      if (this.campaignId) {
        return `${window.location.origin}/mobile-call?patient=${patientId}&campaign=${this.campaignId}`;
      }
      return `${window.location.origin}/mobile-call?patient=${patientId}`;
    },
    selectLink(event) {
      event.target.select();
    },
    copyLink(patientId) {
      const link = this.getCallLink(patientId);
      navigator.clipboard.writeText(link);
      alert('Link copied! Open in a new browser/tab to simulate patient phone.');
    },
    openLink(patientId) {
      const link = this.getCallLink(patientId);
      window.open(link, `_blank_patient_${patientId}`);
    },
    openAllLinks() {
      this.patients.forEach((patient, index) => {
        setTimeout(() => {
          this.openLink(patient.id);
        }, index * 200); // Stagger opening to avoid browser blocking
      });
    }
  }
};
</script>

<style scoped>
.call-links {
  max-width: 1400px;
  margin: 0 auto;
  padding: 2rem;
}

.header {
  text-align: center;
  margin-bottom: 2rem;
}

.header h1 {
  font-size: 2rem;
  color: #1f2937;
  margin-bottom: 0.5rem;
}

.subtitle {
  color: #6b7280;
  font-size: 1rem;
}

.instructions {
  background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
  color: white;
  padding: 2rem;
  border-radius: 16px;
  margin-bottom: 2rem;
}

.instructions h3 {
  margin-bottom: 1rem;
  font-size: 1.25rem;
}

.instructions ol {
  margin-left: 1.5rem;
  line-height: 1.8;
}

.patients-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(350px, 1fr));
  gap: 1.5rem;
  margin-bottom: 2rem;
}

.patient-card {
  background: white;
  border: 2px solid #e5e7eb;
  border-radius: 16px;
  padding: 1.5rem;
  transition: all 0.3s;
}

.patient-card:hover {
  border-color: #667eea;
  box-shadow: 0 8px 24px rgba(102, 126, 234, 0.15);
  transform: translateY(-2px);
}

.patient-header {
  display: flex;
  gap: 1rem;
  margin-bottom: 1rem;
  padding-bottom: 1rem;
  border-bottom: 2px solid #f3f4f6;
}

.patient-icon {
  font-size: 3rem;
  width: 60px;
  height: 60px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
  border-radius: 12px;
  flex-shrink: 0;
}

.patient-info {
  flex: 1;
}

.patient-info h3 {
  font-size: 1.1rem;
  color: #1f2937;
  margin-bottom: 0.25rem;
}

.condition {
  font-size: 0.85rem;
  color: #667eea;
  font-weight: 600;
  margin-bottom: 0.25rem;
}

.phone {
  font-size: 0.85rem;
  color: #6b7280;
}

.patient-details {
  margin-bottom: 1rem;
}

.detail-item {
  display: flex;
  justify-content: space-between;
  padding: 0.5rem 0;
  font-size: 0.9rem;
}

.detail-item .label {
  color: #6b7280;
  font-weight: 500;
}

.detail-item .value {
  color: #1f2937;
  font-weight: 600;
  text-align: right;
}

.detail-item .value.barriers {
  color: #ef4444;
  font-size: 0.85rem;
}

.call-link {
  background: #f9fafb;
  padding: 1rem;
  border-radius: 12px;
}

.link-input {
  width: 100%;
  padding: 0.75rem;
  border: 1px solid #d1d5db;
  border-radius: 8px;
  font-size: 0.85rem;
  font-family: monospace;
  margin-bottom: 0.75rem;
  background: white;
}

.link-actions {
  display: flex;
  gap: 0.5rem;
}

.btn-copy, .btn-open {
  flex: 1;
  padding: 0.75rem;
  border: none;
  border-radius: 8px;
  font-size: 0.9rem;
  font-weight: 600;
  cursor: pointer;
  transition: all 0.2s;
}

.btn-copy {
  background: #f3f4f6;
  color: #374151;
}

.btn-copy:hover {
  background: #e5e7eb;
}

.btn-open {
  background: #667eea;
  color: white;
}

.btn-open:hover {
  background: #5568d3;
  transform: translateY(-1px);
}

.quick-test {
  background: white;
  border: 2px solid #667eea;
  border-radius: 16px;
  padding: 2rem;
  text-align: center;
}

.quick-test h3 {
  color: #1f2937;
  margin-bottom: 0.5rem;
}

.quick-test p {
  color: #6b7280;
  margin-bottom: 1.5rem;
}

.btn-open-all {
  padding: 1rem 2rem;
  background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
  color: white;
  border: none;
  border-radius: 12px;
  font-size: 1.1rem;
  font-weight: 600;
  cursor: pointer;
  transition: all 0.3s;
}

.btn-open-all:hover {
  transform: scale(1.05);
  box-shadow: 0 8px 24px rgba(102, 126, 234, 0.3);
}

@media (max-width: 768px) {
  .patients-grid {
    grid-template-columns: 1fr;
  }
}
</style>

