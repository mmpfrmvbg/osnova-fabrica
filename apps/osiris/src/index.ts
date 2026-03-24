// apps/osiris/src/index.ts
import * as path from 'path';
import dotenv from 'dotenv';
import { startHttpServer } from './http/server';
import { closeDb } from './db/migrations';

const osirisRoot = path.resolve(__dirname, '..');
const repoRoot = path.resolve(__dirname, '..', '..', '..');
dotenv.config({ path: path.join(osirisRoot, '.env') });
dotenv.config({ path: path.join(repoRoot, '.env') });

async function main(): Promise<void> {
  const withTunnel = process.env['USE_TUNNEL'] === 'true';
  try {
    await startHttpServer({ tunnel: withTunnel });
    // startTelegramAdapter() уже запускается внутри startHttpServer()
    process.on('SIGTERM', () => {
      console.log('[osiris] SIGTERM received, shutting down...');
      closeDb();
      process.exit(0);
    });
    process.on('SIGINT', () => {
      console.log('[osiris] SIGINT received, shutting down...');
      closeDb();
      process.exit(0);
    });
  } catch (e) {
    console.error('[osiris:fatal]', e);
    process.exit(1);
  }
}

void main();
