import { createRequire } from 'node:module';

const req = createRequire(import.meta.url);
try {
  const serverOnlyPath = req.resolve('server-only');
  req.cache[serverOnlyPath] = {
    id: serverOnlyPath,
    filename: serverOnlyPath,
    loaded: true,
    exports: {},
  } as NodeModule;
} catch {
  // ignore if server-only is already aliased
}
