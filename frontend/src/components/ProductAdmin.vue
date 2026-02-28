<template>
  <div class="product-admin">
    <div class="page-header">
      <h1>🏢 Product Admin Dashboard</h1>
      <p class="subtitle">Manage hospitals, monitor system activity, and configure orchestration</p>
    </div>

    <div class="tabs">
      <button 
        :class="['tab', { active: activeTab === 'hospitals' }]"
        @click="activeTab = 'hospitals'"
      >
        🏥 Hospitals
      </button>
      <button 
        :class="['tab', { active: activeTab === 'activity' }]"
        @click="activeTab = 'activity'"
      >
        📊 Real-Time Activity
      </button>
      <button 
        :class="['tab', { active: activeTab === 'orchestration' }]"
        @click="activeTab = 'orchestration'"
      >
        ⚙️ Orchestration Settings
      </button>
      <button 
        :class="['tab', { active: activeTab === 'analytics' }]"
        @click="activeTab = 'analytics'"
      >
        📈 System Analytics
      </button>
    </div>

    <!-- Hospitals Tab -->
    <div v-if="activeTab === 'hospitals'" class="tab-content">
      <div class="section-header">
        <h2>Hospital Management</h2>
        <button @click="showCreateHospital = true" class="btn-primary">
          + Add Hospital
        </button>
      </div>

      <div v-if="loading" class="loading">Loading...</div>
      <div v-else class="hospitals-grid">
        <div v-for="org in organizations" :key="org.id" class="hospital-card">
          <div class="hospital-header">
            <h3>{{ org.name }}</h3>
            <span class="badge">{{ org.user_count }} users</span>
          </div>
          <div class="hospital-stats">
            <div class="stat">
              <span class="label">Campaigns:</span>
              <span class="value">{{ org.campaign_count }}</span>
            </div>
            <div class="stat">
              <span class="label">Calls:</span>
              <span class="value">{{ org.call_count }}</span>
            </div>
            <div class="stat">
              <span class="label">Created:</span>
              <span class="value">{{ formatDate(org.created_at) }}</span>
            </div>
          </div>
          <div class="hospital-actions">
            <button @click="viewHospital(org.id)" class="btn-secondary">View Details</button>
            <button @click="openEditHospital(org)" class="btn-secondary">Edit</button>
            <button @click="confirmDeleteHospital(org)" class="btn-danger">Delete</button>
          </div>
        </div>
      </div>
    </div>

    <!-- Real-Time Activity Tab -->
    <div v-if="activeTab === 'activity'" class="tab-content">
      <h2>Real-Time System Activity</h2>
      <div class="activity-grid">
        <div class="activity-card">
          <h3>Active Calls</h3>
          <div class="activity-value">{{ realtimeStats.activeCalls || 0 }}</div>
          <div class="activity-label">Currently in progress</div>
        </div>
        <div class="activity-card">
          <h3>Queue Size</h3>
          <div class="activity-value">{{ realtimeStats.queueSize || 0 }}</div>
          <div class="activity-label">Pending calls</div>
        </div>
        <div class="activity-card">
          <h3>Completed Today</h3>
          <div class="activity-value">{{ realtimeStats.completedToday || 0 }}</div>
          <div class="activity-label">Successful calls</div>
        </div>
        <div class="activity-card">
          <h3>Avg Duration</h3>
          <div class="activity-value">{{ realtimeStats.avgDuration || 0 }}s</div>
          <div class="activity-label">Call duration</div>
        </div>
      </div>

      <div class="recent-events">
        <h3>Recent Events</h3>
        <div class="events-list">
          <div v-for="event in recentEvents" :key="event.id" class="event-item">
            <span class="event-time">{{ formatTime(event.created_at) }}</span>
            <span :class="'event-type ' + event.event_type">{{ event.event_type }}</span>
            <span class="event-details">{{ event.payload?.message || 'Event triggered' }}</span>
          </div>
        </div>
      </div>
    </div>

    <!-- Orchestration Settings Tab -->
    <div v-if="activeTab === 'orchestration'" class="tab-content">
      <h2>Orchestration Configuration</h2>
      
      <div class="config-section">
        <h3>State Machine Settings</h3>
        <div class="config-grid">
          <div class="config-item">
            <label>Max Call Duration (seconds)</label>
            <input v-model="orchestrationConfig.maxCallDuration" type="number" />
          </div>
          <div class="config-item">
            <label>Max Conversation Turns</label>
            <input v-model="orchestrationConfig.maxTurns" type="number" />
          </div>
          <div class="config-item">
            <label>Retry Limit</label>
            <input v-model="orchestrationConfig.retryLimit" type="number" />
          </div>
          <div class="config-item">
            <label>Worker Concurrency</label>
            <input v-model="orchestrationConfig.workerConcurrency" type="number" />
          </div>
        </div>
      </div>

      <div class="config-section">
        <h3>AI Model Configuration</h3>
        <div class="config-grid">
          <div class="config-item">
            <label>LLM Model</label>
            <input v-model="orchestrationConfig.llmModel" type="text" />
          </div>
          <div class="config-item">
            <label>Max Tokens</label>
            <input v-model="orchestrationConfig.maxTokens" type="number" />
          </div>
          <div class="config-item">
            <label>Temperature</label>
            <input v-model="orchestrationConfig.temperature" type="number" step="0.1" />
          </div>
          <div class="config-item">
            <label>Context Window</label>
            <input v-model="orchestrationConfig.contextWindow" type="number" />
          </div>
        </div>
      </div>

      <div class="config-section">
        <h3>Event Bus Configuration</h3>
        <div class="config-grid">
          <div class="config-item">
            <label>Redis Channel</label>
            <input v-model="orchestrationConfig.redisChannel" type="text" />
          </div>
          <div class="config-item">
            <label>Event Retention (hours)</label>
            <input v-model="orchestrationConfig.eventRetention" type="number" />
          </div>
        </div>
      </div>

      <button @click="saveOrchestrationConfig" class="btn-primary">Save Configuration</button>
    </div>

    <!-- System Analytics Tab -->
    <div v-if="activeTab === 'analytics'" class="tab-content">
      <h2>System-Wide Analytics</h2>
      <div v-if="analytics" class="analytics-content">
        <div class="stats-grid">
          <div class="stat-card">
            <div class="stat-icon">🏥</div>
            <div class="stat-value">{{ analytics.totalStats?.total_organizations || 0 }}</div>
            <div class="stat-label">Total Hospitals</div>
          </div>
          <div class="stat-card">
            <div class="stat-icon">👥</div>
            <div class="stat-value">{{ analytics.totalStats?.total_users || 0 }}</div>
            <div class="stat-label">Total Users</div>
          </div>
          <div class="stat-card">
            <div class="stat-icon">📋</div>
            <div class="stat-value">{{ analytics.totalStats?.total_campaigns || 0 }}</div>
            <div class="stat-label">Total Campaigns</div>
          </div>
          <div class="stat-card">
            <div class="stat-icon">📞</div>
            <div class="stat-value">{{ analytics.totalStats?.total_calls || 0 }}</div>
            <div class="stat-label">Total Calls</div>
          </div>
        </div>

        <div class="org-activity">
          <h3>Hospital Activity Today</h3>
          <table>
            <thead>
              <tr>
                <th>Hospital</th>
                <th>Calls Today</th>
                <th>Completed</th>
                <th>Needs Follow-up</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="org in analytics.organizationActivity" :key="org.organization_name">
                <td>{{ org.organization_name }}</td>
                <td>{{ org.calls_today }}</td>
                <td>{{ org.completed_today }}</td>
                <td>{{ org.followup_today }}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </div>

    <!-- Create Hospital Modal -->
    <div v-if="showCreateHospital" class="modal-overlay" @click="showCreateHospital = false">
      <div class="modal" @click.stop>
        <h2>Add New Hospital</h2>
        <form @submit.prevent="createHospital">
          <div class="form-group">
            <label>Hospital Name</label>
            <input v-model="newHospital.name" type="text" required />
          </div>
          <div class="modal-actions">
            <button type="button" @click="showCreateHospital = false" class="btn-secondary">Cancel</button>
            <button type="submit" class="btn-primary">Create</button>
          </div>
        </form>
      </div>
    </div>

    <!-- Edit Hospital Modal -->
    <div v-if="showEditHospital" class="modal-overlay" @click="showEditHospital = false">
      <div class="modal" @click.stop>
        <h2>Update Hospital</h2>
        <form @submit.prevent="updateHospital">
          <div class="form-group">
            <label>Hospital Name</label>
            <input v-model="editHospital.name" type="text" required />
          </div>
          <div class="modal-actions">
            <button type="button" @click="showEditHospital = false" class="btn-secondary">Cancel</button>
            <button type="submit" class="btn-primary">Update</button>
          </div>
        </form>
      </div>
    </div>

    <!-- Hospital Details Modal -->
    <div v-if="hospitalDetails" class="modal-overlay" @click="hospitalDetails = null">
      <div class="modal details-modal" @click.stop>
        <h2>{{ hospitalDetails.organization.name }}</h2>

        <div class="details-grid">
          <div class="detail-item">
            <span class="label">Users</span>
            <span class="value">{{ hospitalDetails.organization.user_count }}</span>
          </div>
          <div class="detail-item">
            <span class="label">Patients</span>
            <span class="value">{{ hospitalDetails.stats.total_patients }}</span>
          </div>
          <div class="detail-item">
            <span class="label">Campaigns</span>
            <span class="value">{{ hospitalDetails.stats.total_campaigns }}</span>
          </div>
          <div class="detail-item">
            <span class="label">Calls</span>
            <span class="value">{{ hospitalDetails.stats.total_calls }}</span>
          </div>
          <div class="detail-item">
            <span class="label">Running Calls</span>
            <span class="value">{{ hospitalDetails.stats.running_calls }}</span>
          </div>
          <div class="detail-item">
            <span class="label">Events</span>
            <span class="value">{{ hospitalDetails.stats.total_events }}</span>
          </div>
        </div>

        <div class="details-section">
          <h3>Patient Status</h3>
          <div v-if="hospitalDetails.patientStatuses.length === 0" class="empty-text">No patients yet</div>
          <div v-else class="chip-list">
            <span v-for="item in hospitalDetails.patientStatuses" :key="item.status" class="chip">
              {{ item.status }}: {{ item.count }}
            </span>
          </div>
        </div>

        <div class="details-section">
          <h3>Call States</h3>
          <div v-if="hospitalDetails.callStates.length === 0" class="empty-text">No calls yet</div>
          <div v-else class="chip-list">
            <span v-for="item in hospitalDetails.callStates" :key="item.state" class="chip">
              {{ item.state }}: {{ item.count }}
            </span>
          </div>
        </div>

        <div class="details-section">
          <h3>Recent Campaigns</h3>
          <div v-if="hospitalDetails.recentCampaigns.length === 0" class="empty-text">No campaigns yet</div>
          <ul v-else class="details-list">
            <li v-for="campaign in hospitalDetails.recentCampaigns" :key="campaign.id">
              {{ campaign.name }} ({{ campaign.status }})
            </li>
          </ul>
        </div>

        <div class="details-section">
          <h3>Recent Patients</h3>
          <div v-if="hospitalDetails.recentPatients.length === 0" class="empty-text">No patients yet</div>
          <ul v-else class="details-list">
            <li v-for="patient in hospitalDetails.recentPatients" :key="patient.id">
              {{ patient.name }} ({{ patient.status }})
            </li>
          </ul>
        </div>

        <div class="details-section">
          <h3>Recent Calls</h3>
          <div v-if="hospitalDetails.recentCalls.length === 0" class="empty-text">No calls yet</div>
          <ul v-else class="details-list">
            <li v-for="call in hospitalDetails.recentCalls" :key="call.id">
              #{{ call.id }} - {{ call.state }} - {{ call.patient_name || 'Unknown patient' }}
            </li>
          </ul>
        </div>

        <div class="modal-actions">
          <button type="button" @click="hospitalDetails = null" class="btn-secondary">Close</button>
        </div>
      </div>
    </div>
  </div>
</template>

<script>
import api from '../api.js';

export default {
  name: 'ProductAdmin',
  data() {
    return {
      activeTab: 'hospitals',
      loading: false,
      organizations: [],
      analytics: null,
      realtimeStats: {},
      recentEvents: [],
      showCreateHospital: false,
      newHospital: { name: '' },
      showEditHospital: false,
      editHospital: { id: null, name: '' },
      hospitalDetails: null,
      orchestrationConfig: {
        maxCallDuration: 300,
        maxTurns: 5,
        retryLimit: 3,
        workerConcurrency: 1,
        llmModel: '',
        maxTokens: 150,
        temperature: 0.7,
        contextWindow: 512,
        redisChannel: 'healthcare:events',
        eventRetention: 24
      }
    };
  },
  async mounted() {
    await this.loadOrganizations();
    await this.loadAnalytics();
    this.startRealtimePolling();
  },
  beforeUnmount() {
    if (this.pollingInterval) {
      clearInterval(this.pollingInterval);
    }
  },
  methods: {
    async loadOrganizations() {
      this.loading = true;
      try {
        const response = await api.get('/product-admin/organizations');
        this.organizations = response.data.organizations;
      } catch (error) {
        console.error('Failed to load organizations:', error);
      } finally {
        this.loading = false;
      }
    },
    async loadAnalytics() {
      try {
        const response = await api.get('/product-admin/analytics');
        this.analytics = response.data;
      } catch (error) {
        console.error('Failed to load analytics:', error);
      }
    },
    startRealtimePolling() {
      this.loadRealtimeStats();
      this.pollingInterval = setInterval(() => {
        this.loadRealtimeStats();
      }, 5000);
    },
    async loadRealtimeStats() {
      try {
        const response = await api.get('/admin/realtime-stats');
        this.realtimeStats = response.data.stats;
        this.recentEvents = response.data.recentEvents || [];
      } catch (error) {
        console.error('Failed to load realtime stats:', error);
      }
    },
    async createHospital() {
      try {
        await api.post('/product-admin/organizations', this.newHospital);
        this.showCreateHospital = false;
        this.newHospital = { name: '' };
        await this.loadOrganizations();
        await this.loadAnalytics();
        alert('Hospital created successfully!');
      } catch (error) {
        alert('Failed to create hospital: ' + (error.response?.data?.error || error.message));
      }
    },
    openEditHospital(org) {
      this.editHospital = {
        id: org.id,
        name: org.name
      };
      this.showEditHospital = true;
    },
    async updateHospital() {
      try {
        await api.put(`/product-admin/organizations/${this.editHospital.id}`, {
          name: this.editHospital.name
        });
        this.showEditHospital = false;
        this.editHospital = { id: null, name: '' };
        await this.loadOrganizations();
        await this.loadAnalytics();
        alert('Hospital updated successfully!');
      } catch (error) {
        alert('Failed to update hospital: ' + (error.response?.data?.error || error.message));
      }
    },
    async confirmDeleteHospital(org) {
      const confirmed = window.confirm(
        `Delete "${org.name}" and all hospital data (users, patients, campaigns, calls, events)? This cannot be undone.`
      );
      if (!confirmed) return;

      try {
        await api.delete(`/product-admin/organizations/${org.id}`);
        if (this.hospitalDetails?.organization?.id === org.id) {
          this.hospitalDetails = null;
        }
        await this.loadOrganizations();
        await this.loadAnalytics();
        alert('Hospital deleted successfully.');
      } catch (error) {
        alert('Failed to delete hospital: ' + (error.response?.data?.error || error.message));
      }
    },
    async viewHospital(orgId) {
      try {
        const response = await api.get(`/product-admin/organizations/${orgId}`);
        const org = response.data.organization || {};
        const stats = response.data.stats || {};
        this.hospitalDetails = {
          organization: {
            ...org,
            user_count: Number(org.user_count || 0)
          },
          stats: {
            total_campaigns: Number(stats.total_campaigns || 0),
            total_patients: Number(stats.total_patients || 0),
            total_calls: Number(stats.total_calls || 0),
            completed_calls: Number(stats.completed_calls || 0),
            followup_calls: Number(stats.followup_calls || 0),
            running_calls: Number(stats.running_calls || 0),
            total_events: Number(stats.total_events || 0)
          },
          recentCampaigns: response.data.recentCampaigns || response.data.campaigns || [],
          recentPatients: response.data.recentPatients || [],
          recentCalls: response.data.recentCalls || [],
          patientStatuses: response.data.patientStatuses || [],
          callStates: response.data.callStates || [],
          recentEvents: response.data.recentEvents || []
        };
      } catch (error) {
        alert('Failed to load hospital details');
      }
    },
    saveOrchestrationConfig() {
      alert('Configuration saved! (This would update environment variables in production)');
    },
    formatDate(dateString) {
      return new Date(dateString).toLocaleDateString();
    },
    formatTime(dateString) {
      return new Date(dateString).toLocaleTimeString();
    }
  }
};
</script>

<style scoped>
.product-admin {
  max-width: 1400px;
  margin: 0 auto;
}

.page-header {
  margin-bottom: 1.5rem;
}

.page-header h1 {
  font-size: 1.75rem;
  color: #1f2937;
  margin-bottom: 0.25rem;
}

.subtitle {
  color: #6b7280;
  font-size: 0.95rem;
}

.tabs {
  display: flex;
  gap: 0.5rem;
  margin-bottom: 1.5rem;
  border-bottom: 2px solid #e5e7eb;
}

.tab {
  padding: 0.75rem 1.5rem;
  background: none;
  border: none;
  border-bottom: 3px solid transparent;
  cursor: pointer;
  font-size: 0.95rem;
  font-weight: 500;
  color: #6b7280;
  transition: all 0.2s;
}

.tab:hover {
  color: #667eea;
}

.tab.active {
  color: #667eea;
  border-bottom-color: #667eea;
}

.tab-content {
  background: white;
  padding: 1.5rem;
  border-radius: 12px;
  box-shadow: 0 1px 3px rgba(0,0,0,0.1);
}

.section-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 1.5rem;
}

.section-header h2 {
  font-size: 1.25rem;
  color: #1f2937;
}

.hospitals-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
  gap: 1rem;
}

.hospital-card {
  border: 1px solid #e5e7eb;
  border-radius: 8px;
  padding: 1.25rem;
  transition: all 0.2s;
}

.hospital-card:hover {
  border-color: #667eea;
  box-shadow: 0 4px 12px rgba(102, 126, 234, 0.1);
}

.hospital-header {
  display: flex;
  justify-content: space-between;
  align-items: start;
  margin-bottom: 1rem;
}

.hospital-header h3 {
  font-size: 1.1rem;
  color: #1f2937;
  margin: 0;
}

.badge {
  padding: 0.25rem 0.75rem;
  background: #f3f4f6;
  border-radius: 12px;
  font-size: 0.8rem;
  color: #6b7280;
}

.hospital-stats {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
  margin-bottom: 1rem;
}

.stat {
  display: flex;
  justify-content: space-between;
  font-size: 0.9rem;
}

.stat .label {
  color: #6b7280;
}

.stat .value {
  font-weight: 600;
  color: #1f2937;
}

.hospital-actions {
  display: flex;
  gap: 0.5rem;
}

.activity-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
  gap: 1rem;
  margin-bottom: 2rem;
}

.activity-card {
  padding: 1.5rem;
  background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
  color: white;
  border-radius: 8px;
  text-align: center;
}

.activity-card h3 {
  font-size: 0.9rem;
  margin-bottom: 0.5rem;
  opacity: 0.9;
}

.activity-value {
  font-size: 2.5rem;
  font-weight: 700;
  margin-bottom: 0.25rem;
}

.activity-label {
  font-size: 0.85rem;
  opacity: 0.8;
}

.recent-events {
  margin-top: 2rem;
}

.recent-events h3 {
  margin-bottom: 1rem;
  color: #1f2937;
}

.events-list {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
  max-height: 400px;
  overflow-y: auto;
}

.event-item {
  display: flex;
  gap: 1rem;
  padding: 0.75rem;
  background: #f9fafb;
  border-radius: 6px;
  font-size: 0.9rem;
}

.event-time {
  color: #6b7280;
  min-width: 80px;
}

.event-type {
  padding: 0.25rem 0.75rem;
  border-radius: 12px;
  font-size: 0.75rem;
  font-weight: 600;
  background: #e0e7ff;
  color: #4338ca;
}

.event-details {
  color: #374151;
}

.config-section {
  margin-bottom: 2rem;
}

.config-section h3 {
  margin-bottom: 1rem;
  color: #1f2937;
}

.config-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(250px, 1fr));
  gap: 1rem;
}

.config-item label {
  display: block;
  margin-bottom: 0.5rem;
  color: #374151;
  font-size: 0.9rem;
  font-weight: 500;
}

.config-item input {
  width: 100%;
  padding: 0.5rem;
  border: 1px solid #d1d5db;
  border-radius: 6px;
  font-size: 0.9rem;
}

.stats-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
  gap: 1rem;
  margin-bottom: 2rem;
}

.stat-card {
  padding: 1.5rem;
  background: white;
  border: 1px solid #e5e7eb;
  border-radius: 8px;
  text-align: center;
}

.stat-icon {
  font-size: 2rem;
  margin-bottom: 0.5rem;
}

.stat-value {
  font-size: 2rem;
  font-weight: 700;
  color: #1f2937;
  margin-bottom: 0.25rem;
}

.stat-label {
  color: #6b7280;
  font-size: 0.9rem;
}

.org-activity {
  margin-top: 2rem;
}

.org-activity h3 {
  margin-bottom: 1rem;
  color: #1f2937;
}

table {
  width: 100%;
  border-collapse: collapse;
}

th, td {
  padding: 0.75rem;
  text-align: left;
  border-bottom: 1px solid #e5e7eb;
}

th {
  background: #f9fafb;
  font-weight: 600;
  color: #374151;
}

.btn-primary, .btn-secondary {
  padding: 0.5rem 1rem;
  border: none;
  border-radius: 6px;
  cursor: pointer;
  font-size: 0.9rem;
  font-weight: 500;
  transition: all 0.2s;
}

.btn-primary {
  background: #667eea;
  color: white;
}

.btn-primary:hover {
  background: #5568d3;
}

.btn-secondary {
  background: #f3f4f6;
  color: #374151;
}

.btn-secondary:hover {
  background: #e5e7eb;
}

.btn-danger {
  background: #ef4444;
  color: white;
  border: none;
  border-radius: 6px;
  padding: 0.5rem 1rem;
  cursor: pointer;
  font-size: 0.9rem;
  font-weight: 500;
}

.btn-danger:hover {
  background: #dc2626;
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
}

.details-modal {
  max-width: 760px;
  max-height: 90vh;
  overflow-y: auto;
}

.details-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
  gap: 0.75rem;
  margin-bottom: 1rem;
}

.detail-item {
  background: #f9fafb;
  border: 1px solid #e5e7eb;
  border-radius: 8px;
  padding: 0.75rem;
  display: flex;
  flex-direction: column;
  gap: 0.2rem;
}

.detail-item .label {
  color: #6b7280;
  font-size: 0.8rem;
}

.detail-item .value {
  color: #111827;
  font-weight: 700;
}

.details-section {
  margin-top: 1rem;
}

.details-section h3 {
  font-size: 1rem;
  margin-bottom: 0.5rem;
  color: #1f2937;
}

.chip-list {
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem;
}

.chip {
  background: #eef2ff;
  color: #3730a3;
  border: 1px solid #c7d2fe;
  border-radius: 999px;
  padding: 0.3rem 0.7rem;
  font-size: 0.8rem;
  font-weight: 600;
}

.details-list {
  list-style: disc;
  margin-left: 1.25rem;
  color: #374151;
}

.details-list li {
  margin-bottom: 0.3rem;
}

.empty-text {
  color: #6b7280;
  font-size: 0.9rem;
}

.modal h2 {
  margin-bottom: 1.5rem;
  color: #1f2937;
}

.form-group {
  margin-bottom: 1rem;
}

.form-group label {
  display: block;
  margin-bottom: 0.5rem;
  color: #374151;
  font-weight: 500;
}

.form-group input {
  width: 100%;
  padding: 0.75rem;
  border: 1px solid #d1d5db;
  border-radius: 6px;
}

.modal-actions {
  display: flex;
  gap: 1rem;
  justify-content: flex-end;
  margin-top: 1.5rem;
}

.loading {
  text-align: center;
  padding: 2rem;
  color: #6b7280;
}
</style>
