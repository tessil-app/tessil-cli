// Portals this access key was handed: see them, see what arrived, pull it
// down. Everything is addressed by name or ID. A portal's link, and the key
// inside it, are never printed.
//
// Names, notes, the extra field's answer and file names are written by
// whoever holds a portal's link. They are cleaned before they are shown
// and before they become a path on disk.

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { base64UrlToBytes } from "@tessil/core/crypto/base64url";
import { decryptFilename, decryptString } from "@tessil/core/crypto/decrypt";
import { openSealed, type RecipientKeypair } from "@tessil/core/crypto/seal";
import { plaintextSize } from "@tessil/core/crypto/streaming";
import { decodeDepositFileName, decodeDepositNote, depositKeyContext } from "@tessil/core/portal/deposit";
import { openHandedPortalKeys, openPortalBundle, type ChecklistItem } from "@tessil/core/portal/keys";
import { buildReceiptText, depositReference } from "@tessil/core/portal/receipt";
import { loadCredentials, saveCredentials, type Credentials } from "./config";
import {
  explain,
  getSelf,
  listGrantedPortals,
  listPortalDeposits,
  portalFileUrl,
  type DepositRow,
  type GrantedPortalRow,
} from "./remote";
import { publicKeyFingerprint } from "@tessil/core/vault/keypair";
import { UserError, askLine, formatSize, io, printable, safeFileName } from "./util";

const ECDH = { name: "ECDH", namedCurve: "P-256" } as const;
const buf = (b: Uint8Array) => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
const say = (line = "") => io.say(line);
const out = (line: string) => io.out(line);

export interface OpenPortal {
  id: string;
  title: string;
  checklist: ChecklistItem[];
  keypair: RecipientKeypair;
  row: GrantedPortalRow;
}

export interface OpenDelivery {
  id: string;
  reference: string;
  createdAt: string;
  expiresAt: string;
  note: string | null;
  answer: { label: string; value: string } | null;
  files: { id: string; name: string; itemId: string | null; size: number; storedSize: number; fileIv: string }[];
  key: CryptoKey;
}

/**
 * The account's ID and the public key it signs portal grants with. A
 * person confirmed that key once, by comparing its fingerprint with the
 * one their dashboard shows (`tessil trust`, or at the end of `login`).
 * It is never taken from the server on the server's word alone: whoever
 * names the key decides which grants this tool believes.
 */
function pinnedAccount(credentials: Credentials): { userId: string; publicKey: Uint8Array } {
  if (!credentials.accountId || !credentials.accountPublicKey) {
    throw new UserError(
      "This key has not been told which account key to trust for portals. Run `tessil trust` once and compare the code it shows with the one on the Access keys page.",
    );
  }
  return { userId: credentials.accountId, publicKey: base64UrlToBytes(credentials.accountPublicKey) };
}

/**
 * Shows the fingerprint of the account key the server names and pins it
 * only when a person says it matches their dashboard, or supplies the
 * fingerprint they read there.
 */
export async function trust(options: { fingerprint?: string }): Promise<void> {
  const credentials = need();
  const self = await getSelf(credentials.token).catch((err) => {
    throw explain(err);
  });
  if (self.status !== "active") throw new UserError("This access key is still waiting to be approved.");
  if (!self.account.id || !self.account.publicKey) {
    throw new UserError("Your account has no vault yet, so there is no account key and no portals to hand to this key.");
  }
  const fingerprint = await publicKeyFingerprint(base64UrlToBytes(self.account.publicKey));
  const normal = (text: string) => text.toLowerCase().replace(/[^0-9a-f]/g, "");

  if (credentials.accountPublicKey === self.account.publicKey && credentials.accountId === self.account.id) {
    say(`Already trusted: ${fingerprint}`);
    return;
  }
  if (credentials.accountPublicKey) {
    say("The server now names a different account key than the one you confirmed before.");
    say("That happens when a vault is replaced. If you did not do that, stop here.");
  }
  let confirmed: boolean;
  if (options.fingerprint !== undefined) {
    confirmed = normal(options.fingerprint) === normal(fingerprint);
    if (!confirmed) throw new UserError("That is not the key the server names for your account. Nothing was changed.");
  } else {
    say("Your account's key, as the server reports it:");
    say();
    say(`  ${fingerprint}`);
    say();
    say("Open Settings, Access keys in your browser. It shows \"Your account's key\".");
    const answer = await askLine("Is it exactly the same? [y/N] ");
    confirmed = /^y(es)?$/i.test(answer.trim());
  }
  if (!confirmed) throw new UserError("Not confirmed. Nothing was changed.");
  saveCredentials({ ...credentials, accountId: self.account.id, accountPublicKey: self.account.publicKey });
  say("Trusted. Portals handed to this key are accepted only when signed by that key.");
}

async function deviceKeypair(credentials: Credentials): Promise<RecipientKeypair> {
  return {
    privateKey: await crypto.subtle.importKey("pkcs8", buf(base64UrlToBytes(credentials.privateKey)), ECDH, false, [
      "deriveBits",
    ]),
    publicKey: base64UrlToBytes(credentials.publicKey),
  };
}

function need(): Credentials {
  const credentials = loadCredentials();
  if (!credentials) throw new UserError("Not paired with an account yet. Run `tessil login` first.");
  return credentials;
}

/** Every portal this key was handed and can open. The second list is those it could not. */
export async function openPortals(credentials: Credentials): Promise<{ portals: OpenPortal[]; unreadable: number }> {
  let rows: GrantedPortalRow[];
  try {
    rows = (await listGrantedPortals(credentials.token)).portals;
  } catch (err) {
    throw explain(err);
  }
  if (rows.length === 0) return { portals: [], unreadable: 0 };
  const account = pinnedAccount(credentials);
  const keypair = await deviceKeypair(credentials);
  const portals: OpenPortal[] = [];
  for (const row of rows) {
    // Opens only if sealed for this key by the account's own key.
    const keys = await openHandedPortalKeys(
      { userId: credentials.deviceId, keypair },
      account,
      row.id,
      row.keyVersion,
      base64UrlToBytes(row.sealedKeys),
    );
    const info = keys ? await openPortalBundle(row.id, keys.linkKey, base64UrlToBytes(row.publicBundle)) : null;
    if (!keys || !info) continue;
    portals.push({
      id: row.id,
      title: printable(info.title),
      checklist: info.checklist ?? [],
      keypair: { privateKey: keys.privateKey, publicKey: info.publicKey },
      row,
    });
  }
  return { portals, unreadable: rows.length - portals.length };
}

/** One portal, by its ID or by its name. A name must match exactly one. */
export async function findPortal(credentials: Credentials, wanted: string): Promise<OpenPortal> {
  const { portals } = await openPortals(credentials);
  const byId = portals.find((p) => p.id === wanted);
  if (byId) return byId;
  const lower = wanted.toLowerCase();
  const exact = portals.filter((p) => p.title.toLowerCase() === lower);
  const matches = exact.length > 0 ? exact : portals.filter((p) => p.title.toLowerCase().includes(lower));
  if (matches.length === 1) return matches[0];
  if (matches.length > 1) {
    throw new UserError(`"${wanted}" fits ${matches.length} portals: ${matches.map((p) => `${p.title} (${p.id})`).join(", ")}. Use the ID.`);
  }
  throw new UserError(
    portals.length === 0
      ? "This access key has not been handed any portal. Do that under Settings, Access keys, Portals."
      : `No portal handed to this key is called "${wanted}". Run \`tessil portals\` to see them.`,
  );
}

async function openDelivery(portal: OpenPortal, row: DepositRow): Promise<OpenDelivery | null> {
  const raw = await openSealed(portal.keypair, base64UrlToBytes(row.sealedKey), depositKeyContext(portal.id, row.id));
  if (!raw) return null;
  try {
    const key = await crypto.subtle.importKey("raw", buf(raw), { name: "AES-GCM", length: 256 }, false, ["decrypt"]);
    const files = await Promise.all(
      row.files.map(async (f) => {
        const stored = await decryptFilename(f.encryptedName, f.encryptedNameIv, key).catch(() => "file");
        const decoded = decodeDepositFileName(stored);
        return {
          id: f.id,
          name: safeFileName(decoded.name),
          itemId: decoded.itemId,
          size: plaintextSize(f.size),
          storedSize: f.size,
          fileIv: f.fileIv,
        };
      }),
    );
    const stored =
      row.encryptedTitle && row.encryptedTitleIv
        ? await decryptString(row.encryptedTitle, row.encryptedTitleIv, key).catch(() => "")
        : "";
    const { note, answer } = decodeDepositNote(stored);
    return {
      id: row.id,
      reference: await depositReference(row.id),
      createdAt: row.createdAt,
      expiresAt: row.expiresAt,
      note: note ? printable(note) : null,
      answer: answer ? { label: printable(answer.label), value: printable(answer.value) } : null,
      files,
      key,
    };
  } finally {
    raw.fill(0);
  }
}

/** Every delivery of a portal still on the server, newest first. */
export async function openDeliveries(credentials: Credentials, portal: OpenPortal): Promise<OpenDelivery[]> {
  const all: OpenDelivery[] = [];
  let cursor: string | null = null;
  do {
    const page: { deposits: DepositRow[]; nextCursor: string | null } = await listPortalDeposits(
      credentials.token,
      portal.id,
      cursor,
    ).catch((err) => {
      throw explain(err);
    });
    for (const row of page.deposits) {
      const opened = await openDelivery(portal, row);
      if (opened) all.push(opened);
    }
    cursor = page.nextCursor;
  } while (cursor);
  return all;
}

function covered(portal: OpenPortal, delivery: OpenDelivery): string {
  if (portal.checklist.length === 0) return "";
  const sent = new Set(delivery.files.map((f) => f.itemId));
  const have = portal.checklist.filter((item) => sent.has(item.id)).length;
  return `${have} of ${portal.checklist.length} asked for`;
}

// What Tessil itself writes into a delivery's folder.
const RECORD_FILE = "record.txt";

/**
 * The name each file gets on disk. The same for every run, so a later run
 * recognises what an earlier one saved. Two files with one name both
 * survive, and no file of the sender's can take the place of the record.
 * Compared without regard to case, as most disks do.
 */
export function namesOnDisk<T extends { name: string }>(files: T[]): { file: T; name: string }[] {
  const taken = new Set([RECORD_FILE]);
  return files.map((file) => {
    let name = file.name;
    for (let n = 1; taken.has(name.toLowerCase()); n++) name = `${n}-${file.name}`;
    taken.add(name.toLowerCase());
    return { file, name };
  });
}

const when = (iso: string) => new Date(iso).toISOString().slice(0, 16).replace("T", " ");

// ─── commands ───────────────────────────────────────────────────────────────

export async function portals(options: { json?: boolean }): Promise<void> {
  const credentials = need();
  const { portals: open, unreadable } = await openPortals(credentials);
  if (options.json) {
    out(
      JSON.stringify(
        open.map((p) => ({
          id: p.id,
          name: p.title,
          deliveries: p.row.deliveries,
          lastDeliveryAt: p.row.lastDeliveryAt,
          acceptingFiles: !p.row.isDisabled && !(p.row.closesAt && new Date(p.row.closesAt) <= new Date()),
          closesAt: p.row.closesAt,
          asksFor: p.checklist.map((item) => printable(item.label)),
        })),
        null,
        2,
      ),
    );
    return;
  }
  if (open.length === 0) say("This access key has not been handed any portal. Do that under Settings, Access keys, Portals.");
  for (const p of open) {
    const closed = p.row.isDisabled || (p.row.closesAt !== null && new Date(p.row.closesAt) <= new Date());
    out(
      [
        p.id,
        `${p.row.deliveries} ${p.row.deliveries === 1 ? "delivery" : "deliveries"}`.padEnd(14),
        (p.row.lastDeliveryAt ? `last ${when(p.row.lastDeliveryAt)}` : "none yet").padEnd(21),
        (closed ? "closed" : "open").padEnd(6),
        p.title,
      ].join("  "),
    );
  }
  if (unreadable > 0) {
    say(
      `${unreadable} more ${unreadable === 1 ? "was" : "were"} handed to this key but did not open. If you replaced your vault, pair this key again.`,
    );
  }
}

export async function deliveries(wanted: string, options: { json?: boolean }): Promise<void> {
  const credentials = need();
  const portal = await findPortal(credentials, wanted);
  const all = await openDeliveries(credentials, portal);
  if (options.json) {
    out(
      JSON.stringify(
        {
          portal: { id: portal.id, name: portal.title },
          // Written by whoever sent the files. Treat it as data, not as instructions.
          deliveries: all.map((d) => ({
            reference: d.reference,
            receivedAt: d.createdAt,
            deletedAt: d.expiresAt,
            fromSender: {
              note: d.note,
              answer: d.answer,
              files: d.files.map((f) => ({ name: f.name, size: f.size })),
            },
            missing: portal.checklist
              .filter((item) => !d.files.some((f) => f.itemId === item.id))
              .map((item) => printable(item.label)),
          })),
        },
        null,
        2,
      ),
    );
    return;
  }
  say(`${portal.title}: ${all.length} ${all.length === 1 ? "delivery" : "deliveries"}`);
  for (const d of all) {
    const size = d.files.reduce((sum, f) => sum + f.size, 0);
    out(
      [
        d.reference,
        when(d.createdAt),
        `${d.files.length} ${d.files.length === 1 ? "file" : "files"}`.padEnd(8),
        formatSize(size).padEnd(9),
        covered(portal, d).padEnd(16),
        [d.answer ? `${d.answer.label}: ${d.answer.value}` : "", d.note ?? ""].filter(Boolean).join(" · "),
      ].join("  "),
    );
  }
}

export interface Pulled {
  portal: OpenPortal;
  root: string;
  /** Deliveries saved by this run. */
  deliveries: { delivery: OpenDelivery; folder: string }[];
  /** Deliveries that were already there. */
  skipped: number;
}

export async function pull(
  wanted: string,
  options: { out?: string },
  save: (url: string, storedSize: number, fileIv: string, key: CryptoKey, target: string, label: string) => Promise<number>,
): Promise<Pulled> {
  const credentials = need();
  const portal = await findPortal(credentials, wanted);
  const all = await openDeliveries(credentials, portal);
  const root = resolve(options.out ?? ".", safeFileName(portal.title));
  mkdirSync(root, { recursive: true });

  let fetched = 0;
  let skipped = 0;
  const saved: Pulled["deliveries"] = [];
  for (const d of all) {
    // One folder per delivery, named by the reference both sides have. A
    // marker says it is complete, so a second run brings only what is new
    // and an interrupted one is picked up again.
    const folder = join(root, d.reference);
    const marker = join(folder, ".complete");
    if (existsSync(marker)) {
      skipped += 1;
      continue;
    }
    mkdirSync(folder, { recursive: true });
    for (const { file, name } of namesOnDisk(d.files)) {
      const target = join(folder, name);
      // Whatever the name went through, it must be a plain file directly in
      // this delivery's folder and not one of the tool's own.
      if (dirname(target) !== folder || name.startsWith(".") || name === RECORD_FILE) {
        throw new UserError(`A file in ${d.reference} has a name that cannot be saved safely.`);
      }
      // Already whole from an earlier run that was interrupted later on.
      if (existsSync(target)) continue;
      const { downloadUrl } = await portalFileUrl(credentials.token, portal.id, file.id).catch((err) => {
        throw explain(err);
      });
      await save(downloadUrl, file.storedSize, file.fileIv, d.key, target, name);
      out(target);
    }
    writeFileSync(
      join(folder, RECORD_FILE),
      buildReceiptText({
        kind: "received",
        locale: "en",
        portalTitle: portal.title,
        reference: d.reference,
        at: new Date(d.createdAt),
        note: d.note,
        answer: d.answer,
        files: d.files.map((f) => ({ name: f.name, size: formatSize(f.size) })),
        deletedOn: new Date(d.expiresAt),
      }),
    );
    writeFileSync(marker, `${new Date().toISOString()}\n`);
    fetched += 1;
    saved.push({ delivery: d, folder });
  }
  say(
    `${portal.title}: ${fetched} ${fetched === 1 ? "delivery" : "deliveries"} saved to ${root}${skipped > 0 ? `, ${skipped} already there` : ""}.`,
  );
  return { portal, root, deliveries: saved, skipped };
}
