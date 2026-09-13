# Reasoner (M02) — bundled Qwen3.5-4B behind the F01 contract

This target is the on-device worker that serves the shared Reasoner contract:

```swift
run(task: ReasoningTask, boundedContext: AssembledContext,
    outputSchema: OutputSchema, abortSignal: AbortSignal) -> JSONValue
```

It is the same seam the TypeScript side calls through
`packages/memory/src/consolidation/index.ts` (`createMemoryConsolidator`) and the same bounded
context that `packages/memory/src/context/index.ts` owns, so an answer produced here is grounded in
exactly the evidence the assembler measured.

## Budget invariant

Every request must obey the one shared budget (`BoundedBudget`):

```
B            = min(8192, floor(0.25 * contextCapacity))
input        = B - outputReservation            (outputReservation = min(2048, max(1, B/4)))
totalTokens  = inputTokens + accounting.output = sum(accounting.*) <= maxTokens = B
```

The worker re-checks the arriving `AssembledContext` against the bundled model's declared capacity
and refuses the request before touching the model if any part of the invariant is broken
(`ReasonerContractError.unboundedRequest`). A model manifest without a declared, positive, finite
`contextCapacity` is rejected at load time — there is no guessed window.

Images are charged with the processor's own calculation (`Qwen35VisionProcessor`,
`ceil(width/28) * ceil(height/28)`, never zero) and the admitted descriptors travel on
`AssembledContext.images`, so the charge and the payload the vision tower receives match. Tool
schemas are charged with the exact `Tool <name>: ` wrapper the prompt sends, and `accounting.reserve`
is the tokenizer's measurement of the assembled prompt minus its counted sections — headers and
separators can never be smuggled past the ceiling uncharged. The output allowance is reserved and
the decoded reply is measured against it before it leaves the worker; an over-long reply is reported
as a failed job instead of being silently truncated.

## Bundle layout

`Qwen35Bundle.load(at:)` expects:

```
<bundle>/model.json          # Qwen35BundleManifest: id "qwen3.5-4b-q4", contextCapacity, vision patch
<bundle>/tokenizer.json      # exact tokenizer (vocab + merges + Split pre-tokenizer); absent -> load fails
<bundle>/weights/model.safetensors
```

`tokenizer.json` is read the way the model runtime reads it: the vocabulary object, the merges table
in either the legacy `"Ġ t"` string form or the newer `["Ġ", "t"]` pair form, and the ByteLevel Split
pre-tokenizer pattern. Counting applies the bundle's merges by exact token pair after byte-level
encoding, so spaces and newlines are charged like the model charges them. A `tokenizer.json` that
exists but does not parse fails the load — the whitespace counter is used only by the scripted
stand-in seam, when a stand-in bundle has no tokenizer file at all.

The bundled model is Qwen3.5-4B (4-bit quantized), declared as `qwen3.5-4b-q4` with a 32,768-token
context window, which yields the standard route `B = min(8192, floor(0.25 * 32768)) = 8192` with a
2,048-token output reservation and a 6,144-token input cap.

`ScriptedStandInBackend` exists so the bounded-context and grounding behavior can be exercised
without weights, downloads, or paid calls — the same way the M02 acceptance test drives the seam.
Loading a bundle without a supplied backend reports that no local runtime is linked: the manifest,
tokenizer and weights are bundled here, while the MLX execution runtime that consumes the weights is
a separate build step and is not silently faked.

## Running

```sh
# Build the worker through the native workspace (`EchoPilotReasoner` target / `echopilot-reasoner`
# product in `native/macos/Package.swift`), from `native/macos`:
swift build --package-path . --product echopilot-reasoner       # or, from the repository root:
swift build --package-path native/macos --product echopilot-reasoner

# Single-binary build without the package manifest:
swiftc Sources/Reasoner/*.swift -o build/echopilot-reasoner
ECHOPILOT_QWEN35_BUNDLE=/path/to/bundle ECHOPILOT_REASONER_SCRIPT=script.json \
  ./build/echopilot-reasoner
```

```sh
# Native self-test: tokenizer, bundle loading, bounded context and worker, no weights required.
ECHOPILOT_REASONER_SELFTEST=1 ./build/echopilot-reasoner
```

The worker speaks newline-delimited JSON on stdio: requests
`{"task":{"taskId","instruction"},"context":{...AssembledContext...},"outputSchema":{"title":...}}`,
responses `{"taskId","status":"ok"|"failed","output":...,"coverage":"complete"|"partial","error":...}`.
A failed model call is reported as `status:"failed"` with `coverage:"partial"`; the caller then uses
its deterministic, evidence-backed template rather than an unverified model reply.
