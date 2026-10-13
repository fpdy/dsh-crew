# Vision safety in this fork

## Supported behavior

This fork removes the former `deepseek-vision` adapter and the global `agent/pre-step` image-transcription hook. It does not advertise image support for an alias whose delegation contract cannot be met. The alias remains disabled on legacy hosts too; absence of `llm.prepareCall` is not evidence of safe compatibility.

- Native DSH model routes remain native. Crew does not read their attachments, append transcripts, strip images, change providers or replace request controls/retry/pricing behavior.
- Explicit `describe_image` and `generate_image` tools remain available through their configured providers. `vision_provider` configures the explicit tool, not an automatic image-paste bridge.
- Persisted `deepseek-vision` agent selections are rejected in the resolved `agent/request` waterfall with `UNSUPPORTED_VISION_ROUTE` and instructions to select a native image-capable model or use `describe_image` explicitly. Direct LLM-runtime calls see the host's ordinary `NO_ADAPTER` response because no alias adapter is registered.
- No native provider registrations, credentials, default models or worker tier bindings are modified by this guard.

There is intentionally no guessed public binding API, private-registry access or fallback that calls `llm.stream()` after resolving different model metadata. Full alias restoration would require a separately reviewed host delegation API and replay-ownership design.

## Why the old wrapper is not repaired by adding one method

Current DSH adapters prepare model metadata and dispatch together. The runtime's public `llm.prepareCall(config)` returns a one-shot, full-config handle; it freezes and verifies reasoning effort, output limits, temperature and stop controls. An adapter's `prepareCall(provider, model, signal)` does not receive those controls. Preparing a delegate runtime call with only provider/model cannot transparently forward later caller controls. Resolving the delegate again during streaming would instead lose connection-generation binding.

The old duck adapter also omitted `imageRequestPricing`, did not preserve delegate retry policy, and nested another runtime boundary that could drop native replay state. Retiring that adapter removes those unsafe paths rather than pretending an incomplete adapter satisfies the contract. Native host adapters keep their own pricing, retry and replay semantics.

## Cancellation and ordinary provider failures

`describeFile(getConfig, imagePath, question, { signal })` and `describeFileWithProvenance(getConfig, imagePath, question, { signal })` accept an optional fourth argument. Existing three-argument callers still work. The explicit tool forwards its execution-context signal.

Cancellation propagates to API requests, response-body reads and CLI subprocesses. It stops the fallback chain and is not converted into a successful transcription or cached result. Cancellation itself does not remove previously verified cache entries. Ordinary provider errors retain the existing configured native-to-CLI fallback policy. This does not change which providers are allowed, require new credentials, or validate the real native vision endpoint.

## Applying an update to an already-running installation

A profile installed with `link:/path/to/dsh-crew` uses source files for the Host and prebuilt artifacts for the browser/MCP shim. Rebuild the affected artifacts after changing their source:

```bash
npm run build:client
npm run build:mcp
```

Restart the existing DSH application after updating Host source. A browser refresh or client-HMR event alone does not replace the already-imported Host module. Do not start a second server as a substitute for updating the existing instance.

The rebuilt panel requests `GET /_dsh/dsh-crew/vision-route/status`. A successful updated Host returns `supported: false`, `registered: false`, `provider: "deepseek-vision"`, and `code: "UNSUPPORTED_VISION_ROUTE"`. The endpoint contains no credentials or provider settings. Until that exact status is confirmed, the panel reports that the safety guard is unverified and requests a DSH restart; it does not claim the old global hook has disappeared.

## Offline verification

Run these commands from the source checkout; the npm package does not ship the test suite. Ordinary tests need Node.js and no model account. Python 3.11+ with `tomllib` enables the optional installer-TOML checks; put that interpreter first on the test command's `PATH` so version-manager shims do not depend on the real `HOME`:

```bash
node --test tests/*.test.mjs
```

The optional real-host contract and compiled-client tests skip explicitly unless `DSH_HOST_ANCHOR` points to an existing built DSH runtime's manifest. For example, use the runtime project manifest from a local Desktop build, not a second running Host:

```bash
DSH_HOST_ANCHOR=/absolute/path/to/runtime/project/package.json \
  node --test tests/*.test.mjs
```

The contract tests import that installation's public Cordis/LLM modules into an isolated context and use only fake adapters. They verify:

- The unsafe alias is not listed and cannot trigger missing adapter-method errors, including pricing/prepared/direct calls.
- Persisted alias selection is rejected after append-based model-selection listeners, whether installed before or after Crew.
- Native non-default pricing/retry behavior is unchanged; prepared calls retain their original registration after replacement.
- Caller controls, one-shot behavior and config-drift checks remain the host's responsibility.
- Native images and opaque replay state are preserved in native prepared/direct calls.

Cancellation tests isolate `HOME`, use local fake CLI processes and mocked fetch responses, and make no real model/network calls. They check aborts before I/O, during CLI/API work and response reading, fallback suppression, process cleanup, cache races, ordinary failures, and legacy three-argument callers. Image-generation regressions confirm that noisy progress logs are diagnostic-only: successful generation still requires the expected file, and nonzero exits/missing output still fail.

The fork's host safety contract has been checked against the local DSH `0.2.1-alpha.2` build. This is **not** a claim that live workers, an image provider's endpoint, every translated upstream workflow, or historical standalone runtime pins are compatible. Live-model checks and full bridge restoration are separate work.

## Validation and self-review record — 2026-10-13

- Full offline suite: **95 passed, 0 failed, 0 skipped**, with the built-host anchor and bundled Python 3.12. The initial ambient Python shim could not run after the tests isolated `HOME`; rerunning with bundled Python fixed that environment issue without changing user settings or installer tests.
- The [browser artifact](<../lib/client.js>) was rebuilt with existing local build tooling. Client type-check, JavaScript syntax checks and `git diff --check` passed. The compiled client loads with the built host's React and renders the unverified-Host notice in an offline server-rendering test. No dependency installation or runtime-pin upgrade was needed.
- Package dry-run passed, includes this safety document and updated source/client, and ran no lifecycle scripts. The existing pnpm version mismatch was made a warning only for the dry-run command; package-manager pins were not edited.
- Independent review reproduced and fixed two P2 defects: guard ordering relative to model selection, and successful image generation incorrectly failing on verbose stderr. Both fixes gained offline regressions. The safety-document packaging omission was also fixed. No confirmed introduced blocker remained after re-review.
- Read-only checks of the existing GUI confirmed Hub/client HTTP 200 and delivery of the rebuilt status-aware client. The existing Host still returned **404** for the new guard-status endpoint: the updated Host source is **not active until DSH is restarted**. No Host restart, profile change, real provider CLI/model request or paid API smoke test was performed.

## Remaining limits

- The guard uses the documented prepend option to wrap the host's append-based selection listeners. Another plugin that later prepends or short-circuits the waterfall can affect the diagnostic; this is not an admission guarantee for arbitrary middleware. The alias remains unregistered and the runtime's `NO_ADAPTER` remains the final safety boundary.
- POSIX cleanup kills the isolated child process group, including descendants that stay in it. Processes that deliberately leave that group and Windows descendant cleanup remain best-effort/unverified; prompt promise settlement does not guarantee universal descendant termination or cancellation of work already accepted remotely.
- The existing JSON cache still uses snapshot writes. Concurrent successful descriptions with different keys can overwrite one another's newly added entries. That pre-existing lost-update issue was not expanded into a cache-storage redesign here; cancellation checks prevent aborted operations from committing unverified results.
