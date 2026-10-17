// Fairness audit: "someone just OFFERED me this quote - can I trust it?"
//
// Every swap an agent executes first passes through a number it did not
// produce: an aggregator, a broker, a router's suggestion, a Telegram bot's
// "opportunity". The chain is the only neutral judge of that number, because
// the venues that would actually execute the trade quote from their own
// logic. Nothing here measures for them; we measure AGAINST them.
//
//   fair                  : the offered amount is what the chain roughly pays
//   overpaying            : the chain would hand you strictly more elsewhere
//   too_good_to_be_true   : nothing on this chain pays that - invented,
//                           stale from another block, or mis-denominated
//   unknown               : no venue could quote the pair at this size
//
// Invented numbers are the same failure class that produced 41 trillion
// USDC of fake profit in an earlier version of our own engine - so the echo
// guard (quoted === amountIn) and the zero guard apply to the OFFERED
// quote too, not just to our decodes.

import { chain, resolveToken } from "./config.mjs";
import { clientFor, quoteAllVenues } from "./measure.mjs";

export async function bestRouteBook(client, chainId, { tokenIn, tokenOut, amountIn, blockNumber }) {
  return quoteAllVenues(client, chainId, {
    tokenIn, tokenOut, amountIn, blockNumber,
    intermediates: ["WETH"],
  });
}

function resolveTokenArg(chainId, arg) {
  const raw = String(arg).trim();
  if (/^0x[0-9a-fA-F]{40}$/.test(raw)) return raw;
  return resolveToken(chainId, raw.toUpperCase()).address;
}

/**
 * Audit one offered quote against the full book.
 * Returns a verdict plus the evidence: the venue-by-venue book the chain
 * actually quoted at one pinned block.
 */
export async function fairQuoteCheck(chainId, {
  tokenIn,
  tokenOut,
  amountIn,
  quotedOut,
  venueClaimed = null,
  chainIn = null, // optional: claimed network the quote came from, for the report
} = {}) {
  const c = chain(chainId);
  const notes = [];
  const checked = [];

  // --- resolve inputs -------------------------------------------------------
  let addrIn;
  let addrOut;
  try {
    addrIn = resolveTokenArg(chainId, tokenIn);
    addrOut = resolveTokenArg(chainId, tokenOut);
  } catch (e) {
    return { ok: false, verdict: "unknown", error: e.message, checked, notes };
  }
  if (addrIn.toLowerCase() === addrOut.toLowerCase()) {
    return { ok: false, verdict: "unknown", error: "tokenIn and tokenOut are the same token", checked, notes };
  }
  if (amountIn === undefined || amountIn === null || BigInt(amountIn) <= 0n) {
    return { ok: false, verdict: "unknown", error: "amountIn must be positive", checked, notes };
  }
  amountIn = BigInt(amountIn);

  // --- countersign the offered quote ----------------------------------------
  checked.push("offered-quote-shape");
  let quoted = null;
  try {
    quoted = BigInt(quotedOut);
  } catch {
    return {
      ok: true, verdict: "too_good_to_be_true",
      error: "quotedOut is not a whole number - nothing on-chain produced it",
      checked, notes, evidence: { offeredRaw: String(quotedOut) },
    };
  }
  if (quoted <= 0n) {
    return {
      ok: true, verdict: "unknown",
      error: "quotedOut <= 0: the offer is either zero-filled, mis-decoded, or fake",
      checked, notes,
    };
  }
  // Echo guard: no venue hands back the exact input. If the offer equals
  // amountIn, this is a re-encoded input, not a quote - the exact bug that
  // once read a router's input as its output.
  if (quoted === amountIn) {
    return {
      ok: true, verdict: "too_good_to_be_true",
      error: "quotedOut equals amountIn exactly - that is an echo of the input, not a quote",
      checked, notes,
    };
  }

  // --- what the chain actually pays ------------------------------------------
  const client = clientFor(chainId);
  const blockNumber = await client.getBlockNumber();
  checked.push("chain-book");
  const book = await bestRouteBook(client, chainId, { tokenIn: addrIn, tokenOut: addrOut, amountIn, blockNumber });

  const evidence = {
    offered: {
      quotedOut: quoted.toString(),
      claimedVenue: venueClaimed,
      claimedChain: chainIn,
    },
    blockNumber: Number(blockNumber),
    amountIn: amountIn.toString(),
    book: book.quoted.slice(0, 8).map((q) => ({
      venue: q.venue, kind: q.kind, amountOut: q.amountOut.toString(),
    })),
    unavailable: book.unavailable.map((u) => u.venue),
  };

  if (!book.quoted.length) {
    return {
      ok: true, verdict: "unknown",
      error: "no venue on this chain could quote this pair at this size - cannot countersign any offer",
      checked, notes: evidence.notes ?? [], evidence,
    };
  }

  const best = book.quoted[0];
  evidence.chainBest = { venue: best.venue, amountOut: best.amountOut.toString() };

  // Tolerance rationale: a fair offer can exceed our book slightly (aggregator
  // routes we do not explore, a one-block difference in the mid price), but a
  // REAL quote should not beat everything the chain offers by a wide margin.
  // Below: within 2% short or up to 15% above = fair; below 2% of best =
  // overpaying; more than 15% above best = too good.
  const ratio = Number(quoted) / Number(best.amountOut);
  evidence.ratioVsChainBest = ratio;

  let verdict;
  if (ratio < 0.98) {
    verdict = "overpaying";
    const lossBps = Number(((best.amountOut - quoted) * 1_000_000n) / best.amountOut) / 100;
    evidence.shortfallBps = lossBps;
    notes.push(`the chain's best route (${best.venue}) pays ${lossBps.toFixed(2)} bps more than your offer`);
  } else if (ratio >= 1.15) {
    verdict = "too_good_to_be_true";
    notes.push(
      `your offer beats everything this chain offers by ${((ratio - 1) * 100).toFixed(1)}% ` +
      `(best real route: ${best.venue}). Real quotes do not materially beat the venue that ` +
      `would execute them - this number is likely invented, stale from another block, or in different units`
    );
  } else {
    verdict = "fair";
    if (ratio > 1.005) {
      notes.push(`slightly above our book (${((ratio - 1) * 100).toFixed(2)}%) - plausible if the offer came via routes or a block we did not measure; evidence included so you can check`);
    } else {
      notes.push("the offer is inside the noise band of what the chain pays right now");
    }
  }

  return {
    ok: true,
    verdict,
    checked,
    notes,
    evidence,
    elapsedNote: `book: ${book.quoted.length} venues quoted, ${book.unavailable.length} could not`,
  };
}
