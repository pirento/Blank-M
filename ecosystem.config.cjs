// PM2 process file for a VPS (Hostinger VPS, DigitalOcean, …).
// Usage: pm2 start ecosystem.config.cjs && pm2 save && pm2 startup
module.exports = {
  apps: [
    {
      name: 'pirento-blank',
      script: 'server.js',
      // Two processes share the port (cluster mode), so one busy request cannot hold up everyone
      // and a restart of one keeps the site up. Sessions, rate limits and job claims live in
      // MongoDB, so this is safe. Raise `instances` up to the number of CPU cores.
      instances: 2,
      exec_mode: 'cluster',
      // Listen on loopback only: Nginx is the single way in, so the client
      // address it forwards (TRUST_PROXY=true) cannot be forged.
      env: { NODE_ENV: 'production', HOST: '127.0.0.1' },
      max_memory_restart: '1G',
      kill_timeout: 30000,
      time: true,
    },
  ],
};
