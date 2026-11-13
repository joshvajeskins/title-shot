/* tslint:disable */
/* eslint-disable */

/**
 * Full request body for a sentence (the free preview uses the same bytes as the paid forge).
 */
export function build_request(model_id: string, sentence: string): string;

/**
 * Sentence validity check shared with the contract: `{ok}` or `{ok:false, error}`.
 */
export function check_sentence(sentence: string): string;

/**
 * Raw model JSON -> `{ok:true, spec}` or `{ok:false, error:{code, field}}`.
 */
export function normalize(raw_json: string): string;

/**
 * Odds over `n` derived seeds -> `{ok, odds}`.
 */
export function odds(champ_json: string, chall_json: string, seed_hex: string, rule: number, n: number): string;

/**
 * `{prefix, suffix}` strings: body = prefix + json_escape(sentence) + suffix.
 */
export function request_parts(model_id: string): string;

/**
 * Library, rules, schools, styles, limits, version and hash for the UI.
 */
export function rulebook_json(): string;

/**
 * Spec JSONs + 64-hex seed + rule -> `{ok, fight:{rounds, events, winner, rounds_won, state_hash}}`.
 */
export function simulate(champ_json: string, chall_json: string, seed_hex: string, rule: number): string;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly build_request: (a: number, b: number, c: number, d: number) => [number, number];
    readonly check_sentence: (a: number, b: number) => [number, number];
    readonly normalize: (a: number, b: number) => [number, number];
    readonly odds: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number) => [number, number];
    readonly request_parts: (a: number, b: number) => [number, number];
    readonly rulebook_json: () => [number, number];
    readonly simulate: (a: number, b: number, c: number, d: number, e: number, f: number, g: number) => [number, number];
    readonly __wbindgen_externrefs: WebAssembly.Table;
    readonly __wbindgen_malloc: (a: number, b: number) => number;
    readonly __wbindgen_realloc: (a: number, b: number, c: number, d: number) => number;
    readonly __wbindgen_free: (a: number, b: number, c: number) => void;
    readonly __wbindgen_start: () => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;

/**
 * Instantiates the given `module`, which can either be bytes or
 * a precompiled `WebAssembly.Module`.
 *
 * @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
 *
 * @returns {InitOutput}
 */
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
 * If `module_or_path` is {RequestInfo} or {URL}, makes a request and
 * for everything else, calls `WebAssembly.instantiate` directly.
 *
 * @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
 *
 * @returns {Promise<InitOutput>}
 */
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;
