import { spawn } from "node:child_process";

export class UserError extends Error {}

/** "7d", "12h", "90m" to whole hours. Null when it is not a duration. */
export function parseHours(input: string): number | null {
  const match = /^(\d+)\s*(h|d|w)?$/i.exec(input.trim());
  if (!match) return null;
  const n = Number(match[1]);
  const unit = (match[2] ?? "h").toLowerCase();
  return unit === "w" ? n * 168 : unit === "d" ? n * 24 : n;
}

export function describeHours(hours: number): string {
  if (hours % 24 === 0) return `${hours / 24} ${hours === 24 ? "day" : "days"}`;
  return `${hours} ${hours === 1 ? "hour" : "hours"}`;
}

export function formatSize(bytes: number): string {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${unit === 0 ? value : value.toFixed(value < 10 ? 2 : 1)} ${units[unit]}`;
}

export interface ParsedLink {
  id: string;
  fragment: string;
}

/** A transfer link, or just "id#key". Null when it is neither. */
export function parseTransferLink(input: string): ParsedLink | null {
  const match = /(?:\/d\/|^)([A-Za-z0-9_-]{21})#(.+)$/.exec(input.trim());
  return match ? { id: match[1], fragment: match[2] } : null;
}

/** A file name with nothing that could place it outside the folder it is saved in. */
export function safeFileName(name: string): string {
  const cleaned = printable(name)
    .replace(/[/\\]/g, "_")
    .replace(/^\.+/, "_")
    .trim();
  return cleaned.length > 0 ? cleaned.slice(0, 240) : "file";
}

/**
 * Text from somewhere else, made safe to print: a title or file name from a
 * link, a name or message from the server. Control characters could move
 * the cursor, recolour or rewrite what the terminal shows; the direction
 * overrides could make a name read as something it is not.
 */
export function printable(text: string): string {
  return text.replace(/[\u0000-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, "");
}

/**
 * Opens a page in the person's browser. Quietly does nothing where there is
 * none, or when the address is not a plain web address. Nothing here goes
 * through a shell.
 */
export function openInBrowser(address: string): void {
  let url: URL;
  try {
    url = new URL(address);
  } catch {
    return;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return;
  const [command, args] =
    process.platform === "darwin"
      ? ["open", [url.href]]
      : process.platform === "win32"
        ? ["rundll32", ["url.dll,FileProtocolHandler", url.href]]
        : ["xdg-open", [url.href]];
  try {
    const child = spawn(command, args, { stdio: "ignore", detached: true, shell: false });
    child.on("error", () => {});
    child.unref();
  } catch {
    // No browser to open; the address is printed as well.
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Reads one line typed at the terminal, without showing it. */
export async function askHidden(question: string): Promise<string> {
  if (!process.stdin.isTTY) throw new UserError("A password is needed, and there is no terminal to ask at.");
  process.stderr.write(question);
  process.stdin.setRawMode(true);
  process.stdin.resume();
  return new Promise((resolve, reject) => {
    let typed = "";
    const onData = (chunk: Buffer) => {
      for (const ch of chunk.toString("utf8")) {
        if (ch === "\r" || ch === "\n") {
          process.stdin.setRawMode(false);
          process.stdin.pause();
          process.stdin.off("data", onData);
          process.stderr.write("\n");
          resolve(typed);
          return;
        }
        if (ch === "\u0003") {
          process.stdin.setRawMode(false);
          process.stderr.write("\n");
          reject(new UserError("Cancelled."));
          return;
        }
        if (ch === "\u007f" || ch === "\b") typed = typed.slice(0, -1);
        else typed += ch;
      }
    };
    process.stdin.on("data", onData);
  });
}
