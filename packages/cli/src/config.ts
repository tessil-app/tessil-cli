// Where the tool keeps what it must remember: which account it works for
// and the three secrets that prove it. They never leave this machine.

import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { keychainDelete, keychainRead, keychainStore } from "./keychain";

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

// The three values that prove who the tool is. Everything else in the file
// is a name or an address.
type Secrets = Pick<Credentials, "token" | "privateKey" | "secret">;
type OnDisk = Omit<Credentials, keyof Secrets> & Partial<Secrets> & { secretsIn?: "keychain" | "file" };

// One keychain entry per server and configuration folder.
const account = () => `${API_URL}@${Buffer.from(configDir()).toString("base64url")}`;

export function loadCredentials(): Credentials | null {
  if (!existsSync(file())) return null;
  try {
    const stored = JSON.parse(readFileSync(file(), "utf8")) as OnDisk;
    // A key is for one server. Pointing the tool elsewhere must not send it there.
    if (stored.apiUrl !== API_URL) return null;
    let secrets: Secrets | null = null;
    if (stored.secretsIn === "keychain") {
      const held = keychainRead(account());
      secrets = held ? (JSON.parse(Buffer.from(held, "base64url").toString("utf8")) as Secrets) : null;
    } else if (stored.token && stored.privateKey && stored.secret) {
      secrets = { token: stored.token, privateKey: stored.privateKey, secret: stored.secret };
    }
    if (!secrets) return null;
    const { secretsIn: _where, ...rest } = stored;
    return { ...rest, ...secrets };
  } catch {
    return null;
  }
}

/** Where the secrets ended up, so the caller can say so. */
export function saveCredentials(credentials: Credentials): "keychain" | "file" {
  const { token, privateKey, secret, ...plain } = credentials;
  const packed = Buffer.from(JSON.stringify({ token, privateKey, secret })).toString("base64url");
  const where = keychainStore(account(), packed) ? "keychain" : "file";
  const onDisk: OnDisk = where === "keychain" ? { ...plain, secretsIn: where } : { ...credentials, secretsIn: where };

  mkdirSync(configDir(), { recursive: true, mode: 0o700 });
  chmodSync(configDir(), 0o700);
  // Readable by this user only, from the moment it exists.
  rmSync(file(), { force: true });
  writeFileSync(file(), JSON.stringify(onDisk, null, 2) + "\n", { mode: 0o600 });
  chmodSync(file(), 0o600);
  return where;
}

export function clearCredentials(): void {
  keychainDelete(account());
  rmSync(file(), { force: true });
}
