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

/** Parse an IPv6 address (any notation, optional brackets) into 8 hextets. */
function parseIpv6(input: string): number[] | null {
  let ip = input.toLowerCase().replace(/^\[|\]$/g, "").replace(/%.*$/, "");
  // Trailing dotted IPv4 (e.g. ::ffff:127.0.0.1) becomes two hextets
  const v4 = ip.match(/^(.*:)(\d+\.\d+\.\d+\.\d+)$/);
  if (v4) {
    const parts = v4[2].split(".").map(Number);
    if (parts.some((p) => p > 255)) return null;
    ip = `${v4[1]}${((parts[0] << 8) | parts[1]).toString(16)}:${((parts[2] << 8) | parts[3]).toString(16)}`;
  }
  const halves = ip.split("::");
  if (halves.length > 2) return null;
  const toHextets = (part: string) => (part ? part.split(":").map((h) => parseInt(h, 16)) : []);
  const head = toHextets(halves[0]);
  const tail = halves.length === 2 ? toHextets(halves[1]) : [];
  const fill = 8 - head.length - tail.length;
  if ((halves.length === 2 ? fill < 1 : fill !== 0)) return null;
  const hextets = [...head, ...Array(fill).fill(0), ...tail];
  if (hextets.some((h) => isNaN(h) || h < 0 || h > 0xffff)) return null;
  return hextets;
}

function embeddedIpv4(hi: number, lo: number): string {
  return `${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`;
}

function isPrivateIpv6(ip: string): boolean {
  const h = parseIpv6(ip);
  if (!h) return true; // unparseable: refuse rather than guess
  const zeroUpTo = (n: number) => h.slice(0, n).every((x) => x === 0);
  // ::, ::1, and the deprecated IPv4-compatible ::a.b.c.d
  if (zeroUpTo(6)) return true;
  // IPv4-mapped ::ffff:a.b.c.d
  if (zeroUpTo(5) && h[5] === 0xffff) return isPrivateIpv4(embeddedIpv4(h[6], h[7]));
  // NAT64 64:ff9b::/96
  if (h[0] === 0x64 && h[1] === 0xff9b && h.slice(2, 6).every((x) => x === 0)) {
    return isPrivateIpv4(embeddedIpv4(h[6], h[7]));
  }
  // 6to4 2002::/16 embeds an IPv4 address in the next 32 bits
  if (h[0] === 0x2002) return isPrivateIpv4(embeddedIpv4(h[1], h[2]));
  if ((h[0] & 0xfe00) === 0xfc00) return true; // fc00::/7 unique local
  if ((h[0] & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  if ((h[0] & 0xff00) === 0xff00) return true; // ff00::/8 multicast
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
  // Fail closed: a resolver error must not be treated as "no private address"
  if (!response.ok) throw new Error(`DNS lookup failed (${response.status})`);
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

  // WHATWG URL keeps the brackets on IPv6 literals ("[::1]")
  const hostname = parsed.hostname.replace(/^\[|\]$/g, "");
  if (isPrivateIp(hostname)) {
    return "Blocked: URL resolves to a private/reserved IP address";
  }
  const lowerHost = hostname.toLowerCase().replace(/\.$/, "");
  if (lowerHost === "localhost" || lowerHost.endsWith(".localhost")) {
    return "Blocked: URL resolves to a private/reserved IP address";
  }

  const cached = verdictCache.get(hostname);
  if (cached && cached.expires > Date.now()) {
    return cached.verdict;
  }

  let ips: string[];
  try {
    ips = await resolveHostname(hostname);
  } catch (e) {
    // Not cached, so a transient resolver failure does not stick
    return `Blocked: could not verify the address of ${hostname} (${e instanceof Error ? e.message : String(e)})`;
  }
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

const MAX_REDIRECTS = 5;

/**
 * fetch() that follows redirects itself, validating every hop with
 * validateUrlForSsrf (redirect: "follow" would let a public URL bounce to a
 * private one). Returns the final response, or an error message.
 */
export async function fetchWithSsrfCheck(
  url: string,
  init: RequestInit = {},
): Promise<{ response: Response; finalUrl: string } | { error: string }> {
  let current = url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const error = await validateUrlForSsrf(current);
    if (error) return { error };
    const response = await fetch(current, { ...init, redirect: "manual" });
    const location = response.headers.get("location");
    if (response.status < 300 || response.status >= 400 || !location) {
      return { response, finalUrl: current };
    }
    current = new URL(location, current).toString();
  }
  return { error: `Too many redirects (more than ${MAX_REDIRECTS})` };
}
