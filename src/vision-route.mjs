// Compatibility guard for the former "deepseek-vision" admission adapter.
//
// A transparent alias needs a public, generation-bound delegate handle that
// preserves caller controls, retry policy and replay ownership. The current
// host's full-config llm.prepareCall() is NOT that handle: controls are frozen
// before adapter.prepareCall(provider, model, signal) can see them. Calling
// llm.stream() later would instead resolve a different connection generation.
//
// This fork therefore does not register an image-capable alias on ANY host.
// Legacy hosts are not an implicit compatibility fallback. Native host image
// routes and the explicit describe_image tool remain independent of this guard.
// Keep the entry point structural: no @deepseek-ai imports or private registry.

export const VISION_PROVIDER = 'deepseek-vision';
export const VISION_ROUTE_ERROR = 'UNSUPPORTED_VISION_ROUTE';

export const VISION_ROUTE_MESSAGE =
  'dsh-crew: "deepseek-vision" is disabled because this fork has no safe public '
  + 'generation-bound delegate binding. Select an image-capable model configured '
  + 'in DSH for pasted images, or use describe_image explicitly. '
  + 'Changing vision_provider only configures the tool; it does not enable automatic transcription.';

/** Safe to expose to the panel: contains no credentials or provider settings. */
export function visionRouteStatus() {
  return { provider: VISION_PROVIDER, supported: false, registered: false,
    code: VISION_ROUTE_ERROR, message: VISION_ROUTE_MESSAGE };
}

function unsupportedRoute() {
  const error = new Error(VISION_ROUTE_MESSAGE);
  error.name = 'CrewVisionCompatibilityError';
  error.code = VISION_ROUTE_ERROR;
  return error;
}

/**
 * Do not advertise images, access attachments, mutate history, or transcribe in
 * agent/pre-step. Guard persisted selections in agent/request, where resolved
 * request controls are available, and pass every native route through unchanged.
 * getConfig is retained in the signature for older callers, but never evaluated.
 */
export function installVisionRoute(ctx, _getConfig) {
  ctx.logger?.warn?.(VISION_ROUTE_MESSAGE);
  // Wrap the host's append-based model-selection listeners, including ones
  // registered before Crew. Appending here would inspect an intermediate seed
  // and could reject a native selection that another listener is about to set.
  // This diagnostic is not an admission guarantee for arbitrary later prepends
  // or short-circuiting plugins: the unregistered alias still fails NO_ADAPTER.
  const dispose = ctx.on('agent/request', async (_payload, next) => {
    const request = await next();
    if (request.provider === VISION_PROVIDER) throw unsupportedRoute();
    return request;
  }, { prepend: true });
  let disposed = false;
  return () => {
    if (disposed) return;
    disposed = true;
    dispose();
  };
}
