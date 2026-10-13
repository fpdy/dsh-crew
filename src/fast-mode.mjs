// Crew owns this request control, never the host's native Fast preference.
export const FAST_CONFIG_KEYS = Object.freeze(['pro_fast_mode', 'flash_fast_mode']);

export function validateFastMode(value, name = 'fast_mode') {
  if (typeof value !== 'boolean') throw new TypeError(`${name} must be a boolean`);
  return value;
}

export function validateFastModeConfig(config) {
  for (const key of FAST_CONFIG_KEYS) {
    if (Object.hasOwn(config, key)) validateFastMode(config[key], key);
  }
  return config;
}

/** Resolve only AFTER tier policy; explicit false is an override, not absence. */
export function resolveFastMode(tier, config = {}, explicit) {
  if (explicit !== undefined) return validateFastMode(explicit);
  const value = config[`${tier}_fast_mode`];
  return value === undefined ? false : validateFastMode(value, `${tier}_fast_mode`);
}

/** Metadata lookup only: no stream, credential resolution, or model request. */
export async function fastModeSupport(llm, binding, signal) {
  if (binding.provider !== 'openai-codex') return { supported: false, reason: 'unsupported_provider' };
  if (typeof llm?.resolveModelInfo !== 'function') return { supported: false, reason: 'host_metadata_unavailable' };
  try {
    const info = await llm.resolveModelInfo(binding.provider, binding.model, signal);
    return Array.isArray(info?.serviceTiers) && info.serviceTiers.includes('priority')
      ? { supported: true }
      : { supported: false, reason: 'priority_not_supported' };
  } catch {
    // Metadata/adapter errors can contain secrets; expose only the category.
    return { supported: false, reason: 'model_metadata_unavailable' };
  }
}

export async function requireFastModeSupport(llm, binding, signal) {
  const result = await fastModeSupport(llm, binding, signal);
  if (!result.supported) throw new Error(`Fast mode unavailable: ${result.reason}`);
  return result;
}

export function requireFastHub(mode, fastMode) {
  if (fastMode && mode !== 'hub') throw new Error('Fast mode requires a reachable, compatible DSH hub; standalone and external CLI workers are unsupported');
}

/** Read ONLY the terminal raw chunk; costs/usage are not service-tier evidence. */
export function terminalResponseServiceTier(stream) {
  if (!Array.isArray(stream)) return null;
  for (let index = stream.length - 1; index >= 0; index--) {
    const record = stream[index];
    if (record?.type !== 'chunk' || record.chunk?.type !== 'finish') continue;
    return typeof record.chunk.responseServiceTier === 'string' ? record.chunk.responseServiceTier : null;
  }
  return null;
}
