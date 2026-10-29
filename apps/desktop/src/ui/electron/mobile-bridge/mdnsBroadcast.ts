/**
 * mobile-bridge/mdnsBroadcast.ts — mDNS 广播 Desktop 在 LAN 的存在.
 *
 * 协议规范 §3.1:
 *   service type: _neox._tcp.local.
 *   TXT: device_id / device_name / version / pubkey_fp
 *
 * 用 bonjour-service (跨平台 mDNS 实现, mac/win/linux 都能跑).
 */

import * as os from 'node:os';
import { Bonjour, type Service } from 'bonjour-service';
import {
  getDeviceId,
  getDeviceName,
  getDesktopPubkeyFingerprint,
} from './deviceStore.js';
import { MDNS_SERVICE_TYPE, PROTOCOL_VERSION } from './types.js';

let bonjour: Bonjour | null = null;
let published: Service | null = null;
let currentPort = 0;
let lastIpSnapshot = '';
let ipMonitorTimer: NodeJS.Timeout | null = null;
let watchdogTimer: NodeJS.Timeout | null = null;
let consecutiveSelfCheckFailures = 0;

/** 把当前所有 LAN IP 拼成 stable string, 用于检测变化 (不在乎顺序细节, 但要稳定签名). */
function snapshotLanIps(): string {
  const ifaces = os.networkInterfaces();
  const ips: string[] = [];
  for (const name of Object.keys(ifaces)) {
    if (/^(docker|veth|vmnet|vboxnet|utun|tap|tun|bridge)/i.test(name)) continue;
    const addrs = ifaces[name];
    if (!addrs) continue;
    for (const a of addrs) {
      if (a.family !== 'IPv4' || a.internal) continue;
      if (a.address.startsWith('169.254.')) continue;
      ips.push(a.address);
    }
  }
  return ips.sort().join(',');
}

/**
 * 我们在 mDNS 上自称的主机名 —— **绝不能是系统主机名**。
 *
 * 形如 `neox-22b0e729.local`: device_id 派生自 machine-id, 同一台机器恒定;
 * 前缀让它不可能跟系统或别的软件撞名。
 *
 * 恒定这一点很重要: 每次启动换个名字的话, 手机 drift 里缓存的 target 就会指向一个
 * 已经不存在的名字, A 查询解不出 IP —— 表现就是"以前能连, 今天连不上了"。
 */
function mdnsHostName(): string {
  const short = getDeviceId().replace(/-/g, '').slice(0, 8) || 'desktop';
  return `neox-${short}.local`;
}

function doPublish(port: number): void {
  if (!bonjour) {
    /* bonjour-service 的默认错误回调会 throw；mDNS 是可选能力，不能让
     * 网络名称冲突或接口切换退出 Electron 主进程。 */
    bonjour = new Bonjour({}, (err: any) => {
      console.warn(`[mobile-bridge] bonjour error (non-fatal): ${err?.message ?? err}`);
    });
  }
  const deviceName = getDeviceName();
  published = bonjour.publish({
    name: deviceName,
    type: MDNS_SERVICE_TYPE,
    host: mdnsHostName(),
    port,
    txt: {
      device_id: getDeviceId(),
      device_name: deviceName,
      version: String(PROTOCOL_VERSION),
      pubkey_fp: getDesktopPubkeyFingerprint(),
    },
  });
  published.on?.('error', (err: any) => {
    console.warn(`[mobile-bridge] mDNS service error (non-fatal): ${err?.message ?? err}`);
  });
  lastIpSnapshot = snapshotLanIps();
  // eslint-disable-next-line no-console
  console.log(`[mobile-bridge] mDNS broadcasting as "_${MDNS_SERVICE_TYPE}._tcp" name="${deviceName}" host=${mdnsHostName()} port=${port} ips=${lastIpSnapshot}`);
}

export function startMdnsBroadcast(port: number): void {
  if (published) {
    // eslint-disable-next-line no-console
    console.warn('[mobile-bridge] mDNS already broadcasting');
    return;
  }
  currentPort = port;
  doPublish(port);

  let restartInflight: Promise<void> | null = null;
  ipMonitorTimer = setInterval(() => {
    const now = snapshotLanIps();
    if (now === lastIpSnapshot) return;
    if (restartInflight) return; /* 上一轮重启还没完, 跳过本次 (下一 tick 5s 后再判断) */
    // eslint-disable-next-line no-console
    console.log(`[mobile-bridge] LAN IP changed: "${lastIpSnapshot}" → "${now}" — restarting mDNS broadcast`);
    restartInflight = (async () => {
      try {
        if (published) {
          await new Promise<void>((resolve) => {
            const stopFn = (published as any).stop;
            if (typeof stopFn === 'function') {
              stopFn.call(published, () => resolve());
            } else {
              resolve();
            }
          });
          published = null;
        }
        if (bonjour) {
          try { bonjour.destroy(); } catch { /* ignore */ }
          bonjour = null;
        }
        doPublish(currentPort);
      } catch (e: any) {
        // eslint-disable-next-line no-console
        console.warn(`[mobile-bridge] mDNS restart failed: ${e?.message}`);
      }
    })().finally(() => { restartInflight = null; });
  }, 5000);
  /* P0-N3: 不阻塞 event loop — quit 时不等下一 tick. 监测有意义只在 app 跑时, app 关时 IP
   *  变化不必跟. */
  ipMonitorTimer.unref?.();

  watchdogTimer = setInterval(() => {
    if (restartInflight) return;
    void (async () => {
      const ok = await selfCheck();
      if (ok) {
        consecutiveSelfCheckFailures = 0;
        return;
      }
      consecutiveSelfCheckFailures += 1;
      if (consecutiveSelfCheckFailures < 2 || restartInflight) return;
      consecutiveSelfCheckFailures = 0;
      // eslint-disable-next-line no-console
      console.warn('[mobile-bridge] mDNS self-check failed twice — restarting broadcast');
      restartInflight = (async () => {
        try {
          if (published) {
            await new Promise<void>((resolve) => {
              const stopFn = (published as any).stop;
              if (typeof stopFn === 'function') stopFn.call(published, () => resolve());
              else resolve();
            });
            published = null;
          }
          if (bonjour) {
            try { bonjour.destroy(); } catch { /* ignore */ }
            bonjour = null;
          }
          doPublish(currentPort);
        } catch (e: any) {
          // eslint-disable-next-line no-console
          console.warn(`[mobile-bridge] mDNS watchdog restart failed: ${e?.message}`);
        }
      })().finally(() => { restartInflight = null; });
    })();
  }, 60_000);
  watchdogTimer.unref?.();
}

/** 用独立 Bonjour 实例 browse 自己 — 4s 内查到自己的 device_id 算活. */
async function selfCheck(): Promise<boolean> {
  const myId = getDeviceId();
  return await new Promise<boolean>((resolve) => {
    let probe: Bonjour | null = null;
    let settled = false;
    const finish = (ok: boolean): void => {
      if (settled) return;
      settled = true;
      try { probe?.destroy(); } catch { /* ignore */ }
      resolve(ok);
    };
    try {
      probe = new Bonjour();
      (probe as any).on?.('error', () => finish(false));
      probe.find({ type: MDNS_SERVICE_TYPE }, (svc: any) => {
        if (svc?.txt?.device_id === myId) finish(true);
      });
    } catch {
      finish(false);
      return;
    }
    const t = setTimeout(() => finish(false), 4000);
    (t as any).unref?.();
  });
}

export async function stopMdnsBroadcast(): Promise<void> {
  if (ipMonitorTimer) {
    clearInterval(ipMonitorTimer);
    ipMonitorTimer = null;
  }
  if (watchdogTimer) {
    clearInterval(watchdogTimer);
    watchdogTimer = null;
  }
  consecutiveSelfCheckFailures = 0;
  if (published) {
    await new Promise<void>((resolve) => {
      const stopFn = (published as any).stop;
      if (typeof stopFn === 'function') {
        stopFn.call(published, () => resolve());
      } else {
        resolve();
      }
    });
    published = null;
  }
  if (bonjour) {
    try { bonjour.destroy(); } catch { /* ignore */ }
    bonjour = null;
  }
}
