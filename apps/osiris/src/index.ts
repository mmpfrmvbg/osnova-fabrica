// apps/osiris/src/index.ts
import * as path from 'path';
import dotenv from 'dotenv';
import { startHttpServer } from './http/server';

const osirisRoot = path.resolve(__dirname, '..');
const repoRoot = path.resolve(__dirname, '..', '..', '..');
dotenv.config({ path: path.join(osirisRoot, '.env') });
dotenv.config({ path: path.join(repoRoot, '.env') });

async function main(): Promise<void> {
  const withTunnel = process.env['USE_TUNNEL'] === 'true';
  try {
    await startHttpServer({ tunnel: withTunnel });
    // startTelegramAdapter() уже запускается внутри startHttpServer()
  } catch (e) {
    console.error('[osiris:fatal]', e);
    process.exit(1);
  }
}

void main();
