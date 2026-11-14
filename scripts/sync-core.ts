// Copies the shared client code out of the website into packages/core.
//
// Until the website imports this package, the website is where that code
// is written and tested, and this is how it gets here. Run from the
// repository root with the website checked out beside it:
//
//   bun run scripts/sync-core.ts ../tessil-web
//
// The only change made is to imports: the website's `$lib/…` becomes a
// relative path. The frozen test vectors come along, so the copy is held
// to opening exactly what the website's code wrote.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

const FILES = [
  "crypto/base64url.ts",
  "crypto/decrypt.ts",
  "crypto/encrypt.ts",
  "crypto/key.ts",
  "crypto/seal.ts",
  "crypto/streaming.ts",
  "crypto/transferPassword.ts",
  "crypto/vectors.json",
  "crypto/vectors.test.ts",
  "portal/keys.ts",
  "portal/deposit.ts",
  "portal/receipt.ts",
  "upload/multipart.ts",
  "upload/pool.ts",
  "upload/fileTypeCheck.ts",
  "api/client.ts",
  "vault/keypair.ts",
  "i18n/locale.ts",
];

const web = resolve(process.argv[2] ?? "../tessil-web");
const from = join(web, "src/lib");
const to = resolve("packages/core/src");

for (const file of FILES) {
  let source = readFileSync(join(from, file), "utf8");
  if (file.endsWith(".ts")) {
    source = source.replace(/(["'])\$lib\/([^"']+)\1/g, (_, quote: string, target: string) => {
      let path = relative(dirname(join(to, file)), join(to, target));
      if (!path.startsWith(".")) path = `./${path}`;
      return `${quote}${path}${quote}`;
    });
    if (/(?:from|import)\s+["']\$(?:lib|app)\//.test(source)) throw new Error(`${file} still imports from the website`);
  }
  mkdirSync(dirname(join(to, file)), { recursive: true });
  writeFileSync(join(to, file), source);
}

const commit = Bun.spawnSync(["git", "-C", web, "rev-parse", "HEAD"]).stdout.toString().trim();
writeFileSync(join(to, "SOURCE"), `tessil-web ${commit}\n`);
console.log(`copied ${FILES.length} files from tessil-web ${commit.slice(0, 7)}`);
