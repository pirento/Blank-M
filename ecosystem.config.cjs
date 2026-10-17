// PM2 process file for a VPS (Hostinger VPS, DigitalOcean, …).
// Usage: pm2 start ecosystem.config.cjs && pm2 save && pm2 startup
module.exports = {
  apps: [
    {
      name: 'pirento-blank',
      script: 'server.js',
      // One process: sessions and rate windows live in MongoDB, but keep a single
      // instance unless you have tested multiple ones behind your proxy.
      instances: 1,
      exec_mode: 'fork',
      // Listen on loopback only: Nginx is the single way in, so the client
      // address it forwards (TRUST_PROXY=true) cannot be forged.
      env: { NODE_ENV: 'production', HOST: '127.0.0.1' },
      max_memory_restart: '512M',
      kill_timeout: 30000,
      time: true,
    },
  ],
};
