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
      },
      restart_delay: 3000,
      max_restarts: 10,
      watch: false,
    },
  ],
};
