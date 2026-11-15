// Talking to the server as an access key.

import { ApiClient, type OwnedTransferSummary } from "@tessil/core/api/client";
import { API_URL, type Credentials } from "./config";
import { UserError, printable } from "./util";

export interface SelfActive {
  status: "active";
  device: { id: string; name: string; permissions: string[]; expiresAt: string | null };
  account: { id?: string; email: string; tier: string; publicKey: string | null };
  caps: { maxFileSize: number; maxTransferSize: number; allowedExpiryHours: number[] };
}
export type Self = SelfActive | { status: "pending"; pairingExpiresAt: string | null };

export class RemoteError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message);
  }
}

async function call<T>(path: string, init: RequestInit & { token?: string } = {}): Promise<T> {
  const { token, ...rest } = init;
  let response: Response;
  try {
    response = await fetch(`${API_URL}${path}`, {
      ...rest,
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...rest.headers,
      },
    });
  } catch {
    throw new UserError(`Could not reach ${API_URL}. Check your connection.`);
  }
  if (response.status === 204) return undefined as T;
  const text = await response.text();
  let body: { error?: string; code?: string } = {};
  try {
    body = JSON.parse(text);
  } catch {
    // Not JSON: an error page from something in between.
  }
  if (!response.ok) throw new RemoteError(body.error ?? `Request failed: ${response.status}`, response.status, body.code);
  return body as T;
}

export function registerDevice(body: { name: string; publicKey: string; tokenHash: string }) {
  return call<{ id: string; pairingCode: string; pairingExpiresAt: string }>("/api/devices", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export const getSelf = (token: string) => call<Self>("/api/devices/self", { token });
export const signOut = (token: string) => call<void>("/api/devices/self", { method: "DELETE", token });

export function listOwnTransfers(token: string, cursor?: string) {
  const query = cursor ? `?cursor=${encodeURIComponent(cursor)}` : "";
  return call<{ transfers: OwnedTransferSummary[]; nextCursor: string | null }>(`/api/devices/self/transfers${query}`, {
    token,
  });
}

export const deleteOwnTransfer = (token: string, id: string) =>
  call<void>(`/api/devices/self/transfers/${encodeURIComponent(id)}`, { method: "DELETE", token });

export interface GrantedPortalRow {
  id: string;
  role: string;
  publicBundle: string;
  sealedKeys: string;
  keyVersion: number;
  isDisabled: boolean;
  closesAt: string | null;
  createdAt: string;
  deliveries: number;
  lastDeliveryAt: string | null;
}

export interface DepositRow {
  id: string;
  createdAt: string;
  expiresAt: string;
  sealedKey: string;
  encryptedTitle: string | null;
  encryptedTitleIv: string | null;
  files: { id: string; encryptedName: string; encryptedNameIv: string; fileIv: string; size: number; mimeType: string | null }[];
}

export const listGrantedPortals = (token: string) =>
  call<{ portals: GrantedPortalRow[] }>("/api/devices/self/portals", { token });

export function listPortalDeposits(token: string, portalId: string, cursor?: string | null) {
  const query = cursor ? `?cursor=${encodeURIComponent(cursor)}` : "";
  return call<{ deposits: DepositRow[]; nextCursor: string | null }>(
    `/api/devices/self/portals/${encodeURIComponent(portalId)}/deposits${query}`,
    { token },
  );
}

export const portalFileUrl = (token: string, portalId: string, fileId: string) =>
  call<{ downloadUrl: string; size: number }>(
    `/api/devices/self/portals/${encodeURIComponent(portalId)}/files/${encodeURIComponent(fileId)}/url`,
    { token },
  );

/** The shared client, signed in as this access key. */
export function clientFor(credentials: Credentials): ApiClient {
  return new ApiClient(API_URL, { token: credentials.token });
}

/** For fetching a link: no key of the account is involved. */
export function anonymousClient(): ApiClient {
  return new ApiClient(API_URL, { token: undefined });
}

/** Turns a refusal about the key itself into something a person can act on. */
export function explain(err: unknown): Error {
  if (err instanceof RemoteError || (err instanceof Error && "status" in err)) {
    const e = err as RemoteError;
    if (e.code === "device_invalid" || e.status === 401) {
      return new UserError("This access key no longer works. Run `tessil login` to pair again.");
    }
    if (e.code === "device_forbidden") {
      return new UserError(`${printable(e.message)} Change what this key may do under Settings, Access keys.`);
    }
    return new UserError(printable(e.message));
  }
  return err instanceof Error ? err : new Error(String(err));
}
