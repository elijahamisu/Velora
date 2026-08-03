import { defineConfig } from 'vite';
import { resolve } from 'path';

export default defineConfig({
  // Root directory of the project
  root: './',
  
  build: {
    // Output directory
    outDir: 'dist',
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'index.html'),
        login: resolve(__dirname, 'login.html'),
        // Add more pages here as we build them:
         register: resolve(__dirname, 'register.html'),
         dashboard: resolve(__dirname, 'dashboard.html'),
         invest: resolve(__dirname, 'invest.html'),
         deposit: resolve(__dirname, 'deposit.html'),
         withdraw: resolve(__dirname, 'withdraw.html'),
         wallet: resolve(__dirname, 'wallet.html'),
         transactions: resolve(__dirname, 'transactions.html'),
         referral: resolve(__dirname, 'referral.html'),
         gift: resolve(__dirname, 'gift.html'),
         notifications: resolve(__dirname, 'notifications.html'),
         profile: resolve(__dirname, 'profile.html'),
         support: resolve(__dirname, 'support.html'),
         terms: resolve(__dirname, 'terms.html'),
         
         //admin panel 
        admin_login: resolve(__dirname, 'admin/login.html'), 
         admin_dashboard: resolve(__dirname, 'admin/dashboard.html'), 
         admin_users: resolve(__dirname, 'admin/users.html'),
         admin_deposits: resolve(__dirname, 'admin/deposits.html'), 
         admin_withdrawals: resolve(__dirname, 'admin/withdrawals.html'),
         admin_investments: resolve(__dirname, 'admin/investments.html'),
         admin_giftCodes: resolve(__dirname, 'gift-codes.html'),
         admin_support: resolve(__dirname, 'admin/support.html'),
         admin_plans: resolve(__dirname, 'admin/plans.html'),
      },
    },
  },
  
  server: {
    port: 3000,
    open: true
  }
});
