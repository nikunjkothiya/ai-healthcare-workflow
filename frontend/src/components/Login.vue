<template>
  <div class="login-container">
    <div class="login-card">
      <h1>🏥 Healthcare AI</h1>
      <h2>Voice Agent Platform</h2>
      
      <form @submit.prevent="handleSubmit">
        <div class="form-group">
          <label>Email</label>
          <input 
            v-model="email" 
            type="email" 
            placeholder="admin@demo.com"
            required
          />
        </div>
        
        <div class="form-group">
          <label>Password</label>
          <input 
            v-model="password" 
            type="password" 
            placeholder="Enter password"
            required
          />
        </div>
        
        <button type="submit" class="btn-primary" :disabled="loading">
          {{ loading ? 'Loading...' : (isRegister ? 'Register' : 'Login') }}
        </button>
        
        <p class="toggle-mode">
          {{ isRegister ? 'Already have an account?' : "Don't have an account?" }}
          <a @click="isRegister = !isRegister">
            {{ isRegister ? 'Login' : 'Register' }}
          </a>
        </p>
      </form>
      
      <div v-if="error" class="error-message">{{ error }}</div>
      <div v-if="success" class="success-message">{{ success }}</div>
      
      <div class="demo-credentials">
        <p class="demo-title"><strong>Demo Credentials:</strong></p>
        
        <div class="credential-box">
          <p class="credential-label">🏥 Hospital Admin (Demo Healthcare):</p>
          <p class="credential-value">Email: <code>admin@demo.com</code></p>
          <p class="credential-value">Password: <code>admin123</code></p>
        </div>
        
        <div class="credential-box">
          <p class="credential-label">⚙️ Product Admin (Manage all hospitals):</p>
          <p class="credential-value">Email: <code>productadmin@healthcare.com</code></p>
          <p class="credential-value">Password: <code>admin123</code></p>
        </div>
      </div>
    </div>
  </div>
</template>

<script>
import api from '../api.js';

export default {
  name: 'Login',
  data() {
    return {
      email: '',
      password: '',
      isRegister: false,
      loading: false,
      error: '',
      success: ''
    };
  },
  methods: {
    async handleSubmit() {
      this.loading = true;
      this.error = '';
      this.success = '';
      
      try {
        const endpoint = this.isRegister ? '/auth/register' : '/auth/login';
        const response = await api.post(endpoint, {
          email: this.email,
          password: this.password
        });
        
        localStorage.setItem('token', response.data.token);
        localStorage.setItem('user', JSON.stringify(response.data.user));
        
        this.success = this.isRegister ? 'Registration successful!' : 'Login successful!';
        
        // Redirect based on role
        const user = response.data.user;
        const redirectPath = user.role === 'product_admin' ? '/product-admin' : '/dashboard';
        
        setTimeout(() => {
          // Force full page reload to ensure navigation updates
          window.location.href = redirectPath;
        }, 500);
      } catch (err) {
        this.error = err.response?.data?.error || 'Authentication failed';
      } finally {
        this.loading = false;
      }
    }
  }
};
</script>

<style scoped>
.login-container {
  min-height: 100vh;
  display: flex;
  align-items: center;
  justify-content: center;
  background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
  padding: 2rem;
}

.login-card {
  background: white;
  padding: 2.5rem;
  border-radius: 16px;
  box-shadow: 0 20px 60px rgba(0,0,0,0.3);
  width: 100%;
  max-width: 480px;
}

.login-card h1 {
  text-align: center;
  color: #1f2937;
  margin-bottom: 0.5rem;
  font-size: 2rem;
  font-weight: 700;
}

.login-card h2 {
  text-align: center;
  color: #6b7280;
  margin-bottom: 2rem;
  font-size: 1rem;
  font-weight: 400;
}

.form-group {
  margin-bottom: 1.25rem;
}

.form-group label {
  display: block;
  margin-bottom: 0.5rem;
  color: #374151;
  font-weight: 600;
  font-size: 0.9rem;
}

.form-group input {
  width: 100%;
  padding: 0.875rem 1rem;
  border: 2px solid #e5e7eb;
  border-radius: 8px;
  font-size: 0.95rem;
  transition: all 0.2s;
  background: #f9fafb;
}

.form-group input:focus {
  outline: none;
  border-color: #667eea;
  background: white;
  box-shadow: 0 0 0 3px rgba(102, 126, 234, 0.1);
}

.btn-primary {
  width: 100%;
  padding: 1rem;
  background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
  color: white;
  border: none;
  border-radius: 8px;
  font-size: 1rem;
  font-weight: 600;
  cursor: pointer;
  transition: all 0.3s;
  margin-top: 0.5rem;
}

.btn-primary:hover:not(:disabled) {
  transform: translateY(-2px);
  box-shadow: 0 10px 20px rgba(102, 126, 234, 0.3);
}

.btn-primary:disabled {
  opacity: 0.6;
  cursor: not-allowed;
  transform: none;
}

.toggle-mode {
  text-align: center;
  margin-top: 1.5rem;
  color: #6b7280;
  font-size: 0.9rem;
}

.toggle-mode a {
  color: #667eea;
  cursor: pointer;
  text-decoration: none;
  font-weight: 600;
  margin-left: 0.25rem;
}

.toggle-mode a:hover {
  text-decoration: underline;
}

.error-message {
  margin-top: 1rem;
  padding: 0.875rem;
  background: #fef2f2;
  color: #dc2626;
  border-radius: 8px;
  text-align: center;
  font-size: 0.9rem;
  border: 1px solid #fecaca;
}

.success-message {
  margin-top: 1rem;
  padding: 0.875rem;
  background: #f0fdf4;
  color: #16a34a;
  border-radius: 8px;
  text-align: center;
  font-size: 0.9rem;
  border: 1px solid #bbf7d0;
}

.demo-credentials {
  margin-top: 2rem;
  padding: 1.5rem;
  background: linear-gradient(135deg, #f8fafc 0%, #f1f5f9 100%);
  border-radius: 12px;
  border: 1px solid #e2e8f0;
}

.demo-title {
  margin: 0 0 1.25rem 0;
  color: #1f2937;
  font-size: 0.95rem;
  text-align: center;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.5px;
}

.credential-box {
  background: white;
  padding: 1.25rem;
  border-radius: 8px;
  margin-bottom: 1rem;
  border-left: 4px solid #667eea;
  box-shadow: 0 1px 3px rgba(0,0,0,0.05);
  transition: all 0.2s;
}

.credential-box:hover {
  box-shadow: 0 4px 12px rgba(102, 126, 234, 0.15);
  transform: translateX(2px);
}

.credential-box:last-child {
  margin-bottom: 0;
}

.credential-label {
  margin: 0 0 0.75rem 0;
  color: #374151;
  font-weight: 700;
  font-size: 0.9rem;
  display: flex;
  align-items: center;
  gap: 0.5rem;
}

.credential-value {
  margin: 0.5rem 0;
  color: #6b7280;
  font-size: 0.85rem;
  display: flex;
  align-items: center;
  gap: 0.5rem;
}

.credential-value code {
  background: #f3f4f6;
  padding: 0.35rem 0.75rem;
  border-radius: 6px;
  font-family: 'Monaco', 'Courier New', monospace;
  color: #667eea;
  font-weight: 700;
  font-size: 0.85rem;
  border: 1px solid #e5e7eb;
  flex: 1;
  text-align: center;
}

@media (max-width: 640px) {
  .login-container {
    padding: 1rem;
  }
  
  .login-card {
    padding: 2rem 1.5rem;
  }
  
  .login-card h1 {
    font-size: 1.75rem;
  }
  
  .demo-credentials {
    padding: 1.25rem;
  }
  
  .credential-box {
    padding: 1rem;
  }
}
</style>
