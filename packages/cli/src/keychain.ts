// The system's own place for secrets: Keychain on macOS, the Secret Service
// on Linux. Reached through the commands those systems ship, so the tool
// stays one file with nothing compiled in.
//
// What this buys over a private file: the secrets are encrypted while the
// machine is locked or off, and they are not in a folder that gets backed
// up, synced or committed by accident. It does not stop another program
// running as the same user from asking for them; nothing on a desktop does.

import { spawnSync } from "node:child_process";

const SERVICE = "app.tessil.cli";

function run(command: string, args: string[], input?: string): { ok: boolean; out: string } {
  try {
    // Never left to inherit this program's standard input: the MCP server
    // reads its protocol from it.
    const result = spawnSync(command, args, {
      ...(input === undefined ? { stdio: ["ignore", "pipe", "ignore"] as const } : { input }),
      encoding: "utf8",
      timeout: 15_000,
      shell: false,
    });
    return { ok: result.status === 0, out: (result.stdout ?? "").trim() };
  } catch {
    return { ok: false, out: "" };
  }
}

// Only what cannot break out of a quoted argument or a command line.
const SAFE = /^[A-Za-z0-9_.:\/@-]+$/;

/** True when the secret was stored. False when this system has no keychain we can use. */
export function keychainStore(account: string, secret: string): boolean {
  if (process.env.TESSIL_NO_KEYCHAIN || !SAFE.test(account) || !SAFE.test(secret)) return false;
  if (process.platform === "darwin") {
    // Through the tool's command mode, on standard input: an argument would
    // be visible to every other program for as long as the command runs.
    return run("security", ["-i"], `add-generic-password -U -a "${account}" -s "${SERVICE}" -w "${secret}"\n`).ok
      // The command mode reports success even when the command inside failed.
      && keychainRead(account) === secret;
  }
  if (process.platform === "linux") {
    return run("secret-tool", ["store", "--label=Tessil command-line tool", "service", SERVICE, "account", account], secret).ok
      && keychainRead(account) === secret;
  }
  return false;
}

export function keychainRead(account: string): string | null {
  if (!SAFE.test(account)) return null;
  const result =
    process.platform === "darwin"
      ? run("security", ["find-generic-password", "-a", account, "-s", SERVICE, "-w"])
      : process.platform === "linux"
        ? run("secret-tool", ["lookup", "service", SERVICE, "account", account])
        : { ok: false, out: "" };
  return result.ok && result.out.length > 0 ? result.out : null;
}

export function keychainDelete(account: string): void {
  if (!SAFE.test(account)) return;
  if (process.platform === "darwin") run("security", ["delete-generic-password", "-a", account, "-s", SERVICE]);
  else if (process.platform === "linux") run("secret-tool", ["clear", "service", SERVICE, "account", account]);
}
