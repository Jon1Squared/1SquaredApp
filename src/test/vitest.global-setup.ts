import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';

const isWin = process.platform === 'win32';
const pgHost =
  process.env.PLATFORM_POSTGRES_MIGRATE_HOST ||
  process.env.PLATFORM_POSTGRES_HOST ||
  '127.0.0.1';
const pgMigratePort = Number(
  process.env.PLATFORM_POSTGRES_MIGRATE_PORT || 5432,
);

function checkTcpPort(host: string, port: number, timeoutMs = 1000): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let settled = false;
    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
    socket.connect(port, host);
  });
}

export async function setup(): Promise<() => Promise<void>> {
  const alreadyListening = await checkTcpPort(pgHost, pgMigratePort);

  const setupRes = spawnSync(
    process.execPath,
    [path.resolve(process.cwd(), 'scripts', 'setup-test-postgres.mjs')],
    {
      stdio: 'inherit',
      env: process.env,
      shell: false,
    },
  );
  if (setupRes.status !== 0) {
    throw new Error(
      `[vitest.global-setup] setup-test-postgres.mjs failed with exit code ${setupRes.status ?? 1}`,
    );
  }

  return async () => {
    if (!alreadyListening && isWin && process.env.LOCALAPPDATA) {
      const localPgRoot = path.join(
        process.env.LOCALAPPDATA,
        'onesquared-pg16',
      );
      const pgCtlExe = path.join(localPgRoot, 'pgsql', 'bin', 'pg_ctl.exe');
      const pgDataDir = path.join(localPgRoot, 'pgdata');
      if (fs.existsSync(pgCtlExe) && fs.existsSync(pgDataDir)) {
        spawnSync(pgCtlExe, ['-D', pgDataDir, '-m', 'fast', 'stop'], {
          stdio: 'ignore',
          shell: false,
        });
      }
    }
  };
}
