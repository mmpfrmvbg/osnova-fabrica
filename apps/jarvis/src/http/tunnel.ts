// apps/jarvis/src/http/tunnel.ts
import { execFileSync, spawn } from 'child_process';

export function isCloudflaredInstalled(): boolean {
  try {
    execFileSync('cloudflared', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

export function startTunnel(port: number): void {
  if (!isCloudflaredInstalled()) {
    console.log(
      '[jarvis:tunnel] cloudflared not found. Install: https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/',
    );
    console.log(
      '[jarvis:tunnel] Or on Linux/macOS: curl -L ... | tar xz && sudo mv cloudflared /usr/local/bin/',
    );
    console.log('[jarvis:tunnel] Continuing without tunnel...');
    return;
  }

  console.log(`[jarvis:tunnel] Starting Cloudflare Tunnel → http://localhost:${port}`);
  console.log('[jarvis:tunnel] Public URL will appear above (look for "trycloudflare.com")');

  const child = spawn('cloudflared', ['tunnel', '--url', `http://localhost:${port}`], {
    stdio: 'inherit',
  });

  child.on('error', (err: NodeJS.ErrnoException) => {
    console.error('[jarvis:tunnel] cloudflared spawn failed:', err.message);
  });
}
