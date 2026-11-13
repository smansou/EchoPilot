import {
  createHash,
  randomBytes,
  randomUUID,
  createPublicKey,
  verify,
} from "node:crypto";
import { createServer } from "node:http";
import { mkdirSync, readFileSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { encryptedState } from "./encrypted-state";
import { openAIModels } from "../shared/model-catalog";
const AUTH = "https://auth.openai.com",
  RESOURCE = "https://api.openai.com/v1";
const SCOPES =
  "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct";
type Profile = {
  id: string;
  clientId: string;
  subject?: string;
  email?: string;
  access?: string;
  refresh?: string;
  idToken?: string;
  expires?: number;
  scopes?: string[];
  pendingIdentity?: string;
};
type State = { profiles: Profile[]; active?: string };
export type AccountStatus = {
  connected: boolean;
  sharing: boolean;
  connecting: boolean;
  active?: string;
  profiles: { id: string; label: string; connected: boolean }[];
};
export async function verifyIdentity(
  token: string,
  clientId: string,
  nonce: string | undefined,
  request: typeof fetch = fetch,
) {
  const parts = token.split(".");
  if (parts.length !== 3) throw Error("ChatGPT returned an invalid identity.");
  const header = JSON.parse(Buffer.from(parts[0]!, "base64url").toString());
  const claims = JSON.parse(Buffer.from(parts[1]!, "base64url").toString());
  if (header.alg !== "RS256" || typeof header.kid !== "string")
    throw Error("Unsupported ChatGPT identity signature.");
  const discovery = await request(AUTH + "/.well-known/openid-configuration", {
    redirect: "error",
    signal: AbortSignal.timeout(15000),
  });
  if (!discovery.ok) throw Error("Cannot verify ChatGPT identity. Try again.");
  const config = (await discovery.json()) as any;
  if (config.issuer !== AUTH || new URL(config.jwks_uri).origin !== AUTH)
    throw Error("Invalid ChatGPT identity issuer.");
  const keys = await request(config.jwks_uri, {
    redirect: "error",
    signal: AbortSignal.timeout(15000),
  });
  if (!keys.ok) throw Error("Cannot verify ChatGPT identity.");
  const jwks = (await keys.json()) as any;
  const key = jwks.keys?.find(
    (k: any) =>
      k.kid === header.kid && k.kty === "RSA" && (!k.use || k.use === "sig"),
  );
  if (
    !key ||
    !verify(
      "RSA-SHA256",
      Buffer.from(parts.slice(0, 2).join(".")),
      createPublicKey({ key, format: "jwk" }),
      Buffer.from(parts[2]!, "base64url"),
    )
  )
    throw Error("ChatGPT identity verification failed.");
  const now = Date.now() / 1000;
  if (
    claims.iss !== AUTH ||
    !(Array.isArray(claims.aud)
      ? claims.aud.includes(clientId)
      : claims.aud === clientId) ||
    typeof claims.exp !== "number" ||
    claims.exp <= now ||
    claims.nbf > now + 30 ||
    typeof claims.sub !== "string" ||
    !claims.sub ||
    (nonce !== undefined && claims.nonce !== nonce) ||
    (claims.azp && claims.azp !== clientId) ||
    (Array.isArray(claims.aud) && claims.aud.length > 1 && claims.azp !== clientId)
  )
    throw Error("ChatGPT identity did not match this sign-in.");
  return {
    subject: claims.sub as string,
    ...(typeof claims.email === "string" ? { email: claims.email } : {}),
  };
}
export function createChatGPTAccount(options: {
  directory: string;
  crypto: Parameters<typeof encryptedState>[2];
  openBrowser(url: string): Promise<unknown>;
  fetcher?: typeof fetch;
}) {
  const request = options.fetcher || fetch;
  const store = encryptedState(
    options.directory,
    "chatgpt-account",
    options.crypto,
  );
  let loaded = false;
  let saved: State = { profiles: [] };
  let pending: AbortController | null = null;
  let epoch = 0;
  let flight: Promise<string> | null = null;
  const load = () => {
    if (!loaded) {
      const value = store.load() as State | null;
      if (value?.profiles) saved = value;
      else if (existsSync(join(options.directory, "chatgpt-account.enc")))
        throw Error(
          "Could not unlock the saved ChatGPT connection. Check macOS Keychain and restart EchoPilot.",
        );
      loaded = true;
    }
  };
  const persist = () => {
    if (!options.crypto.available())
      throw Error(
        "macOS Keychain is unavailable. Unlock it before connecting ChatGPT.",
      );
    store.save(saved);
  };
  const selected = () => saved.profiles.find((p) => p.id === saved.active);
  const status = (): AccountStatus => {
    load();
    const p = selected();
    return {
      connected: !!p?.access,
      sharing:
        !!p?.access &&
        !p.pendingIdentity &&
        !!p.scopes?.includes("chatgpt.tokens.use.direct"),
      connecting: !!pending,
      ...(saved.active ? { active: saved.active } : {}),
      profiles: saved.profiles.map((p, i) => ({
        id: p.id,
        label: (p.email || "ChatGPT account") + ` · Connection ${i + 1}`,
        connected: !!p.access,
      })),
    };
  };
  async function token(form: URLSearchParams, signal: AbortSignal) {
    const r = await request(AUTH + "/api/accounts/oauth/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: form,
      redirect: "error",
      signal,
    });
    if (!r.ok) {
      await r.body?.cancel();
      throw Error(
        "ChatGPT could not renew this connection. Please sign in again.",
      );
    }
    const data = (await r.json()) as any;
    if (
      typeof data.access_token !== "string" ||
      typeof data.expires_in !== "number" ||
      data.expires_in <= 0 ||
      (data.token_type !== undefined && String(data.token_type).toLowerCase() !== "bearer")
    )
      throw Error("ChatGPT returned invalid credentials.");
    return data;
  }
  function credentials(p: Profile, data: any) {
    p.access = data.access_token;
    if (typeof data.refresh_token === "string") p.refresh = data.refresh_token;
    p.expires = Date.now() + data.expires_in * 1000;
    if (typeof data.scope === "string") p.scopes = data.scope.split(/\s+/);
    if (typeof data.id_token === "string") p.idToken = data.id_token;
  }
  async function access() {
    load();
    if (pending) throw Error("Finish ChatGPT sign-in first.");
    const p = selected();
    if (!p?.access || !p.scopes?.includes("chatgpt.tokens.use.direct"))
      throw Error("Connect ChatGPT and allow plan usage in Connections.");
    if (!p.pendingIdentity && (p.expires || 0) > Date.now() + 60000)
      return p.access;
    if (flight) return flight;
    const version = epoch;
    flight = (async () => {
      if (p.pendingIdentity) {
        const identity = await verifyIdentity(
          p.pendingIdentity,
          p.clientId,
          undefined,
          request,
        );
        if (identity.subject !== p.subject) {
          delete p.access;
          delete p.refresh;
          persist();
          throw Error("ChatGPT account identity changed. Reconnect.");
        }
        delete p.pendingIdentity;
        persist();
        if ((p.expires || 0) > Date.now() + 60000) return p.access!;
      }
      if (!p.refresh)
        throw Error("Sign in to ChatGPT again to renew this connection.");
      const data = await token(
        new URLSearchParams({
          grant_type: "refresh_token",
          refresh_token: p.refresh,
          client_id: p.clientId,
          resource: RESOURCE,
        }),
        AbortSignal.timeout(30000),
      );
      if (version !== epoch) throw Error("ChatGPT account changed. Try again.");
      credentials(p, data);
      if (typeof data.id_token === "string") p.pendingIdentity = data.id_token;
      persist();
      if (data.id_token) {
        const identity = await verifyIdentity(
          data.id_token,
          p.clientId,
          undefined,
          request,
        );
        if (identity.subject !== p.subject) {
          delete p.access;
          delete p.refresh;
          persist();
          throw Error("ChatGPT account identity changed. Reconnect.");
        }
        delete p.pendingIdentity;
        persist();
      }
      if (!p.scopes?.includes("chatgpt.tokens.use.direct"))
        throw Error(
          "ChatGPT plan usage is disabled. Reconnect and allow plan usage.",
        );
      return p.access!;
    })().finally(() => {
      flight = null;
    });
    return flight;
  }
  async function signIn(newProfile = false) {
    load();
    if (pending || flight)
      throw Error("A ChatGPT connection change is already in progress.");
    if (!options.crypto.available())
      throw Error("Unlock macOS Keychain before signing in.");
    const controller = new AbortController();
    const signal = AbortSignal.any([
      controller.signal,
      AbortSignal.timeout(600000),
    ]);
    const previous = newProfile ? undefined : selected();
    const p: Profile = previous
      ? { ...previous }
      : { id: randomUUID(), clientId: "" };
    const hostPath = join(options.directory, "chatgpt-host.json");
    mkdirSync(options.directory, { recursive: true });
    let hostId: string;
    if (existsSync(hostPath))
      hostId = JSON.parse(readFileSync(hostPath, "utf8")).id;
    else {
      hostId = "urn:uuid:" + randomUUID();
      writeFileSync(hostPath, JSON.stringify({ id: hostId }), {
        mode: 0o600,
        flag: "wx",
      });
    }
    const state = randomBytes(32).toString("base64url"),
      nonce = randomBytes(32).toString("base64url"),
      verifier = randomBytes(48).toString("base64url");
    let resolveCallback!: (value: { code: string; clientId: string }) => void,
      rejectCallback!: (reason: Error) => void;
    const callback = new Promise<{ code: string; clientId: string }>(
      (resolve, reject) => {
        resolveCallback = resolve;
        rejectCallback = reject;
      },
    );
    void callback.catch(() => {});
    const server = createServer((req, res) => {
      const url = new URL(req.url || "", "http://127.0.0.1");
      if (url.pathname !== "/auth/callback") {
        res.writeHead(404).end();
        return;
      }
      if (url.searchParams.get("state") !== state) {
        res.writeHead(400).end("Invalid sign-in attempt.");
        return;
      }
      if (url.searchParams.has("error")) {
        res.end("Sign-in was cancelled. Return to EchoPilot.");
        rejectCallback(Error("ChatGPT sign-in was not authorized."));
        return;
      }
      const code = url.searchParams.get("code"),
        clientId = url.searchParams.get("client_id") || p.clientId;
      if (
        !code ||
        !clientId ||
        clientId === "dynamic_agent_client" ||
        (p.clientId && p.clientId !== clientId)
      ) {
        res.writeHead(400).end("Incomplete registration.");
        rejectCallback(Error("ChatGPT returned an incomplete registration."));
        return;
      }
      res.setHeader("Content-Type", "text/plain");
      res.end("You can return to EchoPilot. Finishing sign-in…");
      resolveCallback({ code, clientId });
    });
    const abort = () =>
      rejectCallback(Error("ChatGPT sign-in cancelled or timed out."));
    pending = controller;
    signal.addEventListener("abort", abort, { once: true });
    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
      });
      const address = server.address();
      if (!address || typeof address === "string")
        throw Error("Could not start the local sign-in callback.");
      const redirect = `http://127.0.0.1:${address.port}/auth/callback`;
      const url = new URL(AUTH + "/api/accounts/authorize");
      url.search = new URLSearchParams({
        client_id: p.clientId || "dynamic_agent_client",
        ...(!p.clientId ? { agent_name_hint: "EchoPilot" } : {}),
        ext_agent_host_id: hostId,
        response_type: "code",
        redirect_uri: redirect,
        scope: SCOPES,
        resource: RESOURCE,
        state,
        nonce,
        code_challenge_method: "S256",
        code_challenge: createHash("sha256")
          .update(verifier)
          .digest("base64url"),
        ...(p.idToken ? { id_token_hint: p.idToken } : {}),
      }).toString();
      try { await options.openBrowser(url.href); } catch { throw Error("Could not open your browser. Try signing in again."); }
      const result = await callback;
      signal.throwIfAborted();
      p.clientId = result.clientId;
      // Retain an issued registration even if code exchange fails. Do not replace active credentials.
      if (!previous) {
        saved.profiles.push({ ...p });
        persist();
      }
      const data = await token(
        new URLSearchParams({
          grant_type: "authorization_code",
          client_id: p.clientId,
          code: result.code,
          code_verifier: verifier,
          redirect_uri: redirect,
          resource: RESOURCE,
        }),
        signal,
      );
      if (typeof data.id_token !== "string")
        throw Error("ChatGPT did not return a verifiable identity.");
      const identity = await verifyIdentity(
        data.id_token,
        p.clientId,
        nonce,
        request,
      );
      signal.throwIfAborted();
      if (previous?.subject && previous.subject !== identity.subject)
        throw Error(
          "This sign-in belongs to another account. Use Add account instead.",
        );
      Object.assign(p, identity);
      p.scopes = [];
      credentials(p, data);
      saved.profiles = saved.profiles.map((v) => (v.id === p.id ? p : v));
      saved.active = p.id;
      persist();
      pending = null;
      return status();
    } finally {
      signal.removeEventListener("abort", abort);
      server.close();
      server.closeAllConnections();
      pending = null;
    }
  }
  return {
    status,
    signIn,
    cancel() {
      pending?.abort();
    },
    access,
    async models() {
      const key = await access();
      const r = await request(RESOURCE + "/models", {
        headers: { Authorization: `Bearer ${key}` },
        redirect: "error",
        signal: AbortSignal.timeout(20000),
      });
      if (!r.ok)
        throw Error(
          "Could not load this ChatGPT account’s models. Reconnect or try again.",
        );
      return openAIModels(await r.json());
    },
    select(id: string) {
      load();
      if (pending || flight) throw Error("Finish the connection change first.");
      if (!saved.profiles.some((p) => p.id === id))
        throw Error("Unknown ChatGPT account.");
      epoch++;
      saved.active = id;
      persist();
      return status();
    },
    async disconnect() {
      load();
      if (pending || flight) throw Error("Finish the connection change first.");
      epoch++;
      const p = selected();
      if (!p) return status();
      let failed = false;
      try {
        if (p.refresh) {
          const discovery = await request(
            AUTH + "/.well-known/openid-configuration",
            { redirect: "error", signal: AbortSignal.timeout(15000) },
          );
          const config = (await discovery.json()) as any;
          if (new URL(config.revocation_endpoint).origin !== AUTH)
            throw Error("Invalid revocation endpoint");
          const r = await request(config.revocation_endpoint, {
            method: "POST",
            redirect: "error",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({
              token: p.refresh,
              token_type_hint: "refresh_token",
              client_id: p.clientId,
            }),
            signal: AbortSignal.timeout(15000),
          });
          failed = !r.ok;
        }
      } catch {
        failed = true;
      } finally {
        delete p.access;
        delete p.refresh;
        delete p.idToken;
        delete p.pendingIdentity;
        delete p.scopes;
        persist();
      }
      if (failed)
        throw Error(
          "Signed out locally. Remote disconnection could not be confirmed; disconnect EchoPilot in ChatGPT settings.",
        );
      return status();
    },
  };
}
