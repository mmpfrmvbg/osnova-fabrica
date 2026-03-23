// apps/osiris/src/http/tunnel.ts
import { execFileSync, spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

function resolveCloudflaredExecutable(): string {
  const localExe = path.join(process.cwd(), 'cloudflared.exe');
  if (fs.existsSync(localExe)) {
    return localExe;
  }
  return 'cloudflared';
}

export function isCloudflaredInstalled(): boolean {
  const cf = resolveCloudflaredExecutable();
  if (cf !== 'cloudflared') {
    try {
      execFileSync(cf, ['--version'], { stdio: 'ignore' });
      return true;
    } catch {
      return false;
    }
  }
  try {
    execFileSync('cloudflared', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    // Windows: попробовать через cmd
    try {
      execFileSync('cmd.exe', ['/c', 'cloudflared', '--version'], { stdio: 'ignore' });
      return true;
    } catch {
      return false;
    }
  }
}

export function startTunnel(port: number, urlFile?: string): void {
  if (!isCloudflaredInstalled()) {
    console.log(
      '[osiris:tunnel] cloudflared not found.',
    );
    console.log(
      '[osiris:tunnel] Install: winget install Cloudflare.cloudflared',
    );
    console.log(
      '[osiris:tunnel] Or: https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/',
    );
    console.log('[osiris:tunnel] Continuing without tunnel...');
    return;
  }

  const saveUrlTo = urlFile ?? path.join(process.cwd(), 'tunnel-url.txt');

  console.log(`[osiris:tunnel] Starting Cloudflare Tunnel → http://localhost:${port}`);

  const cf = resolveCloudflaredExecutable();
  const isWin = process.platform === 'win32';
  const tunnelArgs = [
    'tunnel',
    '--url',
    `http://localhost:${port}`,
    '--protocol',
    'http2',
  ] as const;
  const [cmd, args] =
    isWin && cf === 'cloudflared'
      ? ['cmd.exe', ['/c', 'cloudflared', ...tunnelArgs]]
      : [cf, [...tunnelArgs]];

  const child = spawn(cmd, args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: false,
  });

  function tryParseUrl(line: string): string | null {
    const m = line.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/i);
    return m ? m[0] : null;
  }

  function onData(chunk: Buffer): void {
    const text = chunk.toString();
    for (const line of text.split('\n')) {
      const url = tryParseUrl(line);
      if (url) {
        console.log(`[osiris:tunnel] Public URL: ${url}`);
        process.env.TUNNEL_URL = url;
        try {
          fs.writeFileSync(saveUrlTo, url, 'utf8');
          console.log(`[osiris:tunnel] URL saved → ${saveUrlTo}`);
        } catch {
          // ignore write errors
        }
      }
      if (line.trim()) process.stdout.write(`[cloudflared] ${line}\n`);
    }
  }

  child.stdout?.on('data', onData);
  child.stderr?.on('data', onData);

  child.on('error', (err: NodeJS.ErrnoException) => {
    console.error('[osiris:tunnel] cloudflared spawn failed:', err.message);
  });

  child.on('exit', (code) => {
    if (code !== 0) console.error(`[osiris:tunnel] cloudflared exited with code ${code}`);
  });
}
