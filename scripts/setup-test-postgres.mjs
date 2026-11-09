import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';

const isWin = process.platform === 'win32';
const npxCmd = isWin ? 'npx.cmd' : 'npx';

const pgHost = process.env.PLATFORM_POSTGRES_MIGRATE_HOST || process.env.PLATFORM_POSTGRES_HOST || '127.0.0.1';
const pgMigratePort = Number(process.env.PLATFORM_POSTGRES_MIGRATE_PORT || 5432);

function checkTcpPort(host, port, timeoutMs = 1500) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let settled = false;
    const finish = (ok) => {
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

async function ensureLocalWindowsPostgresIfNeeded() {
  if (await checkTcpPort(pgHost, pgMigratePort)) {
    return;
  }

  if (isWin && process.env.LOCALAPPDATA) {
    const localPgRoot = path.join(process.env.LOCALAPPDATA, 'onesquared-pg16');
    const pgBinDir = path.join(localPgRoot, 'pgsql', 'bin');
    const initdbExe = path.join(pgBinDir, 'initdb.exe');
    const pgCtlExe = path.join(pgBinDir, 'pg_ctl.exe');
    const pgDataDir = path.join(localPgRoot, 'pgdata');
    const pgLogFile = path.join(localPgRoot, 'postgres.log');
    const pwFile = path.join(localPgRoot, 'pgpass.tmp');

    if (fs.existsSync(initdbExe) && fs.existsSync(pgCtlExe)) {
      if (!fs.existsSync(path.join(pgDataDir, 'PG_VERSION'))) {
        fs.mkdirSync(localPgRoot, { recursive: true });
        fs.writeFileSync(pwFile, 'postgres\n', 'utf8');
        try {
          const initRes = spawnSync(
            initdbExe,
            [
              '-D',
              pgDataDir,
              '-U',
              'postgres',
              '-E',
              'UTF8',
              '--locale=C',
              '-A',
              'scram-sha-256',
              `--pwfile=${pwFile}`,
            ],
            { stdio: 'inherit', shell: false },
          );
          if (initRes.status !== 0) {
            console.error('[setup-test-postgres] initdb failed.');
            process.exit(initRes.status ?? 1);
          }
        } finally {
          if (fs.existsSync(pwFile)) {
            fs.unlinkSync(pwFile);
          }
        }
      }

      const pidFile = path.join(pgDataDir, 'postmaster.pid');
      if (fs.existsSync(pidFile)) {
        fs.unlinkSync(pidFile);
      }
      const startRes = spawnSync(
        pgCtlExe,
        [
          '-D',
          pgDataDir,
          '-l',
          pgLogFile,
          '-w',
          'start',
          '-o',
          `-h 127.0.0.1 -p ${pgMigratePort}`,
        ],
        { stdio: 'inherit', shell: false },
      );
      if (startRes.status !== 0 && !(await checkTcpPort(pgHost, pgMigratePort))) {
        console.error('[setup-test-postgres] pg_ctl start failed.');
        process.exit(startRes.status ?? 1);
      }
    }
  }

  for (let i = 0; i < 20; i++) {
    if (await checkTcpPort(pgHost, pgMigratePort)) {
      return;
    }
    await new Promise((r) => setTimeout(r, 500));
  }

  console.error(
    `[setup-test-postgres] PostgreSQL 16 is not reachable at ${pgHost}:${pgMigratePort}. Start it via 'docker compose -f docker-compose.postgres.yml up -d' or local PostgreSQL 16.`,
  );
  process.exit(1);
}

async function run() {
  await ensureLocalWindowsPostgresIfNeeded();

  const args = ['tsx', 'scripts/provision-test-postgres.ts'];
  const res = isWin
    ? spawnSync([npxCmd, ...args].join(' '), {
        stdio: 'inherit',
        env: process.env,
        shell: true,
      })
    : spawnSync(npxCmd, args, {
        stdio: 'inherit',
        env: process.env,
        shell: false,
      });

  if (res.status !== 0) {
    process.exit(res.status ?? 1);
  }
}

run();
