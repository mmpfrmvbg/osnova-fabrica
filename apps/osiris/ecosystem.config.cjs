module.exports = {
  apps: [
    {
      name: 'osiris',
      script: 'src/index.ts',
      interpreter: 'node',
      interpreter_args: '--require tsx/cjs',
      cwd: '/opt/osnova/apps/osiris',
      env: {
        NODE_ENV: 'production',
        TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN || '',
        PUSH_WEBHOOK_URL: 'http://localhost:3000/internal/push-test',
      },
      kill_timeout: 8000,
      restart_delay: 3000,
      max_restarts: 10,
      watch: false,
    },
  ],
};
