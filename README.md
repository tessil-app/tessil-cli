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
