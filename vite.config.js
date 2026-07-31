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
        // register: resolve(__dirname, 'register.html'),
        // dashboard: resolve(__dirname, 'dashboard.html'),
      },
    },
  },
  
  server: {
    port: 3000,
    open: true
  }
});
