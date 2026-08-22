import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Defense-in-depth against XSS-driven token exfiltration (admin JWT is
// stored in localStorage) — restricts script/object sources so an XSS can't
// load a remote script or plugin. connect-src stays broad (https:/wss:)
// since VITE_API_URL/VITE_SOCKET_URL are runtime-configured and can't be
// hard-coded here without risking breakage on a differently-configured
// deployment. script-src/style-src allow maps.googleapis.com (Zones page's
// Google Maps JS SDK) and unpkg.com (Live Tracking page's Leaflet CDN load).
const CSP = "default-src 'self'; script-src 'self' https://maps.googleapis.com https://unpkg.com; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://unpkg.com; font-src 'self' https://fonts.gstatic.com https://fonts.cdnfonts.com; img-src 'self' data: https:; connect-src 'self' https: wss:; object-src 'none'; base-uri 'self'; frame-ancestors 'none';"

// Only injects the CSP into the production build's index.html — Vite's dev
// server injects its own inline HMR/React-Refresh <script>, which a strict
// script-src 'self' would block, so local `npm run dev` stays unaffected.
function cspPlugin() {
  return {
    name: 'inject-csp',
    transformIndexHtml(html, ctx) {
      if (!ctx.bundle) return html
      return html.replace(
        '<meta name="viewport" content="width=device-width, initial-scale=1.0" />',
        `<meta name="viewport" content="width=device-width, initial-scale=1.0" />\n  <meta http-equiv="Content-Security-Policy" content="${CSP}" />`
      )
    }
  }
}

export default defineConfig({
  plugins: [react(), cspPlugin()],
  base: '/parking/',
  server: {
    port: 7100,
    proxy: {
      '/api': {
        target: 'http://localhost:7000',
        changeOrigin: true
      },
      '/socket.io': {
        target: 'http://localhost:7000',
        ws: true,
        configure: (proxy) => {
          proxy.on('error', (err) => {
            if (['ECONNABORTED', 'ECONNRESET'].includes(err.code)) return
            console.error('Socket proxy error:', err)
          })
        }
      }
    }
  }
})