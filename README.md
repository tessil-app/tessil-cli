# tessil

Send and fetch end-to-end encrypted files from a terminal. The command-line tool for
[tessil.app](https://tessil.app).

Files are encrypted on your machine before anything is uploaded. The server never sees their
contents, their names, or the key in the link.

> **Status: early.** Not published yet. The server side is live; the page where you approve
> the tool is not linked from the site until this is released.

## What it does

```
tessil login                      Pair this machine with your account
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

tessil portals [--json]           Portals this key was handed
tessil deliveries <portal>        What arrived in one, by name or ID  [--json]
tessil pull <portal> [--out dir]  Download what arrived; again later for what is new
```

Links go to standard output and everything else to standard error, so
`tessil send report.pdf --quiet | pbcopy` puts just the link on the clipboard.

## How pairing works

`tessil login` does not ask for your email or password. It makes its own key pair and token
on your machine, shows a short code, and opens a page in your browser. There you see the
same key code the tool printed, choose what the tool may do, and approve.

The result is an **access key**:

- It can only do what you ticked: send, see what it sent, delete what it sent.
- It never has your vault, your password or your browser session, and cannot reach account
  settings, billing or portals.
- It works for 90 days and can be renewed or revoked in the dashboard at any time.
  "Sign out everywhere" revokes every access key too.

What the tool remembers is kept in `~/.config/tessil/credentials.json`, readable only by you.
`tessil logout` revokes the key on the server and removes the file.

## Portals

A key opens a portal only if you hand it that portal: under Settings, Access keys, tick
"Read portals you pick" when approving, then choose the portals. Your browser seals each
portal's keys for this key and signs them with your account's key; the tool refuses any
that are not signed by the account it was paired with.

`tessil pull "Tax 2025"` makes a folder per delivery, named by the reference both you and
the sender have, with the files and a `record.txt`. Run it again later and it fetches only
what is new, so it can run on a schedule as an archive of a portal whose files are deleted
after a while.

Portals are addressed by name or ID. The tool never prints a portal's link.

Names, notes and file names in a delivery are written by whoever sent it. The tool strips
anything that could redraw your terminal or point outside the folder, and `--json` puts
all of it under `fromSender`, so a program reading the output can tell what a stranger
wrote from what Tessil says.

## What the tool will not do

- **Send programs or scripts as they are.** Same rule as the website. Put them in an archive.
- **Save a file outside the folder you chose.** The name of a downloaded file is chosen by
  whoever sent it, so anything that looks like a path is flattened, and an existing file is
  never replaced.
- **Talk to another server with your key.** A key is stored with the server it belongs to.

## Same code as the website

`packages/core` is the encryption, sealing and upload code the website runs, copied by
`scripts/sync-core.ts` with nothing changed but import paths. It comes with a fixture of
real output frozen from the website (`crypto/vectors.json`) and tests that this copy must
keep opening. `packages/core/src/SOURCE` names the website commit it came from.

## Running it from source

Needs [Bun](https://bun.sh).

```bash
bun install
bun test
bun run dev -- help          # run from source
bun run build                # one self-contained program in dist/tessil
```

Against a server of your own:

```bash
TESSIL_API_URL=http://localhost:3000 TESSIL_WEB_URL=http://localhost:5173 bun run dev -- login
```

To bring `packages/core` up to date with the website checked out beside this repository:

```bash
bun run sync-core ../tessil-web
```

## Measured

On an Apple Silicon laptop against a local stand-in for storage, so these are the tool's
own limits, not a network's: about 680 MB a second in each direction on a 1.2 GB file, with
memory flat at roughly 150 MB while sending and 370 MB while fetching, whatever the file
size. On a real connection the connection is the limit.

## Licence

AGPL-3.0, like the rest of Tessil.
