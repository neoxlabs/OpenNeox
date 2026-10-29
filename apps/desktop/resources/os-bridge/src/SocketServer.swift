import Foundation

/*
 * Unix domain socket 服务端 —— **独立身份的必要代价**。
 * ═══════════════════════════════════════════════════════════════════════════
 * 桥要拿到自己的 TCC 身份 (辅助功能列表里那条「Neox Computer Use」), 就必须由
 * launchd 拉起 (`open -a`) 而不是被宿主 spawn —— 被 spawn 的进程 TCC 记的是**责任
 * 进程**, 于是 dev 显示「Electron」、打包版显示「Neox」、从终端跑显示终端名,
 * 同一个能力在列表里三个身份, 用户勾一个另外两个还是不能用。
 *
 * 代价: `open` 起来的 app **没有可用的 stdio**, 所以协议从 stdin/stdout 换成
 * unix socket。协议本身一个字没变 (还是 JSON-lines), 只是换了根管子。
 *
 * 一次只服务一个连接: 宿主那边是单例客户端, 多连接只会让元素表 (它是进程级的)
 * 被两个会话互相踩。第二个连接直接关掉, 比默默共享一张表安全。
 */

final class SocketServer {
    private let path: String
    private var listenFD: Int32 = -1

    init(path: String) {
        self.path = path
    }

    /** 起监听。失败返回错误描述。 */
    func start() -> String? {
        unlink(path)   /* 上一次没清干净的残留 socket 文件会让 bind 直接失败 */

        listenFD = socket(AF_UNIX, SOCK_STREAM, 0)
        guard listenFD >= 0 else { return "socket() 失败: \(String(cString: strerror(errno)))" }

        var addr = sockaddr_un()
        addr.sun_family = sa_family_t(AF_UNIX)
        let maxLen = MemoryLayout.size(ofValue: addr.sun_path)
        guard path.utf8.count < maxLen else { return "socket 路径太长 (>\(maxLen)): \(path)" }
        _ = withUnsafeMutablePointer(to: &addr.sun_path) { ptr in
            path.withCString { src in
                strncpy(UnsafeMutableRawPointer(ptr).assumingMemoryBound(to: CChar.self), src, maxLen - 1)
            }
        }

        let size = socklen_t(MemoryLayout<sockaddr_un>.size)
        let bindResult = withUnsafePointer(to: &addr) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { bind(listenFD, $0, size) }
        }
        guard bindResult == 0 else { return "bind 失败: \(String(cString: strerror(errno)))" }
        /* 只有本用户能连 —— 这条管子后面是"能操作你整台电脑"的能力 */
        chmod(path, 0o600)
        guard listen(listenFD, 4) == 0 else { return "listen 失败: \(String(cString: strerror(errno)))" }
        return nil
    }

    /**
     * 接一个连接, 按行读请求, 逐行回复。连接断了就返回 (调用方决定要不要再接一个)。
     * `handle` 负责处理一行请求并把回复写回去。
     */
    func serveOne(handle: (String, @escaping (String) -> Void) -> Void) {
        let fd = accept(listenFD, nil, nil)
        guard fd >= 0 else { return }
        defer { close(fd) }

        let writeLock = NSLock()
        let write: (String) -> Void = { line in
            writeLock.lock()
            defer { writeLock.unlock() }
            var data = Array((line + "\n").utf8)
            var offset = 0
            while offset < data.count {
                let n = data.withUnsafeBytes { send(fd, $0.baseAddress!.advanced(by: offset), data.count - offset, 0) }
                if n <= 0 { break }
                offset += n
            }
        }

        var buffer = Data()
        var chunk = [UInt8](repeating: 0, count: 16 * 1024)
        while true {
            let n = recv(fd, &chunk, chunk.count, 0)
            if n <= 0 { break }   /* 对端关了 */
            buffer.append(contentsOf: chunk[0..<n])
            while let nl = buffer.firstIndex(of: 0x0A) {
                let lineData = buffer[buffer.startIndex..<nl]
                buffer = buffer[(nl + 1)...]
                guard let line = String(data: lineData, encoding: .utf8) else { continue }
                let trimmed = line.trimmingCharacters(in: .whitespacesAndNewlines)
                if trimmed.isEmpty { continue }
                handle(trimmed, write)
            }
        }
    }

    func stop() {
        if listenFD >= 0 { close(listenFD) }
        unlink(path)
    }
}
