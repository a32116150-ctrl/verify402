// Facilitator client whose failures speak the middleware's language.
//
// A facilitator that rejects our auth (401) or cannot be reached surfaces as a
// plain Error inside @x402/core. The Express middleware only recognises
// `FacilitatorResponseError` (it walks the cause chain), so without this class
// every facilitator failure — a bad key, a region block, an outage — reaches the
// caller as an opaque `500 {"error":"Internal Server Error"}`.
//
// Wrapping instead of re-mapping keeps the cause chain intact: the middleware
// turns a facilitator failure into 502 with the facilitator's own message, which
// is the honest signal, and a buyer or agent can tell "try later" apart from
// "this service is broken".

import { HTTPFacilitatorClient, FacilitatorResponseError } from "@x402/core/server";

export class FacilitatorClient extends HTTPFacilitatorClient {
  async #call(operation, fn) {
    try {
      return await fn();
    } catch (error) {
      if (error instanceof FacilitatorResponseError) throw error;
      const message = error && error.message ? error.message : String(error);
      const wrapped = new FacilitatorResponseError(message || `facilitator ${operation} failed`);
      // Preserve the original error (and its origin, if the facilitator gave one).
      wrapped.cause = error;
      throw wrapped;
    }
  }

  async getSupported(...args) {
    return this.#call("supported", () => super.getSupported(...args));
  }

  async verify(...args) {
    return this.#call("verify", () => super.verify(...args));
  }

  async settle(...args) {
    return this.#call("settle", () => super.settle(...args));
  }
}
