import { BlockList, isIP } from 'node:net';

/**
 * Which addresses the fetcher may connect to: public unicast ones only. A web source is an address
 * a customer types in, so without this the admin would fetch `http://169.254.169.254/` or the
 * router's login page for whoever can reach it.
 */
const BLOCKED = new BlockList();

const V4: Array<[string, number]> = [
  ['0.0.0.0', 8], // "this network"
  ['10.0.0.0', 8],
  ['100.64.0.0', 10], // carrier-grade NAT
  ['127.0.0.0', 8],
  ['169.254.0.0', 16], // link-local, incl. the cloud metadata address
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4], // multicast
  ['240.0.0.0', 4], // reserved, incl. broadcast
];
const V6: Array<[string, number]> = [
  ['::', 96], // unspecified, loopback and the deprecated IPv4-compatible range
  ['64:ff9b::', 96], // NAT64: reaches an IPv4 address through the gateway
  ['64:ff9b:1::', 48],
  ['100::', 64], // discard
  ['2001::', 32], // Teredo
  ['2001:db8::', 32], // documentation
  ['2002::', 16], // 6to4
  ['fc00::', 7], // unique local
  ['fe80::', 10], // link-local
  ['fec0::', 10], // site-local, deprecated
  ['ff00::', 8], // multicast
];
for (const [net, prefix] of V4) BLOCKED.addSubnet(net, prefix, 'ipv4');
for (const [net, prefix] of V6) BLOCKED.addSubnet(net, prefix, 'ipv6');

/** The 16 bytes of an IPv6 address, or undefined when it is not one. */
function v6Bytes(address: string): number[] | undefined {
  let text = address.toLowerCase();
  const zone = text.indexOf('%');
  if (zone >= 0) text = text.slice(0, zone);
  const tail = text.lastIndexOf(':');
  if (text.slice(tail + 1).includes('.')) {
    const parts = text
      .slice(tail + 1)
      .split('.')
      .map(Number);
    if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return undefined;
    const high = ((parts[0]! << 8) | parts[1]!).toString(16);
    const low = ((parts[2]! << 8) | parts[3]!).toString(16);
    text = `${text.slice(0, tail + 1)}${high}:${low}`;
  }
  const halves = text.split('::');
  if (halves.length > 2) return undefined;
  const groups = (half: string): string[] => (half === '' ? [] : half.split(':'));
  const head = groups(halves[0]!);
  const rest = halves.length === 2 ? groups(halves[1]!) : [];
  const missing = 8 - head.length - rest.length;
  if (halves.length === 1 ? missing !== 0 : missing < 1) return undefined;
  const all = [...head, ...Array<string>(halves.length === 2 ? missing : 0).fill('0'), ...rest];
  const bytes: number[] = [];
  for (const group of all) {
    if (!/^[0-9a-f]{1,4}$/.test(group)) return undefined;
    const value = Number.parseInt(group, 16);
    bytes.push(value >> 8, value & 255);
  }
  return bytes;
}

/** True when a connection to this literal address stays on the public internet. */
export function isPublicAddress(address: string): boolean {
  const family = isIP(address.replace(/%.*$/, ''));
  if (family === 4) return !BLOCKED.check(address, 'ipv4');
  if (family !== 6) return false;
  const bytes = v6Bytes(address);
  if (!bytes) return false;
  // ::ffff:a.b.c.d is IPv4 in an IPv6 coat, written dotted or as hex groups: judge the IPv4 inside.
  if (bytes.slice(0, 10).every((byte) => byte === 0) && bytes[10] === 255 && bytes[11] === 255) {
    return !BLOCKED.check(bytes.slice(12).join('.'), 'ipv4');
  }
  const canonical = Array.from({ length: 8 }, (_unused, index) =>
    ((bytes[index * 2]! << 8) | bytes[index * 2 + 1]!).toString(16),
  ).join(':');
  return !BLOCKED.check(canonical, 'ipv6');
}
