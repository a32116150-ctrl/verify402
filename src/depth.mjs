// Public client for the paid depth/capacity engine.
//
// The USD ladder, pinned-block quotes and capacity arithmetic live only in the
// private verify402-engine service. This module is a thin proxy.

import { callPaidEngine } from "./paid-engine.mjs";

export async function depthProfile(chainId, opts = {}) {
  return callPaidEngine("depth", chainId, opts);
}
