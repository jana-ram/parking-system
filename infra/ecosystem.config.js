/**
 * PM2 process config for the backend API. Not managing owner-web here — it's
 * a static build served directly by nginx (infra/nginx/owner-web.conf), no
 * Node process needed for it in production.
 */
module.exports = {
  apps: [
    {
      name: 'smart-parking-backend',
      cwd: '/srv/smart-parking/parking-system/backend',
      script: 'src/server.js',
      instances: 1,
      // Single instance, not cluster mode: mongoose.startSession() transactions
      // and the sync/anomaly services hold no in-process shared state that
      // would break under clustering, but there's also nothing here that
      // benefits from it yet at this scale (§Z's milestone table scopes
      // horizontal scaling as a later concern) — revisit if/when a single
      // node's throughput is the actual bottleneck, not preemptively.
      exec_mode: 'fork',
      autorestart: true,
      max_memory_restart: '400M',
      env_production: {
        NODE_ENV: 'production',
      },
      error_file: '/var/log/smart-parking/backend-error.log',
      out_file: '/var/log/smart-parking/backend-out.log',
      time: true,
    },
  ],
}
