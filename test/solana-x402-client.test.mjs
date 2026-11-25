// The decoder must read what REAL x402 Solana payers send. This builds
// payment payloads with the official @x402/svm client (the same code agents
// use), in both transaction versions the live challenge advertises ([0, 1]),
// against a local fake Solana node. Nothing is submitted anywhere.
//
//   node --test test/solana-x402-client.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createPublicKey, verify as cryptoVerify } from "node:crypto";
import { ExactSvmScheme } from "@x402/svm/exact/client";
// Transitive dependency of @x402/svm; used only to make a throwaway signer.
import { generateKeyPairSigner } from "@solana/kit";
import { base58, decodeSolanaTransaction, solanaPaymentRef } from "../src/solana-payment.mjs";

const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const DEVNET_USDC = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function base58Decode(text) {
  let n = 0n;
  for (const ch of text) n = n * 58n + BigInt(B58.indexOf(ch));
  const bytes = [];
  while (n > 0n) { bytes.unshift(Number(n & 0xffn)); n >>= 8n; }
  for (const ch of text) { if (ch !== "1") break; bytes.unshift(0); }
  return Buffer.from(bytes);
}

function mintAccountData(decimals) {
  const data = Buffer.alloc(82);
  data.writeUInt32LE(0, 0); // no mint authority
  data.writeBigUInt64LE(1_000_000_000n, 36); // supply
  data[44] = decimals;
  data[45] = 1; // initialized
  return data.toString("base64");
}

async function fakeSolanaNode() {
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => { raw += c; });
    req.on("end", () => {
      const body = JSON.parse(raw);
      let result = null;
      if (body.method === "getAccountInfo") {
        result = {
          context: { slot: 1 },
          value: {
            data: [mintAccountData(6), "base64"],
            executable: false,
            lamports: 1461600,
            owner: TOKEN_PROGRAM,
            rentEpoch: 0,
            space: 82,
          },
        };
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }));
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { server, url: `http://127.0.0.1:${server.address().port}` };
}

for (const version of [0, 1]) {
  test(`real @x402/svm v${version} payment: payer, signature and blockhash are read exactly`, async () => {
    const node = await fakeSolanaNode();
    try {
      const payer = await generateKeyPairSigner();
      const feePayer = (await generateKeyPairSigner()).address;
      const payTo = (await generateKeyPairSigner()).address;
      const blockhash = base58(Buffer.alloc(32, 7));
      const scheme = new ExactSvmScheme(payer, { rpcUrl: node.url });
      const payment = await scheme.createPaymentPayload(2, {
        scheme: "exact",
        network: "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1",
        amount: "30000",
        asset: DEVNET_USDC,
        payTo,
        maxTimeoutSeconds: 300,
        extra: { feePayer, transactionVersions: [version], recentBlockhash: blockhash },
      });
      const tx = payment.payload.transaction;
      assert.equal(typeof tx, "string");

      const decoded = decodeSolanaTransaction(tx);
      assert.equal(decoded.signers[0], feePayer, "the facilitator pays the fee (slot 0)");
      assert.ok(decoded.signers.includes(payer.address));
      assert.equal(decoded.recentBlockhash, blockhash);
      assert.equal(decoded.durableNonce, false);

      // The extracted signature must really be the payer's Ed25519 signature
      // over the exact message bytes: that is what makes it a unique handle.
      const slot = decoded.signers.indexOf(payer.address);
      const pubkey = createPublicKey({
        key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), base58Decode(payer.address)]),
        format: "der",
        type: "spki",
      });
      assert.ok(cryptoVerify(null, decoded.message, pubkey, decoded.signatures[slot]), "payer signature verifies over the message");

      const ref = solanaPaymentRef(tx);
      assert.equal(ref.payerSigner, payer.address, "the payer, not the unsigned fee payer");
      assert.equal(ref.recentBlockhash, blockhash);
      assert.match(ref.payerSignature, /^[1-9A-HJ-NP-Za-km-z]{80,90}$/);
    } finally {
      node.server.close();
    }
  });
}
