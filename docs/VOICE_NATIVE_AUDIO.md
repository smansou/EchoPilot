# Native voice audio and interruption

The voice fix follows the official OpenAI GPT-Live WebRTC example's ongoing-call structure: the original microphone track goes to the peer connection and incoming media plays through native WebRTC audio. Our context/tool work stays on the backend/sideband path.

A concrete deviation had broken this arrangement. The startup/wake replay worklet remained between microphone and sender indefinitely. A non-silent backlog cannot catch up when input and consumption both run at 1x speed; every future user interruption could therefore arrive seconds late. Replay is now finite: when it drains, or GPT-Live begins producing assistant output, the sender switches to the original microphone and closes replay resources. Quiet/close cannot accidentally restore live capture during an asynchronous track replacement.

There is an explicit startup tradeoff: a full-duplex backchannel can end replay before the remaining startup tail is sent. Current microphone input takes priority at that point. We do not promise lossless delayed replay and zero live latency simultaneously.

For Gemini's PCM path, an interruption stops and disconnects all queued WebAudio sources and resets scheduling. An interrupted provider envelope cannot refill the queue or assistant caption with the canceled output; the user transcription and later assistant turns still flow. Discarding same-envelope captions is our consistency inference from Google's canceled-generation guidance.

We did not invent GPT-Live cancellation/truncation events or add a new local VAD. The model controls its yield timing. LiveKit's established GPT-Live integration documents the same limitation: local forced cutoff requires extra VAD and cannot truncate GPT-Live history. The transport repair removes our backlog, but actual model interruption latency still needs a live conversation test.

## Established references actually read

- Official OpenAI browser WebRTC implementation: https://developers.openai.com/api/docs/guides/voice-webrtc?api=live
- Official GPT-Live session handling: https://developers.openai.com/api/docs/guides/live-conversations
- Official interruption prompting: https://developers.openai.com/api/docs/guides/live-prompting
- LiveKit GPT-Live integration and interruption limitations: https://docs.livekit.io/agents/models/realtime/gpt-live/#turn-detection-and-interruption
- Google Live interruption guidance: https://aistudio.google.com/docs/live-api/capabilities#interruptions

## Real browser verification

Run `node scripts/check-live-media-chromium.mjs <electron-executable>`. It uses actual Chromium WebRTC peers, AudioWorklet and WebAudio scheduling with synthetic input. It records no physical microphone and makes no provider requests.

The retained harness verified that a three-second startup backlog leaves the sender when the assistant event arrives, and that interrupting four queued one-second PCM sources stops/disconnects all four, allowing the next turn to schedule without the stale tail. These are browser-mechanics checks, not end-to-end measurements of the provider's native barge-in timing.
