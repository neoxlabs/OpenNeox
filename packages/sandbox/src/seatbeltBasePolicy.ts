/**
 * Seatbelt 基座策略 (SBPL) —— 完整的系统交互白名单基座。
 *
 * 为什么要这么长: macOS 下几乎任何程序 (node/git/curl/编译器) 启动都要读一堆 sysctl、
 * 连一堆系统 mach 服务 (dirhelper 找 tmp、trustd/ocspd 验证书、SecurityServer 钥匙串、
 * networkd 域名解析)。Neox 现在的基座只有 5 行 (process/sysctl-read/mach-lookup/signal),
 * 太薄 → deny-default 下正常程序会莫名失败。这份基座补齐, 让"正常命令不误伤"。
 *
 * 注意: 这里只放"无害的系统交互"。真正的能力 (读哪、写哪、网络) 由 policy.ts 追加, 不在基座。
 */

/** 基座: deny-default + 进程/信号/sysctl/mach 系统服务白名单 (无 fs 读写能力, 无网络)。 */
export const SEATBELT_BASE_POLICY = String.raw`
(version 1)

; 默认全拒 —— 能力靠下面 + policy 显式 allow 才有。
(deny default)
; 不把每条 deny 打到日志 (否则刷屏)。
(deny file-write-setugid)

; ---- 进程 ----
; 允许执行/派生子进程 (agent 要跑命令), 但只能信号/查同沙盒内进程。
(allow process-exec)
(allow process-fork)
(allow signal (target same-sandbox))
(allow process-info-pidinfo)
(allow process-info-setcontrol (target self))

; ---- /dev/null 写 (极常见: 2>/dev/null) ----
(allow file-write-data
  (require-all
    (path "/dev/null")
    (vnode-type CHARACTER-DEVICE)))

; ---- sysctl 读 (程序启动普遍要读; 白名单化, 不给 sysctl-write) ----
(allow sysctl-read
  (sysctl-name "hw.activecpu")
  (sysctl-name "hw.busfrequency_compat")
  (sysctl-name "hw.byteorder")
  (sysctl-name "hw.cacheconfig")
  (sysctl-name "hw.cachelinesize_compat")
  (sysctl-name "hw.cpufamily")
  (sysctl-name "hw.cpufrequency_compat")
  (sysctl-name "hw.cputype")
  (sysctl-name "hw.l1dcachesize_compat")
  (sysctl-name "hw.l1icachesize_compat")
  (sysctl-name "hw.l2cachesize_compat")
  (sysctl-name "hw.l3cachesize_compat")
  (sysctl-name "hw.logicalcpu")
  (sysctl-name "hw.logicalcpu_max")
  (sysctl-name "hw.machine")
  (sysctl-name "hw.memsize")
  (sysctl-name "hw.ncpu")
  (sysctl-name "hw.nperflevels")
  (sysctl-name "hw.optional.arm.FEAT_BF16")
  (sysctl-name "hw.optional.arm.FEAT_DotProd")
  (sysctl-name "hw.optional.arm.FEAT_FCMA")
  (sysctl-name "hw.optional.arm.FEAT_FHM")
  (sysctl-name "hw.optional.arm.FEAT_FP16")
  (sysctl-name "hw.optional.arm.FEAT_I8MM")
  (sysctl-name "hw.optional.arm.FEAT_LSE")
  (sysctl-name "hw.optional.arm.FEAT_RDM")
  (sysctl-name "hw.optional.arm.FEAT_SHA512")
  (sysctl-name "hw.optional.armv8_2_sha512")
  (sysctl-name "hw.pagesize")
  (sysctl-name "hw.pagesize_compat")
  (sysctl-name "hw.physicalcpu")
  (sysctl-name "hw.physicalcpu_max")
  (sysctl-name "hw.tbfrequency_compat")
  (sysctl-name "hw.vectorunit")
  (sysctl-name "kern.hostname")
  (sysctl-name "kern.maxfilesperproc")
  (sysctl-name "kern.osproductversion")
  (sysctl-name "kern.osrelease")
  (sysctl-name "kern.ostype")
  (sysctl-name "kern.osvariant_status")
  (sysctl-name "kern.osversion")
  (sysctl-name "kern.secure_kernel")
  (sysctl-name "kern.usrstack64")
  (sysctl-name "kern.version")
  (sysctl-name "sysctl.proc_cputype")
  (sysctl-name "vm.footprint_interval")
  (sysctl-name-prefix "hw.perflevel")
  (sysctl-name-prefix "net.routetable"))

; ---- mach 系统服务 (启动/TLS/证书/临时目录/解析) ----
; 只放常用系统 daemon, 不放任意 mach-lookup。
(allow mach-lookup
  (global-name "com.apple.system.opendirectoryd.libinfo")   ; getpwuid 等
  (global-name "com.apple.system.notification_center")
  (global-name "com.apple.CoreServices.coreservicesd")
  (global-name "com.apple.coreservices.launchservicesd")
  (global-name "com.apple.dnssd.service")                   ; DNS (仅联网档才真能用)
  (global-name "com.apple.system.logger")
  (global-name "com.apple.trustd")                          ; 证书验证
  (global-name "com.apple.trustd.agent")
  (global-name "com.apple.ocspd")                           ; 证书吊销
  (global-name "com.apple.SecurityServer")                  ; 钥匙串/加密
  (global-name "com.apple.SystemConfiguration.configd")
  (global-name "com.apple.SystemConfiguration.SCNetworkReachability")
  (global-name "com.apple.networkd")
  (global-name "com.apple.nsurlsessiond")
  (global-name "com.apple.usymptomsd")
  (global-name "com.apple.logd")
  (global-name "com.apple.diagnosticd")
  (global-name "com.apple.system.DirectoryService.libinfo_v1")
  (global-name "com.apple.PowerManagement.control"))
`.trimStart();
