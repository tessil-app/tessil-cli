// Where the tool keeps what it must remember: which account it works for
// and the three secrets that prove it. They never leave this machine.

import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface Credentials {
  /** The site the key belongs to, so a key for one server is never sent to another. */
  apiUrl: string;
  deviceId: string;
  name: string;
  /** Signs the tool in. `tsl_…` */
  token: string;
  /** PKCS#8, base64url. Things are encrypted to the matching public key. */
  privateKey: string;
  publicKey: string;
  /** Wraps the keys of transfers this tool sent, so it can name them later. */
  secret: string;
  email: string;
  /**
   * The account this key works for and the public key it signs portal
   * grants with, remembered from the first time the server named them. A
   * grant signed by any other key is refused.
   */
  accountId?: string;
  accountPublicKey?: string;
}

export const API_URL = (process.env.TESSIL_API_URL ?? "https://tessil.app").replace(/\/+$/, "");
/** Where a person approves the tool. The same site unless told otherwise. */
export const WEB_URL = (process.env.TESSIL_WEB_URL ?? API_URL).replace(/\/+$/, "");

export function configDir(): string {
  if (process.env.TESSIL_CONFIG_DIR) return process.env.TESSIL_CONFIG_DIR;
  const base = process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config");
  return join(base, "tessil");
}

const file = () => join(configDir(), "credentials.json");

export function loadCredentials(): Credentials | null {
  if (!existsSync(file())) return null;
  try {
    const stored = JSON.parse(readFileSync(file(), "utf8")) as Credentials;
    // A key is for one server. Pointing the tool elsewhere must not send it there.
    return stored.apiUrl === API_URL ? stored : null;
  } catch {
    return null;
  }
}

export function saveCredentials(credentials: Credentials): void {
  mkdirSync(configDir(), { recursive: true, mode: 0o700 });
  chmodSync(configDir(), 0o700);
  // Readable by this user only, from the moment it exists.
  writeFileSync(file(), JSON.stringify(credentials, null, 2) + "\n", { mode: 0o600 });
  chmodSync(file(), 0o600);
}

export function clearCredentials(): void {
  rmSync(file(), { force: true });
}
