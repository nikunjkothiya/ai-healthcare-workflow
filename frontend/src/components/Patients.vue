<template>
  <div class="patients">
    <div class="page-header">
      <h1>👥 Patient Management</h1>
      <p class="subtitle">Manage your patient database and categories</p>
    </div>

    <div class="actions-bar">
      <div class="search-box">
        <input 
          v-model="searchQuery" 
          type="text" 
          placeholder="Search patients by name, phone, or condition..."
          class="search-input"
        />
      </div>
      <div class="action-buttons">
        <button @click="showUploadModal = true" class="btn-secondary">
          📤 Import CSV
        </button>
        <button @click="showAddModal = true" class="btn-primary">
          + Add Patient
        </button>
      </div>
    </div>

    <div class="filters">
      <button 
        :class="['filter-btn', { active: selectedCategory === 'all' }]"
        @click="selectedCategory = 'all'"
      >
        All ({{ patients.length }})
      </button>
      <button 
        v-for="cat in categories" 
        :key="cat.value"
        :class="['filter-btn', { active: selectedCategory === cat.value }]"
        @click="selectedCategory = cat.value"
      >
        {{ cat.icon }} {{ cat.label }} ({{ getCategoryCount(cat.value) }})
      </button>
    </div>

    <div v-if="loading" class="loading">Loading patients...</div>

    <div v-else-if="filteredPatients.length === 0" class="no-data">
      <div class="empty-icon">👥</div>
      <p>No patients found</p>
      <small>Add patients to start managing your database</small>
    </div>

    <div v-else class="patients-table">
      <table>
        <thead>
          <tr>
            <th>Name</th>
            <th>Phone</th>
            <th>Category</th>
            <th>Condition</th>
            <th>Age</th>
            <th>Last Contact</th>
            <th>Status</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="patient in paginatedPatients" :key="patient.id">
            <td>
              <div class="patient-name">
                <span class="avatar">{{ getInitials(patient.name) }}</span>
                {{ patient.name }}
              </div>
            </td>
            <td>{{ patient.phone }}</td>
            <td>
              <span :class="'category-badge ' + patient.category">
                {{ getCategoryLabel(patient.category) }}
              </span>
            </td>
            <td>{{ patient.metadata?.medical_condition || '-' }}</td>
            <td>{{ patient.metadata?.age || '-' }}</td>
            <td>{{ patient.last_contact ? formatDate(patient.last_contact) : 'Never' }}</td>
            <td>
              <span :class="'status-badge ' + patient.status">
                {{ patient.status }}
              </span>
            </td>
            <td>
              <div class="action-btns">
                <button @click="editPatient(patient)" class="btn-icon" title="Edit">
                  ✏️
                </button>
                <button @click="deletePatient(patient.id)" class="btn-icon" title="Delete">
                  🗑️
                </button>
              </div>
            </td>
          </tr>
        </tbody>
      </table>

      <div class="pagination">
        <button 
          @click="currentPage--" 
          :disabled="currentPage === 1"
          class="btn-page"
        >
          Previous
        </button>
        <span class="page-info">
          Page {{ currentPage }} of {{ totalPages }}
        </span>
        <button 
          @click="currentPage++" 
          :disabled="currentPage === totalPages"
          class="btn-page"
        >
          Next
        </button>
      </div>
    </div>

    <!-- Add/Edit Patient Modal -->
    <div v-if="showAddModal || showEditModal" class="modal-overlay" @click="closeModals">
      <div class="modal large" @click.stop>
        <h2>{{ showEditModal ? 'Edit Patient' : 'Add New Patient' }}</h2>
        <form @submit.prevent="savePatient">
          <div class="form-row">
            <div class="form-group">
              <label>Full Name *</label>
              <input v-model="patientForm.name" type="text" required />
            </div>
            <div class="form-group">
              <label>Phone Number *</label>
              <input v-model="patientForm.phone" type="tel" required />
            </div>
          </div>

          <div class="form-row">
            <div class="form-group">
              <label>Category *</label>
              <select v-model="patientForm.category" required>
                <option value="">Select category</option>
                <option v-for="cat in categories" :key="cat.value" :value="cat.value">
                  {{ cat.label }}
                </option>
              </select>
            </div>
            <div class="form-group">
              <label>Age</label>
              <input v-model="patientForm.age" type="number" min="0" max="120" />
            </div>
          </div>

          <div class="form-group">
            <label>Medical Condition</label>
            <input v-model="patientForm.medical_condition" type="text" />
          </div>

          <div class="form-row">
            <div class="form-group">
              <label>Appointment Type</label>
              <input v-model="patientForm.appointment_type" type="text" />
            </div>
            <div class="form-group">
              <label>Appointment Date</label>
              <input v-model="patientForm.appointment_date" type="datetime-local" />
            </div>
          </div>

          <div class="form-group">
            <label>Doctor</label>
            <input v-model="patientForm.doctor" type="text" />
          </div>

          <div class="form-row">
            <div class="form-group">
              <label>Language</label>
              <select v-model="patientForm.language">
                <option value="English">English</option>
                <option value="Spanish">Spanish</option>
                <option value="Chinese">Chinese</option>
                <option value="Other">Other</option>
              </select>
            </div>
            <div class="form-group">
              <label>Insurance Status</label>
              <select v-model="patientForm.insurance_status">
                <option value="Private Insurance">Private Insurance</option>
                <option value="Medicare">Medicare</option>
                <option value="Medicaid">Medicaid</option>
                <option value="Uninsured">Uninsured</option>
              </select>
            </div>
          </div>

          <div class="form-group">
            <label>Known Barriers</label>
            <div class="checkbox-group">
              <label class="checkbox-label">
                <input type="checkbox" v-model="patientForm.transportation_issue" />
                Transportation Issues
              </label>
              <label class="checkbox-label">
                <input type="checkbox" v-model="patientForm.financial_concern" />
                Financial Concerns
              </label>
              <label class="checkbox-label">
                <input type="checkbox" v-model="patientForm.previous_no_show" />
                Previous No-Show
              </label>
            </div>
          </div>

          <div class="modal-actions">
            <button type="button" @click="closeModals" class="btn-secondary">
              Cancel
            </button>
            <button type="submit" class="btn-primary">
              {{ showEditModal ? 'Update' : 'Add' }} Patient
            </button>
          </div>
        </form>
      </div>
    </div>

    <!-- Upload CSV Modal -->
    <div v-if="showUploadModal" class="modal-overlay" @click="showUploadModal = false">
      <div class="modal" @click.stop>
        <h2>Import Patients from CSV</h2>
        <p class="help-text">
          CSV should have columns: name, phone, category, medical_condition, age, appointment_type, 
          appointment_date, doctor, language, insurance_status, transportation_issue, financial_concern, previous_no_show
        </p>
        <form @submit.prevent="uploadCSV">
          <div class="form-group">
            <input type="file" @change="handleFileSelect" accept=".csv" required />
          </div>
          <div class="modal-actions">
            <button type="button" @click="showUploadModal = false" class="btn-secondary">
              Cancel
            </button>
            <button type="submit" class="btn-primary" :disabled="!selectedFile">
              Import
            </button>
          </div>
        </form>
      </div>
    </div>
  </div>
</template>

<script>
import api from '../api.js';

export default {
  name: 'Patients',
  data() {
    return {
      patients: [],
      loading: true,
      searchQuery: '',
      selectedCategory: 'all',
      currentPage: 1,
      itemsPerPage: 10,
      showAddModal: false,
      showEditModal: false,
      showUploadModal: false,
      selectedFile: null,
      editingPatientId: null,
      patientForm: this.getEmptyForm(),
      categories: [
        { value: 'diabetes', label: 'Diabetes', icon: '🩺' },
        { value: 'heart_disease', label: 'Heart Disease', icon: '❤️' },
        { value: 'asthma', label: 'Asthma', icon: '🫁' },
        { value: 'hypertension', label: 'Hypertension', icon: '💊' },
        { value: 'other', label: 'Other', icon: '📋' }
      ]
    };
  },
  computed: {
    filteredPatients() {
      let filtered = this.patients;

      // Filter by category
      if (this.selectedCategory !== 'all') {
        filtered = filtered.filter(p => p.category === this.selectedCategory);
      }

      // Filter by search query
      if (this.searchQuery) {
        const query = this.searchQuery.toLowerCase();
        filtered = filtered.filter(p => 
          p.name.toLowerCase().includes(query) ||
          p.phone.includes(query) ||
          (p.metadata?.medical_condition || '').toLowerCase().includes(query)
        );
      }

      return filtered;
    },
    paginatedPatients() {
      const start = (this.currentPage - 1) * this.itemsPerPage;
      const end = start + this.itemsPerPage;
      return this.filteredPatients.slice(start, end);
    },
    totalPages() {
      return Math.ceil(this.filteredPatients.length / this.itemsPerPage);
    }
  },
  async mounted() {
    await this.loadPatients();
  },
  methods: {
    async loadPatients() {
      this.loading = true;
      try {
        const response = await api.get('/patients');
        this.patients = response.data.patients;
      } catch (error) {
        console.error('Failed to load patients:', error);
        alert('Failed to load patients');
      } finally {
        this.loading = false;
      }
    },
    getEmptyForm() {
      return {
        name: '',
        phone: '',
        category: '',
        age: '',
        medical_condition: '',
        appointment_type: '',
        appointment_date: '',
        doctor: '',
        language: 'English',
        insurance_status: 'Private Insurance',
        transportation_issue: false,
        financial_concern: false,
        previous_no_show: false
      };
    },
    async savePatient() {
      try {
        const metadata = {
          age: this.patientForm.age,
          medical_condition: this.patientForm.medical_condition,
          appointment_type: this.patientForm.appointment_type,
          appointment_date: this.patientForm.appointment_date,
          doctor: this.patientForm.doctor,
          language: this.patientForm.language,
          insurance_status: this.patientForm.insurance_status,
          transportation_issue: this.patientForm.transportation_issue ? 'Yes' : 'No',
          financial_concern: this.patientForm.financial_concern ? 'Yes' : 'No',
          previous_no_show: this.patientForm.previous_no_show ? 'Yes' : 'No'
        };

        if (this.showEditModal) {
          await api.put(`/patients/${this.editingPatientId}`, {
            name: this.patientForm.name,
            phone: this.patientForm.phone,
            category: this.patientForm.category,
            metadata
          });
        } else {
          await api.post('/patients', {
            name: this.patientForm.name,
            phone: this.patientForm.phone,
            category: this.patientForm.category,
            metadata
          });
        }

        this.closeModals();
        await this.loadPatients();
        alert(this.showEditModal ? 'Patient updated!' : 'Patient added!');
      } catch (error) {
        console.error('Save patient error:', error);
        alert('Failed to save patient');
      }
    },
    editPatient(patient) {
      this.editingPatientId = patient.id;
      this.patientForm = {
        name: patient.name,
        phone: patient.phone,
        category: patient.category,
        age: patient.metadata?.age || '',
        medical_condition: patient.metadata?.medical_condition || '',
        appointment_type: patient.metadata?.appointment_type || '',
        appointment_date: patient.metadata?.appointment_date || '',
        doctor: patient.metadata?.doctor || '',
        language: patient.metadata?.language || 'English',
        insurance_status: patient.metadata?.insurance_status || 'Private Insurance',
        transportation_issue: patient.metadata?.transportation_issue === 'Yes',
        financial_concern: patient.metadata?.financial_concern === 'Yes',
        previous_no_show: patient.metadata?.previous_no_show === 'Yes'
      };
      this.showEditModal = true;
    },
    async deletePatient(patientId) {
      if (!confirm('Are you sure you want to delete this patient?')) return;

      try {
        await api.delete(`/patients/${patientId}`);
        await this.loadPatients();
        alert('Patient deleted');
      } catch (error) {
        console.error('Delete patient error:', error);
        alert('Failed to delete patient');
      }
    },
    closeModals() {
      this.showAddModal = false;
      this.showEditModal = false;
      this.patientForm = this.getEmptyForm();
      this.editingPatientId = null;
    },
    handleFileSelect(event) {
      this.selectedFile = event.target.files[0];
    },
    async uploadCSV() {
      try {
        const formData = new FormData();
        formData.append('file', this.selectedFile);

        await api.post('/patients/import', formData, {
          headers: { 'Content-Type': 'multipart/form-data' }
        });

        this.showUploadModal = false;
        this.selectedFile = null;
        await this.loadPatients();
        alert('Patients imported successfully!');
      } catch (error) {
        console.error('Import error:', error);
        alert('Failed to import patients');
      }
    },
    getCategoryCount(category) {
      return this.patients.filter(p => p.category === category).length;
    },
    getCategoryLabel(category) {
      const cat = this.categories.find(c => c.value === category);
      return cat ? cat.label : category;
    },
    getInitials(name) {
      return name.split(' ').map(n => n[0]).join('').toUpperCase().slice(0, 2);
    },
    formatDate(dateString) {
      return new Date(dateString).toLocaleDateString();
    }
  }
};
</script>

<style scoped>
.patients {
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

.actions-bar {
  display: flex;
  justify-content: space-between;
  gap: 1rem;
  margin-bottom: 1rem;
}

.search-box {
  flex: 1;
  max-width: 400px;
}

.search-input {
  width: 100%;
  padding: 0.75rem 1rem;
  border: 2px solid #e5e7eb;
  border-radius: 8px;
  font-size: 0.95rem;
}

.search-input:focus {
  outline: none;
  border-color: #667eea;
}

.action-buttons {
  display: flex;
  gap: 0.5rem;
}

.filters {
  display: flex;
  gap: 0.5rem;
  margin-bottom: 1.5rem;
  flex-wrap: wrap;
}

.filter-btn {
  padding: 0.5rem 1rem;
  background: white;
  border: 2px solid #e5e7eb;
  border-radius: 8px;
  cursor: pointer;
  font-size: 0.9rem;
  font-weight: 500;
  transition: all 0.2s;
}

.filter-btn:hover {
  border-color: #667eea;
}

.filter-btn.active {
  background: #667eea;
  border-color: #667eea;
  color: white;
}

.patients-table {
  background: white;
  border-radius: 12px;
  box-shadow: 0 1px 3px rgba(0,0,0,0.1);
  overflow: hidden;
}

table {
  width: 100%;
  border-collapse: collapse;
}

th, td {
  padding: 1rem;
  text-align: left;
  border-bottom: 1px solid #e5e7eb;
}

th {
  background: #f9fafb;
  font-weight: 600;
  color: #374151;
  font-size: 0.85rem;
  text-transform: uppercase;
  letter-spacing: 0.5px;
}

.patient-name {
  display: flex;
  align-items: center;
  gap: 0.75rem;
}

.avatar {
  width: 32px;
  height: 32px;
  background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
  color: white;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 0.75rem;
  font-weight: 600;
}

.category-badge {
  padding: 0.25rem 0.75rem;
  border-radius: 12px;
  font-size: 0.8rem;
  font-weight: 600;
}

.category-badge.diabetes {
  background: #dbeafe;
  color: #1e40af;
}

.category-badge.heart_disease {
  background: #fee2e2;
  color: #991b1b;
}

.category-badge.asthma {
  background: #d1fae5;
  color: #065f46;
}

.category-badge.hypertension {
  background: #fef3c7;
  color: #92400e;
}

.category-badge.other {
  background: #f3f4f6;
  color: #374151;
}

.status-badge {
  padding: 0.25rem 0.75rem;
  border-radius: 12px;
  font-size: 0.8rem;
  font-weight: 600;
}

.status-badge.active {
  background: #d1fae5;
  color: #065f46;
}

.status-badge.pending {
  background: #fef3c7;
  color: #92400e;
}

.status-badge.inactive {
  background: #f3f4f6;
  color: #6b7280;
}

.action-btns {
  display: flex;
  gap: 0.5rem;
}

.btn-icon {
  padding: 0.25rem 0.5rem;
  background: none;
  border: none;
  cursor: pointer;
  font-size: 1.1rem;
  transition: transform 0.2s;
}

.btn-icon:hover {
  transform: scale(1.2);
}

.pagination {
  display: flex;
  justify-content: center;
  align-items: center;
  gap: 1rem;
  padding: 1rem;
  border-top: 1px solid #e5e7eb;
}

.btn-page {
  padding: 0.5rem 1rem;
  background: white;
  border: 2px solid #e5e7eb;
  border-radius: 6px;
  cursor: pointer;
  font-weight: 500;
}

.btn-page:hover:not(:disabled) {
  border-color: #667eea;
  color: #667eea;
}

.btn-page:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.page-info {
  color: #6b7280;
  font-size: 0.9rem;
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
  max-width: 700px;
}

.modal h2 {
  margin-bottom: 1.5rem;
  color: #1f2937;
}

.form-row {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 1rem;
}

.form-group {
  margin-bottom: 1rem;
}

.form-group label {
  display: block;
  margin-bottom: 0.5rem;
  color: #374151;
  font-weight: 500;
  font-size: 0.9rem;
}

.form-group input,
.form-group select {
  width: 100%;
  padding: 0.75rem;
  border: 2px solid #e5e7eb;
  border-radius: 6px;
  font-size: 0.95rem;
}

.form-group input:focus,
.form-group select:focus {
  outline: none;
  border-color: #667eea;
}

.checkbox-group {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}

.checkbox-label {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  cursor: pointer;
}

.checkbox-label input[type="checkbox"] {
  width: auto;
}

.help-text {
  color: #6b7280;
  font-size: 0.85rem;
  margin-bottom: 1rem;
  line-height: 1.5;
}

.modal-actions {
  display: flex;
  gap: 1rem;
  justify-content: flex-end;
  margin-top: 1.5rem;
}

.btn-primary, .btn-secondary {
  padding: 0.75rem 1.5rem;
  border: none;
  border-radius: 8px;
  cursor: pointer;
  font-size: 0.95rem;
  font-weight: 600;
  transition: all 0.2s;
}

.btn-primary {
  background: #667eea;
  color: white;
}

.btn-primary:hover:not(:disabled) {
  background: #5568d3;
}

.btn-primary:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.btn-secondary {
  background: #f3f4f6;
  color: #374151;
}

.btn-secondary:hover {
  background: #e5e7eb;
}

.loading, .no-data {
  text-align: center;
  padding: 3rem;
  color: #6b7280;
  background: white;
  border-radius: 12px;
}

.empty-icon {
  font-size: 4rem;
  margin-bottom: 1rem;
}

@media (max-width: 768px) {
  .actions-bar {
    flex-direction: column;
  }

  .search-box {
    max-width: 100%;
  }

  .form-row {
    grid-template-columns: 1fr;
  }

  table {
    font-size: 0.85rem;
  }

  th, td {
    padding: 0.75rem 0.5rem;
  }
}
</style>
