import { createApp } from 'vue';
import { createRouter, createWebHistory } from 'vue-router';
import App from './App.vue';
import Login from './components/Login.vue';
import Dashboard from './components/Dashboard.vue';
import LiveCall from './components/LiveCall.vue';
import Campaigns from './components/Campaigns.vue';
import CallDetails from './components/CallDetails.vue';
import ProductAdmin from './components/ProductAdmin.vue';
import MobileCall from './components/MobileCall.vue';
import CallLinks from './components/CallLinks.vue';
import Patients from './components/Patients.vue';

const routes = [
  { path: '/', redirect: '/login' },
  { path: '/login', component: Login },
  { path: '/dashboard', component: Dashboard, meta: { requiresAuth: true } },
  { path: '/patients', component: Patients, meta: { requiresAuth: true } },
  { path: '/campaigns', component: Campaigns, meta: { requiresAuth: true } },
  { path: '/calls/:id', component: CallDetails, meta: { requiresAuth: true } },
  { path: '/product-admin', component: ProductAdmin, meta: { requiresAuth: true, requiresProductAdmin: true } },
  { path: '/mobile-call', component: MobileCall },
  { path: '/call-links', component: CallLinks, meta: { requiresAuth: true } }
];

const router = createRouter({
  history: createWebHistory(),
  routes
});

router.beforeEach((to, from, next) => {
  const token = localStorage.getItem('token');
  const userStr = localStorage.getItem('user');
  const user = userStr ? JSON.parse(userStr) : null;
  
  if (to.meta.requiresAuth && !token) {
    next('/login');
  } else if (to.meta.requiresAuth && user?.role === 'product_admin' && !to.meta.requiresProductAdmin) {
    next('/product-admin');
  } else if (to.meta.requiresProductAdmin && user?.role !== 'product_admin') {
    next('/dashboard');
  } else if (to.path === '/login' && token) {
    // Redirect based on role
    if (user?.role === 'product_admin') {
      next('/product-admin');
    } else {
      next('/dashboard');
    }
  } else {
    next();
  }
});

const app = createApp(App);
app.use(router);
app.mount('#app');
