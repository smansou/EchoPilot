import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createChatGPTAccount, verifyIdentity } from "./chatgpt-account";
const { privateKey, publicKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
});
const jwk = { ...publicKey.export({ format: "jwk" }), kid: "test", use: "sig" };
function jwt(claims: Record<string, unknown>) {
  const header = Buffer.from(
    JSON.stringify({ alg: "RS256", kid: "test" }),
  ).toString("base64url");
  const payload = Buffer.from(
    JSON.stringify({
      iss: "https://auth.openai.com",
      aud: "issued-client",
      exp: Date.now() / 1000 + 300,
      sub: "subject",
      ...claims,
    }),
  ).toString("base64url");
  return (
    header +
    "." +
    payload +
    "." +
    sign(
      "RSA-SHA256",
      Buffer.from(header + "." + payload),
      privateKey,
    ).toString("base64url")
  );
}
const identityFetch = (async (url) =>
  Response.json(
    String(url).includes("openid-configuration")
      ? {
          issuer: "https://auth.openai.com",
          jwks_uri: "https://auth.openai.com/jwks",
          revocation_endpoint: "https://auth.openai.com/revoke",
        }
      : { keys: [jwk] },
  )) as typeof fetch;
test("identity verification rejects a wrong audience, nonce, issuer, signature, or expired token", async () => {
  assert.equal(
    (
      await verifyIdentity(
        jwt({ nonce: "n" }),
        "issued-client",
        "n",
        identityFetch,
      )
    ).subject,
    "subject",
  );
  for (const claims of [
    { aud: "other" },
    { nonce: "wrong" },
    { iss: "https://evil.test" },
    { exp: 1 },
  ])
    await assert.rejects(() =>
      verifyIdentity(
        jwt({ nonce: "n", ...claims }),
        "issued-client",
        "n",
        identityFetch,
      ),
    );
  const bad = jwt({ nonce: "n" }).split(".");
  bad[2] = "AAAA";
  await assert.rejects(() =>
    verifyIdentity(bad.join("."), "issued-client", "n", identityFetch),
  );
});
test("browser sign-in persists protected credentials, discovers models, resumes, and signs out", async () => {
  const directory = mkdtempSync(join(tmpdir(), "echo-auth-"));
  let nonce = "",
    host = "",
    redirect = "",
    verifier = "";
  let tokenCalls = 0;
  const crypto = {
    available: () => true,
    encrypt: (s: string) => Buffer.from(Buffer.from(s).map((b) => b ^ 43)),
    decrypt: (b: Buffer) => Buffer.from(b.map((v) => v ^ 43)).toString(),
  };
  const request = (async (url, init) => {
    const value = String(url);
    if (value.includes("oauth/token")) {
      tokenCalls++;
      const form = init?.body as URLSearchParams;
      assert.equal(form.get("client_id"), "issued-client");
      assert.equal(form.get("redirect_uri"), redirect);
      verifier = form.get("code_verifier")!;
      return Response.json({
        access_token: "test-access",
        refresh_token: "test-refresh",
        expires_in: 3600,
        scope: "chatgpt.tokens.use.direct",
        id_token: jwt({ nonce }),
      });
    }
    if (value.endsWith("/models")) {
      assert.equal((init?.headers as any).Authorization, "Bearer test-access");
      return Response.json({
        models: [
          {
            slug: "latest-account-model",
            display_name: "Latest",
            visibility: "list",
          },
        ],
      });
    }
    if (value.endsWith("/revoke")) return new Response("");
    return identityFetch(url, init);
  }) as typeof fetch;
  const options = {
    directory,
    crypto,
    fetcher: request,
    openBrowser: async (value: string) => {
      const url = new URL(value);
      assert.equal(url.origin, "https://auth.openai.com");
      assert.equal(url.searchParams.get("client_id"), "dynamic_agent_client");
      nonce = url.searchParams.get("nonce")!;
      host = url.searchParams.get("ext_agent_host_id")!;
      redirect = url.searchParams.get("redirect_uri")!;
      const callback = new URL(redirect);
      callback.search = new URLSearchParams({
        state: url.searchParams.get("state")!,
        code: "test-code",
        client_id: "issued-client",
      }).toString();
      await fetch(callback);
    },
  };
  try {
    const account = createChatGPTAccount(options);
    assert.equal(account.status().connected, false);
    const status = await account.signIn();
    assert.equal(status.sharing, true);
    assert.equal(status.connecting, false);
    assert.equal(tokenCalls, 1);
    assert.ok(verifier.length >= 43);
    assert.match(host, /^urn:uuid:/);
    assert.equal(JSON.stringify(status).includes("test-access"), false);
    assert.equal(
      readFileSync(join(directory, "chatgpt-account.enc"), "utf8").includes(
        "test-access",
      ),
      false,
    );
    assert.equal((await account.models())[0]?.id, "latest-account-model");
    const resumed = createChatGPTAccount(options);
    assert.equal(resumed.status().sharing, true);
    await resumed.disconnect();
    assert.equal(resumed.status().connected, false);
    assert.equal(resumed.status().profiles.length, 1);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
test("sign-in fails before opening a browser if OS encryption is unavailable", async () => {
  let opened = false;
  const directory = mkdtempSync(join(tmpdir(), "echo-auth-"));
  try {
    const account = createChatGPTAccount({
      directory,
      crypto: {
        available: () => false,
        encrypt: () => {
          throw Error("must not write");
        },
        decrypt: () => "",
      },
      openBrowser: async () => {
        opened = true;
      },
    });
    await assert.rejects(() => account.signIn(), /Keychain/);
    assert.equal(opened, false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
test("concurrent requests share a single token refresh and persist its rotating refresh token", async () => {
  const directory = mkdtempSync(join(tmpdir(), "echo-refresh-"));
  const crypto = {
    available: () => true,
    encrypt: (s: string) => Buffer.from(s),
    decrypt: (b: Buffer) => b.toString(),
  };
  const { encryptedState } = await import("./encrypted-state");
  const store = encryptedState(directory, "chatgpt-account", crypto);
  store.save({
    active: "p",
    profiles: [
      {
        id: "p",
        clientId: "issued-client",
        subject: "subject",
        access: "expired",
        refresh: "old-refresh",
        expires: 1,
        scopes: ["chatgpt.tokens.use.direct"],
      },
    ],
  });
  let refreshes = 0;
  const request = (async (url, init) => {
    if (String(url).includes("oauth/token")) {
      refreshes++;
      assert.equal(
        (init?.body as URLSearchParams).get("refresh_token"),
        "old-refresh",
      );
      await new Promise((r) => setTimeout(r, 20));
      return Response.json({
        access_token: "new-access",
        refresh_token: "rotated",
        expires_in: 3600,
        scope: "chatgpt.tokens.use.direct",
        id_token: jwt({}),
      });
    }
    return identityFetch(url, init);
  }) as typeof fetch;
  try {
    const account = createChatGPTAccount({
      directory,
      crypto,
      fetcher: request,
      openBrowser: async () => {},
    });
    assert.deepEqual(await Promise.all([account.access(), account.access()]), [
      "new-access",
      "new-access",
    ]);
    assert.equal(refreshes, 1);
    assert.equal((store.load() as any).profiles[0].refresh, "rotated");
    assert.equal((store.load() as any).profiles[0].pendingIdentity, undefined);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
