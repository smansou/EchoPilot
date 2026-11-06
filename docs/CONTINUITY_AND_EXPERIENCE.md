# EchoPilot continuity and experience

This branch starts at the October 18 personal-context baseline and incorporates the November 3 uncommitted fixes from worktree `81a5`. The source worktrees are untouched. Work is committed progressively on `feature/fluid-companion`; merge only after local testing with the user.

## Context strategy

The product should feel continuous because it can recover relevant evidence, not because it carries every transcript forever. Keep these layers separate:

| Layer | Purpose | Bound / lifecycle |
| --- | --- | --- |
| Explicit memory | Preferences, decisions, unfinished commitments | 40 records, 2,400 estimated tokens; never silently evict unfinished work |
| Startup working set | Recent dialogue, project identities, retained briefs, evidence | 6,000 estimated tokens; round-robin recent project excerpts |
| Current dialogue | Natural turn-taking and immediate follow-ups | GPT-Live manages its own long-conversation context; application archives older fragments |
| Local voice archive | Recall older spoken decisions and rationale | Encrypted on this Mac; chapters at 160 fragments or 24,000 characters; at most 200 records / 4 MiB |
| Coding-session library | Searchable source excerpts with dates and identities | Existing bounded local index; on-demand deeper file reads |
| Background evidence | The current question and currently visible referent | 6,000 estimated tokens per rolling minute; dedupe by source and content; at most 256 remembered source fingerprints |
| Screen context | Cursor or experimental gaze referent and nearby targets | Opt-in, readable text, freshness checks, bounded packet rate; no always-on screenshot upload |
| Backend work | Missing evidence, reasoning, tools, actions | Six model steps / ten tools per request, bounded initial evidence and tool outputs; no scheduled paid summarizer |

GPT-Live preserves its initial instructions and automatically summarizes and replaces its voice engine as context grows. Do not force an application reconnect simply because a cumulative injection counter crossed a threshold. Gemini retains the existing quiet-period rollover because its adapter has different session behavior. Source: [Managing GPT-Live sessions](https://developers.openai.com/api/docs/guides/live-conversations).

A new utterance supersedes the earlier topic for retrieval. Start with cached evidence, identify matching saved sessions by title/project, and hydrate missing local evidence quietly. A late result must not speak over a new request. Reference changes at the same source ID are updates, not duplicates. Archived records are dated evidence, not verified current status or authority to perform work.

No retention policy provides literal infinite verbatim recall. Explicit important facts remain in memory; old raw voice chapters eventually age out under the local storage cap. Account access, transport reconnection, end-of-session limits, and model behavior still require real voice testing. Do not claim measured latency or costs from synthetic checks.

## Tools and interaction

The backend includes local session and conversation search, evidence paging, sourced research, memory creation/removal, context inspection, new coding tasks, continuation from a saved session, task status/cancel, screen observation, semantic target search, visual focus, guarded desktop edits, clipboard read/copy, compact flow explanations, hang-up, and sleep.

Continuing a coding session creates a new fork through the installed CLI. It does **not** inject text into an already-running original session. The receipt distinguishes starting from completed work. Clipboard reads and writes are for explicit requests. Copied or observed content is untrusted evidence. Desktop edits keep their later-confirmation requirement.

Home exposes conversation, dictation, work/memory, recent conversations, and screen sharing. Settings contains provider setup, permissions, and experimental gaze. The introduction can be skipped and replayed. The notch attaches to the physical screen edge and remains nonfocusable. The orb falls from its existing notch position under constant gravity, loses energy through two bounces, and settles beside the referent with a damped approach. The caption stays hidden until response text streams; listening and speaking have distinct orb motion, with no separate waveform. Overlays are click-through and respect reduced motion. Visual explanations are small dismissible flow panels.

## Local acceptance with the user

1. Open the packaged branch build, finish or skip the introduction, and verify existing provider keys remain usable.
2. Start voice with Option–Space. Ask about two unrelated saved projects without naming session IDs. Ask a deeper follow-up and correct the topic mid-lookup.
3. End the call, resume, and ask about a decision from the earlier conversation. Verify the answer preserves uncertainty when saved records are incomplete.
4. Enable screen context on Home. Point to a paragraph, ask what it means, request a different target, and ask for a visual explanation. Verify the orb/caption stay on the correct display and do not take focus.
5. Test built-in and external displays, menu-bar visibility, Spaces, reduced motion, and target disappearance. The synthetic native-window test cannot prove exact physical-notch alignment on every Mac.
6. Dictate into an editable field from the shortcut. Test replacement selection, insertion at a caret, cancellation during startup, denied microphone access, and the Home button’s return-to-app behavior.
7. Ask to continue a known coding session with an explicit task. Check the new fork receipt and task result. Do not merge this branch until these local checks are satisfactory.

## Validation

TypeScript, renderer compilation, targeted tests and the full project suite are run during implementation. UI and overlay smoke tests use synthetic data / disposable profiles. Provider-backed voice quality, real microphone capture, TCC permissions, and hardware placement remain manual acceptance checks; no API key or real conversation content is needed by the synthetic tests.

### Verified branch build (November 6, 2026)

- Full project suite: 764 tests passed; TypeScript and production build passed.
- Desktop UI smoke: Home, skipped introduction, custom provider keys, voice controls, refreshed permissions, gaze controls, and disconnected-display recovery passed.
- Native companion smoke: hidden-until-speech caption, click-through edges, ordinary-window focus, stable target dedupe, setup cancellation, and destroyed-window recovery passed.
- Visual explanation smoke: bounded steps, literal text rendering, focus preservation, and recovery passed.
- `artifacts/local-app/EchoPilot-fluid-companion.app` passed local package qualification (signature, metadata, synthetic startup). Qualification uses disposable profiles; real provider/microphone/hardware acceptance remains the next step.
