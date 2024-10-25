import ipaddr, { IPv4 } from 'ipaddr.js'
import { Netmask } from 'netmask'
const { isValid: is_valid, parse } = ipaddr

const PRIVATE_IP_RANGES = [
  '0.0.0.0/8',
  '10.0.0.0/8',
  '100.64.0.0/10',
  '127.0.0.0/8',
  '169.254.0.0/16',
  '172.16.0.0/12',
  '192.0.0.0/24',
  '192.0.0.0/29',
  '192.0.0.8/32',
  '192.0.0.9/32',
  '192.0.0.10/32',
  '192.0.0.170/32',
  '192.0.0.171/32',
  '192.0.2.0/24',
  '192.31.196.0/24',
  '192.52.193.0/24',
  '192.88.99.0/24',
  '192.168.0.0/16',
  '192.175.48.0/24',
  '198.18.0.0/15',
  '198.51.100.0/24',
  '203.0.113.0/24',
  '240.0.0.0/4',
  '255.255.255.255/32',
]

const NETMASK_RANGES = PRIVATE_IP_RANGES.map((ip_range) => new Netmask(ip_range))

function ipv4Check(ip_addr: string) {
  for (let r of NETMASK_RANGES) {
    if (r.contains(ip_addr)) return true
  }

  return false
}

export function isPrivateIp(ip: string): boolean | undefined {
  if (is_valid(ip)) {
    const parsed = parse(ip)

    if (parsed.kind() === 'ipv4') return ipv4Check((parsed as IPv4).toNormalizedString())
  }

  return false
}
