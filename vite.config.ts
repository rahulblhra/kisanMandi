import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'

export default defineConfig({
  base: '/kisanMandi/',

  plugins: [
    react(),

    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: [],

      manifest: {
        name: 'Kisan Mandi',
        short_name: 'Mandi',
        description: 'Local-first mandi commission agent management',
        theme_color: '#f6f7f2',
        background_color: '#f6f7f2',
        display: 'standalone',
        start_url: '/kisanMandi/',
        icons: [],
      },

      workbox: {
        navigateFallback: '/kisanMandi/index.html',
      },
    }),
  ],
})
