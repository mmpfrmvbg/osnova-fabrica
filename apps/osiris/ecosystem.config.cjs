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
        BOT_TOKEN: process.env.BOT_TOKEN || '',
        PUSH_WEBHOOK_URL: 'http://localhost:3000/internal/push-test',
      },
      restart_delay: 3000,
      max_restarts: 10,
      watch: false,
    },
  ],
};
