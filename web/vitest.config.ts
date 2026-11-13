import { defineConfig } from 'vitest/config'

// Worker/chain tests run in plain node (no DOM, no network). `.wasm` imports (which Wrangler compiles in the Worker)
// become a compiled WebAssembly.Module here, so the real endpoints import unchanged.
const wasmModule = {
  name: 'wasm-module',
  enforce: 'pre' as const,
  load(id: string) {
    if (!id.endsWith('.wasm')) return null
    return `import { readFileSync } from 'node:fs'\nexport default new WebAssembly.Module(readFileSync(${JSON.stringify(id)}))`
  },
}

export default defineConfig({
  plugins: [wasmModule],
  test: { environment: 'node', include: ['test/**/*.test.ts'], testTimeout: 20000 },
})
