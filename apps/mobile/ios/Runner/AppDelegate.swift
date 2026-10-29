import AVFoundation
import Flutter
import UIKit

@main
@objc class AppDelegate: FlutterAppDelegate {
  private var pilotVoice: PilotVoiceBridge?

  override func application(
    _ application: UIApplication,
    didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?
  ) -> Bool {
    GeneratedPluginRegistrant.register(with: self)
    if let registrar = self.registrar(forPlugin: "NeoxPilotVoice") {
      pilotVoice = PilotVoiceBridge(messenger: registrar.messenger())
    }
    return super.application(application, didFinishLaunchingWithOptions: launchOptions)
  }
}

/// `neox.pilot/voice` 的 iOS 端 —— 跟 android/.../PilotVoiceBridge.kt 同一份约定:
/// play(audio, format, media) 播完才回 true (通话 / 语音对话循环据此接着听), 播不了回 false; stop() 打断。
/// 合成在 Dart 那边 (core/voice/pilot_voice.dart), 这里只播。
/// 其余安卓专属通道 (手机工具 / 来电 / 推送 / 保活 / APK 更新 / 本地模型) iOS 不实现,
/// Dart 侧都按平台跳过或 catchError。
final class PilotVoiceBridge: NSObject, AVAudioPlayerDelegate {
  private let channel: FlutterMethodChannel
  private var player: AVAudioPlayer?
  private var pending: FlutterResult?

  init(messenger: FlutterBinaryMessenger) {
    channel = FlutterMethodChannel(name: "neox.pilot/voice", binaryMessenger: messenger)
    super.init()
    channel.setMethodCallHandler { [weak self] call, result in
      guard let self else { return }
      switch call.method {
      case "play":
        let args = call.arguments as? [String: Any] ?? [:]
        let audio = (args["audio"] as? FlutterStandardTypedData)?.data
        self.play(audio, media: args["media"] as? Bool ?? false, result: result)
      case "stop":
        self.stop()
        result(nil)
      default:
        result(FlutterMethodNotImplemented)
      }
    }
  }

  private func play(_ audio: Data?, media: Bool, result: @escaping FlutterResult) {
    stop()
    guard let audio, !audio.isEmpty else { result(false); return }
    let session = AVAudioSession.sharedInstance()
    do {
      /* 识别 (speech_to_text / record) 会把会话切成 playAndRecord, 那个类别默认走听筒 ——
       * 拿在手上听不见。保持 playAndRecord (说完马上要接着听), 只把输出拉到扬声器。 */
      if session.category == .playAndRecord {
        try session.setActive(true)
        try session.overrideOutputAudioPort(media ? .speaker : .none)
      } else {
        try session.setCategory(.playback, mode: .spokenAudio)
        try session.setActive(true)
      }
      let p = try AVAudioPlayer(data: audio)
      p.delegate = self
      pending = result
      player = p
      if !p.play() { finish(false) }
    } catch {
      NSLog("[pilot-voice] play failed: \(error)")
      pending = result
      finish(false)
    }
  }

  func audioPlayerDidFinishPlaying(_ player: AVAudioPlayer, successfully flag: Bool) {
    finish(flag)
  }

  func audioPlayerDecodeErrorDidOccur(_ player: AVAudioPlayer, error: Error?) {
    finish(false)
  }

  private func finish(_ ok: Bool) {
    player = nil
    if let r = pending {
      pending = nil
      r(ok)
    }
  }

  func stop() {
    player?.stop()
    finish(false)
  }
}
