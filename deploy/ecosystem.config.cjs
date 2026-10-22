// pm2 start deploy/ecosystem.config.cjs   (from /var/www/mailtrack)
module.exports = {
  apps: [
    {
      name: 'mailtrack',
      cwd: '/var/www/mailtrack',
      script: 'dist/server/index.js',
      node_args: '--env-file=.env',
      max_memory_restart: '300M',
      kill_timeout: 12000,
    },
  ],
};
