# tessil

Send and fetch end-to-end encrypted files from a terminal. The command-line tool for
[tessil.app](https://tessil.app).

Files are encrypted on your machine before anything is uploaded. The server never sees their
contents, their names, or the key in the link.

## Install

```bash
brew install tessil-app/tap/tessil                # macOS and Linux, with Homebrew
curl -fsSL https://raw.githubusercontent.com/tessil-app/tessil-cli/main/install.sh | sh   # macOS and Linux
npx tessil help                                   # anywhere with Node 20 or newer
```

Or download the program for your system from the
[releases](https://github.com/tessil-app/tessil-cli/releases), where every file is listed
with its checksum. The install script checks that checksum and installs nothing if it does
not match.

Then `tessil login`.

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
tessil link <id> [--copy]         Show the link of something this key sent
tessil revoke <id>                Delete something this key sent
tessil logout                     Sign this machine out

tessil trust                      Confirm your account's key, once, before using portals
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

The tool's three secrets (its token, private key and wrapping secret) go into the system
keychain: Keychain on macOS, the Secret Service on Linux. Where neither can be used, such as
on Windows for now or on a build server, they go into `~/.config/tessil/credentials.json`,
readable only by you, and the tool says so. Set `TESSIL_NO_KEYCHAIN=1` to choose the file.
`tessil logout` revokes the key on the server and removes both.

## Portals

A key opens a portal only if you hand it that portal: under Settings, Access keys, tick
"Read portals you pick" when approving, then choose the portals. Your browser seals each
portal's keys for this key and signs them with your account's key; the tool refuses any
that are not signed by the account it was paired with.

Before the first use, run `tessil trust`. It shows the fingerprint of your account's key as
the server reports it, and asks whether the Access keys page shows the same. Only then does
the tool accept portals signed by that key. It never takes the key on the server's word
alone, because whoever names that key decides which portals the tool believes are yours.
From a script: `tessil trust --fingerprint "<the code from the page>"`.

`tessil pull "Tax 2025"` makes a folder per delivery, named by the reference both you and
the sender have, with the files and a `record.txt`. Run it again later and it fetches only
what is new, so it can run on a schedule as an archive of a portal whose files are deleted
after a while.

Portals are addressed by name or ID. The tool never prints a portal's link.

Names, notes and file names in a delivery are written by whoever sent it. The tool strips
anything that could redraw your terminal or point outside the folder, and `--json` puts
all of it under `fromSender`, so a program reading the output can tell what a stranger
wrote from what Tessil says.

## For an AI assistant (MCP)

`tessil mcp` runs the same commands as an MCP server, for assistants that can start a
program on your machine, such as Claude Code or the Claude desktop app. It uses the access
key from `tessil login`, with the permissions you gave it.

Claude Code:

```bash
claude mcp add tessil -- tessil mcp
```

Others, in their MCP configuration:

```json
{ "mcpServers": { "tessil": { "command": "tessil", "args": ["mcp"] } } }
```

The tools: `status`, `send_files`, `list_sent`, `revoke_transfer`, `fetch_from_clipboard`,
`list_portals`, `list_deliveries`, `pull_deliveries`.

What is different from the commands, on purpose:

- **The assistant never gets a link.** What an assistant sees is kept by whoever runs the
  model, and a link holds the key. `send_files` puts the link on your clipboard and tells
  the assistant only that it did. On a machine without a clipboard, run `tessil link <id>`
  yourself. To hand an assistant a file someone sent you, copy the link and ask it to
  fetch what is on your clipboard.
- **What this does not cover.** An assistant that can also run shell commands as you can
  do what you can: read the clipboard, or run `tessil send` itself and read the link it
  prints. `tessil link` refuses to print to anything but a terminal for that reason, but
  the real boundary is which commands you let the assistant run. Through these tools
  alone, it never sees a link.
- **No tool takes a link, a key, a password or a folder.** Downloads go to
  `~/Downloads/Tessil`, or to the `downloadDir` you set in `~/.config/tessil/mcp.json`.
- **No tool returns what is inside a file.** Whether the assistant reads a downloaded file
  is up to the assistant's own file permissions, where you can see and decide it.
- **What a sender wrote is marked.** Notes, answers and file names from a delivery come
  back under `from_sender` with a warning, cleaned and cut to 300 characters. A note that
  says "ignore your instructions" is a note.
- **It runs only on your machine.** There is no hosted version; one would have to hold
  your keys.

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
bun run build:npm            # the single file that goes to npm, for Node
```

How a release is made is in [RELEASING.md](RELEASING.md).

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
