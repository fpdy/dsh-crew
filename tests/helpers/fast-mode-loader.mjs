// Test-only fallback for source MCP tests in a Host-anchored checkout. No
// dependency installation or production resolver changes are needed.
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
const require = createRequire(process.env.DSH_HOST_ANCHOR ?? import.meta.url);
export async function resolve(specifier, context, nextResolve) {
  try { return await nextResolve(specifier, context); }
  catch (error) {
    if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error;
    if (specifier.startsWith('@modelcontextprotocol/sdk/')) return { url: pathToFileURL(require.resolve(specifier)).href, shortCircuit: true };
    if (specifier !== 'zod') throw error;
    const sdkRequire = createRequire(require.resolve('@modelcontextprotocol/sdk/server/mcp.js'));
    return { url: pathToFileURL(sdkRequire.resolve('zod')).href, shortCircuit: true };
  }
}
