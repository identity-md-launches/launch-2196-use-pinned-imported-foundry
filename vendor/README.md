# Offline Node dependency bundle

`viem.mjs` is an ESM bundle of the existing `viem@2.57.7` dependency and the transitive code it uses. It is ordinary source, not a submodule or `node_modules` directory. The application imports it relatively, so `node --test test/*.test.mjs`, the read-only CLI, worker and simulations work without npm/network. Node 24 provides `node:sqlite`; Foundry supplies the EVM tools.

The repository's package.json and lockfile are unchanged. `worker-dependencies.json` records pinned registry versions/integrities; `licenses/` retains their license notices. `bundle-inputs.json` is esbuild's relative input map. `viem-entry.mjs` lists only the imported public exports.

To regenerate, in a separate disposable build directory, copy the original package.json and package-lock.json, run `npm ci --ignore-scripts`, and copy `viem-entry.mjs` there as `entry.mjs`. With esbuild **0.25.12**, run from that directory:

```sh
esbuild entry.mjs --bundle --format=esm --platform=node --target=node24 --legal-comments=inline --outfile=viem.mjs --metafile=bundle-map.json
```

Copy `viem.mjs` back here and retain the input portion of the metafile. Running from the disposable directory ensures module labels contain relative package paths, not machine paths. Regeneration needs the pinned npm packages/bundler; running or testing the delivered bundle does not. This does not upgrade or replace the pinned dependencies. The complete contract/worker/fork suites exercise the bundle through the same imported APIs.
