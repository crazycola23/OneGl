import "dotenv/config";
import { spawn } from "node:child_process";

/**
 * Opens an SSH tunnel to the loopback-only PostgreSQL instance.
 *
 * The database container publishes 5432 on the server's loopback interface only, so
 * nothing outside that host can reach it. A collector running elsewhere connects
 * through this tunnel instead, which is why no firewall rule ever has to be opened.
 */
const target = process.env.ONEGL_SSH_TARGET;
const localPort = Number(process.env.ONEGL_DB_TUNNEL_PORT ?? 15432);
const remoteHost = process.env.ONEGL_DB_REMOTE_HOST ?? "127.0.0.1";
const remotePort = Number(process.env.ONEGL_DB_REMOTE_PORT ?? 5432);

if (!target) {
  console.error(
    "ONEGL_SSH_TARGET is not set. Example: ONEGL_SSH_TARGET=user@10.0.0.5 npm run db:tunnel",
  );
  process.exit(1);
}

console.log(`Tunnelling 127.0.0.1:${localPort} -> ${remoteHost}:${remotePort} via ${target}`);
console.log("Keep this process running, then point DATABASE_URL at 127.0.0.1:" + localPort);

const child = spawn(
  "ssh",
  [
    "-N",
    "-o",
    "ExitOnForwardFailure=yes",
    "-o",
    "ServerAliveInterval=30",
    "-o",
    "ServerAliveCountMax=3",
    "-L",
    `${localPort}:${remoteHost}:${remotePort}`,
    target,
  ],
  { stdio: "inherit" },
);

child.on("error", (error) => {
  console.error(`Failed to start ssh: ${error.message}`);
  process.exitCode = 1;
});
child.on("exit", (code, signal) => {
  if (signal) console.error(`ssh tunnel terminated by ${signal}`);
  process.exitCode = code ?? 0;
});
