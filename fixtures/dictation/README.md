# Dictation fixtures

`a02-correction-pairs.json` is the deterministic A02 oracle fixture for the contextual dictation
path (speech + screenshot + project memory → evidence-backed correction → insertion).

Everything here is invented. It holds no real audio, no real screenshot pixels, no real
credentials, and no user project names. The screenshot entries are artifact references plus
dimensions; the text a real model would read from the image arrives as OCR/selected-text/AX
evidence, which is exactly what the oracle checks is transmitted and corroborated.

The fixture is deliberately paired so the evidence dependency is visible:

- `json-response` — the same raw transcript and the same model rule, with the permitted screenshot
  (OCR evidence `JSON.parse(payload)`) and then without any screenshot. The with-evidence variant
  corrects Jason → JSON; the without-evidence variant must stay raw.
- `sqlite-migration` — the same raw transcript and model rule, with the prior project glossary
  (`SQLite`, variant `sequel lite`) and then without it. The with-glossary variant corrects; the
  without-glossary variant must stay raw.
- `jason-person-in-screenshot` / `jason-person-in-glossary` — evidence about a person called Jason;
  a model that proposes Jason → JSON anyway must be blocked and the raw word preserved.
- `protected-tokens` — a model at confidence 1.0 proposing new numbers, flags, negation, quoted
  literals, and paths; every proposal must be blocked.
- `acoustic-*` — substitutions justified by a verifiable normalization reason instead of evidence,
  plus a claimed reason that does not verify.

The fixture does not measure the real end-of-utterance latency of a live ASR + Qwen reasoner + AX
insertion; that needs the signed helper, Screen Recording consent, model weights, and the A04
hardware qualification. `packages/capture/src/correction/acceptance.test.ts` pins the frozen
TypeScript seam and measures the warm correction gate deterministically with an injected clock.
