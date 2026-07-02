const PRIVATE_IP_RANGES: Array<{ prefix: number[]; bits: number }> = [
  { prefix: [10], bits: 8 },           // 10.0.0.0/8
  { prefix: [172, 16], bits: 12 },     // 172.16.0.0/12
  { prefix: [192, 168], bits: 16 },    // 192.168.0.0/16
  { prefix: [127], bits: 8 },          // 127.0.0.0/8 (loopback)
  { prefix: [169, 254], bits: 16 },    // 169.254.0.0/16 (link-local)
  { prefix: [0], bits: 8 },            // 0.0.0.0/8
  { prefix: [100, 64], bits: 10 },     // 100.64.0.0/10 (CGNAT)
  { prefix: [192, 0, 0], bits: 24 },   // 192.0.0.0/24
  { prefix: [192, 0, 2], bits: 24 },   // 192.0.2.0/24 (TEST-NET-1)
  { prefix: [198, 51, 100], bits: 24 },// 198.51.100.0/24 (TEST-NET-2)
  { prefix: [203, 0, 113], bits: 24 }, // 203.0.113.0/24 (TEST-NET-3)
  { prefix: [224], bits: 4 },          // 224.0.0.0/4 (multicast)
  { prefix: [240], bits: 4 },          // 240.0.0.0/4 (reserved)
];

function ipMatchesCidr(ip: number[], prefix: number[], bits: number): boolean {
  const ipNum = (ip[0] << 24) | (ip[1] << 16) | (ip[2] << 8) | ip[3];
  const p = [...prefix, 0, 0, 0, 0].slice(0, 4);
  const prefixNum = (p[0] << 24) | (p[1] << 16) | (p[2] << 8) | p[3];
  const mask = bits === 0 ? 0 : (~0 << (32 - bits));
  return (ipNum & mask) === (prefixNum & mask);
}

function isPrivateIpv4(ip: string): boolean {
  const parts = ip.split(".").map(Number);
  if (parts.length !== 4 || parts.some((p) => isNaN(p) || p < 0 || p > 255)) return false;
  for (const range of PRIVATE_IP_RANGES) {
    if (ipMatchesCidr(parts, range.prefix, range.bits)) return true;
  }
  return false;
}

function isPrivateIpv6(ip: string): boolean {
  const lower = ip.toLowerCase();
  if (lower === "::1") return true;
  if (lower === "::") return true;
  if (lower.startsWith("fc") || lower.startsWith("fd")) return true;
  if (lower.startsWith("fe80")) return true;
  const v4Mapped = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (v4Mapped) return isPrivateIpv4(v4Mapped[1]);
  return false;
}

function isPrivateIp(ip: string): boolean {
  return ip.includes(":") ? isPrivateIpv6(ip) : isPrivateIpv4(ip);
}

async function resolveRecords(hostname: string, type: "A" | "AAAA"): Promise<string[]> {
  const dohUrl = `https://1.1.1.1/dns-query?name=${encodeURIComponent(hostname)}&type=${type}`;
  const response = await fetch(dohUrl, {
    headers: { Accept: "application/dns-json" },
  });
  if (!response.ok) return [];
  const data = await response.json<{ Answer?: Array<{ type: number; data: string }> }>();
  if (!data.Answer) return [];
  return data.Answer.filter((a) => a.type === 1 || a.type === 28).map((a) => a.data);
}

async function resolveHostname(hostname: string): Promise<string[]> {
  const [v4, v6] = await Promise.all([
    resolveRecords(hostname, "A"),
    resolveRecords(hostname, "AAAA"),
  ]);
  return [...v4, ...v6];
}

// Short-lived per-isolate cache of DNS-based verdicts — avoids paying two
// DoH round trips per request when the same host is fetched repeatedly
// (crawls, batch link fetching). TTL keeps DNS-rebinding exposure bounded.
const VERDICT_TTL_MS = 60_000;
const VERDICT_CACHE_MAX = 256;
const verdictCache = new Map<string, { verdict: string | null; expires: number }>();

export async function validateUrlForSsrf(input: string): Promise<string | null> {
  let parsed: URL;
  try {
    parsed = new URL(input);
  } catch {
    return "Invalid URL";
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return `Blocked: unsupported protocol "${parsed.protocol}"`;
  }

  const hostname = parsed.hostname;
  if (isPrivateIp(hostname)) {
    return "Blocked: URL resolves to a private/reserved IP address";
  }

  const cached = verdictCache.get(hostname);
  if (cached && cached.expires > Date.now()) {
    return cached.verdict;
  }

  const ips = await resolveHostname(hostname);
  let verdict: string | null = null;
  for (const ip of ips) {
    if (isPrivateIp(ip)) {
      verdict = "Blocked: URL resolves to a private/reserved IP address";
      break;
    }
  }

  if (verdictCache.size >= VERDICT_CACHE_MAX) verdictCache.clear();
  verdictCache.set(hostname, { verdict, expires: Date.now() + VERDICT_TTL_MS });
  return verdict;
}
