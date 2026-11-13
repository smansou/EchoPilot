import { useEffect, useState } from "react";
import {
  DEFAULT_MODELS,
  PROVIDER_LABELS,
  resolveProviderSetup,
  type TextProvider,
} from "../shared/provider-setup";
import type { AssistantModel } from "../shared/model-catalog";
import type { AccountStatus } from "../main/chatgpt-account";
type Props = {
  values: Record<string, string>;
  keys: { provider: string; maskedSuffix: string }[];
  save(key: string, value: string): Promise<void>;
  store(provider: string, secret: string): Promise<void>;
  request(input: Record<string, unknown>): Promise<any>;
  account: AccountStatus;
  accountChanged(status: AccountStatus): void;
};
function KeyField({
  provider,
  saved,
  store,
}: {
  provider: TextProvider;
  saved?: string | undefined;
  store: Props["store"];
}) {
  const [secret, setSecret] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  return (
    <form
      className="key-form"
      onSubmit={(event) => {
        event.preventDefault();
        if (!secret.trim() || busy) return;
        setBusy(true);
        setError("");
        void store(provider, secret.trim())
          .then(() => setSecret(""))
          .catch(() => setError("Could not save this key. Please try again."))
          .finally(() => setBusy(false));
      }}
    >
      <label htmlFor={`key-${provider}`}>
        {provider === "openai" ? "OpenAI" : PROVIDER_LABELS[provider]} API key
        <span>
          {saved ? `Saved · •••• ${saved}` : "Stored in your Mac’s Keychain"}
        </span>
      </label>
      <div>
        <input
          id={`key-${provider}`}
          type="password"
          autoComplete="off"
          value={secret}
          onChange={(e) => setSecret(e.target.value)}
          placeholder={saved ? "Replace key" : "Paste your API key"}
        />
        <button className="primary" disabled={!secret.trim() || busy}>
          {busy ? "Saving…" : "Save key"}
        </button>
      </div>
      {error && (
        <p className="field-error" role="alert">
          {error}
        </p>
      )}
    </form>
  );
}
export function ProviderSetup({
  values,
  keys,
  save,
  store,
  request,
  account,
  accountChanged,
}: Props) {
  const [error, setError] = useState(""),
    [models, setModels] = useState<AssistantModel[]>([]),
    [loading, setLoading] = useState(false),
    [revision, setRevision] = useState(0),
    [connecting, setConnecting] = useState(false),
    [modelError, setModelError] = useState("");
  const setup = resolveProviderSetup((key) => values[key] ?? "");
  const required = [...new Set([setup.voice, setup.reasoning])].filter(
    (p) => p !== "chatgpt",
  );
  const ready =
    required.every((provider) =>
      keys.some((key) => key.provider === provider),
    ) &&
    (setup.reasoning !== "chatgpt" || account.sharing);
  const modelKey =
    setup.reasoning === "chatgpt"
      ? "providers.chatgptModel"
      : setup.preset !== "custom"
        ? setup.voice === "openai"
          ? "providers.openaiSelectedModel"
          : "providers.geminiSelectedModel"
        : setup.reasoning === "anthropic"
          ? "providers.anthropicModel"
          : setup.reasoning === "openrouter"
            ? "providers.openrouterModel"
            : setup.reasoning === "gemini"
              ? "providers.geminiModel"
              : "providers.textModel";
  const selectedModel = setup.textModel;
  const catalogReady =
    setup.reasoning === "chatgpt"
      ? account.sharing
      : keys.some((k) => k.provider === setup.reasoning);
  const credentialVersion = keys
    .map((k) => k.provider + ":" + k.maskedSuffix)
    .join(",");
  useEffect(() => {
    let alive = true;
    setModels([]);
    setModelError("");
    if (setup.reasoning === "openrouter" || !catalogReady) {
      setLoading(false);
      return;
    }
    setLoading(true);
    void request({ action: "assistant-models" })
      .then((result: AssistantModel[]) => {
        if (alive) setModels(result);
      })
      .catch((e) => {
        if (alive)
          setModelError(e.message || "Could not load models. Try refreshing.");
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [
    setup.reasoning,
    catalogReady,
    credentialVersion,
    account.active,
    revision,
  ]);
  async function change(task: () => Promise<void>) {
    setError("");
    try {
      await task();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save this choice.");
    }
  }
  async function chooseAssistant(provider: string) {
    await save("live.provider", setup.voice);
    await save("providers.active", provider);
    await save("setup.preset", "custom");
  }
  async function chooseVoice(provider: string) {
    if (provider === setup.voice) return;
    if (setup.preset !== "custom") {
      await save("providers.active", setup.reasoning);
      await save(
        setup.reasoning === "openai"
          ? "providers.textModel"
          : "providers.geminiModel",
        setup.textModel,
      );
    }
    await save("live.provider", provider);
    await save("setup.preset", "custom");
  }
  async function accountAction(action: string, newProfile = false) {
    setConnecting(true);
    setError("");
    try {
      const next = await request({ action, newProfile });
      accountChanged(next);
      setRevision((v) => v + 1);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not connect ChatGPT.");
      try {
        accountChanged(await request({ action: "chatgpt-status" }));
      } catch {}
    } finally {
      setConnecting(false);
    }
  }
  // A new account starts with its first available assistant, rather than asking for a model ID.
  useEffect(() => {
    const first = models.find((m) => m.assistant);
    if (setup.reasoning === "chatgpt" && !selectedModel && first)
      void change(() => save(modelKey, first.id));
  }, [models, selectedModel, modelKey]);
  const selected = models.find((m) => m.id === selectedModel);
  return (
    <section className="card provider-setup">
      <div className="card-title">
        <h2>Assistant connection</h2>
        <span className={`badge ${ready ? "saved" : ""}`}>
          {ready ? "Ready" : "Finish connecting below"}
        </span>
      </div>
      <div className="form-row">
        <div>
          <label htmlFor="reasoning-provider">Assistant provider</label>
          <p className="footnote">
            Reasons, researches, and uses your desktop tools.
          </p>
        </div>
        <select
          id="reasoning-provider"
          value={setup.reasoning}
          onChange={(e) => void change(() => chooseAssistant(e.target.value))}
        >
          {(
            ["chatgpt", "openai", "anthropic", "gemini", "openrouter"] as const
          ).map((p) => (
            <option key={p} value={p}>
              {PROVIDER_LABELS[p]}
            </option>
          ))}
        </select>
      </div>
      {setup.reasoning === "chatgpt" && (
        <div className="account-connection">
          <h3>Use your ChatGPT plan</h3>
          <p className="footnote">
            Sign in in your browser and allow Cleo to use your plan.
            Available for eligible accounts; usage counts toward your plan
            limits.
          </p>
          {account.profiles.length > 0 && (
            <div className="form-row">
              <label htmlFor="chatgpt-account">Account</label>
              <select
                id="chatgpt-account"
                disabled={connecting}
                value={account.active || ""}
                onChange={(e) =>
                  void change(async () => {
                    accountChanged(
                      await request({
                        action: "chatgpt-select",
                        id: e.target.value,
                      }),
                    );
                    setRevision((v) => v + 1);
                  })
                }
              >
                {!account.active && (
                  <option value="">Choose a saved account</option>
                )}
                {account.profiles.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.label}
                  </option>
                ))}
              </select>
            </div>
          )}
          <div className="account-actions">
            {!account.sharing && (
              <button
                className="primary"
                disabled={connecting}
                onClick={() => void accountAction("chatgpt-sign-in")}
              >
                {connecting
                  ? "Continue in your browser…"
                  : "Continue with ChatGPT"}
              </button>
            )}
            {connecting && (
              <button
                onClick={() => void request({ action: "chatgpt-cancel" })}
              >
                Cancel sign-in
              </button>
            )}
            {account.sharing && (
              <>
                <span className="badge saved">Using ChatGPT plan</span>
                <button
                  onClick={() =>
                    void change(async () => {
                      await request({ action: "chatgpt-usage" });
                    })
                  }
                >
                  Manage usage ↗
                </button>
              </>
            )}
            {!connecting && account.profiles.length > 0 && (
              <button
                onClick={() => void accountAction("chatgpt-sign-in", true)}
              >
                Add account
              </button>
            )}
            {account.connected && (
              <button
                disabled={connecting}
                onClick={() => void accountAction("chatgpt-disconnect")}
              >
                Sign out
              </button>
            )}
          </div>
        </div>
      )}
      <div className="form-row">
        <label htmlFor="reasoning-model">
          {setup.reasoning === "openrouter"
            ? "OpenRouter model ID"
            : "Assistant model"}
        </label>
        {setup.reasoning === "openrouter" ? (
          <input
            id="reasoning-model"
            key={modelKey + selectedModel}
            defaultValue={selectedModel || DEFAULT_MODELS.openrouter}
            onBlur={(e) => {
              if (e.target.value.trim())
                void change(() => save(modelKey, e.target.value.trim()));
            }}
            spellCheck={false}
          />
        ) : (
          <select
            id="reasoning-model"
            disabled={loading || !catalogReady}
            value={selectedModel}
            onChange={(e) => void change(() => save(modelKey, e.target.value))}
          >
            {!selected && (
              <option value={selectedModel}>
                {loading
                  ? "Loading models…"
                  : !catalogReady
                    ? "Connect to load available models"
                    : selectedModel
                      ? `${selectedModel} · Not in the current catalog`
                      : "Choose a model"}
              </option>
            )}
            {models.map((model) => (
              <option
                key={model.id}
                value={model.id}
                disabled={!model.assistant}
              >
                {model.label}
                {!model.assistant ? " · Not an assistant model" : ""}
              </option>
            ))}
          </select>
        )}
      </div>
      {setup.reasoning !== "openrouter" && (
        <div className="model-status">
          <p className="footnote" aria-live="polite">
            {modelError ||
              (!catalogReady
                ? "Connect this provider to see its available models."
                : loading
                  ? "Checking your connection’s available models…"
                  : `${models.length} models returned by this connection. Model access and supported features depend on your account.`)}
          </p>
          <button
            disabled={loading || !catalogReady}
            onClick={() => setRevision((v) => v + 1)}
          >
            Refresh models
          </button>
        </div>
      )}
      <hr />
      <h3>Voice & dictation</h3>
      <p className="footnote">
        Audio uses a separate API connection, including when the assistant uses
        your ChatGPT plan.
      </p>
      <div
        className="provider-choices"
        role="group"
        aria-label="Voice provider"
      >
        {(["gemini", "openai"] as const).map((provider) => (
          <button
            type="button"
            key={provider}
            className={`provider-choice ${provider}`}
            aria-pressed={setup.voice === provider}
            onClick={() => void change(() => chooseVoice(provider))}
          >
            <span className="provider-mark" aria-hidden="true">
              {provider === "gemini" ? "✧" : "◉"}
            </span>
            <span>
              <strong>
                {provider === "openai" ? "OpenAI" : PROVIDER_LABELS[provider]}
              </strong>
              <small>Voice & dictation</small>
            </span>
            <i aria-hidden="true" />
          </button>
        ))}
      </div>
      {error && (
        <p className="field-error" role="alert">
          {error}
        </p>
      )}
      {required.map((provider) => (
        <KeyField
          key={provider}
          provider={provider}
          saved={keys.find((key) => key.provider === provider)?.maskedSuffix}
          store={store}
        />
      ))}
      <p className="footnote">
        Credentials stay protected on this Mac. API key connections are billed
        separately from chat subscriptions.
      </p>
    </section>
  );
}
