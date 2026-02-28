<template>
  <div id="app">
    <nav v-if="isAuthenticated" class="navbar" :key="navKey">
      <div class="nav-brand">
        <span class="logo">🏥</span>
        <span class="brand-text">Healthcare AI Voice Agent</span>
      </div>
      <div class="nav-links">
        <template v-if="isProductAdmin">
          <router-link to="/product-admin" class="nav-link">
            <span class="icon">🏢</span> Product Admin
          </router-link>
        </template>
        <template v-else>
          <router-link to="/dashboard" class="nav-link">
            <span class="icon">📊</span> Dashboard
          </router-link>
          <router-link to="/patients" class="nav-link">
            <span class="icon">👥</span> Patients
          </router-link>
          <router-link to="/campaigns" class="nav-link">
            <span class="icon">📋</span> Campaigns
          </router-link>
        </template>
        <button @click="logout" class="logout-btn">
          <span class="icon">🚪</span> Logout
        </button>
      </div>
    </nav>
    <main class="main-content">
      <router-view :key="$route.fullPath" />
    </main>
  </div>
</template>

<script>
export default {
  name: 'App',
  data() {
    return {
      navKey: 0
    };
  },
  computed: {
    isAuthenticated() {
      return !!localStorage.getItem('token');
    },
    user() {
      const userStr = localStorage.getItem('user');
      return userStr ? JSON.parse(userStr) : null;
    },
    isProductAdmin() {
      return this.user?.role === 'product_admin';
    }
  },
  watch: {
    '$route'() {
      // Force navigation re-render on route change
      this.navKey++;
    }
  },
  methods: {
    logout() {
      localStorage.removeItem('token');
      localStorage.removeItem('user');
      this.navKey++; // Force re-render
      this.$router.push('/login');
    }
  }
};
</script>

<style>
* {
  margin: 0;
  padding: 0;
  box-sizing: border-box;
}

body {
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
  background: #f5f7fa;
  color: #2c3e50;
}

.navbar {
  background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
  color: white;
  padding: 0.75rem 1.5rem;
  display: flex;
  justify-content: space-between;
  align-items: center;
  box-shadow: 0 2px 8px rgba(0,0,0,0.1);
  position: sticky;
  top: 0;
  z-index: 100;
}

.nav-brand {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  font-size: 1.25rem;
  font-weight: 600;
}

.logo {
  font-size: 1.75rem;
}

.brand-text {
  letter-spacing: -0.5px;
}

.nav-links {
  display: flex;
  gap: 0.5rem;
  align-items: center;
}

.nav-link {
  color: white;
  text-decoration: none;
  padding: 0.5rem 1rem;
  border-radius: 6px;
  transition: all 0.2s;
  display: flex;
  align-items: center;
  gap: 0.5rem;
  font-size: 0.9rem;
  font-weight: 500;
}

.nav-link .icon {
  font-size: 1.1rem;
}

.nav-link:hover {
  background: rgba(255,255,255,0.15);
  transform: translateY(-1px);
}

.nav-link.router-link-active {
  background: rgba(255,255,255,0.25);
}

.logout-btn {
  background: rgba(255,255,255,0.2);
  color: white;
  border: none;
  padding: 0.5rem 1rem;
  border-radius: 6px;
  cursor: pointer;
  font-size: 0.9rem;
  font-weight: 500;
  display: flex;
  align-items: center;
  gap: 0.5rem;
  transition: all 0.2s;
}

.logout-btn:hover {
  background: rgba(255,255,255,0.3);
  transform: translateY(-1px);
}

.main-content {
  padding: 1.5rem;
  max-width: 1400px;
  margin: 0 auto;
}

@media (max-width: 768px) {
  .navbar {
    flex-direction: column;
    gap: 1rem;
    padding: 1rem;
  }
  
  .nav-links {
    width: 100%;
    justify-content: center;
    flex-wrap: wrap;
  }
  
  .main-content {
    padding: 1rem;
  }
}
</style>
