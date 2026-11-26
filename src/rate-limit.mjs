// Who a free-gate rate limit counts against.
//
// An IPv6 client usually controls a whole /64, so counting each address
// separately would let one caller rotate through addresses past the daily
// cap. IPv4 (including IPv4-mapped IPv6) is counted per address; IPv6 per /64.

export function rateLimitSubject(ip) {
  const raw = String(ip || "unknown").trim();
  const mapped = raw.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
  if (mapped) return mapped[1];
  if (!raw.includes(":")) return raw;
  const lower = raw.toLowerCase().split("%")[0];
  let groups;
  if (lower.includes("::")) {
    const [head, tail] = lower.split("::");
    const left = head ? head.split(":") : [];
    const right = tail ? tail.split(":") : [];
    const fill = Math.max(0, 8 - left.length - right.length);
    groups = [...left, ...Array(fill).fill("0"), ...right];
  } else {
    groups = lower.split(":");
  }
  const prefix = groups
    .slice(0, 4)
    .map((g) => (g || "0").replace(/^0+(?=.)/, ""));
  return `${prefix.join(":")}::/64`;
}
