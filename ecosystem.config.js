module.exports = {
  apps: [
    {
      name: 'jam-server',
      script: 'server.js',
      instances: 1, // MediaSoup manages its own workers, keep PM2 to 1 instance
      exec_mode: 'fork', // Don't use cluster mode with MediaSoup
      
      // Environment variables
      env: {
        NODE_ENV: 'production',
        PORT: 4000,
        CORS_ORIGIN: 'https://jam.khobordari.in',
        MEDIASOUP_LISTEN_IP: '0.0.0.0',
        MEDIASOUP_ANNOUNCED_IP: '172.232.111.180',
        RTC_MIN_PORT: 40000,
        RTC_MAX_PORT: 49999,
      },
      
      // Logging
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      error_file: './logs/jam-server-error.log',
      out_file: './logs/jam-server-out.log',
      merge_logs: true,
      
      // Process management
      max_memory_restart: '1G',
      min_uptime: '10s',
      max_restarts: 10,
      restart_delay: 4000,
      
      // Graceful shutdown
      kill_timeout: 10000,
      wait_ready: true,
      listen_timeout: 10000,
      
      // Watch (disable in production)
      watch: false,
      ignore_watch: ['node_modules', 'logs', '*.log'],
    },
  ],
};