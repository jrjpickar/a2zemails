import {defineConfig} from 'vite';

// Libraries change rarely, so they get their own files. A normal deploy then only re-downloads app code.
export default defineConfig({
 build:{
  rollupOptions:{
   output:{
    manualChunks(id) {
     if (!id.includes('node_modules')) return;
     if (/[\\/]node_modules[\\/](react|react-dom|scheduler)[\\/]/.test(id)) return 'react';
     if (id.includes('lucide-react')) return 'icons';
     return 'vendor';
    },
   },
  },
 },
});
