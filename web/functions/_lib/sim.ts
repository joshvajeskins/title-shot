// The bout-sim wasm inside a Worker: Wrangler compiles the .wasm import to a WebAssembly.Module at build time.
import wasmModule from '../../src/sim/pkg/bout_sim_bg.wasm'
import { loadSimSync, type Sim } from '../../src/sim'

export const sim = (): Sim => loadSimSync(wasmModule as WebAssembly.Module)
