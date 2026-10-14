# Desktop redesign · October 4, 2026

The new interface has four pages: General, Dictation & agent, Gaze, and History. Everyday interaction takes place in a small desktop notch.

## Start

1. Quit the older EchoPilot app so it releases its global shortcuts.
2. Open the new app linked in LIVE_HANDOFF.md.
3. In General, choose Gemini or OpenAI and save its API key. Advanced lets you choose live voice and reasoning separately, including OpenRouter for reasoning/dictation. See [native live voice](REALTIME.md).
4. Allow Microphone and Accessibility in macOS settings. Screen Recording is optional for screenshot fallback. Camera is only needed for gaze.
5. Click a text field in another app, press Control+Option+Space, speak, then press again. Smart dictation is on by default. Plain dictation is available in settings.
6. Option+Space opens live-agent mode. Speak naturally over continuous native audio. Proposed supported desktop actions ask for spoken confirmation. Command+Option+Period cancels the session.
7. Gaze → Calibrate gaze opens targets on the built-in display. Follow the light with your eyes and keep your head still. Escape cancels. Failed or canceled setup releases the camera session. If your eyes cannot be tracked during calibration, setup stops with a lighting/positioning message instead of waiting indefinitely. Gaze estimates never move the mouse.

## Context and memory

Smart dictation and live turns use bounded Accessibility text. If that is insufficient and Screen Recording is allowed, a single screenshot can be sent to the selected provider, without a capture preview. Secure/excluded observations do not trigger screenshot fallback. Camera frames are never sent.

Questions about Claude or Codex projects use automatically discovered local saved sessions. Retrieval considers project names, current screen context, relevant conversation excerpts, and recent EchoPilot conversations. It can support questions and brainstorming; saved records are not a guarantee of live task status. No coding-agent pairing or command-line configuration is required. Unsupported or ambiguous records require clarification.

History is encrypted locally with macOS safeStorage. Audio, screenshots, and camera images are not saved. API keys use Keychain.

## Known boundaries

- Live paid-provider speech, real insertion across applications, and webcam accuracy still require hands-on acceptance.
- Desktop actions support a bounded set of AX control operations. Arbitrary file rename and general multi-step desktop automation are not implemented.
- Insertion requires a readable editable AX field and cursor range. A changed or unsupported field is not modified; recognized text remains in History.
- Gaze calibration is per running session. Poor tracking must not be interpreted as a precise target.
- Local Claude/Codex session files are supported; inaccessible, remote, and unsupported desktop session stores are not assumed available.
- This app has an ad-hoc local signature and is not notarized.
