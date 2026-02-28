<template>
  <div class="campaigns">
    <div class="header">
      <h1>Campaigns</h1>
      <button @click="showCreateModal = true" class="btn-primary">
        + Create Campaign
      </button>
    </div>
    
    <div v-if="loading" class="loading">Loading campaigns...</div>
    
    <div v-else-if="campaigns.length === 0" class="no-data">
      No campaigns yet. Create your first campaign!
    </div>
    
    <div v-else class="campaigns-grid">
      <div v-for="campaign in campaigns" :key="campaign.id" class="campaign-card">
        <div class="campaign-header">
          <h3>{{ campaign.name }}</h3>
          <span :class="'status-badge ' + campaign.status">
            {{ campaign.status }}
          </span>
        </div>
        <div class="campaign-meta">
          <p>Created: {{ formatDate(campaign.created_at) }}</p>
        </div>
        <div class="campaign-actions">
          <button @click="viewCampaign(campaign.id)" class="btn-secondary">
            View Details
          </button>
          <button @click="deleteCampaign(campaign)" class="btn-danger">
            Delete Campaign
          </button>
        </div>
      </div>
    </div>
    
    <!-- Create Campaign Modal -->
    <div v-if="showCreateModal" class="modal-overlay" @click="closeCreateModal">
      <div class="modal" @click.stop>
        <h2>Create New Campaign</h2>
        <form @submit.prevent="createCampaign">
          <div class="form-group">
            <label>Campaign Name</label>
            <input v-model="newCampaignName" type="text" required placeholder="e.g., Diabetes Appointment Reminders" />
          </div>
          <div class="form-group">
            <label>Opening Prompt (First thing AI says when patient answers)</label>
            <textarea 
              v-model="newCampaignOpening" 
              rows="3" 
              required
              placeholder="e.g., Hello, I'm calling from City General Hospital to confirm your upcoming appointment with Dr. Smith."
            ></textarea>
            <small class="help-text">This is what the AI agent will say first when the patient answers the call.</small>
          </div>
          <div class="form-group">
            <label>When to Start Calling?</label>
            <div class="radio-group">
              <label class="radio-option">
                <input type="radio" v-model="startTimeOption" value="now" />
                <span>Start Now (begins in 1 minute)</span>
              </label>
              <label class="radio-option">
                <input type="radio" v-model="startTimeOption" value="scheduled" />
                <span>Schedule for Later</span>
              </label>
            </div>
          </div>
          <div v-if="startTimeOption === 'scheduled'" class="form-group">
            <label>Schedule Date & Time</label>
            <input v-model="scheduleDateTime" type="datetime-local" required />
            <small class="help-text">Campaign will start calling patients at this time</small>
          </div>
          <div class="form-group">
            <label>Select Patient Groups *</label>
            <div class="category-selection">
              <label v-for="category in categories" :key="category.value" class="category-option">
                <input type="checkbox" v-model="newCampaignCategories" :value="category.value" />
                <span class="category-label">
                  <span class="icon">{{ category.icon }}</span>
                  <span>{{ category.label }} Patients</span>
                  <span class="count">({{ getCategoryCount(category.value) }})</span>
                </span>
              </label>
            </div>
            <div class="selected-summary">
              <strong>Total patients selected:</strong> {{ totalCreateSelectedPatients }}
            </div>
          </div>
          <div class="modal-actions">
            <button type="button" @click="closeCreateModal" class="btn-secondary">
              Cancel
            </button>
            <button type="submit" class="btn-primary" :disabled="creatingCampaign">
              {{ creatingCampaign ? 'Creating...' : 'Create & Schedule' }}
            </button>
          </div>
        </form>
      </div>
    </div>
    
    <!-- Campaign Details Modal with Live Patient URLs -->
    <div v-if="selectedCampaign" class="modal-overlay" @click="selectedCampaign = null">
      <div class="modal large" @click.stop>
        <h2>{{ selectedCampaign.campaign.name }}</h2>
        <div class="campaign-details">
          <p><strong>Status:</strong> <span :class="'status-badge ' + selectedCampaign.campaign.status">{{ selectedCampaign.campaign.status }}</span></p>
          <p><strong>Total Patients:</strong> {{ selectedCampaign.patients.length }}</p>
          
          <div v-if="selectedCampaign.campaign.status === 'running'" class="live-calls-section">
            <h3>🔴 Live Campaign - Patient Call URLs</h3>
            <p class="help-text">Copy and open these URLs to simulate patient phones. AI will call them one by one.</p>
          </div>
          
          <h3>Patients & Call URLs</h3>
          <table>
            <thead>
              <tr>
                <th>Name</th>
                <th>Phone</th>
                <th>Status</th>
                <th>Patient Call URL</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="patient in selectedCampaign.patients" :key="patient.id">
                <td>{{ patient.name }}</td>
                <td>{{ patient.phone }}</td>
                <td>
                  <span :class="'status-badge ' + patient.status">
                    {{ patient.status }}
                  </span>
                </td>
                <td>
                  <div class="url-cell">
                    <input 
                      :value="getPatientCallUrl(patient.id, selectedCampaign.campaign.id)" 
                      readonly 
                      class="url-input"
                      @click="selectUrl"
                    />
                    <button @click="copyPatientUrl(patient.id, selectedCampaign.campaign.id)" class="btn-copy-small">
                      📋
                    </button>
                    <button @click="openPatientUrl(patient.id, selectedCampaign.campaign.id)" class="btn-open-small">
                      🔗
                    </button>
                  </div>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <div class="modal-actions">
          <button v-if="selectedCampaign.campaign.status === 'running'" @click="openAllPatientUrls(selectedCampaign.campaign.id, selectedCampaign.patients)" class="btn-primary">
            🚀 Open All Patient Phones
          </button>
          <button @click="selectedCampaign = null" class="btn-secondary">Close</button>
        </div>
      </div>
    </div>
  </div>
</template>

<script>
import api from '../api.js';

export default {
  name: 'Campaigns',
  data() {
    return {
      campaigns: [],
      loading: true,
      showCreateModal: false,
      newCampaignName: '',
      newCampaignOpening: '',
      newCampaignCategories: [],
      creatingCampaign: false,
      startTimeOption: 'now',
      scheduleDateTime: '',
      categoryCounts: {},
      selectedCampaign: null,
      refreshInterval: null,
      categories: [
        { value: 'diabetes', label: 'Diabetes', icon: '🩺' },
        { value: 'heart_disease', label: 'Heart Disease', icon: '❤️' },
        { value: 'asthma', label: 'Asthma', icon: '🫁' },
        { value: 'hypertension', label: 'Hypertension', icon: '💊' },
        { value: 'other', label: 'Other', icon: '📋' }
      ]
    };
  },
  async mounted() {
    await this.loadCampaigns();
    await this.loadCategoryCounts();
  },
  beforeUnmount() {
    // Clear refresh interval when component is destroyed
    if (this.refreshInterval) {
      clearInterval(this.refreshInterval);
    }
  },
  watch: {
    selectedCampaign(newVal) {
      // Start auto-refresh when campaign details are opened and campaign is running
      if (newVal && newVal.campaign.status === 'running') {
        this.startAutoRefresh(newVal.campaign.id);
      } else {
        this.stopAutoRefresh();
      }
    }
  },
  computed: {
    totalCreateSelectedPatients() {
      return this.newCampaignCategories.reduce((sum, cat) => {
        return sum + (this.categoryCounts[cat] || 0);
      }, 0);
    }
  },
  methods: {
    async loadCampaigns() {
      try {
        const response = await api.get('/campaigns');
        this.campaigns = response.data.campaigns;
      } catch (error) {
        console.error('Failed to load campaigns:', error);
        alert('Failed to load campaigns');
      } finally {
        this.loading = false;
      }
    },
    
    async createCampaign() {
      if (this.newCampaignCategories.length === 0) {
        alert('Please select at least one patient group.');
        return;
      }

      if (this.totalCreateSelectedPatients === 0) {
        alert('Selected patient groups have no available active patients.');
        return;
      }

      this.creatingCampaign = true;
      let campaignId = null;
      try {
        let scheduleTime = null;
        
        if (this.startTimeOption === 'now') {
          // Start in 1 minute
          const now = new Date();
          now.setMinutes(now.getMinutes() + 1);
          scheduleTime = now.toISOString();
        } else if (this.startTimeOption === 'scheduled' && this.scheduleDateTime) {
          // Use user-selected datetime
          scheduleTime = new Date(this.scheduleDateTime).toISOString();
        }

        const createResponse = await api.post('/campaigns', {
          name: this.newCampaignName,
          opening_prompt: this.newCampaignOpening,
          schedule_time: scheduleTime,
          retry_limit: 0  // No retries - just mark as missed/rejected
        });

        campaignId = createResponse.data?.campaign?.id;
        if (!campaignId) {
          throw new Error('Campaign creation failed: missing campaign ID');
        }

        await api.post(`/campaigns/${campaignId}/assign-patients`, {
          categories: this.newCampaignCategories
        });

        const startResponse = await api.post(`/campaigns/${campaignId}/start`, {
          callMode: 'websocket'
        });

        const queuedCount = startResponse.data?.patientsQueued || 0;
        const campaignStatus = startResponse.data?.message?.toLowerCase().includes('scheduled')
          ? 'scheduled'
          : 'running';

        this.closeCreateModal();
        await this.loadCampaigns();
        await this.loadCategoryCounts();
        await this.viewCampaign(campaignId);
        alert(`Campaign created and ${campaignStatus} with ${queuedCount} patients.`);
      } catch (error) {
        console.error('Failed to create campaign:', error);
        if (campaignId) {
          try {
            await api.delete(`/campaigns/${campaignId}`);
          } catch (cleanupError) {
            console.error('Failed to rollback partial campaign:', cleanupError);
          }
        }
        alert(error.response?.data?.error || 'Failed to create and schedule campaign');
      } finally {
        this.creatingCampaign = false;
      }
    },
    
    async loadCategoryCounts() {
      try {
        const response = await api.get('/patients');
        const patients = response.data.patients;
        this.categoryCounts = this.categories.reduce((acc, category) => {
          acc[category.value] = patients.filter(p => p.category === category.value).length;
          return acc;
        }, {});
      } catch (error) {
        console.error('Failed to load category counts:', error);
      }
    },
    
    getCategoryCount(category) {
      return this.categoryCounts[category] || 0;
    },
    
    async deleteCampaign(campaign) {
      if (!confirm(`Delete campaign "${campaign.name}" and its call history? This action cannot be undone.`)) {
        return;
      }

      try {
        await api.delete(`/campaigns/${campaign.id}`);
        if (this.selectedCampaign?.campaign?.id === campaign.id) {
          this.selectedCampaign = null;
          this.stopAutoRefresh();
        }
        await this.loadCampaigns();
        await this.loadCategoryCounts();
        alert('Campaign deleted successfully');
      } catch (error) {
        console.error('Failed to delete campaign:', error);
        alert(error.response?.data?.error || 'Failed to delete campaign');
      }
    },

    closeCreateModal() {
      this.showCreateModal = false;
      this.newCampaignName = '';
      this.newCampaignOpening = '';
      this.newCampaignCategories = [];
      this.startTimeOption = 'now';
      this.scheduleDateTime = '';
    },
    
    async viewCampaign(campaignId) {
      try {
        const response = await api.get(`/campaigns/${campaignId}`);
        this.selectedCampaign = response.data;
      } catch (error) {
        console.error('Failed to load campaign details:', error);
        alert('Failed to load campaign details');
      }
    },
    
    getPatientCallUrl(patientId, campaignId) {
      return `${window.location.origin}/mobile-call?patient=${patientId}&campaign=${campaignId}`;
    },
    
    selectUrl(event) {
      event.target.select();
    },
    
    copyPatientUrl(patientId, campaignId) {
      const url = this.getPatientCallUrl(patientId, campaignId);
      navigator.clipboard.writeText(url);
      alert('Patient call URL copied! Open in a new browser tab to simulate patient phone.');
    },
    
    openPatientUrl(patientId, campaignId) {
      const url = this.getPatientCallUrl(patientId, campaignId);
      window.open(url, `_blank_patient_${patientId}`);
    },
    
    openAllPatientUrls(campaignId, patients) {
      patients.forEach((patient, index) => {
        setTimeout(() => {
          this.openPatientUrl(patient.id, campaignId);
        }, index * 200); // Stagger opening to avoid browser blocking
      });
    },
    
    startAutoRefresh(campaignId) {
      // Clear any existing interval
      this.stopAutoRefresh();
      
      // Refresh campaign details every 3 seconds
      this.refreshInterval = setInterval(async () => {
        try {
          const response = await api.get(`/campaigns/${campaignId}`);
          this.selectedCampaign = response.data;
          
          // Stop refreshing if campaign is no longer running
          if (response.data.campaign.status !== 'running') {
            this.stopAutoRefresh();
          }
        } catch (error) {
          console.error('Failed to refresh campaign:', error);
        }
      }, 3000);
    },
    
    stopAutoRefresh() {
      if (this.refreshInterval) {
        clearInterval(this.refreshInterval);
        this.refreshInterval = null;
      }
    },
    
    formatDate(dateString) {
      return new Date(dateString).toLocaleString();
    }
  }
};
</script>

<style scoped>
.campaigns .header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 2rem;
}

.campaigns h1 {
  color: #2c3e50;
}

.loading, .no-data {
  text-align: center;
  padding: 3rem;
  color: #7f8c8d;
  background: white;
  border-radius: 12px;
}

.campaigns-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(350px, 1fr));
  gap: 1.5rem;
}

.campaign-card {
  background: white;
  padding: 1.5rem;
  border-radius: 12px;
  box-shadow: 0 2px 8px rgba(0,0,0,0.1);
}

.campaign-header {
  display: flex;
  justify-content: space-between;
  align-items: start;
  margin-bottom: 1rem;
}

.campaign-header h3 {
  color: #2c3e50;
  margin: 0;
}

.status-badge {
  padding: 0.25rem 0.75rem;
  border-radius: 12px;
  font-size: 0.85rem;
  font-weight: 600;
}

.status-badge.pending {
  background: #fff3cd;
  color: #856404;
}

.status-badge.running {
  background: #d4edda;
  color: #155724;
}

.status-badge.completed {
  background: #d1ecf1;
  color: #0c5460;
}

.status-badge.failed {
  background: #f8d7da;
  color: #721c24;
}

.status-badge.missed {
  background: #fff3cd;
  color: #856404;
}

.status-badge.rejected {
  background: #f8d7da;
  color: #721c24;
}

.status-badge.calling {
  background: #cce5ff;
  color: #004085;
}

.campaign-meta {
  color: #7f8c8d;
  font-size: 0.9rem;
  margin-bottom: 1rem;
}

.campaign-actions {
  display: flex;
  gap: 0.5rem;
  flex-wrap: wrap;
}

.btn-primary, .btn-secondary, .btn-success, .btn-danger {
  padding: 0.5rem 1rem;
  border: none;
  border-radius: 6px;
  cursor: pointer;
  font-size: 0.9rem;
  font-weight: 600;
  transition: all 0.3s;
}

.btn-primary {
  background: #667eea;
  color: white;
}

.btn-primary:hover:not(:disabled) {
  background: #5568d3;
}

.btn-secondary {
  background: #95a5a6;
  color: white;
}

.btn-secondary:hover:not(:disabled) {
  background: #7f8c8d;
}

.btn-success {
  background: #27ae60;
  color: white;
}

.btn-success:hover:not(:disabled) {
  background: #229954;
}

.btn-danger {
  background: #dc2626;
  color: white;
}

.btn-danger:hover:not(:disabled) {
  background: #b91c1c;
}

button:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.modal-overlay {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background: rgba(0,0,0,0.5);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1000;
}

.modal {
  background: white;
  padding: 2rem;
  border-radius: 12px;
  max-width: 500px;
  width: 90%;
  max-height: 90vh;
  overflow-y: auto;
}

.modal.large {
  max-width: 800px;
}

.modal h2 {
  margin-bottom: 1.5rem;
  color: #2c3e50;
}

.help-text {
  color: #7f8c8d;
  font-size: 0.9rem;
  margin-bottom: 1rem;
}

.form-group {
  margin-bottom: 1.5rem;
}

.form-group label {
  display: block;
  margin-bottom: 0.5rem;
  color: #2c3e50;
  font-weight: 600;
}

.form-group input {
  width: 100%;
  padding: 0.75rem;
  border: 2px solid #e0e0e0;
  border-radius: 6px;
  font-size: 1rem;
}

.form-group textarea {
  width: 100%;
  padding: 0.75rem;
  border: 2px solid #e0e0e0;
  border-radius: 6px;
  font-size: 1rem;
  font-family: inherit;
  resize: vertical;
}

.form-group input:focus,
.form-group textarea:focus {
  outline: none;
  border-color: #667eea;
}

.radio-group {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
}

.radio-option {
  display: flex;
  align-items: center;
  padding: 0.75rem;
  border: 2px solid #e0e0e0;
  border-radius: 6px;
  cursor: pointer;
  transition: all 0.2s;
}

.radio-option:hover {
  border-color: #667eea;
  background: #f9fafb;
}

.radio-option input[type="radio"] {
  margin-right: 0.75rem;
  width: 18px;
  height: 18px;
  cursor: pointer;
}

.radio-option span {
  font-size: 0.95rem;
  color: #2c3e50;
}

.help-text {
  display: block;
  margin-top: 0.5rem;
  color: #7f8c8d;
  font-size: 0.85rem;
  font-style: italic;
}

.modal-actions {
  display: flex;
  gap: 1rem;
  justify-content: flex-end;
  margin-top: 1.5rem;
}

.campaign-details h3 {
  margin: 1.5rem 0 1rem;
  color: #2c3e50;
}

.campaign-details table {
  width: 100%;
  border-collapse: collapse;
  margin-top: 1rem;
}

.campaign-details th,
.campaign-details td {
  padding: 0.75rem;
  text-align: left;
  border-bottom: 1px solid #e0e0e0;
}

.campaign-details th {
  background: #f8f9fa;
  font-weight: 600;
  color: #2c3e50;
}

.live-calls-section {
  background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
  color: white;
  padding: 1.5rem;
  border-radius: 12px;
  margin: 1rem 0;
}

.live-calls-section h3 {
  margin: 0 0 0.5rem 0;
  font-size: 1.2rem;
}

.live-calls-section .help-text {
  color: rgba(255, 255, 255, 0.9);
  margin: 0;
  font-size: 0.95rem;
}

.url-cell {
  display: flex;
  gap: 0.5rem;
  align-items: center;
}

.url-input {
  flex: 1;
  padding: 0.5rem;
  border: 1px solid #d1d5db;
  border-radius: 6px;
  font-size: 0.85rem;
  font-family: monospace;
  background: #f9fafb;
}

.btn-copy-small,
.btn-open-small {
  padding: 0.5rem 0.75rem;
  border: none;
  border-radius: 6px;
  cursor: pointer;
  font-size: 1rem;
  transition: all 0.2s;
}

.btn-copy-small {
  background: #f3f4f6;
}

.btn-copy-small:hover {
  background: #e5e7eb;
  transform: scale(1.1);
}

.btn-open-small {
  background: #667eea;
  color: white;
}

.btn-open-small:hover {
  background: #5568d3;
  transform: scale(1.1);
}

.category-selection {
  display: flex;
  flex-direction: column;
  gap: 1rem;
  margin: 1.5rem 0;
}

.category-option {
  display: flex;
  align-items: center;
  padding: 1rem;
  border: 2px solid #e0e0e0;
  border-radius: 8px;
  cursor: pointer;
  transition: all 0.2s;
}

.category-option:hover {
  border-color: #667eea;
  background: #f9fafb;
}

.category-option input[type="checkbox"] {
  margin-right: 1rem;
  width: 20px;
  height: 20px;
  cursor: pointer;
}

.category-label {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  flex: 1;
  font-size: 1rem;
}

.category-label .icon {
  font-size: 1.5rem;
}

.category-label .count {
  margin-left: auto;
  color: #7f8c8d;
  font-weight: 600;
}

.selected-summary {
  padding: 1rem;
  background: #f0f9ff;
  border-radius: 8px;
  text-align: center;
  color: #0369a1;
  font-size: 1.1rem;
  margin-bottom: 1rem;
}
</style>
