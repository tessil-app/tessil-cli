// Writes the Homebrew formula for a release from its checksums.
// Usage: bun run scripts/release/formula.ts <version> <SHA256SUMS file>

import { readFileSync } from "node:fs";

const [version, sumsFile] = process.argv.slice(2);
if (!version || !sumsFile) throw new Error("usage: formula.ts <version> <SHA256SUMS>");

const sums = new Map<string, string>();
for (const line of readFileSync(sumsFile, "utf8").split("\n")) {
  const [sum, name] = line.trim().split(/\s+/);
  if (sum && name) sums.set(name.replace(/^\*/, ""), sum);
}
const base = `https://github.com/tessil-app/tessil-cli/releases/download/v${version}`;
function asset(name: string): string {
  const sum = sums.get(name);
  if (!sum) throw new Error(`no checksum for ${name}`);
  return `      url "${base}/${name}"\n      sha256 "${sum}"`;
}

process.stdout.write(`class Tessil < Formula
  desc "End-to-end encrypted file transfer from a terminal"
  homepage "https://tessil.app"
  version "${version}"
  license "AGPL-3.0-only"

  on_macos do
    on_arm do
${asset("tessil-darwin-arm64.tar.gz")}
    end
    on_intel do
${asset("tessil-darwin-x64.tar.gz")}
    end
  end

  on_linux do
    on_arm do
${asset("tessil-linux-arm64.tar.gz")}
    end
    on_intel do
${asset("tessil-linux-x64.tar.gz")}
    end
  end

  def install
    bin.install "tessil"
  end

  test do
    assert_match version.to_s, shell_output("#{bin}/tessil --version")
  end
end
`);
