#!/usr/bin/env bun
// tessil: send and fetch end-to-end encrypted files from a terminal.

import { get, list, login, logout, revoke, send, whoami } from "./commands";
import { UserError } from "./util";

const HELP = `tessil: end-to-end encrypted file transfer, from a terminal.

Usage
  tessil login [--name <name>]      Pair this machine with your account
  tessil whoami                     Show the account and what this key may do
  tessil send <file>...             Encrypt and upload, print a link
      --expires <12h|3d|2w>           How long the link works
      --password                      Ask for a password to protect the link
      --max-downloads <n>             Stop after this many downloads
      --title <text>                  A title, encrypted like the files
      --quiet                         Print only the link
  tessil get <link> [--out <dir>]   Download and decrypt a link
  tessil list [--json]              What this key sent
  tessil revoke <id>                Delete something this key sent
  tessil logout                     Sign this machine out

Files are encrypted on this machine before anything is uploaded.
The server never sees their contents, their names or the key in the link.
`;

interface Parsed {
  positional: string[];
  flags: Record<string, string | boolean>;
}

const VALUE_FLAGS = new Set(["name", "expires", "max-downloads", "title", "out"]);

function parse(args: string[]): Parsed {
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--") {
      positional.push(...args.slice(i + 1));
      break;
    }
    if (arg.startsWith("--")) {
      const [name, inline] = arg.slice(2).split(/=(.*)/s, 2);
      if (VALUE_FLAGS.has(name)) {
        const value = inline ?? args[++i];
        if (value === undefined) throw new UserError(`--${name} needs a value.`);
        flags[name] = value;
      } else {
        flags[name] = true;
      }
    } else {
      positional.push(arg);
    }
  }
  return { positional, flags };
}

async function run(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  if (!command || command === "help" || command === "--help" || command === "-h") {
    process.stdout.write(HELP);
    return;
  }
  if (command === "--version" || command === "-v") {
    const { version } = await import("../package.json");
    process.stdout.write(`${version}\n`);
    return;
  }
  const { positional, flags } = parse(rest);
  const text = (name: string) => (typeof flags[name] === "string" ? (flags[name] as string) : undefined);

  switch (command) {
    case "login":
      return login({ name: text("name") });
    case "logout":
      return logout();
    case "whoami":
      return whoami();
    case "send": {
      const max = text("max-downloads");
      const maxDownloads = max === undefined ? undefined : Number(max);
      if (maxDownloads !== undefined && (!Number.isInteger(maxDownloads) || maxDownloads < 1 || maxDownloads > 100)) {
        throw new UserError("--max-downloads takes a whole number from 1 to 100.");
      }
      await send(positional, {
        expires: text("expires"),
        password: flags.password === true,
        maxDownloads,
        title: text("title"),
        quiet: flags.quiet === true,
      });
      return;
    }
    case "get":
      if (positional.length !== 1) throw new UserError("Usage: tessil get <link> [--out <dir>]");
      return get(positional[0], { out: text("out") });
    case "list":
      return list({ json: flags.json === true });
    case "revoke":
      if (positional.length !== 1) throw new UserError("Usage: tessil revoke <id>");
      return revoke(positional[0]);
    default:
      throw new UserError(`Unknown command "${command}". Run \`tessil help\`.`);
  }
}

run().catch((err) => {
  if (err instanceof UserError) {
    process.stderr.write(`${err.message}\n`);
  } else {
    process.stderr.write(`Something went wrong: ${err instanceof Error ? err.message : String(err)}\n`);
    if (process.env.TESSIL_DEBUG && err instanceof Error) process.stderr.write(`${err.stack}\n`);
  }
  process.exit(1);
});
