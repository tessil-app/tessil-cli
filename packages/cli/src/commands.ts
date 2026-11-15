// What each command does. Printing for a person happens here; anything
// another program might read goes to standard output, the rest to standard
// error.

import {
  closeSync,
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  openSync,
  readSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { hostname } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { ApiError } from "@tessil/core/api/client";
import { bytesToBase64Url } from "@tessil/core/crypto/base64url";
import { decryptFile, decryptFilename, decryptString } from "@tessil/core/crypto/decrypt";
import { encryptFilename, encryptString } from "@tessil/core/crypto/encrypt";
import { exportKey, generateKey, importKey } from "@tessil/core/crypto/key";
import { encryptFileStream, isStreamingFormat, plaintextSize, streamingDecrypt } from "@tessil/core/crypto/streaming";
import {
  deriveTransferPassword,
  isProtectedFragment,
  protectTransferKey,
  saltFromFragment,
  unwrapTransferKey as openProtectedFragment,
} from "@tessil/core/crypto/transferPassword";
import { blockedKind } from "@tessil/core/upload/fileTypeCheck";
import { uploadEncryptedStreamMultipart } from "@tessil/core/upload/multipart";
import { runFiles } from "@tessil/core/upload/pool";
import { API_URL, WEB_URL, clearCredentials, loadCredentials, saveCredentials, type Credentials } from "./config";
import { newDevice, unwrapTransferKey, wrapTransferKey } from "./device";
import {
  anonymousClient,
  clientFor,
  deleteOwnTransfer,
  explain,
  getSelf,
  listOwnTransfers,
  registerDevice,
  signOut,
  type SelfActive,
} from "./remote";
import {
  UserError,
  askHidden,
  copyToClipboard,
  describeHours,
  formatSize,
  io,
  openInBrowser,
  parseHours,
  parseTransferLink,
  printable,
  safeFileName,
  sleep,
} from "./util";

const TITLE_MAX = 100;
const MIN_PASSWORD_LENGTH = 8;
const PIECE_BYTES = 256 * 1024;
const STRETCH_BYTES = 16 * 1024 * 1024;

/**
 * A stored file as a stream, read with ranged requests of a fixed size and
 * handed on in small pieces. Nothing is asked for until it is wanted.
 */
function rangedBody(url: string, size: number, label: string): ReadableStream<Uint8Array> {
  let offset = 0;
  let pending: Uint8Array | null = null;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (!pending) {
        if (offset >= size) {
          controller.close();
          return;
        }
        const end = Math.min(offset + STRETCH_BYTES, size) - 1;
        const response = await fetch(url, { headers: { Range: `bytes=${offset}-${end}` } });
        if (response.status !== 206 && !(response.status === 200 && offset === 0 && end === size - 1)) {
          throw new UserError(`Could not download ${label} (${response.status}).`);
        }
        pending = new Uint8Array(await response.arrayBuffer());
        if (pending.length !== end - offset + 1) throw new UserError(`The download of ${label} was cut short.`);
        offset = end + 1;
      }
      const piece = pending.subarray(0, PIECE_BYTES);
      pending = pending.length > PIECE_BYTES ? pending.subarray(PIECE_BYTES) : null;
      controller.enqueue(piece);
    },
  });
}

/**
 * Downloads one stored file, decrypts it and writes it to `target`, which
 * must not exist yet. Returns the size of what was written.
 */
export async function saveEncryptedFile(
  url: string,
  storedSize: number,
  fileIv: string,
  key: CryptoKey,
  target: string,
  label: string,
): Promise<number> {
  // Fetched a stretch at a time. Memory then stays at one stretch however
  // fast the connection is and however large the file.
  const rest = rangedBody(url, storedSize, label);
  const reader = rest.getReader();
  const first = await reader.read();
  const head = first.value ?? new Uint8Array(0);
  reader.releaseLock();
  const body = prepend(head, rest);

  // Written beside the target under a name no sender can choose (theirs
  // never start with a dot), and moved into place only when whole. A
  // download that was cut off leaves no file that looks finished.
  const part = join(dirname(target), `.${basename(target)}.part`);
  rmSync(part, { force: true });
  let written: number;
  try {
    // Today's chunked format, or the older one that is decrypted whole.
    if (isStreamingFormat(head)) {
      await pipeline(Readable.fromWeb(streamingDecrypt(body, storedSize, key) as never), createWriteStream(part, { flags: "wx" }));
      written = plaintextSize(storedSize);
    } else {
      const plain = await decryptFile(await new Response(body).arrayBuffer(), fileIv, key);
      writeFileSync(part, new Uint8Array(await plain.arrayBuffer()), { flag: "wx" });
      written = plain.size;
    }
    if (existsSync(target)) throw new UserError(`${label} is already there; nothing was replaced.`);
    renameSync(part, target);
  } catch (err) {
    rmSync(part, { force: true });
    throw err;
  }
  return written;
}

/** `first`, then the rest of `stream`. For looking at the start of a stream without losing it. */
function prepend(first: Uint8Array, stream: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
  const reader = stream.getReader();
  let sent = first.length === 0;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (!sent) {
        sent = true;
        controller.enqueue(first);
        return;
      }
      const { done, value } = await reader.read();
      if (done) controller.close();
      else controller.enqueue(value);
    },
    cancel: (reason) => reader.cancel(reason),
  });
}
const say = (line = "") => io.say(line);
const out = (line: string) => io.out(line);

function need(): Credentials {
  const credentials = loadCredentials();
  if (!credentials) throw new UserError("Not paired with an account yet. Run `tessil login` first.");
  return credentials;
}

async function active(credentials: Credentials): Promise<SelfActive> {
  try {
    const self = await getSelf(credentials.token);
    if (self.status !== "active") throw new UserError("This access key is still waiting to be approved.");
    return self;
  } catch (err) {
    throw explain(err);
  }
}

// ─── login, logout, whoami ──────────────────────────────────────────────────

export async function login(options: { name?: string }): Promise<void> {
  const existing = loadCredentials();
  if (existing) {
    const self = await getSelf(existing.token).catch(() => null);
    if (self?.status === "active") {
      say(`Already paired with ${printable(existing.email)} as "${printable(self.device.name)}". Run \`tessil logout\` first to pair again.`);
      return;
    }
  }

  const device = await newDevice();
  const name = (options.name ?? `${hostname()}, tessil`).slice(0, 80);
  let registered;
  try {
    registered = await registerDevice({ name, publicKey: device.publicKey, tokenHash: device.tokenHash });
  } catch (err) {
    throw explain(err);
  }

  // The code comes from the server and ends up in an address and on screen.
  if (!/^[A-Z2-9]{4}-[A-Z2-9]{4}$/.test(registered.pairingCode)) {
    throw new UserError("The server answered with something that is not a pairing code.");
  }
  const url = `${WEB_URL}/dashboard/settings/access?code=${encodeURIComponent(registered.pairingCode)}`;
  say("To let this program act for your account, approve it in your browser:");
  say();
  say(`  ${url}`);
  say();
  say(`  Code            ${registered.pairingCode}`);
  say(`  This key        ${device.fingerprint}`);
  say();
  say("The page shows the same key code. If it differs, do not approve.");
  say("Waiting for approval (ten minutes at most)…");
  openInBrowser(url);

  const deadline = new Date(registered.pairingExpiresAt).getTime();
  while (Date.now() < deadline) {
    await sleep(2000);
    let self;
    try {
      self = await getSelf(device.token);
    } catch {
      // Gone: the code ran out or the request was turned down.
      break;
    }
    if (self.status === "active") {
      const where = saveCredentials({
        apiUrl: API_URL,
        deviceId: self.device.id,
        name: self.device.name,
        token: device.token,
        privateKey: device.privateKey,
        publicKey: device.publicKey,
        secret: device.secret,
        email: self.account.email,
      });
      say();
      say(`Paired with ${printable(self.account.email)} as "${printable(self.device.name)}".`);
      say(`It may: ${printable(self.device.permissions.join(", "))}.`);
      say(
        where === "keychain"
          ? "Its secrets are in your system keychain."
          : "Its secrets are in a file only you can read; this system has no keychain the tool can use.",
      );
      if (self.device.permissions.includes("portals:read")) {
        say();
        say("Before it can open portals, run `tessil trust` once to confirm your account's key.");
      }
      return;
    }
  }
  throw new UserError("Not approved in time. Run `tessil login` again.");
}

export async function logout(): Promise<void> {
  const credentials = loadCredentials();
  if (!credentials) {
    say("Not paired.");
    return;
  }
  // The key is revoked on the server too, so a copy of the file is worthless.
  await signOut(credentials.token).catch(() => {});
  clearCredentials();
  say("Signed out. This access key no longer works.");
}

export async function whoami(): Promise<void> {
  const credentials = need();
  const self = await active(credentials);
  out(`${printable(self.account.email)} (${printable(self.account.tier)})`);
  say(`Access key   ${printable(self.device.name)}`);
  say(`May          ${printable(self.device.permissions.join(", "))}`);
  if (self.device.expiresAt) {
    const days = Math.ceil((new Date(self.device.expiresAt).getTime() - Date.now()) / 86_400_000);
    say(`Works for    ${days} more ${days === 1 ? "day" : "days"}`);
  }
  say(`Server       ${API_URL}`);
}

// ─── send ───────────────────────────────────────────────────────────────────

export interface SendOptions {
  expires?: string;
  password?: boolean;
  maxDownloads?: number;
  title?: string;
  /** Print only the link, for use in a script. */
  quiet?: boolean;
}

// Shown to the person downloading, next to the file's name. Nothing depends
// on it; anything not listed is "a file".
const CONTENT_TYPES: Record<string, string> = {
  pdf: "application/pdf",
  zip: "application/zip",
  gz: "application/gzip",
  tar: "application/x-tar",
  json: "application/json",
  txt: "text/plain",
  log: "text/plain",
  md: "text/markdown",
  csv: "text/csv",
  html: "text/html",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  heic: "image/heic",
  mp4: "video/mp4",
  mov: "video/quicktime",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xls: "application/vnd.ms-excel",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ppt: "application/vnd.ms-powerpoint",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
};

export function contentTypeOf(path: string): string {
  const dot = path.lastIndexOf(".");
  const extension = dot === -1 ? "" : path.slice(dot + 1).toLowerCase();
  return CONTENT_TYPES[extension] ?? "application/octet-stream";
}

export interface DiskFile {
  name: string;
  size: number;
  type: string;
  /** The first bytes, for telling a program or script from anything else. */
  head: Blob;
  /** What the shared code needs of a browser's File: a size and a stream. */
  asFile: File;
}

/**
 * A file on disk as the shared code wants it.
 *
 * It is read with Node's stream, which works the same under Node and Bun.
 * Not with Bun's own file stream: in Bun 1.3, finishing one of those while
 * data is arriving on standard input ends standard input, and standard
 * input is what the MCP server lives on. It quit after every upload.
 * `fs.openAsBlob` behaves the same way there.
 */
export function fileFromDisk(path: string): DiskFile {
  const full = resolve(path);
  if (!existsSync(full)) throw new UserError(`No such file: ${path}`);
  const stat = statSync(full);
  if (stat.isDirectory()) throw new UserError(`${path} is a folder. Put it in an archive first, then send that.`);
  const start = Buffer.alloc(Math.min(stat.size, 512));
  const fd = openSync(full, "r");
  try {
    readSync(fd, start, 0, start.length, 0);
  } finally {
    closeSync(fd);
  }
  return {
    name: basename(full),
    size: stat.size,
    type: contentTypeOf(full),
    head: new Blob([start]),
    asFile: {
      size: stat.size,
      stream: () => Readable.toWeb(createReadStream(full)) as unknown as ReadableStream<Uint8Array>,
    } as unknown as File,
  };
}

export interface Sent {
  id: string;
  link: string;
  files: { name: string; size: number }[];
  totalBytes: number;
  hours: number;
  expiresAt: string;
}

export async function send(paths: string[], options: SendOptions): Promise<Sent> {
  if (paths.length === 0) throw new UserError("Nothing to send. Usage: tessil send <file> [more files]");
  const credentials = need();
  const self = await active(credentials);
  const api = clientFor(credentials);
  const files = paths.map(fileFromDisk);

  const allowed = self.caps.allowedExpiryHours;
  const longest = Math.max(...allowed);
  let hours = Math.min(longest, 168);
  if (options.expires) {
    const wanted = parseHours(options.expires);
    if (wanted === null) throw new UserError(`"${options.expires}" is not a duration. Use something like 12h, 3d or 2w.`);
    if (!allowed.includes(wanted)) {
      throw new UserError(
        `Your plan allows these lifetimes: ${allowed.map(describeHours).join(", ")}. "${options.expires}" is not one of them.`,
      );
    }
    hours = wanted;
  } else if (!allowed.includes(hours)) {
    hours = longest;
  }

  const total = files.reduce((sum, f) => sum + f.size, 0);
  for (const file of files) {
    if (file.size === 0) throw new UserError(`${file.name} is empty.`);
    if (file.size > self.caps.maxFileSize) {
      throw new UserError(`${file.name} is ${formatSize(file.size)}. Your plan allows ${formatSize(self.caps.maxFileSize)} per file.`);
    }
    // The same rule as the website: no programs and no scripts.
    const blocked = await blockedKind(file.head);
    if (blocked) {
      throw new UserError(
        `${file.name} is ${blocked === "script" ? "a script" : "a program"}, which Tessil does not carry as it is. Put it in an archive and send that.`,
      );
    }
  }
  if (total > self.caps.maxTransferSize) {
    throw new UserError(`${formatSize(total)} in one transfer. Your plan allows ${formatSize(self.caps.maxTransferSize)}.`);
  }

  let password: string | undefined;
  if (options.password) {
    password = await askHidden("Password for the link: ");
    if (password.length < MIN_PASSWORD_LENGTH) throw new UserError(`Use at least ${MIN_PASSWORD_LENGTH} characters.`);
    if ((await askHidden("Once more: ")) !== password) throw new UserError("Those two did not match.");
  }

  const key = await generateKey();
  const protectedKey = password ? await protectTransferKey(key, password) : null;
  const title = options.title?.trim().slice(0, TITLE_MAX);
  const encryptedTitle = title ? await encryptString(title, key) : null;

  let transferId: string;
  let expiresAt: string;
  try {
    const created = await api.createTransfer(
      hours,
      protectedKey ? { verifier: protectedKey.verifier, salt: protectedKey.salt } : undefined,
      options.maxDownloads ?? null,
      encryptedTitle ? { encryptedTitle: encryptedTitle.ciphertext, encryptedTitleIv: encryptedTitle.iv } : null,
    );
    transferId = created.transferId;
    expiresAt = created.expiresAt;
  } catch (err) {
    throw explain(err);
  }

  const progress = new Array<number>(files.length).fill(0);
  const report = () => {
    if (options.quiet || !process.stderr.isTTY) return;
    const done = progress.reduce((sum, p, i) => sum + (p / 100) * files[i].size, 0);
    process.stderr.write(`\rEncrypting and uploading  ${Math.floor((done / total) * 100)}%   `);
  };

  try {
    await runFiles(
      files,
      (file) => file.size,
      async (file, i, signal) => {
        const { encryptedName, iv } = await encryptFilename(file.name, key);
        const encryptor = encryptFileStream(file.asFile, key);
        const init = await api.initMultipartUpload({
          transferId,
          contentType: file.type || "application/octet-stream",
          encryptedName,
          encryptedNameIv: iv,
          fileIv: encryptor.ivB64,
          size: encryptor.size,
        });
        await uploadEncryptedStreamMultipart({
          uploadId: init.uploadId,
          fileId: init.fileId,
          transferId,
          r2Key: init.r2Key,
          source: encryptor.stream,
          partUrls: init.partUrls,
          signal,
          api,
          onProgress: (p) => {
            progress[i] = p.percent;
            report();
          },
        });
        progress[i] = 100;
        report();
      },
    );

    const raw = new Uint8Array(await crypto.subtle.exportKey("raw", key));
    const wrappedKey = await wrapTransferKey(credentials.secret, credentials.deviceId, transferId, raw);
    raw.fill(0);
    await api.completeTransfer(transferId, { wrappedKey });
  } catch (err) {
    await api.abortTransfer(transferId).catch(() => {});
    if (!options.quiet && process.stderr.isTTY) process.stderr.write("\n");
    throw explain(err);
  }
  if (!options.quiet && process.stderr.isTTY) process.stderr.write("\r\x1b[K");

  const link = `${WEB_URL}/d/${transferId}#${protectedKey ? protectedKey.fragment : await exportKey(key)}`;
  if (!options.quiet) {
    say(`Sent ${files.length === 1 ? files[0].name : `${files.length} files`} (${formatSize(total)}), encrypted on this machine.`);
    say(`The link works for ${describeHours(hours)}${options.maxDownloads ? `, ${options.maxDownloads} ${options.maxDownloads === 1 ? "download" : "downloads"}` : ""}${password ? ", with the password you chose" : ""}.`);
    say();
  }
  out(link);
  return {
    id: transferId,
    link,
    files: files.map((f) => ({ name: f.name, size: f.size })),
    totalBytes: total,
    hours,
    expiresAt,
  };
}

// ─── get ────────────────────────────────────────────────────────────────────

/** Downloads and decrypts a link. Returns where each file was saved. */
export async function get(link: string, options: { out?: string }): Promise<string[]> {
  // Fetching needs nothing from the account, but the tool is for accounts.
  need();
  const parsed = parseTransferLink(link);
  if (!parsed) throw new UserError("That is not a Tessil link. It should look like https://tessil.app/d/…#…");
  const api = anonymousClient();
  const folder = resolve(options.out ?? ".");
  mkdirSync(folder, { recursive: true });

  let meta;
  try {
    meta = await api.getTransferMetadata(parsed.id);
  } catch (err) {
    if (err instanceof ApiError && (err.status === 404 || err.status === 410)) {
      throw new UserError("That transfer no longer exists. It may have expired or been deleted.");
    }
    throw explain(err);
  }

  let key: CryptoKey;
  let accessToken: string | undefined;
  if (isProtectedFragment(parsed.fragment)) {
    const password = await askHidden("Password for this link: ");
    const derived = await deriveTransferPassword(password, saltFromFragment(parsed.fragment));
    try {
      key = await openProtectedFragment(parsed.fragment, derived.wrappingKey);
      meta = await api.verifyTransferPassword(parsed.id, derived.verifier);
      accessToken = meta.accessToken;
    } catch {
      throw new UserError("That password is not right.");
    }
  } else {
    if (meta.passwordRequired) throw new UserError("This link is from an older version of Tessil and needs a password; open it in a browser.");
    try {
      key = await importKey(parsed.fragment);
    } catch {
      throw new UserError("The part of the link after # is damaged. Copy the whole link again.");
    }
  }

  const files = meta.files ?? [];
  if (files.length === 0) throw new UserError("That transfer has no files.");
  const saved: string[] = [];
  const title =
    meta.encryptedTitle && meta.encryptedTitleIv
      ? await decryptString(meta.encryptedTitle, meta.encryptedTitleIv, key).catch(() => null)
      : null;
  if (title) say(`"${printable(title)}"`);

  for (const file of files) {
    // The name was chosen by whoever sent this. It is never allowed to
    // point outside the folder, and never replaces a file already there.
    // From here on only the cleaned name is used, on disk and on screen.
    const stored = safeFileName(await decryptFilename(file.encryptedName, file.encryptedNameIv, key).catch(() => "file"));
    let target = join(folder, stored);
    for (let n = 1; existsSync(target); n++) target = join(folder, `${n}-${stored}`);

    const { downloadUrl } = await api.getDownloadUrl(file.id, accessToken).catch((err) => {
      throw explain(err);
    });
    const bytes = await saveEncryptedFile(downloadUrl, file.size, file.fileIv, key, target, stored);
    say(`  ${target}  (${formatSize(bytes)})`);
    out(target);
    saved.push(target);
  }
  return saved;
}

// ─── list, revoke ───────────────────────────────────────────────────────────

export interface SentRow {
  id: string;
  title: string | null;
  files: number;
  size: number;
  downloads: number;
  expiresAt: string;
  complete: boolean;
  password: boolean;
}

/** What this key sent and still exists, with titles it can read itself. */
export async function sentTransfers(): Promise<SentRow[]> {
  const credentials = need();
  let res;
  try {
    res = await listOwnTransfers(credentials.token);
  } catch (err) {
    throw explain(err);
  }
  const rows: SentRow[] = [];
  for (const t of res.transfers) {
    let title: string | null = null;
    const raw = t.wrappedKey
      ? await unwrapTransferKey(credentials.secret, credentials.deviceId, t.id, t.wrappedKey)
      : null;
    if (raw && t.encryptedTitle && t.encryptedTitleIv) {
      const key = await importKey(bytesToBase64Url(raw));
      title = await decryptString(t.encryptedTitle, t.encryptedTitleIv, key).catch(() => null);
    }
    rows.push({
      id: t.id,
      title: title ? printable(title) : null,
      files: t.fileCount,
      size: t.totalBytes,
      downloads: t.downloadCount,
      expiresAt: t.expiresAt,
      complete: t.isCompleted,
      password: t.hasPassword,
    });
  }
  return rows;
}

export async function list(options: { json?: boolean }): Promise<void> {
  const rows = await sentTransfers();
  if (options.json) {
    out(JSON.stringify(rows, null, 2));
    return;
  }
  if (rows.length === 0) {
    say("This access key has not sent anything that still exists.");
    return;
  }
  for (const r of rows) {
    const left = Math.ceil((new Date(r.expiresAt).getTime() - Date.now()) / 3_600_000);
    const lifetime = left <= 0 ? "expired" : left < 48 ? `${left}h left` : `${Math.round(left / 24)}d left`;
    out(
      [
        r.id,
        `${r.files} ${r.files === 1 ? "file" : "files"}`.padEnd(8),
        formatSize(r.size).padEnd(9),
        `${r.downloads} ${r.downloads === 1 ? "download" : "downloads"}`.padEnd(12),
        lifetime.padEnd(9),
        r.title ?? (r.complete ? "" : "(not finished)"),
      ].join("  "),
    );
  }
}

/**
 * The link of something this key sent, built again from the key it kept.
 * For a person at a terminal: how a link reaches them when an assistant
 * did the sending and was not given it.
 */
export async function link(id: string, options: { copy?: boolean } = {}): Promise<string> {
  const credentials = need();
  if (!/^[A-Za-z0-9_-]{21}$/.test(id)) throw new UserError("Give the transfer's ID, as shown by `tessil list`.");
  let res;
  try {
    res = await listOwnTransfers(credentials.token);
  } catch (err) {
    throw explain(err);
  }
  const row = res.transfers.find((t) => t.id === id);
  if (!row) throw new UserError("No transfer of this access key has that ID.");
  if (row.hasPassword) {
    throw new UserError("That transfer has a password, and its link was made with it. It cannot be rebuilt here.");
  }
  const raw = row.wrappedKey
    ? await unwrapTransferKey(credentials.secret, credentials.deviceId, id, row.wrappedKey)
    : null;
  if (!raw) throw new UserError("This machine no longer has the key for that transfer.");
  const built = `${WEB_URL}/d/${id}#${bytesToBase64Url(raw)}`;
  // This command exists so a person can get a link an assistant was not
  // given. Run by a program, with its output captured, it would hand the
  // link straight back to that program.
  if (options.copy) {
    if (!copyToClipboard(built)) throw new UserError("This machine has no clipboard the tool can use.");
    say("Copied to your clipboard.");
  } else if (process.stdout.isTTY) {
    out(built);
  } else {
    throw new UserError("`tessil link` prints only to a terminal. Use `tessil link <id> --copy` to put it on the clipboard.");
  }
  return built;
}

export async function revoke(id: string): Promise<void> {
  const credentials = need();
  const transferId = parseTransferLink(id)?.id ?? id;
  if (!/^[A-Za-z0-9_-]{21}$/.test(transferId)) throw new UserError("Give the transfer's ID, as shown by `tessil list`.");
  try {
    await deleteOwnTransfer(credentials.token, transferId);
  } catch (err) {
    const e = explain(err);
    throw e.message === "Not found" ? new UserError("No transfer of this access key has that ID.") : e;
  }
  say("Deleted. The link no longer works.");
}
