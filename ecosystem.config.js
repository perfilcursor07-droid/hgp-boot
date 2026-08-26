module.exports = {
  apps: [
    {
      name: 'hgp-boot',
      script: 'server.js',
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      watch: false,
      max_memory_restart: '800M',
      min_uptime: '15s',
      max_restarts: 40,
      restart_delay: 4000,
      exp_backoff_restart_delay: 2000,
      kill_timeout: 12000,
      env: {
        NODE_ENV: 'production'
      }
    }
  ]
};
