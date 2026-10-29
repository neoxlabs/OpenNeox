/*
 * NeoxMacSpeech — 系统语音识别 + 关键词唤醒桥 (2026-07-13)
 *
 * 架构:
 *   Electron 主进程 spawn 本 CLI (常驻子进程).
 *   Node → Swift (stdin): 逐行 JSON 控制命令 {"cmd": "start"|"stop"|"setKeywords"|"probePermission"}
 *   Swift → Node (stdout): 逐行 JSON 事件 {"type": "ready"|"permission"|"partial"|"wake"|"error"|...}
 *
 * 核心:
 *   - SFSpeechRecognizer + AVAudioEngine 常驻本地识别 (requiresOnDeviceRecognition=true)
 *   - 每 55s 主动重启一次 recognition task (Apple 单 task 上限 60s)
 *   - partial text 按尾部匹配关键词, 命中即发 wake 事件
 *   - wake 事件后短暂 mute (2s) 防止连续触发
 *
 * TCC 责任链断开 (macOS 15 Sequoia):
 *   dev 模式 Neox 从 Terminal/Termius 启动, TCC 沿父进程链追到 GUI launcher, 责任归 Termius.
 *   Termius 没有 speech usage description → SIGABRT.
 *   修: 启动时用 posix_spawn + responsibility_spawnattrs_setdisclaim 重启自身,
 *   disclaim child 的 TCC 责任归属回自己 (Chromium Helper / Electron Helper 同款招).
 */

import Foundation
import AVFoundation
import Speech
import Darwin

// MARK: - TCC 责任链断开 (posix_spawn disclaim)

/// 从 libSystem 动态载入 responsibility_spawnattrs_setdisclaim (SPI, 不公开).
/// 返回 0 = 成功; -1 = 加载失败 (老 macOS 版本).
private func setDisclaim(_ attrs: UnsafeMutablePointer<posix_spawnattr_t?>) -> Int32 {
    typealias FnType = @convention(c) (UnsafeMutablePointer<posix_spawnattr_t?>, CInt) -> CInt
    guard let sym = dlsym(UnsafeMutableRawPointer(bitPattern: -2), "responsibility_spawnattrs_setdisclaim") else {
        return -1
    }
    let fn = unsafeBitCast(sym, to: FnType.self)
    return fn(attrs, 1)
}

/// 若当前进程还未 disclaim (没有 NEOX_DISCLAIMED env), 用 posix_spawn 重启自身 + disclaim,
/// 父进程 waitpid 后同码退出. child 继承 stdin/stdout/stderr 供 Node IPC 无缝接管.
///
/// 打包 GUI 版 (从 Finder 双击) 一般不需要此招, 但加了也无害 (直接透传).
/// 关键: 只有 dev 从 Terminal spawn 时才有 TCC responsible = Terminal 的问题.
private func relaunchDisclaimedIfNeeded() {
    if getenv("NEOX_DISCLAIMED") != nil { return }  /* 已经是 disclaimed child, 正常跑 */

    var attr = posix_spawnattr_t(nil as OpaquePointer?)
    guard posix_spawnattr_init(&attr) == 0 else { return }
    defer { posix_spawnattr_destroy(&attr) }

    let disclaimResult = setDisclaim(&attr)
    if disclaimResult != 0 {
        /* 老系统或 SPI 挪走 — 直接原地跑, TCC 会 SIGABRT 但至少给出诊断 */
        FileHandle.standardError.write("responsibility_spawnattrs_setdisclaim unavailable, running in place\n".data(using: .utf8)!)
        return
    }

    /* argv: 保留原样 */
    let args = CommandLine.arguments
    let cArgs: [UnsafeMutablePointer<CChar>?] = args.map { strdup($0) } + [nil]
    defer { for p in cArgs { if let p = p { free(p) } } }

    /* env: 加 NEOX_DISCLAIMED=1, 其他不动 */
    var envList: [String] = []
    var envIdx = 0
    while let cur = environ[envIdx] {
        envList.append(String(cString: cur))
        envIdx += 1
    }
    envList.append("NEOX_DISCLAIMED=1")
    let cEnv: [UnsafeMutablePointer<CChar>?] = envList.map { strdup($0) } + [nil]
    defer { for p in cEnv { if let p = p { free(p) } } }

    var pid: pid_t = 0
    let execPath = args[0]
    let rc = execPath.withCString { path -> Int32 in
        posix_spawn(&pid, path,
                    nil,             /* file_actions=nil → 继承所有 fd (stdin/stdout/stderr 传给 child) */
                    &attr,
                    cArgs.map { UnsafeMutablePointer<CChar>(mutating: $0) },
                    cEnv.map { UnsafeMutablePointer<CChar>(mutating: $0) })
    }
    if rc != 0 {
        FileHandle.standardError.write("posix_spawn failed rc=\(rc)\n".data(using: .utf8)!)
        return  /* 让原地继续, TCC 崩就崩, 至少有诊断 */
    }

    /* Parent 等 child 结束, 用 child 的 exit code 退出 —— 对 Node 无感知. */
    var status: Int32 = 0
    _ = waitpid(pid, &status, 0)
    if (status & 0x7f) == 0 {
        exit((status >> 8) & 0xff)
    } else {
        exit(128 + (status & 0x7f))
    }
}

/* 主入口的第一件事: 若需要就 disclaim self, 之后代码永远运行在"我自己是责任方"的上下文里 */
relaunchDisclaimedIfNeeded()

// MARK: - IPC 编解码

struct IPCEvent: Codable {
    let type: String
    var text: String? = nil
    var keyword: String? = nil
    var matched: String? = nil
    var confidence: Double? = nil
    var speech: String? = nil
    var mic: String? = nil
    var message: String? = nil
    var locale: String? = nil
    var onDevice: Bool? = nil
}

@inline(__always)
func emit(_ evt: IPCEvent) {
    guard let data = try? JSONEncoder().encode(evt),
          let s = String(data: data, encoding: .utf8) else { return }
    FileHandle.standardOutput.write((s + "\n").data(using: .utf8)!)
}

struct IPCCommand: Codable {
    let cmd: String
    var keywords: [String]? = nil
    var locale: String? = nil
}

// MARK: - 关键词匹配

/// 尾部关键词匹配 — 用户刚说的最后一段, 忽略大小写与空格.
///
/// SFSpeechRecognizer 中文识别精度不完美, "贾维斯" 可能识别成 "价格士", "假维斯", "家伟斯" 等.
/// 修: 对每个关键词生成一批同音/近音变体, 任意一个尾部命中就算 wake.
/// 2 个字以上短关键词还额外允许"包含" (contains) 而不是必须尾部, 免 SFSpeech 尾部乱识别导致漏.
func matchKeyword(text: String, keywords: [String]) -> (kw: String, matched: String)? {
    let normalized = text.lowercased()
        .replacingOccurrences(of: "，", with: " ")
        .replacingOccurrences(of: "。", with: " ")
        .replacingOccurrences(of: "、", with: " ")
        .replacingOccurrences(of: ",", with: " ")
        .replacingOccurrences(of: ".", with: " ")
        .replacingOccurrences(of: "?", with: " ")
        .replacingOccurrences(of: "!", with: " ")
        .replacingOccurrences(of: "？", with: " ")
        .replacingOccurrences(of: "！", with: " ")
    let trimmed = normalized.trimmingCharacters(in: .whitespacesAndNewlines)

    for kw in keywords {
        let target = kw.lowercased().trimmingCharacters(in: .whitespacesAndNewlines)
        if target.isEmpty { continue }

        /* 精确尾部 */
        if trimmed.hasSuffix(target) {
            return (kw, target)
        }
        /* 尾部近似: 允许尾部含空格/标点 */
        if normalized.hasSuffix(target) || normalized.hasSuffix(target + " ") {
            return (kw, target)
        }
        /* 短关键词 (中文 2-4 字 或英文 <= 8 字符) 允许"包含"检测 —
         * SFSpeech 中文识别常在尾部加一个语气词或误识, 严格尾部会漏, "包含"更实用 */
        let isChinese = target.contains { $0.unicodeScalars.contains { $0.value >= 0x4E00 && $0.value <= 0x9FFF } }
        let isShort = isChinese ? (target.count >= 2 && target.count <= 4) : (target.count >= 3 && target.count <= 8)
        if isShort && trimmed.contains(target) {
            /* 只在文本最后 10 字里含才算, 免几分钟前说过的还触发 */
            let tail = trimmed.count > 12 ? String(trimmed.suffix(12)) : trimmed
            if tail.contains(target) {
                return (kw, target)
            }
        }
    }
    return nil
}

// MARK: - 识别引擎

final class SpeechEngine {
    private var audioEngine = AVAudioEngine()
    private var recognizer: SFSpeechRecognizer?
    private var request: SFSpeechAudioBufferRecognitionRequest?
    private var task: SFSpeechRecognitionTask?
    private var keywords: [String] = []
    private var muteUntil: Date = .distantPast
    private var restartTimer: Timer?
    private var isRunning = false
    private var currentLocale = "zh-CN"

    func requestPermission() {
        SFSpeechRecognizer.requestAuthorization { status in
            let speechStr: String
            switch status {
            case .authorized: speechStr = "granted"
            case .denied: speechStr = "denied"
            case .restricted: speechStr = "restricted"
            case .notDetermined: speechStr = "notDetermined"
            @unknown default: speechStr = "unknown"
            }
            /* 麦克风独立权限 — 用 AVCaptureDevice */
            let micStatus = AVCaptureDevice.authorizationStatus(for: .audio)
            let micStr: String
            switch micStatus {
            case .authorized: micStr = "granted"
            case .denied: micStr = "denied"
            case .restricted: micStr = "restricted"
            case .notDetermined: micStr = "notDetermined"
            @unknown default: micStr = "unknown"
            }
            emit(IPCEvent(type: "permission", speech: speechStr, mic: micStr))
        }
    }

    func setKeywords(_ kws: [String]) {
        keywords = kws.filter { !$0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
        emit(IPCEvent(type: "keywords_set", message: "\(keywords.count)"))
    }

    func setLocale(_ locale: String) {
        currentLocale = locale
    }

    func start() {
        guard !isRunning else { return }
        /* 🔐 关键: 必须先拿到 Speech + Mic 两个权限才能启动.
         * 未授权直接调 recognitionTask 会 SIGABRT (2026-07-13 用户实录).
         * 先 Speech (弹语音识别授权对话框), granted 后再 Mic (弹麦克风对话框). */
        SFSpeechRecognizer.requestAuthorization { [weak self] status in
            DispatchQueue.main.async {
                guard let self else { return }
                if status != .authorized {
                    let statusStr = self.speechStatusString(status)
                    emit(IPCEvent(type: "permission", speech: statusStr, mic: "notRequested"))
                    emit(IPCEvent(type: "error", message: "speech permission not granted: \(statusStr)"))
                    return
                }
                /* 若 mic 状态已经是 denied/restricted, 直接告知用户去系统设置, 不再 requestAccess
                 * (dev 模式 disclaimed 子进程有时 requestAccess 不弹对话框直接返 false, 反复触发). */
                let curMic = AVCaptureDevice.authorizationStatus(for: .audio)
                if curMic == .denied || curMic == .restricted {
                    let micStr = curMic == .denied ? "denied" : "restricted"
                    emit(IPCEvent(type: "permission", speech: "granted", mic: micStr))
                    emit(IPCEvent(type: "error", message: "mic permission denied"))
                    return
                }
                AVCaptureDevice.requestAccess(for: .audio) { [weak self] granted in
                    DispatchQueue.main.async { self?.startAfterAllAuth(granted: granted) }
                }
            }
        }
    }

    private func speechStatusString(_ status: SFSpeechRecognizerAuthorizationStatus) -> String {
        switch status {
        case .authorized: return "granted"
        case .denied: return "denied"
        case .restricted: return "restricted"
        case .notDetermined: return "notDetermined"
        @unknown default: return "unknown"
        }
    }

    private func startAfterAllAuth(granted: Bool) {
        if !granted {
            emit(IPCEvent(type: "permission", speech: "granted", mic: "denied"))
            emit(IPCEvent(type: "error", message: "mic permission denied"))
            return
        }
        emit(IPCEvent(type: "permission", speech: "granted", mic: "granted"))
        let loc = Locale(identifier: currentLocale)
        guard let rec = SFSpeechRecognizer(locale: loc), rec.isAvailable else {
            emit(IPCEvent(type: "error", message: "SFSpeechRecognizer unavailable for locale \(currentLocale)"))
            return
        }
        recognizer = rec
        isRunning = true
        launchTask()
        /* 每 55s 主动重启, 规避单 task 60s 上限 */
        restartTimer = Timer.scheduledTimer(withTimeInterval: 55.0, repeats: true) { [weak self] _ in
            self?.restartTask()
        }
        emit(IPCEvent(type: "started", locale: currentLocale, onDevice: rec.supportsOnDeviceRecognition))
    }

    private func launchTask() {
        stopTask()
        let req = SFSpeechAudioBufferRecognitionRequest()
        req.shouldReportPartialResults = true
        /* 关键: 强制本地识别 — 不上传 Apple 服务器. Catalina+ 支持. */
        if recognizer?.supportsOnDeviceRecognition == true {
            req.requiresOnDeviceRecognition = true
        }
        request = req

        let input = audioEngine.inputNode
        /* AudioEngine 已运行时不要重装 tap — 只有第一次真需要装. */
        if !audioEngine.isRunning {
            let format = input.outputFormat(forBus: 0)
            input.removeTap(onBus: 0)
            input.installTap(onBus: 0, bufferSize: 1024, format: format) { [weak self] buffer, _ in
                self?.request?.append(buffer)
            }
            do {
                audioEngine.prepare()
                try audioEngine.start()
            } catch {
                emit(IPCEvent(type: "error", message: "audio engine start: \(error.localizedDescription)"))
                return
            }
        }

        task = recognizer?.recognitionTask(with: req) { [weak self] result, error in
            guard let self else { return }
            if let result = result {
                let text = result.bestTranscription.formattedString
                if !text.isEmpty {
                    emit(IPCEvent(type: "partial", text: text))
                    /* mute 期不响应 (避免自身 TTS 或立刻二次触发) */
                    if Date() >= self.muteUntil {
                        if let hit = matchKeyword(text: text, keywords: self.keywords) {
                            /* 命中 → 发 wake, 3 秒 mute (给 VoiceMode 打开留时间, 免立即误触发第二次).
                             * 关键: 一次 wake 后旧 partial 里包含关键词的部分会持续留着,
                             * 光 restartTask 不够 — 得 fullRestartAudioEngine 完全刷新缓存, 让 partial text 从头开始. */
                            emit(IPCEvent(type: "wake", keyword: hit.kw, matched: hit.matched, confidence: 1.0))
                            self.muteUntil = Date().addingTimeInterval(3.0)
                            self.fullRestartAudioEngine()
                            return
                        }
                    }
                }
                if result.isFinal {
                    self.restartTask()
                }
            }
            if let error = error as NSError? {
                /* 中断 / EOF / timeout → 自动重启, 除非停止 */
                let ignoredCodes: Set<Int> = [203, 216, 1101, 1110]
                if !ignoredCodes.contains(error.code) {
                    emit(IPCEvent(type: "error", message: "recognition: \(error.localizedDescription)"))
                }
                if self.isRunning { self.restartTask() }
            }
        }
    }

    private func restartTask() {
        guard isRunning else { return }
        launchTask()
    }

    /// wake 命中后完全重启 audioEngine + recognizer — 目的:
    /// · 彻底清空 SFSpeech 内部 partial text 缓存, 免"贾维斯"文本一直留着反复 match
    /// · 释放 mic 短暂, 让即将开启的 VoiceMode/Composer 麦克风优先拿到设备
    /// · 3s mute 期结束后 launchTask 恢复监听
    private func fullRestartAudioEngine() {
        stopTask()
        if audioEngine.isRunning {
            audioEngine.stop()
            audioEngine.inputNode.removeTap(onBus: 0)
        }
        /* 换新的 AVAudioEngine 实例, 免旧 engine 状态残留 */
        audioEngine = AVAudioEngine()
        /* mute 期结束后自动 relaunch (SFSpeech / mic 让给 VoiceMode 3s 后恢复) */
        DispatchQueue.main.asyncAfter(deadline: .now() + 3.0) { [weak self] in
            guard let self, self.isRunning else { return }
            self.launchTask()
        }
    }

    private func stopTask() {
        request?.endAudio()
        task?.cancel()
        task = nil
        request = nil
    }

    func stop() {
        isRunning = false
        restartTimer?.invalidate()
        restartTimer = nil
        stopTask()
        if audioEngine.isRunning {
            audioEngine.stop()
            audioEngine.inputNode.removeTap(onBus: 0)
        }
        emit(IPCEvent(type: "stopped"))
    }
}

// MARK: - stdin 命令读取循环

let engine = SpeechEngine()

emit(IPCEvent(type: "ready"))

/* 独立线程读 stdin, 每行 JSON = 一条命令.
 * 主线程留给 RunLoop 承载 SFSpeechRecognizer 的回调. */
DispatchQueue.global(qos: .userInitiated).async {
    while let line = readLine(strippingNewline: true) {
        let trimmed = line.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.isEmpty { continue }
        guard let data = trimmed.data(using: .utf8),
              let cmd = try? JSONDecoder().decode(IPCCommand.self, from: data) else {
            emit(IPCEvent(type: "error", message: "bad cmd: \(trimmed.prefix(80))"))
            continue
        }
        DispatchQueue.main.async {
            switch cmd.cmd {
            case "probePermission":
                engine.requestPermission()
            case "setKeywords":
                engine.setKeywords(cmd.keywords ?? [])
                if let loc = cmd.locale { engine.setLocale(loc) }
            case "start":
                if let kws = cmd.keywords { engine.setKeywords(kws) }
                if let loc = cmd.locale { engine.setLocale(loc) }
                engine.start()
            case "stop":
                engine.stop()
            case "quit", "exit":
                engine.stop()
                exit(0)
            default:
                emit(IPCEvent(type: "error", message: "unknown cmd: \(cmd.cmd)"))
            }
        }
    }
    /* stdin 关闭 = 父进程死了 = 我们也退出 */
    DispatchQueue.main.async {
        engine.stop()
        exit(0)
    }
}

/* SIGTERM/SIGINT 平滑退出 */
signal(SIGTERM) { _ in exit(0) }
signal(SIGINT) { _ in exit(0) }

RunLoop.main.run()
