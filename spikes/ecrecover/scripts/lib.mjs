// Shared helpers: NEAR AI signature text + EIP-191 + recover + the contract's exact check order.
// Mirrors spikes/ecrecover/contract/src (verify.rs, lib.rs) so node and the contract can be compared
// case by case. Independent crypto implementation (noble) from the Rust side (k256 / host fns).
import { secp256k1 } from '@noble/curves/secp256k1';
import { sha256 } from '@noble/hashes/sha256';
import { keccak_256 } from '@noble/hashes/sha3';
import { bytesToHex, hexToBytes, utf8ToBytes, concatBytes } from '@noble/hashes/utils';

export const MAX_RESPONSE_BYTES = 8 * 1024;
export const MAX_SENTENCE_BYTES = 1024;
export const N = secp256k1.CURVE.n;

export const sha256Hex = (b) => bytesToHex(sha256(typeof b === 'string' ? utf8ToBytes(b) : b));
export const jsonEscape = (s) => JSON.stringify(s).slice(1, -1);
export const requestBytes = (prefix, suffix, sentence) => prefix + jsonEscape(sentence) + suffix;

export function signedText(kind, modelId, reqHex, respHex) {
  return kind === 'provider_tee' ? `${modelId}:${reqHex}:${respHex}` : `${reqHex}:${respHex}`;
}
export function eip191Digest(text) {
  const body = utf8ToBytes(text);
  return keccak_256(concatBytes(utf8ToBytes(`\x19Ethereum Signed Message:\n${body.length}`), body));
}
const addrOf = (pub65) => '0x' + bytesToHex(keccak_256(pub65.slice(1)).slice(12));

/** Contract-equivalent verification. Returns {ok, code, signer, content?}. */
export function verifyForge(cfg, c) {
  const fail = (code, extra = {}) => ({ ok: false, code, ...extra });
  if (c.signing_algo !== 'ecdsa') return fail('E_ALGO');
  if (c.signature_kind !== 'provider_tee' && c.signature_kind !== 'gateway') return fail('E_KIND');
  if (Buffer.byteLength(c.sentence) > MAX_SENTENCE_BYTES) return fail('E_SENTENCE_SIZE');
  if (Buffer.byteLength(c.response) > MAX_RESPONSE_BYTES) return fail('E_RESPONSE_SIZE');
  const h = c.signature_hex.replace(/^0x/, '');
  if (!/^([0-9a-fA-F]{2})*$/.test(h)) return fail('E_SIG_HEX');
  const raw = hexToBytes(h);
  if (raw.length !== 65) return fail('E_SIG_LEN');
  const vb = raw[64];
  if (![0, 1, 27, 28].includes(vb)) return fail('E_SIG_V');
  const rec = vb >= 27 ? vb - 27 : vb;
  const req = utf8ToBytes(requestBytes(cfg.prefix, cfg.suffix, c.sentence));
  const text = signedText(c.signature_kind, cfg.model_id, sha256Hex(req), sha256Hex(c.response));
  let signer;
  try {
    const sig = secp256k1.Signature.fromCompact(raw.slice(0, 64)).addRecoveryBit(rec);
    if (sig.hasHighS()) return fail('E_RECOVER');
    signer = addrOf(sig.recoverPublicKey(eip191Digest(text)).toRawBytes(false));
  } catch {
    return fail('E_RECOVER');
  }
  if (!cfg.allowlist.some((a) => a.toLowerCase() === signer)) return fail('E_SIGNER', { signer });
  try {
    const env = JSON.parse(c.response);
    const content = env.choices[0].message.content;
    if (typeof content !== 'string' || content === '') return fail('E_NO_CONTENT', { signer });
    return { ok: true, code: 'OK', signer, content };
  } catch {
    return fail('E_ENVELOPE', { signer });
  }
}

export const cfgOf = (vec) => ({
  model_id: vec.model_id,
  allowlist: vec.allowlist,
  prefix: Buffer.from(vec.prefix_b64, 'base64').toString('utf8'),
  suffix: Buffer.from(vec.suffix_b64, 'base64').toString('utf8'),
});

const flipV = (sigHex) => {
  const b = hexToBytes(sigHex.replace(/^0x/, ''));
  b[64] = b[64] >= 27 ? (b[64] === 27 ? 28 : 27) : b[64] ^ 1;
  return bytesToHex(b);
};

/** Key-free negative cases derived from one valid case (used for recorded real vectors). */
export function deriveNegatives(base) {
  const mut = (name, patch, code) => ({ ...base, name, ...patch, expect: { ok: false, code, content: null } });
  const raw = hexToBytes(base.signature_hex.replace(/^0x/, ''));
  const s = BigInt('0x' + bytesToHex(raw.slice(32, 64)));
  const hs = new Uint8Array(raw);
  hs.set(hexToBytes((N - s).toString(16).padStart(64, '0')), 32);
  hs[64] = raw[64] >= 27 ? (raw[64] === 27 ? 28 : 27) : raw[64] ^ 1;
  const lastCh = base.response.lastIndexOf('}');
  return [
    mut('tampered_response_byte', { response: base.response.slice(0, lastCh) + ' ' + base.response.slice(lastCh) }, 'E_SIGNER'),
    mut('tampered_sentence', { sentence: base.sentence + '!' }, 'E_SIGNER'),
    mut('high_s_malleable_twin', { signature_hex: bytesToHex(hs) }, 'E_RECOVER'),
    mut('wrong_v_flipped', { signature_hex: flipV(base.signature_hex) }, 'E_SIGNER'),
    mut('truncated_sig_64_bytes', { signature_hex: bytesToHex(raw.slice(0, 64)) }, 'E_SIG_LEN'),
    mut('wrong_kind', { signature_kind: base.signature_kind === 'provider_tee' ? 'gateway' : 'provider_tee' }, 'E_SIGNER'),
  ];
}
