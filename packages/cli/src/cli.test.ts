import { describe, expect, it } from "bun:test";
import { mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { base64UrlToBytes } from "@tessil/core/crypto/base64url";
import { newDevice, unwrapTransferKey, wrapTransferKey } from "./device";
import { namesOnDisk } from "./portals";
import { describeHours, formatSize, parseHours, parseTransferLink, printable, safeFileName } from "./util";

describe("a new access key", () => {
  it("has a token, a P-256 key pair, a secret and a fingerprint, all different each time", async () => {
    const a = await newDevice();
    const b = await newDevice();
    expect(a.token).toMatch(/^tsl_[A-Za-z0-9_-]{43}$/);
    expect(a.tokenHash).toMatch(/^[0-9a-f]{64}$/);
    const publicKey = base64UrlToBytes(a.publicKey);
    expect(publicKey).toHaveLength(65);
    expect(publicKey[0]).toBe(4);
    expect(base64UrlToBytes(a.secret)).toHaveLength(32);
    expect(a.fingerprint).toMatch(/^([0-9a-f]{4} ){7}[0-9a-f]{4}$/);
    expect(a.token).not.toBe(b.token);
    expect(a.publicKey).not.toBe(b.publicKey);
    expect(a.secret).not.toBe(b.secret);
  });

  it("hashes the token the way the server does", async () => {
    const d = await newDevice();
    const expected = new Bun.CryptoHasher("sha256").update(d.token).digest("hex");
    expect(d.tokenHash).toBe(expected);
  });
});

describe("the key of a transfer this tool sent", () => {
  const key = crypto.getRandomValues(new Uint8Array(32));

  it("comes back only for the same device, transfer and secret", async () => {
    const a = await newDevice();
    const b = await newDevice();
    const wrapped = await wrapTransferKey(a.secret, "device-a", "transfer-1", key);
    // The shape the server stores in the same column as a vault's wrap.
    expect(base64UrlToBytes(wrapped)).toHaveLength(60);
    expect(await unwrapTransferKey(a.secret, "device-a", "transfer-1", wrapped)).toEqual(key);
    expect(await unwrapTransferKey(b.secret, "device-a", "transfer-1", wrapped)).toBeNull();
    expect(await unwrapTransferKey(a.secret, "device-b", "transfer-1", wrapped)).toBeNull();
    expect(await unwrapTransferKey(a.secret, "device-a", "transfer-2", wrapped)).toBeNull();
    expect(await unwrapTransferKey(a.secret, "device-a", "transfer-1", "not-a-wrap")).toBeNull();
  });
});

describe("reading what a person typed", () => {
  it("understands lifetimes", () => {
    expect(parseHours("12h")).toBe(12);
    expect(parseHours("3d")).toBe(72);
    expect(parseHours("2w")).toBe(336);
    expect(parseHours("24")).toBe(24);
    expect(parseHours("soon")).toBeNull();
    expect(describeHours(72)).toBe("3 days");
    expect(describeHours(6)).toBe("6 hours");
  });

  it("takes a link or an id with its key, and nothing else", () => {
    const id = "V1StGXR8_Z5jdHi6B-myT";
    expect(parseTransferLink(`https://tessil.app/d/${id}#abc`)).toEqual({ id, fragment: "abc" });
    expect(parseTransferLink(`${id}#p.salt.wrapped`)).toEqual({ id, fragment: "p.salt.wrapped" });
    expect(parseTransferLink(`https://tessil.app/d/${id}`)).toBeNull();
    expect(parseTransferLink("https://example.com/#abc")).toBeNull();
  });

  it("shows sizes the way the website does", () => {
    expect(formatSize(512)).toBe("512 B");
    expect(formatSize(1536)).toBe("1.50 KB");
    expect(formatSize(20 * 1024 ** 3)).toBe("20.0 GB");
  });
});

describe("a file name chosen by whoever sent the link", () => {
  it("cannot leave the folder it is saved in", () => {
    expect(safeFileName("../../.ssh/authorized_keys")).toBe("__.._.ssh_authorized_keys");
    expect(safeFileName("/etc/passwd")).toBe("_etc_passwd");
    expect(safeFileName("..\\..\\boot.ini")).toBe("__.._boot.ini");
    expect(safeFileName(".bashrc")).toBe("_bashrc");
    expect(safeFileName("report\u0000.pdf\n")).toBe("report.pdf");
    expect(safeFileName("   ")).toBe("file");
    expect(safeFileName("normal name (1).pdf")).toBe("normal name (1).pdf");
  });
});

describe("what is kept on disk", () => {
  it("is readable by its owner only, and not handed to another server", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tessil-test-"));
    process.env.TESSIL_CONFIG_DIR = dir;
    // This test is about the file. The keychain has its own, below.
    process.env.TESSIL_NO_KEYCHAIN = "1";
    const config = await import("./config");
    const d = await newDevice();
    const where = config.saveCredentials({
      apiUrl: config.API_URL,
      deviceId: "d",
      name: "n",
      token: d.token,
      privateKey: d.privateKey,
      publicKey: d.publicKey,
      secret: d.secret,
      email: "a@b.c",
    });
    expect(where).toBe("file");
    expect(statSync(join(dir, "credentials.json")).mode & 0o777).toBe(0o600);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(config.loadCredentials()?.token).toBe(d.token);

    config.saveCredentials({ ...config.loadCredentials()!, apiUrl: "https://elsewhere.example" });
    expect(config.loadCredentials()).toBeNull();
    config.clearCredentials();
    expect(config.loadCredentials()).toBeNull();
  });
});

describe("text from elsewhere, before it reaches the terminal", () => {
  it("loses anything that could redraw the screen or disguise a name", () => {
    expect(printable("report\u001b[2J\u001b[1;1Hall good")).toBe("report[2J[1;1Hall good");
    expect(printable("a\u0007b\u009bc\rd")).toBe("abcd");
    expect(printable("invoice\u202Efdp.exe")).toBe("invoicefdp.exe");
    expect(printable("Jaaropgave \u00e9\u00e9n \u6587 \u{1F4C4}")).toBe("Jaaropgave \u00e9\u00e9n \u6587 \u{1F4C4}");
  });

  it("is applied to a downloaded file's name as well", () => {
    expect(safeFileName("ok\u001b[31m.txt")).toBe("ok[31m.txt");
    expect(safeFileName("invoice\u202Efdp.exe")).toBe("invoicefdp.exe");
  });
});

describe("a delivery's folder on disk", () => {
  it("is named by things that cannot leave the folder it is pulled into", () => {
    // The portal's name comes from the account, the file names from a stranger.
    expect(safeFileName("../../Tax 2025")).toBe("__.._Tax 2025");
    expect(safeFileName("Tax 2025")).toBe("Tax 2025");
    expect(safeFileName("..")).toBe("_");
    expect(safeFileName(".complete")).toBe("_complete");
  });

  it("keeps two files of one name apart, and never lets one stand in for the record", () => {
    const names = namesOnDisk([
      { name: "scan.pdf" },
      { name: "Scan.PDF" },
      { name: "record.txt" },
      { name: "scan.pdf" },
      { name: "1-scan.pdf" },
    ]).map((n) => n.name);
    expect(names).toEqual(["scan.pdf", "1-Scan.PDF", "1-record.txt", "2-scan.pdf", "1-1-scan.pdf"]);
    expect(new Set(names.map((n) => n.toLowerCase())).size).toBe(names.length);
    // The same list gives the same names, so a second run finds what the first saved.
    expect(namesOnDisk([{ name: "a" }, { name: "a" }]).map((n) => n.name)).toEqual(["a", "1-a"]);
  });
});

describe("the system keychain", () => {
  it("refuses values that could break out of a command, without running anything", async () => {
    const { keychainRead, keychainStore } = await import("./keychain");
    delete process.env.TESSIL_NO_KEYCHAIN;
    expect(keychainStore('a" -s other', "c2VjcmV0")).toBe(false);
    expect(keychainStore("account", 'x"\ndelete-keychain')).toBe(false);
    expect(keychainStore("account", "has space")).toBe(false);
    expect(keychainRead("a; rm -rf ~")).toBeNull();
    process.env.TESSIL_NO_KEYCHAIN = "1";
    expect(keychainStore("account", "c2VjcmV0")).toBe(false);
  });
});
