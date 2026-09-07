module.exports = {
  apps: [
    {
      name:          'bot-nefertiti',
      script:        'index.js',
      watch:         false,
      restart_delay: 5000,    // espera 5 s antes de reiniciar tras un crash
      max_restarts:  10,       // máximo 10 reinicios consecutivos
      env: {
        NODE_ENV: 'development',
      },
      env_production: {
        NODE_ENV: 'production',
      },
      error_file:  'logs/pm2-error.log',
      out_file:    'logs/pm2-out.log',
      merge_logs:  true,
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
    },
  ],
};
