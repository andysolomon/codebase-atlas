import { defineConfig, loadEnv, type Connect, type Plugin, type ViteDevServer } from 'vite';

/** Serve `api/enrich.ts` from the dev server.

    In production that file is a Vercel Function; under `bun run dev` there is no backend at all, so
    the ANALYZE button had nothing to call and analysis silently never happened. This mounts the same
    handler as dev middleware — the module is loaded through Vite, so editing it reloads it — and
    lifts `.env.local` into `process.env` so the key it needs is where the provider looks for it.

    Dev only. `vite build` emits no server code, and Vercel keeps running the real function. */
function enrichDevEndpoint(mode: string): Plugin {
  return {
    name: 'atlas-enrich-dev',
    apply: 'serve',
    configureServer(server: ViteDevServer) {
      // '' = no prefix filter: AI_GATEWAY_API_KEY / VERCEL_OIDC_TOKEN / MINIMAX_API_KEY are server-side
      // names with no VITE_ prefix, and they are read from process.env deep inside the provider.
      const env = loadEnv(mode, process.cwd(), '');
      for (const [k, v] of Object.entries(env)) if (process.env[k] === undefined) process.env[k] = v;

      server.middlewares.use('/api/enrich', async (req: Connect.IncomingMessage, res, next) => {
        const method = req.method || 'GET';
        // GET is the model probe and POST runs a pass. Anything else falls through — and so would GET,
        // straight into Vite's module pipeline, which answers with the file's own transformed source.
        if (method !== 'POST' && method !== 'GET') return next();
        try {
          const body = method === 'POST' ? await new Promise<string>((resolve, reject) => {
            let s = '';
            req.on('data', (c) => { s += c; });
            req.on('end', () => resolve(s));
            req.on('error', reject);
          }) : undefined;
          const mod = await server.ssrLoadModule('/api/enrich.ts');
          const handler = mod.default as (r: Request) => Promise<Response>;
          const out = await handler(new Request('http://localhost/api/enrich', {
            method,
            ...(body != null ? {
              headers: { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(body)) },
              body,
            } : {}),
          }));
          res.statusCode = out.status;
          out.headers.forEach((v, k) => res.setHeader(k, v));
          res.end(await out.text());
        } catch (e) {
          server.config.logger.error(`[atlas] /api/enrich failed: ${(e as Error).message}`);
          res.statusCode = 500;
          res.setHeader('content-type', 'application/json');
          res.end(JSON.stringify({ ok: false, error: 'the dev enrichment endpoint threw — see the terminal' }));
        }
      });
    },
  };
}

export default defineConfig(({ mode }) => ({
  build: { target: 'es2022' },
  server: { port: 5173 },
  plugins: [enrichDevEndpoint(mode)],
}));
