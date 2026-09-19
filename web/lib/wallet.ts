import bs58 from "bs58";
import { API } from "./api";

/**
 * Phantom and Solflare, through the providers they inject. No adapter library:
 * both expose connect() and signMessage(), which is all sign-in needs. The
 * wallet only ever signs the plain-text sign-in message - never a transaction.
 */
export type WalletName = "Phantom" | "Solflare";

type PublicKeyLike = { toBase58(): string; toString(): string };
type SignResult = Uint8Array | { signature: Uint8Array };
type InjectedProvider = {
  isPhantom?: boolean;
  isSolflare?: boolean;
  publicKey?: PublicKeyLike | null;
  connect(): Promise<{ publicKey?: PublicKeyLike } | boolean | void>;
  disconnect?(): Promise<void>;
  signMessage(message: Uint8Array, display?: "utf8" | "hex"): Promise<SignResult>;
};

type WalletWindow = Window & {
  phantom?: { solana?: InjectedProvider };
  solana?: InjectedProvider;
  solflare?: InjectedProvider;
};

export function providerFor(name: WalletName): InjectedProvider | null {
  if (typeof window === "undefined") return null;
  const w = window as WalletWindow;
  if (name === "Phantom") return w.phantom?.solana ?? (w.solana?.isPhantom ? w.solana : null) ?? null;
  return w.solflare?.isSolflare ? w.solflare : null;
}

export const installedWallets = (): WalletName[] =>
  (["Phantom", "Solflare"] as const).filter((name) => providerFor(name) !== null);

const INSTALL_URL: Record<WalletName, string> = {
  Phantom: "https://phantom.com/download",
  Solflare: "https://solflare.com/download",
};
export const installUrl = (name: WalletName) => INSTALL_URL[name];

/** "Privy" is an embedded wallet made by email or X login; the others are browser extensions. */
export type SignInMethod = WalletName | "Privy";

export type Session = { token: string; ownerId: string; wallet: SignInMethod; expiresAt: string };

const SESSION_KEY = "oxude.session";

/**
 * The session token lives in localStorage so a refresh does not ask for a new
 * signature. It grants this app's actions only - no wallet authority - but any
 * script running on the page can read it, so the page must stay free of
 * third-party script.
 */
export function loadSession(): Session | null {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    const session = JSON.parse(raw) as Session;
    return new Date(session.expiresAt).getTime() > Date.now() ? session : null;
  } catch {
    return null;
  }
}

function saveSession(session: Session | null) {
  try {
    if (session) localStorage.setItem(SESSION_KEY, JSON.stringify(session));
    else localStorage.removeItem(SESSION_KEY);
  } catch {
    /* storage unavailable: the session lasts this page load */
  }
}

async function post<T>(path: string, body: unknown, token?: string): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) throw new Error(typeof json["error"] === "string" ? json["error"] : `request failed (${res.status})`);
  return json as T;
}

/** Connect, fetch a nonce for this key, sign the server's message, exchange it for a session. */
export async function signInWith(name: WalletName): Promise<Session> {
  const provider = providerFor(name);
  if (!provider) throw new Error(`${name} is not installed`);

  const connected = await provider.connect();
  const key =
    (connected && typeof connected === "object" && "publicKey" in connected ? connected.publicKey : undefined) ??
    provider.publicKey;
  if (!key) throw new Error(`${name} did not share a public key`);
  const publicKey = key.toBase58 ? key.toBase58() : key.toString();

  const issued = await post<{ nonce: string; message: string }>("/auth/nonce", { publicKey });
  const signed = await provider.signMessage(new TextEncoder().encode(issued.message), "utf8");
  const signature = bs58.encode(signed instanceof Uint8Array ? signed : signed.signature);

  const verified = await post<{ token: string; ownerId: string; expiresAt: string }>("/auth/verify", {
    publicKey,
    nonce: issued.nonce,
    signature,
  });
  const session: Session = { ...verified, wallet: name };
  saveSession(session);
  return session;
}

/**
 * The same exchange as signInWith, for a signer that isn't an injected
 * extension (a Privy embedded wallet). Same nonce, same message, same
 * verification: the server can't tell the two apart, and owner_id is the key.
 */
export async function signInWithSigner(
  publicKey: string,
  sign: (message: Uint8Array) => Promise<Uint8Array>,
  wallet: SignInMethod,
): Promise<Session> {
  const issued = await post<{ nonce: string; message: string }>("/auth/nonce", { publicKey });
  const signature = bs58.encode(await sign(new TextEncoder().encode(issued.message)));
  const verified = await post<{ token: string; ownerId: string; expiresAt: string }>("/auth/verify", {
    publicKey,
    nonce: issued.nonce,
    signature,
  });
  const session: Session = { ...verified, wallet };
  saveSession(session);
  return session;
}

export async function signOut(session: Session | null): Promise<void> {
  if (session) {
    await post("/auth/logout", {}, session.token).catch(() => undefined);
    if (session.wallet !== "Privy") await providerFor(session.wallet)?.disconnect?.().catch(() => undefined);
  }
  saveSession(null);
}

export const shortKey = (key: string) => `${key.slice(0, 4)}…${key.slice(-4)}`;
