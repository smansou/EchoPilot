# Permissions and revocation

EchoPilot runs entirely on your Mac and needs three macOS privacy grants before it can hear and
act. The onboarding flow asks for each one at the moment it first matters, explains why, and lets
you continue without it — the app degrades to a read-only state instead of stalling.

## Microphone (dictation and live conversation)

Required for dictation, local conversation and narration follow-ups. Without the microphone grant
the app records nothing: the dictation hotkey shows "microphone permission required" and the
session transcript stays empty. Grant it in **System Settings → Privacy & Security → Microphone**
and enable EchoPilot. macOS may require quitting and reopening the app after the first grant.

## Screen recording (meeting and editor context)

Screen recording is the grant macOS uses for *any* window-content capture, including the
on-device context reader that attaches the code editor or call window to a session. EchoPilot does
not upload or store pixels; it extracts text on device. Deny it and dictation plus narration still
work — only context-aware routing loses its grounding, and the app says so in the session header.

## Accessibility (insertion and dispatch)

Accessibility lets EchoPilot insert dictated text at the cursor and send a routed instruction to
the selected target (for example Codex or a chat app) without stealing focus. Without it,
dictation lands in the EchoPilot window only, and every dispatch request asks for confirmation.
Grant it in **System Settings → Privacy & Security → Accessibility**.

## Revocation

You can revoke any grant at any time in System Settings; revocation takes effect on the next
capture, not just after a restart, because each capture checks the current authorization before
recording. Revoking the microphone stops all recording immediately. Revoking Accessibility stops
insertion and dispatch. Revoking Screen Recording empties context attachments. If you revoke and
then re-grant, EchoPilot re-validates on the next session and never silently keeps using a cached
decision. A support bundle records only which grants were present, never their contents.
