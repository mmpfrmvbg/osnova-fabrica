// apps/jarvis/src/http/tunnel.ts
import { execFileSync, spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

export function isCloudflaredInstalled(): boolean {
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
      '[jarvis:tunnel] cloudflared not found.',
    );
    console.log(
      '[jarvis:tunnel] Install: winget install Cloudflare.cloudflared',
    );
    console.log(
      '[jarvis:tunnel] Or: https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/',
    );
    console.log('[jarvis:tunnel] Continuing without tunnel...');
    return;
  }

  const saveUrlTo = urlFile ?? path.join(process.cwd(), 'tunnel-url.txt');

  console.log(`[jarvis:tunnel] Starting Cloudflare Tunnel → http://localhost:${port}`);

  const isWin = process.platform === 'win32';
  const [cmd, args] = isWin
    ? ['cmd.exe', ['/c', 'cloudflared', 'tunnel', '--url', `http://localhost:${port}`]]
    : ['cloudflared', ['tunnel', '--url', `http://localhost:${port}`]];

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
        console.log(`[jarvis:tunnel] Public URL: ${url}`);
        process.env.TUNNEL_URL = url;
        try {
          fs.writeFileSync(saveUrlTo, url, 'utf8');
          console.log(`[jarvis:tunnel] URL saved → ${saveUrlTo}`);
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
    console.error('[jarvis:tunnel] cloudflared spawn failed:', err.message);
  });

  child.on('exit', (code) => {
    if (code !== 0) console.error(`[jarvis:tunnel] cloudflared exited with code ${code}`);
  });
}
