import { resolveTierBinding } from '../tier-binding.mjs';

export type FastSupport = {
  ok: true;
  protocol: 1;
  tiers: Record<'pro' | 'flash', { provider: string; model: string; supported: boolean; reason?: string }>;
};

/** Fail closed on old/invalid responses. Matching the binding prevents stale enablement. */
export function parseFastSupport(value: any): FastSupport | null {
  if (value?.ok !== true || value.protocol !== 1) return null;
  for (const tier of ['pro', 'flash']) {
    const entry = value.tiers?.[tier];
    if (!entry || typeof entry.provider !== 'string' || typeof entry.model !== 'string'
      || typeof entry.supported !== 'boolean'
      || (entry.reason !== undefined && typeof entry.reason !== 'string')) return null;
  }
  return value;
}

export function canEnableFast(status: FastSupport | null, config: any, tier: 'pro' | 'flash'): boolean {
  if (!config || config.mode === 'standalone') return false;
  const binding = resolveTierBinding(tier, config);
  const entry = status?.tiers[tier];
  return entry?.supported === true && binding.provider === 'openai-codex'
    && entry.provider === binding.provider && entry.model === binding.model;
}

/** An outgoing request is not proof of fulfilled priority service. */
export function fastObservation(job: any): 'none' | 'requested' | 'confirmed' | 'standard' | 'other' {
  if (job?.fast_mode_requested !== true) return 'none';
  if (job.response_service_tier === 'priority' || job.response_service_tier === 'fast') return 'confirmed';
  if (job.response_service_tier === 'default') return 'standard';
  if (typeof job.response_service_tier === 'string') return 'other';
  return 'requested';
}
