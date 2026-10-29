import * as os from 'node:os';

/**
 * LAN IP 候选工具。
 *
 * Desktop 可能同时有 Wi-Fi、有线、手机热点、虚拟网卡。Mobile 不该只拿一个
 * “主 IP”硬连，而是拿全部真实内网候选后自己按当前手机网络选择最快路径。
 */
export function getPrimaryLanIp(): string | null {
  return listLanIpCandidates()[0] ?? null;
}

export function listLanIpCandidates(): string[] {
  const ifaces = os.networkInterfaces();
  const candidates: string[] = [];
  for (const name of Object.keys(ifaces)) {
    if (/^(docker|veth|vmnet|vboxnet|utun|tap|tun|bridge)/i.test(name)) continue;
    const addrs = ifaces[name];
    if (!addrs) continue;
    for (const a of addrs) {
      if (a.family !== 'IPv4') continue;
      if (a.internal) continue;
      if (a.address.startsWith('169.254.')) continue;
      candidates.push(a.address);
    }
  }
  const score = (ip: string): number => {
    if (ip.startsWith('192.168.')) return 0;
    if (ip.startsWith('10.')) return 1;
    if (/^172\.(1[6-9]|2[0-9]|3[01])\./.test(ip)) return 2;
    return 3;
  };
  candidates.sort((a, b) => score(a) - score(b));
  return candidates;
}
