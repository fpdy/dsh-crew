# ChatGPT Subscription Fast mode

This fork can request priority service for native DSH Hub workers using the `openai-codex` ChatGPT OAuth provider. Fast does not change the model, reasoning effort, tools or sandbox. It is not the `flash` tier and does not change the orchestrator's model. The default is off for both tiers.

## Persistent configuration

Merge these entries into `~/.config/dsh-crew/config.json`; keep your other settings:

```json
{
  "mode": "hub",
  "pro_provider": "openai-codex",
  "pro_model": "<your configured GPT model ID>",
  "pro_fast_mode": true,
  "flash_fast_mode": false
}
```

Use a model already configured and available in DSH's Models settings. Do not use the example placeholder as a real model ID. In this fork's settings panel, each Fast toggle shows its exact tier binding and stays disabled until a compatible Host reports support. An already-enabled toggle can always be switched off. The panel saves persistent defaults; restart the caller's MCP session to read them. `dsh_worker_config` can set `pro_fast_mode` and `flash_fast_mode` for the current MCP session only. Optional `fast_mode: true/false` on a worker call overrides its tier's default; explicit false wins over true. Without an override, escalation resolves the destination tier's default again. A failed Fast job is never automatically retried with Fast disabled: if pro would be Standard, Crew returns the original failure with `escalation_skipped: "fast_mode_would_be_disabled"`. Reasoning effort remains independently controlled by `default_effort` / `effort`.

External CLI workers ignore tier Fast defaults and reject an explicit `fast_mode: true`. Standalone workers cannot request Fast. Auto mode may use standalone for ordinary jobs, but never silently substitutes standalone when effective Fast is true. Unsupported provider/model routes and old Hubs fail before starting a job or acquiring a workspace lock. There is no fallback to paid OpenAI API access or automatic retry with Fast disabled.

Malformed, non-object or unreadable global worker configuration is rejected rather than treated as Fast off. Saving a setting never overwrites those invalid bytes; fix or restore the file first. Only a missing file receives defaults.

Codex's own configuration file does not configure DSH's native worker requests. No Codex feature flag, new token store, credential copying, alias adapter, or login subprocess is introduced by this feature.

## Host prerequisite and reversible patch

Unpatched DSH `0.2.1-alpha.2` cannot forward this request control. The exact source-compatible prerequisite is bundled in `host-compat/fast-mode/host.patch`, with before/after SHA-256 hashes in `manifest.json`. It adds typed per-request `serviceTier: 'priority'`, exact-route capability metadata, native SDK payload forwarding and raw terminal service-tier observation. It does not add a global provider Fast default. This patch targets the inspected `@earendil-works/pi-ai@1.0.2` integration; no dependency upgrade is required.

Run the following from the Crew package directory against a DSH source checkout, not an installed application bundle:

```sh
node scripts/host-fast-patch.mjs check /path/to/deepseek-harness
node scripts/host-fast-patch.mjs apply /path/to/deepseek-harness
```

`check` is read-only for the Host. Forward and reverse operations first run against a private declared-files-only snapshot and verify both output hashes and exact roundtrip bytes; corrupted patch/manifest data is refused before live writes. `apply` verifies every declared file before writing, rejects mixed/drifted/symlinked paths and undeclared patch targets, and retains original-file backups. An already-applied patch is reported without applying twice. A different release or modified source must be reviewed rather than force-applied. The installer never changes credentials, runs model requests, installs dependencies or rebuilds automatically.

Build the patched Host using its existing toolchain and build instructions. For the inspected source tree, the standard commands are:

```sh
pnpm run build:lib
pnpm run build:web
```

A source archive without `.git` also needs the Host build's public `DSH_CLIENT_COMMIT_HASH` override set to the original release's real source commit. For `dsh-v0.2.1-alpha.2`, its peeled Git tag resolves to `d743267388641bc76f17c45ce8b4c231aed1d32c`; export that value before the two commands above. It labels the release base, not the locally applied patch. Do not substitute the Crew branch's commit or a fabricated hash.

Build Crew's client as well (`pnpm run build:client` in Crew), then restart the DSH process/application that serves the existing GUI and refresh that page. A new server, browser refresh alone or rebuilding only Crew's panel does not update Host code. Confirm the settings capability status before enabling Fast. Restart Claude Code/Codex MCP sessions after persistent-default changes. A desktop distribution may require its usual packaging/build steps in addition to a source build; do not overwrite arbitrary installed app files.

To roll back, first disable Fast defaults and finish/cancel affected jobs through the normal job controls. Then:

```sh
node scripts/host-fast-patch.mjs revert /path/to/deepseek-harness
```

Revert also verifies patched-file hashes and refuses to overwrite later edits. Rebuild and restart the same Host afterwards. Retained backups are not deleted automatically. Fast-enabled persisted sessions require the patched Host. Do not resume them on an unpatched/rolled-back Host: old readers do not understand this request control and can ignore it. Use the patched Host to continue those sessions or explicitly start a new Standard session after disabling Fast.

## Requested versus observed service

A worker sends `service_tier: "priority"` when Fast is requested; when off, it omits the field and preserves the previous standard request behavior. `fast_mode_requested` in job/probe output records that choice. `response_service_tier` records only the raw terminal server response observed by the SDK, or null when absent/unknown. A server response of `default` is displayed as Standard even if priority was requested. A later request/error resets the observation, preventing a previous successful step from masquerading as confirmation for the current step. SDK-normalized costs, inferred pricing and elapsed time are not used as evidence of applied Fast.

[Official Codex speed documentation](https://learn.chatgpt.com/docs/agent-configuration/speed) describes increased usage consumption (currently 2.5× included subscription usage and 2× purchased credits for supported Fast models). Actual availability depends on account, model, workspace policy and rollout. [Codex's request mapping](https://github.com/openai/codex/blob/main/codex-rs/protocol/src/config_types.rs) maps Fast to `priority`; this source implementation is not a stable third-party OAuth HTTP specification. Paid API tier/fallback contracts must not be assumed for the ChatGPT subscription endpoint. No latency, availability or billing amount is guaranteed by Crew.

## Offline validation and live checks

Tests use in-memory adapters, local transport fixtures, test-only Loader compositions and isolated config directories. They cover persistence defaults, explicit false, tier policy/escalation, MCP/Hub preflight, old Host refusal, request equality/freezing, retry/resume, SSE/WebSocket/common payload handling, native image/tool/cancellation regressions and raw server downgrade/unknown observations. The patch installer is tested without a Git repository, including preflight refusal, application, idempotence, revert and path safety. No production OAuth tokens or real model requests are needed.

### Validation record

The final reviewed source passed 138 Crew tests (no skips), 337 focused Host tests across 10 files, and the two MCP dispatch tests repeated against the rebuilt release bundle with `DSH_CREW_TEST_BUNDLE=1`. Host `build:lib` and `build:web` passed using the verified release-base commit override described above. The client typecheck/module-loader render check, dependency-free seven-tool MCP handshake, and offline package dry-run passed. The real 23-file patch was checked against the applied Host and applied/reverted/reapplied in an isolated original-byte fixture with every manifest hash verified.

Independent review fixes cover Fast→Standard escalation, invalid config preservation, pre-write patch output-hash validation, and an adapter control-mutation race during credential resolution. Fast's captured value now remains stable across awaits. The generated SDK bundle's code-generation template whitespace and unified-diff context whitespace are intentionally preserved.

No running Host was restarted and no model/account configuration was changed. Client behavior was verified with offline Loader/render fixtures, not an authenticated live GUI refresh. Restart the serving Host and refresh the existing GUI for activation; live account eligibility, tier acknowledgment, latency and billing remain unverified.

A real subscription smoke test is separate and opt-in because it consumes usage. `dsh_worker_probe` also makes a real bounded model request; checking capability status alone does not. Offline test success does not prove account entitlement, applied Fast or faster processing.
