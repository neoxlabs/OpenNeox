//! neox-native — 客户端关键算法 (Rust, 编译进二进制 .node 文件).
//!
//! 暴露的 N-API 函数:
//!   - compute_fingerprint(blob_obj) → fpHash (sha256 base64url 前缀)
//!   - compute_hmac_sig(ts, nonce, path, body_sha256) → sigHex
//!   - verify_pin(cert_der_buf) → bool
//!   - get_secret_version() → string  (调试 / 服务端用 User-Agent 选 secret 时对照)
//!
//! 反逆向核心:
//!   · 根 secret 由构建期环境注入 (见 root_secret), 源码里不留值
//!   · per-app-version secret = HKDF(root, "neox-app-vX.Y.Z")
//!   · LTO + strip + panic=abort + 单 codegen 单元 → 调用图打散
//!   · 关键调用打 #[inline(never)] 防止全 inline 后函数边界完全消失也没问题
//!     (调用方需要找入口点; 但函数名都 strip 了, 没意义)

#![allow(clippy::needless_return)]

use hkdf::Hkdf;
use hmac::{Hmac, Mac};
use napi::bindgen_prelude::*;
use napi_derive::napi;
use sha2::{Digest, Sha256};
use std::collections::HashMap;

type HmacSha256 = Hmac<Sha256>;

/// 当前 root secret 的版本号. 跟 desktop package.json 的安全语义版本绑.
/// 升级时改这里 + 重新编译 → 老 secret 自动作废.
const SECRET_VERSION: &str = "v3.4.1";

/// 根 secret — 构建期从 NEOX_HMAC_ROOT_SECRET 注入, 源码里不留值.
/// 改这个值 = 全部已下发的客户端立即失效, 是核武器, 慎用.
///
/// 这是 ship 的 desktop 二进制的密码学边界, 不分 dev / prod —
/// 客户端 binary 同一份, dev 用户和 prod 用户都拿到这同一个 secret.
/// 服务端 .env.local 和 .env.production 的 NEOX_HMAC_ROOT_SECRET 必须跟这里
/// 一字不差; 不一致 → 客户端所有 LLM 请求 401 bad_signature.
///
/// 升级流程: 改这里 + bump SECRET_VERSION (上面那个常量) + 重新 cargo build
///                + 同步更新服务端两个 .env + 发新 desktop 版本.
fn root_secret() -> String {
    /* 公开树: 不做编译期混淆 —— 混淆只拖慢反汇编, 拖不住 git, 真边界是源码里没有值。 */
    /* 公开树: root secret 不随源码分发, 由官方出包机器在编译期注入 (NEOX_HMAC_ROOT_SECRET)。
     * 没注入 = 未签名构建: get_secret_version() 返回 "unsigned", 客户端据此不签名直接发请求,
     * 照常可用。签名只用来识别官方构建, 不是认证 —— 认证是每个用户自己的 key。
     * ⚠️ 必须是 option_env! (编译期), 不能是运行时 env + expect: 本 crate panic=abort,
     *    运行时读不到会直接杀掉宿主进程。 */
    option_env!("NEOX_HMAC_ROOT_SECRET").unwrap_or("").to_string()
}

/// per-app-version 派生 secret — 客户端每次发版换新 secret, 老破解版本服务端立即拒.
/// HKDF 是 RFC 5869 标准, 跟服务端用同款.
fn versioned_secret() -> Vec<u8> {
    let root = root_secret();
    let hk = Hkdf::<Sha256>::new(None, root.as_bytes());
    let info = format!("neox-app-{}", SECRET_VERSION);
    let mut out = vec![0u8; 32];
    hk.expand(info.as_bytes(), &mut out).expect("hkdf expand 32 bytes");
    out
}

/// 输入: 客户端构造的设备指纹字典 (machineId, installUuid, cpuModel, ...)
/// 输出: 32 字符 base64url-no-pad sha256 前缀
///
/// JS 侧传 object, 我们按字典序拼 key=value 行 sha256, 跟 desktop deviceFingerprint.ts 兼容.
#[napi]
#[inline(never)]
pub fn compute_fingerprint(blob: HashMap<String, String>) -> String {
    let mut keys: Vec<&String> = blob.keys().collect();
    keys.sort();
    let mut hasher = Sha256::new();
    for k in keys {
        let v = blob.get(k).map(String::as_str).unwrap_or("");
        hasher.update(k.as_bytes());
        hasher.update(b"=");
        hasher.update(v.as_bytes());
        hasher.update(b"\n");
    }
    let digest = hasher.finalize();
    let b64 = base64url_no_pad(&digest);
    b64.chars().take(32).collect()
}

/// 响应签校验用 (**请求签发已切 compute_hmac_sig_v2**, 2026-07-03 cutover).
///
/// gateway respsign.go 目前仍用 v1 公式发响应签 X-Resp-Sig, 客户端用这个函数算同款做完整性校验.
/// 响应方向不需要绑 nxk/设备 (响应给的就是已认证 client), 保留 v1 无破口.
///
/// 输入: ts (unix 秒字符串), nonce (hex), path, body_sha256 (hex)
/// 输出: hex(hmac_sha256(versioned_secret, ts + "\n" + nonce + "\n" + path + "\n" + body_sha256))
#[napi]
#[inline(never)]
pub fn compute_hmac_sig(ts: String, nonce: String, path: String, body_sha256: String) -> Result<String> {
    let secret = versioned_secret();
    let mut mac = HmacSha256::new_from_slice(&secret)
        .map_err(|e| Error::new(Status::GenericFailure, format!("hmac key: {}", e)))?;
    mac.update(ts.as_bytes());
    mac.update(b"\n");
    mac.update(nonce.as_bytes());
    mac.update(b"\n");
    mac.update(path.as_bytes());
    mac.update(b"\n");
    mac.update(body_sha256.as_bytes());
    let bytes = mac.finalize().into_bytes();
    Ok(hex::encode(bytes))
}

/// S1 v2 (2026-07-03): 签名绑 nxk + 设备指纹.
/// 输出 = hex(hmac_sha256(versioned_secret,
///          ts \n nonce \n path \n body_sha256 \n nxk_id \n device_fp))
/// 服务端 model-gateway/internal/sigverify computeSigV2 逐字节对齐此顺序.
///   nxk_id   = sha256(nxk)[:16] hex (JS 侧算, 只传指纹不传原 key)
///   device_fp= 客户端设备指纹 (X-Device-FP header 同值); 无则传空串, 两端一致即可
/// 目的: 偷来的 root secret 也没法给"别的 nxk / 别的设备"伪造能与请求头对上的签名.
#[napi]
#[inline(never)]
pub fn compute_hmac_sig_v2(
    ts: String,
    nonce: String,
    path: String,
    body_sha256: String,
    nxk_id: String,
    device_fp: String,
) -> Result<String> {
    let secret = versioned_secret();
    let mut mac = HmacSha256::new_from_slice(&secret)
        .map_err(|e| Error::new(Status::GenericFailure, format!("hmac key: {}", e)))?;
    mac.update(ts.as_bytes());
    mac.update(b"\n");
    mac.update(nonce.as_bytes());
    mac.update(b"\n");
    mac.update(path.as_bytes());
    mac.update(b"\n");
    mac.update(body_sha256.as_bytes());
    mac.update(b"\n");
    mac.update(nxk_id.as_bytes());
    mac.update(b"\n");
    mac.update(device_fp.as_bytes());
    let bytes = mac.finalize().into_bytes();
    Ok(hex::encode(bytes))
}

/// 工具: body bytes → sha256 hex (客户端先算 body 哈希再传给 compute_hmac_sig).
/// 暴露这个比让 JS 端用 SubtleCrypto 更稳 (JS 端也可以自己算, 这里是便利函数).
#[napi]
pub fn sha256_hex(bytes: Buffer) -> String {
    let mut hasher = Sha256::new();
    hasher.update(&bytes[..]);
    hex::encode(hasher.finalize())
}

/// SEC-4 (2026-06-17): AEAD 派生 key — HKDF-SHA256(root_secret, info=info_str, L=32).
///   客户端 JS 拿到这 32 字节后做 AES-256-GCM. root secret 不出 native.
///   info 传 "neox-aead-v1" 跟服务端约定.
///   ⚠️ 这个 key 不在反逆向边界内 — 它的派生公式是公开的, 但派生输入 (root_secret)
///   被 obfstr 混淆. 拿到这把 key 的攻击者只能解 AEAD body, 不能伪造 HMAC sig.
#[napi]
#[inline(never)]
pub fn aead_subkey(info: String) -> Buffer {
    let root = root_secret();
    let hk = Hkdf::<Sha256>::new(None, root.as_bytes());
    let mut out = vec![0u8; 32];
    hk.expand(info.as_bytes(), &mut out).expect("hkdf expand 32 bytes");
    Buffer::from(out)
}

/// SEC-4: AEAD encrypt — 用 aead_subkey("neox-aead-v1") 派生的 key 加密 body.
///   输入: plaintext (UTF-8 JSON bytes)
///   输出: nonce(12B) || ciphertext || tag(16B), 一气呵成的 Buffer
///   JS 端只需 base64(返回值) 当 body 发, 服务端收到 base64 decode 后直接传给 AES-256-GCM Open.
#[napi]
#[inline(never)]
pub fn aead_encrypt(plaintext: Buffer) -> Result<Buffer> {
    use aes_gcm::aead::{Aead, KeyInit, OsRng};
    use aes_gcm::{AeadCore, Aes256Gcm, Nonce};

    let root = root_secret();
    let hk = Hkdf::<Sha256>::new(None, root.as_bytes());
    let mut key = vec![0u8; 32];
    hk.expand(b"neox-aead-v1", &mut key)
        .map_err(|e| Error::new(Status::GenericFailure, format!("hkdf: {}", e)))?;
    let cipher = Aes256Gcm::new_from_slice(&key)
        .map_err(|e| Error::new(Status::GenericFailure, format!("cipher init: {}", e)))?;
    let nonce_bytes = Aes256Gcm::generate_nonce(&mut OsRng);
    let nonce = Nonce::from_slice(&nonce_bytes);
    let ciphertext = cipher
        .encrypt(nonce, &plaintext[..])
        .map_err(|e| Error::new(Status::GenericFailure, format!("aead encrypt: {}", e)))?;
    /* ciphertext 已是 ct || tag (aes-gcm crate 自动 append 16B tag).
     * 我们要的总输出 = nonce || ct || tag, 拼起来. */
    let mut out = Vec::with_capacity(12 + ciphertext.len());
    out.extend_from_slice(&nonce_bytes);
    out.extend_from_slice(&ciphertext);
    Ok(Buffer::from(out))
}

/// TLS pin 校验 — 客户端启动时拿连上 gateway 的证书 DER, 跟编译期 pin 列表比.
/// 列表用 obfstr 混淆, 运行时还原后 sha256 比对. 双 pin (主+备) 保证轮换不中断.
///
/// 2026-07-03: 现状 = 占位, 需要作者把生产证书 SPKI SHA-256 填进 pin_primary/pin_backup,
/// 而且要跟 CF 边缘证书轮换策略配套 (双 pin 至少覆盖 curr + next). 未填 pin 时:
///   - **占位状态 (以 __ 开头)** → 一律返 **false** (fail-close), **不再默认 true**.
///   - 想 dev 时不 pin, 显式在 CLI/Electron 里跳过调用即可 (不要绕过 verify_pin 语义).
///
/// 拿到 CF 边缘证书 SPKI SHA-256:
///   `echo | openssl s_client -connect neox-dev.com:443 -servername neox-dev.com 2>/dev/null \
///     | openssl x509 -pubkey -noout | openssl pkey -pubin -outform der \
///     | openssl dgst -sha256 -hex`
#[napi]
#[inline(never)]
pub fn verify_pin(cert_der: Buffer) -> bool {
    let mut hasher = Sha256::new();
    hasher.update(&cert_der[..]);
    let actual = hex::encode(hasher.finalize());
    let pin_primary = obfstr::obfstr!("__PRIMARY_PIN_PLACEHOLDER__").to_string();
    let pin_backup = obfstr::obfstr!("__BACKUP_PIN_PLACEHOLDER__").to_string();
    /* 占位状态 — fail-close. 之前占位默认 true = pinning 完全失效, MITM 直接过. */
    if pin_primary.starts_with("__") && pin_backup.starts_with("__") {
        return false;
    }
    actual == pin_primary || actual == pin_backup
}

/// 暴露版本号 — 服务端按 User-Agent 找对应 secret 时, 客户端可主动告知.
#[napi]
pub fn get_secret_version() -> &'static str {
    match option_env!("NEOX_HMAC_ROOT_SECRET") {
        Some(s) if !s.is_empty() => SECRET_VERSION,
        _ => "unsigned",
    }
}

/* ---------- helpers ---------- */

#[inline]
fn base64url_no_pad(bytes: &[u8]) -> String {
    /* 自实现避免引 base64 crate; 简单查表. */
    const CHARSET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    let mut out = String::with_capacity(bytes.len() * 4 / 3 + 4);
    let mut i = 0;
    while i + 3 <= bytes.len() {
        let b0 = bytes[i] as u32;
        let b1 = bytes[i + 1] as u32;
        let b2 = bytes[i + 2] as u32;
        out.push(CHARSET[((b0 >> 2) & 0x3F) as usize] as char);
        out.push(CHARSET[(((b0 << 4) | (b1 >> 4)) & 0x3F) as usize] as char);
        out.push(CHARSET[(((b1 << 2) | (b2 >> 6)) & 0x3F) as usize] as char);
        out.push(CHARSET[(b2 & 0x3F) as usize] as char);
        i += 3;
    }
    let rem = bytes.len() - i;
    if rem == 1 {
        let b0 = bytes[i] as u32;
        out.push(CHARSET[((b0 >> 2) & 0x3F) as usize] as char);
        out.push(CHARSET[((b0 << 4) & 0x3F) as usize] as char);
    } else if rem == 2 {
        let b0 = bytes[i] as u32;
        let b1 = bytes[i + 1] as u32;
        out.push(CHARSET[((b0 >> 2) & 0x3F) as usize] as char);
        out.push(CHARSET[(((b0 << 4) | (b1 >> 4)) & 0x3F) as usize] as char);
        out.push(CHARSET[((b1 << 2) & 0x3F) as usize] as char);
    }
    out
}
