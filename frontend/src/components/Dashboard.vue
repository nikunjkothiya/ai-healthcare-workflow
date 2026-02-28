<template>
  <div class="dashboard">
    <div class="page-header">
      <h1>📊 Dashboard</h1>
      <p class="subtitle">Overview of your healthcare outreach campaigns</p>
    </div>
    
    <div class="stats-grid">
      <div class="stat-card">
        <div class="stat-icon campaigns">📋</div>
        <div class="stat-content">
          <div class="stat-value">{{ stats.totalCampaigns }}</div>
          <div class="stat-label">Total Campaigns</div>
        </div>
      </div>
      
      <div class="stat-card">
        <div class="stat-icon calls">📞</div>
        <div class="stat-content">
          <div class="stat-value">{{ stats.totalCalls }}</div>
          <div class="stat-label">Total Calls</div>
        </div>
      </div>
      
      <div class="stat-card">
        <div class="stat-icon confirmed">✅</div>
        <div class="stat-content">
          <div class="stat-value">{{ stats.confirmedAppointments }}</div>
          <div class="stat-label">Confirmed Appointments</div>
        </div>
      </div>
      
      <div class="stat-card">
        <div class="stat-icon positive">😊</div>
        <div class="stat-content">
          <div class="stat-value">{{ stats.sentimentBreakdown.positive }}</div>
          <div class="stat-label">Positive Sentiment</div>
        </div>
      </div>
    </div>
    
    <div class="content-grid">
      <div class="chart-card">
        <h3>Sentiment Distribution</h3>
        <canvas ref="sentimentChart"></canvas>
      </div>
      
      <div class="recent-calls-card">
        <h3>Recent Calls</h3>
        <div v-if="loading" class="loading">
          <div class="spinner"></div>
          <p>Loading...</p>
        </div>
        <div v-else-if="stats.recentCalls.length === 0" class="no-data">
          <div class="empty-icon">📭</div>
          <p>No calls yet</p>
          <small>Start a campaign to see results here</small>
        </div>
        <div v-else class="calls-list">
          <div v-for="call in stats.recentCalls.slice(0, 5)" :key="call.id" class="call-item">
            <div class="call-info">
              <div class="call-patient">{{ call.patient_name }}</div>
              <div class="call-meta">
                <span class="call-campaign">{{ call.campaign_name }}</span>
                <span class="call-date">{{ formatDate(call.created_at) }}</span>
              </div>
            </div>
            <div class="call-status">
              <span :class="'sentiment-badge ' + call.sentiment">
                {{ call.sentiment }}
              </span>
              <span class="confirmed-badge" :class="{ confirmed: call.appointment_confirmed }">
                {{ call.appointment_confirmed ? '✓ Confirmed' : '○ Pending' }}
              </span>
            </div>
            <button @click="viewCall(call.id)" class="btn-view">View</button>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script>
import api from '../api.js';
import { Chart, registerables } from 'chart.js';

Chart.register(...registerables);

export default {
  name: 'Dashboard',
  data() {
    return {
      stats: {
        totalCampaigns: 0,
        totalCalls: 0,
        confirmedAppointments: 0,
        sentimentBreakdown: {
          positive: 0,
          neutral: 0,
          negative: 0
        },
        recentCalls: []
      },
      loading: true,
      chart: null
    };
  },
  async mounted() {
    await this.loadStats();
    this.renderChart();
  },
  methods: {
    async loadStats() {
      try {
        const response = await api.get('/stats');
        this.stats = response.data;
      } catch (error) {
        console.error('Failed to load stats:', error);
      } finally {
        this.loading = false;
      }
    },
    renderChart() {
      const ctx = this.$refs.sentimentChart;
      
      if (this.chart) {
        this.chart.destroy();
      }
      
      this.chart = new Chart(ctx, {
        type: 'doughnut',
        data: {
          labels: ['Positive', 'Neutral', 'Negative'],
          datasets: [{
            data: [
              this.stats.sentimentBreakdown.positive,
              this.stats.sentimentBreakdown.neutral,
              this.stats.sentimentBreakdown.negative
            ],
            backgroundColor: ['#10b981', '#f59e0b', '#ef4444'],
            borderWidth: 0
          }]
        },
        options: {
          responsive: true,
          maintainAspectRatio: true,
          plugins: {
            legend: {
              position: 'bottom',
              labels: {
                padding: 15,
                font: {
                  size: 12
                }
              }
            }
          }
        }
      });
    },
    formatDate(dateString) {
      const date = new Date(dateString);
      const now = new Date();
      const diff = now - date;
      const minutes = Math.floor(diff / 60000);
      const hours = Math.floor(minutes / 60);
      const days = Math.floor(hours / 24);
      
      if (minutes < 60) return `${minutes}m ago`;
      if (hours < 24) return `${hours}h ago`;
      if (days < 7) return `${days}d ago`;
      return date.toLocaleDateString();
    },
    viewCall(callId) {
      this.$router.push(`/calls/${callId}`);
    }
  },
  watch: {
    'stats.sentimentBreakdown': {
      handler() {
        this.$nextTick(() => {
          this.renderChart();
        });
      },
      deep: true
    }
  }
};
</script>

<style scoped>
.dashboard {
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
  font-weight: 700;
}

.subtitle {
  color: #6b7280;
  font-size: 0.95rem;
}

.stats-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
  gap: 1rem;
  margin-bottom: 1.5rem;
}

.stat-card {
  background: white;
  padding: 1.25rem;
  border-radius: 12px;
  box-shadow: 0 1px 3px rgba(0,0,0,0.1);
  display: flex;
  align-items: center;
  gap: 1rem;
  transition: transform 0.2s, box-shadow 0.2s;
}

.stat-card:hover {
  transform: translateY(-2px);
  box-shadow: 0 4px 12px rgba(0,0,0,0.15);
}

.stat-icon {
  font-size: 2.5rem;
  width: 60px;
  height: 60px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 12px;
  flex-shrink: 0;
}

.stat-icon.campaigns { background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); }
.stat-icon.calls { background: linear-gradient(135deg, #f093fb 0%, #f5576c 100%); }
.stat-icon.confirmed { background: linear-gradient(135deg, #4facfe 0%, #00f2fe 100%); }
.stat-icon.positive { background: linear-gradient(135deg, #43e97b 0%, #38f9d7 100%); }

.stat-content {
  flex: 1;
}

.stat-value {
  font-size: 1.75rem;
  font-weight: 700;
  color: #1f2937;
  line-height: 1;
  margin-bottom: 0.25rem;
}

.stat-label {
  color: #6b7280;
  font-size: 0.85rem;
  font-weight: 500;
}

.content-grid {
  display: grid;
  grid-template-columns: 1fr 2fr;
  gap: 1.5rem;
}

.chart-card, .recent-calls-card {
  background: white;
  padding: 1.5rem;
  border-radius: 12px;
  box-shadow: 0 1px 3px rgba(0,0,0,0.1);
}

.chart-card h3, .recent-calls-card h3 {
  font-size: 1.1rem;
  color: #1f2937;
  margin-bottom: 1rem;
  font-weight: 600;
}

.chart-card canvas {
  max-height: 250px;
}

.loading {
  text-align: center;
  padding: 2rem;
  color: #6b7280;
}

.spinner {
  width: 40px;
  height: 40px;
  border: 3px solid #e5e7eb;
  border-top-color: #667eea;
  border-radius: 50%;
  animation: spin 1s linear infinite;
  margin: 0 auto 1rem;
}

@keyframes spin {
  to { transform: rotate(360deg); }
}

.no-data {
  text-align: center;
  padding: 2rem;
  color: #6b7280;
}

.empty-icon {
  font-size: 3rem;
  margin-bottom: 0.5rem;
}

.no-data p {
  font-weight: 500;
  margin-bottom: 0.25rem;
}

.no-data small {
  font-size: 0.85rem;
  color: #9ca3af;
}

.calls-list {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
}

.call-item {
  display: flex;
  align-items: center;
  gap: 1rem;
  padding: 0.75rem;
  border: 1px solid #e5e7eb;
  border-radius: 8px;
  transition: all 0.2s;
}

.call-item:hover {
  border-color: #667eea;
  background: #f9fafb;
}

.call-info {
  flex: 1;
  min-width: 0;
}

.call-patient {
  font-weight: 600;
  color: #1f2937;
  font-size: 0.95rem;
  margin-bottom: 0.25rem;
}

.call-meta {
  display: flex;
  gap: 0.75rem;
  font-size: 0.8rem;
  color: #6b7280;
}

.call-status {
  display: flex;
  gap: 0.5rem;
  align-items: center;
}

.sentiment-badge {
  padding: 0.25rem 0.75rem;
  border-radius: 12px;
  font-size: 0.75rem;
  font-weight: 600;
  text-transform: capitalize;
}

.sentiment-badge.positive {
  background: #d1fae5;
  color: #065f46;
}

.sentiment-badge.neutral {
  background: #fef3c7;
  color: #92400e;
}

.sentiment-badge.negative {
  background: #fee2e2;
  color: #991b1b;
}

.confirmed-badge {
  padding: 0.25rem 0.75rem;
  border-radius: 12px;
  font-size: 0.75rem;
  font-weight: 600;
  background: #f3f4f6;
  color: #6b7280;
}

.confirmed-badge.confirmed {
  background: #d1fae5;
  color: #065f46;
}

.btn-view {
  padding: 0.5rem 1rem;
  background: #667eea;
  color: white;
  border: none;
  border-radius: 6px;
  cursor: pointer;
  font-size: 0.85rem;
  font-weight: 500;
  transition: all 0.2s;
}

.btn-view:hover {
  background: #5568d3;
  transform: translateY(-1px);
}

@media (max-width: 1024px) {
  .content-grid {
    grid-template-columns: 1fr;
  }
}

@media (max-width: 640px) {
  .stats-grid {
    grid-template-columns: 1fr;
  }
  
  .call-item {
    flex-direction: column;
    align-items: flex-start;
  }
  
  .call-status {
    width: 100%;
    justify-content: space-between;
  }
}
</style>
