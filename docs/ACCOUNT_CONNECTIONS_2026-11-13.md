# Assistant accounts and model discovery — November 13

Connections now separates the assistant account from the audio provider. Existing API configurations remain usable. Select **ChatGPT account → Continue with ChatGPT** to authorize the assistant using an eligible ChatGPT plan. Audio still requires the selected OpenAI or Gemini API key.

The account integration implements OpenAI's documented public dynamic-registration flow: a persistent installation host ID, system browser, IPv4 loopback callback, state/nonce/PKCE, issued client registration, signed ID-token verification, encrypted local credentials, serialized refresh rotation, distinct saved accounts, and sign-out/revocation. Tokens never enter the renderer. No other app's saved tokens are read. The implementation follows the public protocol documentation; no DevKit source or its noncommercial license is incorporated.

Account-authenticated inference uses the public Responses API with `store:false` and `stream:true`. The adapter keeps function calls/results, screen images, and encrypted reasoning items across the backend tool loop. It rejects incomplete streams and reports subscription usage-limit errors. OpenAI API-key reasoning also uses Responses so the catalog is no longer tied to older Chat Completions models.

The model picker discovers the current connection's catalog. ChatGPT display names and ordering come from its account catalog. OpenAI, Anthropic, and Gemini API catalogs are fetched with their saved keys; paginated catalogs are read fully within a defensive page limit. Specialized models remain visible but disabled as assistant choices when identifiable from their metadata/model family. Discovery establishes catalog visibility, not proof that every model supports every tool or is callable under the user's quota. OpenRouter retains manual model-ID entry. Static model enums were removed from settings validation.

New ChatGPT connections choose the first advertised assistant model, and the user can change it. Changing the audio provider preserves the assistant selection. Account switching stops the active conversation before changing credentials. Manage usage opens ChatGPT's usage settings.

## Verification

- Typecheck and the full project suite passed (785 tests); final targeted authentication and voice-to-screen regressions also passed. Electron UI smoke checks dynamic model options, specialized model disabling, account sign-in entry, audio/assistant independence, and retained OpenRouter entry.
- The November 13 local app bundle passed startup qualification: `artifacts/local-app/EchoPilot-Nov13.app`.
- Controlled OAuth tests use a local callback and generated RSA identity tokens. They check identity validation, protected persistence, resume/sign-out, encryption unavailability, and concurrent token refresh.
- Controlled account-authenticated Responses tests cover screen-tool calls and results, image/reasoning translation, usage failures, and incomplete streams.
- No real account sign-in or paid inference performed by the coding agent. Real sign-in, account-specific catalog access, and live orb/screen interactions still require user acceptance testing.

## Official protocol references

- https://developers.openai.com/siwc/token-sharing-open-source/sign-in
- https://developers.openai.com/siwc/token-sharing-open-source/profiles-and-sessions
- https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference
- https://developers.openai.com/api/reference/resources/models/methods/list
- https://platform.claude.com/docs/en/api/models/list
- https://ai.google.dev/api/models
