#!/usr/bin/env node
/**
 * 开发模式下修改 Electron.app 的 Info.plist:
 *   1. Dock/菜单栏显示 "Neox" 而不是 "Electron"
 *   2. CFBundleIdentifier 改成 Neox 自己的 — 避免 macOS TCC 把 com.github.Electron
 *      跟其他用同一 id 的应用 (例如用户机器上的 IntelliJ IDEA 或别的 Electron helper)
 *      共享权限缓存. 表现是: iCloud / 文件 / 麦克风等系统弹窗里 "responsible app"
 *      显示成 "IntelliJ IDEA" 而不是 "Neox" — 同一个 bundle id 在 TCC 数据库里
 *      被映射到了第一个注册的应用名.
 *
 * 打包模式不需要 (electron-builder 用 productName + appId 自动处理).
 */
const fs = require('fs');
const path = require('path');

const APP_NAME = 'Neox';
const APP_ID = 'com.mk-co.neox.dev';   /* 唯一 id, 跟生产 electron-builder appId 区分, 避免冲突 */
const ELECTRON_APP = path.resolve(__dirname, '..', 'node_modules/electron/dist/Electron.app');
const PLIST = path.join(ELECTRON_APP, 'Contents/Info.plist');

if (!fs.existsSync(PLIST)) {
  console.log('Electron.app not found, skipping name patch');
  process.exit(0);
}

let content = fs.readFileSync(PLIST, 'utf8');
let changed = false;

// CFBundleName
content = content.replace(
  /(<key>CFBundleName<\/key>\s*<string>).*?(<\/string>)/,
  (_, pre, post) => { changed = true; return `${pre}${APP_NAME}${post}`; }
);

// CFBundleDisplayName
content = content.replace(
  /(<key>CFBundleDisplayName<\/key>\s*<string>).*?(<\/string>)/,
  (_, pre, post) => { changed = true; return `${pre}${APP_NAME}${post}`; }
);

// CFBundleIdentifier — 给 Electron.app 独立 id, 让 TCC 弹窗正确显示 "Neox"
content = content.replace(
  /(<key>CFBundleIdentifier<\/key>\s*<string>).*?(<\/string>)/,
  (_, pre, post) => { changed = true; return `${pre}${APP_ID}${post}`; }
);

/* 语音识别权限声明 (dev 模式补): 生产走 electron-builder extendInfo, dev 走这里 patch.
 * 未声明 macOS 首次调用 SFSpeechRecognizer.requestAuthorization 会直接拒 (无弹窗). */
const SPEECH_KEY = 'NSSpeechRecognitionUsageDescription';
const SPEECH_DESC = 'Neox 使用系统语音识别在本地转写你的语音, 完全离线, 数据不出机器';
const MIC_KEY = 'NSMicrophoneUsageDescription';
const MIC_DESC = 'Neox 需要使用麦克风来做语音输入和语音对话';
const ensureKey = (key, desc) => {
  if (content.includes(`<key>${key}</key>`)) {
    /* 已存在 — 覆盖描述, 用户能看到符合语境的中文 */
    content = content.replace(
      new RegExp(`(<key>${key}</key>\\s*<string>).*?(</string>)`),
      (_, pre, post) => { changed = true; return `${pre}${desc}${post}`; }
    );
  } else {
    /* 插到 </dict>\n</plist> 之前 */
    content = content.replace(
      /(<\/dict>\s*<\/plist>)/,
      `\t<key>${key}</key>\n\t<string>${desc}</string>\n$1`
    );
    changed = true;
  }
};
ensureKey(SPEECH_KEY, SPEECH_DESC);
ensureKey(MIC_KEY, MIC_DESC);

if (changed) {
  fs.writeFileSync(PLIST, content);
  console.log(`✅ Patched Electron.app → name="${APP_NAME}", bundleId="${APP_ID}"`);
} else {
  console.log(`Already patched (name="${APP_NAME}", bundleId="${APP_ID}")`);
}

/* Dev Dock 默认会显示 electron.icns（原子标）。把我们的白底 squircle 覆盖进去，
 * 这样即便 app.dock.setIcon 还没跑，Dock 也不会是原生 Electron 图标。 */
const ICON_ICNS = path.resolve(__dirname, '..', 'build', 'icon.icns');
const ELECTRON_ICNS = path.join(ELECTRON_APP, 'Contents/Resources/electron.icns');
if (fs.existsSync(ICON_ICNS) && fs.existsSync(path.dirname(ELECTRON_ICNS))) {
  fs.copyFileSync(ICON_ICNS, ELECTRON_ICNS);
  console.log('✅ Patched Electron.app icon → build/icon.icns');
}
