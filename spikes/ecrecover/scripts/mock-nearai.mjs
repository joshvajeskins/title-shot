// Local stand-in for the three NEAR AI Cloud endpoints record-vector.mjs uses, so the recorder can be
// exercised end-to-end without a key. Signs provider_tee text with a throwaway key, EIP-191.
//   node scripts/mock-nearai.mjs [port]   then   NEARAI_API_KEY=mock node scripts/record-vector.mjs \
//        --base http://127.0.0.1:<port> --model Qwen/Qwen3.8-27B --out-dir <tmp>
import http from 'node:http';
import { secp256k1 } from '@noble/curves/secp256k1';
import { keccak_256 } from '@noble/hashes/sha3';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils';
import { sha256Hex, eip191Digest } from './lib.mjs';

const port = Number(process.argv[2] || 8799);
const priv = secp256k1.utils.randomPrivateKey();
const addr = '0x' + bytesToHex(keccak_256(secp256k1.getPublicKey(priv, false).slice(1)).slice(12));
const store = new Map();

http.createServer(async (req, res) => {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const body = Buffer.concat(chunks);
  const url = new URL(req.url, 'http://x');
  const send = (code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(typeof obj === 'string' ? obj : JSON.stringify(obj)); };
  if (!req.headers.authorization?.startsWith('Bearer ')) return send(401, { error: 'no key' });
  if (url.pathname === '/v1/attestation/report') {
    return send(200, { gateway_attestation: { signing_address: '0x' + '11'.repeat(20) },
      model_attestations: [{ model_name: url.searchParams.get('model'), signing_address: addr }] });
  }
  if (url.pathname === '/v1/chat/completions' && req.method === 'POST') {
    const model = JSON.parse(body).model;
    const id = 'chatcmpl-mock-' + store.size;
    const resp = JSON.stringify({ id, object: 'chat.completion', model,
      choices: [{ index: 0, message: { role: 'assistant', content: '{"ok":true}' }, finish_reason: 'stop' }] });
    store.set(id, { model, req: body, resp: Buffer.from(resp) });
    return send(200, resp);
  }
  const m = url.pathname.match(/^\/v1\/signature\/(.+)$/);
  if (m && store.has(m[1])) {
    const e = store.get(m[1]);
    const text = `${e.model}:${sha256Hex(e.req)}:${sha256Hex(e.resp)}`;
    const sig = secp256k1.sign(eip191Digest(text), priv, { lowS: true });
    const out = bytesToHex(sig.toCompactRawBytes()) + (27 + sig.recovery).toString(16);
    return send(200, { text, signature: '0x' + out, signing_address: addr, signing_algo: 'ecdsa' });
  }
  send(404, { error: 'not found' });
}).listen(port, '127.0.0.1', () => console.log('mock NEAR AI on', port, 'signer', addr));
