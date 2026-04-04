import { spawn } from "node:child_process";
import { access, mkdir, writeFile } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { once } from "node:events";
import { createConnection } from "node:net";

const LAVALINK_PORT = 2334;
const LAVALINK_HOST = "127.0.0.1";
const JAVA_DIR = "/data/jre";
const JAVA_BIN = `${JAVA_DIR}/bin/java`;
const LAVALINK_JAR = "/data/Lavalink.jar";
const JAVA_DOWNLOAD_URL = "https://api.adoptium.net/v3/binary/latest/17/ga/linux/x64/jre/hotspot/normal/eclipse";
const LAVALINK_DOWNLOAD_URL = "https://github.com/lavalink-devs/Lavalink/releases/latest/download/Lavalink.jar";

const log = (message: string) => {
  console.log(`[poke-discord-bridge:launcher] ${message}`);
};

function exists(path: string): Promise<boolean> {
  return access(path, fsConstants.F_OK)
    .then(() => true)
    .catch(() => false);
}

async function run(command: string, args: string[], env?: NodeJS.ProcessEnv): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: "inherit",
      env: env ?? process.env
    });

    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }

      reject(new Error(`${command} exited with ${code ?? `signal ${signal ?? "unknown"}`}`));
    });
  });
}

async function download(url: string, destination: string): Promise<void> {
  const response = await fetch(url, {
    headers: {
      "User-Agent": "PokeDiscord"
    }
  });

  if (!response.ok) {
    throw new Error(`Failed to download ${url}: ${response.status} ${response.statusText}`);
  }

  await writeFile(destination, Buffer.from(await response.arrayBuffer()));
}

async function ensureJava(): Promise<void> {
  if (await exists(JAVA_BIN)) return;

  log("Downloading portable Java runtime...");
  await mkdir(JAVA_DIR, { recursive: true });
  await download(JAVA_DOWNLOAD_URL, "/tmp/temurin17.tar.gz");
  await run("tar", ["-xzf", "/tmp/temurin17.tar.gz", "-C", JAVA_DIR, "--strip-components=1"]);
}

async function ensureLavalinkJar(): Promise<void> {
  if (await exists(LAVALINK_JAR)) return;

  log("Downloading Lavalink jar...");
  await download(LAVALINK_DOWNLOAD_URL, LAVALINK_JAR);
}

async function waitForTcpPort(host: string, port: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const ready = await new Promise<boolean>(resolve => {
      const socket = createConnection({ host, port });

      const finish = (value: boolean) => {
        socket.removeAllListeners();
        socket.destroy();
        resolve(value);
      };

      socket.once("connect", () => finish(true));
      socket.once("error", () => finish(false));
      socket.setTimeout(1000, () => finish(false));
    });

    if (ready) return;
    await new Promise(resolve => setTimeout(resolve, 1000));
  }

  throw new Error(`Timed out waiting for ${host}:${port}`);
}

async function main(): Promise<void> {
  log("Bootstrapping Lavalink...");

  await ensureJava();
  await ensureLavalinkJar();

  const lavalinkEnv: NodeJS.ProcessEnv = {
    ...process.env,
    SERVER_PORT: String(LAVALINK_PORT),
    LAVALINK_SERVER_PASSWORD: process.env.POKE_LAVALINK_PASSWORD ?? process.env.LAVALINK_SERVER_PASSWORD
  };

  if (!lavalinkEnv.LAVALINK_SERVER_PASSWORD) {
    throw new Error("Missing POKE_LAVALINK_PASSWORD.");
  }

  let bot: ReturnType<typeof spawn> | null = null;
  log(`Starting Lavalink on ${LAVALINK_HOST}:${LAVALINK_PORT}...`);
  const lavalink = spawn(JAVA_BIN, ["-jar", LAVALINK_JAR], {
    stdio: "inherit",
    env: lavalinkEnv
  });

  let shuttingDown = false;
  const shutdown = async (code: number): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;

    lavalink.kill("SIGTERM");
    bot?.kill("SIGTERM");
    process.exit(code);
  };

  lavalink.once("exit", (code, signal) => {
    if (!shuttingDown) {
      void shutdown(code ?? 1);
      return;
    }

    log(`Lavalink exited (${code ?? `signal ${signal ?? "unknown"}`}).`);
  });

  await waitForTcpPort(LAVALINK_HOST, LAVALINK_PORT, 120_000);
  log("Lavalink is ready, starting bot...");

  bot = spawn("bun", ["run", "src/index.ts"], {
    stdio: "inherit",
    env: process.env
  });

  process.once("SIGINT", () => void shutdown(0));
  process.once("SIGTERM", () => void shutdown(0));

  const [botExitCode, botExitSignal] = await once(bot, "exit") as [number | null, NodeJS.Signals | null];
  if (!shuttingDown) {
    const code = botExitCode ?? 1;
    log(`Bot exited (${botExitCode ?? `signal ${botExitSignal ?? "unknown"}`}).`);
    await shutdown(code);
  }
}

void main().catch(error => {
  console.error(`[poke-discord-bridge:launcher] ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
  process.exit(1);
});
