import java.util.Properties
import java.io.FileInputStream

plugins {
    id("com.android.application")
    id("kotlin-android")
    // The Flutter Gradle Plugin must be applied after the Android and Kotlin Gradle plugins.
    id("dev.flutter.flutter-gradle-plugin")
}

/* Release 签名 — android/key.properties 存在时启用真签名 (文件不入库, 见 .gitignore):
 *   storeFile=/绝对路径/neox-release.jks
 *   storePassword=...
 *   keyAlias=neox
 *   keyPassword=...
 * 生成 keystore:
 *   keytool -genkey -v -keystore neox-release.jks -keyalg RSA -keysize 2048 \
 *     -validity 10000 -alias neox
 * 没有 key.properties 时回落 debug 签名 (开发机 flutter run --release 可用,
 * 发布产物绝不能用 debug 签名 — CI/发布脚本必须配真 keystore). */
val keystoreProperties = Properties()
val keystorePropertiesFile = rootProject.file("key.properties")
val hasReleaseKeystore = keystorePropertiesFile.exists()
if (hasReleaseKeystore) {
    keystoreProperties.load(FileInputStream(keystorePropertiesFile))
}

/* FCM 推送 (2026-10-02) — 不用 google-services 插件: 它要求 google-services.json 必须存在,
 * 开源版没有就编不过。这里把同样的几项写成资源 (google_app_id 等), Firebase 自带的
 * FirebaseInitProvider 启动时照样读到并初始化。文件不在 (开源版) 就不写, 推送整块不生效。 */
val firebaseProperties = Properties()
val firebasePropertiesFile = file("firebase.properties")
val hasFirebase = firebasePropertiesFile.exists()
if (hasFirebase) {
    firebaseProperties.load(FileInputStream(firebasePropertiesFile))
}
fun firebase(key: String): String = firebaseProperties.getProperty(key) ?: ""

android {
    namespace = "com.mkco.neox.mobile"
    /* 2026-08-04: 固定 36, 不再跟 flutter.compileSdkVersion (当前 Flutter 给的是 35)。
     * mobile_scanner 早就在警告要 36, flutter_web_auth_2 依赖的 androidx.browser 1.9.0
     * 直接把它变成硬失败 (checkDebugAarMetadata)。compileSdk 只影响编译期可见的 API,
     * 不改运行时行为 —— targetSdk 才是行为开关, 那个仍跟 Flutter 走。 */
    compileSdk = 36
    // 多个插件 (mobile_scanner / flutter_local_notifications / flutter_secure_storage /
    // path_provider / permission_handler / shared_preferences / sqlite3_flutter_libs)
    // 要求 NDK 27+, 跟 Flutter 默认 26.3 不兼容. 用最高版本 (向后兼容).
    ndkVersion = "27.0.12077973"

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_11
        targetCompatibility = JavaVersion.VERSION_11
        // flutter_local_notifications 要求 core library desugaring (Java 8+ API on Android <26)
        isCoreLibraryDesugaringEnabled = true
    }

    kotlinOptions {
        jvmTarget = JavaVersion.VERSION_11.toString()
        /* litertlm-android 0.17 是 Kotlin 2.4 编的, 本工程的 Kotlin 插件 2.1 只认到 2.2 的元数据。
         * 只影响编译期读元数据, 运行时字节码兼容 (升 Kotlin 插件会牵连一串 Flutter 插件, 不值得)。 */
        freeCompilerArgs += listOf("-Xskip-metadata-version-check")
    }

    defaultConfig {
        applicationId = "dev.neoxlabs.openneox"
        // 26 (Android 8.0): 本地大模型插件 llama_flutter_android 的下限 (之前 23 是 mobile_scanner 的)
        minSdk = 26
        targetSdk = flutter.targetSdkVersion
        versionCode = flutter.versionCode
        versionName = flutter.versionName
        if (hasFirebase) {
            resValue("string", "google_app_id", firebase("appId"))
            resValue("string", "gcm_defaultSenderId", firebase("senderId"))
            resValue("string", "google_api_key", firebase("apiKey"))
            resValue("string", "project_id", firebase("projectId"))
            resValue("string", "google_storage_bucket", firebase("storageBucket"))
        }
    }

    /* 原生库解压到 nativeLibraryDir: LiteRT-LM 的 NPU 后端按目录路径去 dlopen 联发科调度库
     * (jniLibs/arm64-v8a/libLiteRtDispatch_MediaTek.so, 自己用 Bazel 从 LiteRT 源码编的, AAR 里没有);
     * 默认不解压时那个目录是空的, NPU 永远起不来。 */
    packaging {
        jniLibs { useLegacyPackaging = true }
    }

    signingConfigs {
        if (hasReleaseKeystore) {
            create("release") {
                storeFile = file(keystoreProperties["storeFile"] as String)
                storePassword = keystoreProperties["storePassword"] as String
                keyAlias = keystoreProperties["keyAlias"] as String
                keyPassword = keystoreProperties["keyPassword"] as String
            }
        }
    }

    buildTypes {
        release {
            signingConfig = if (hasReleaseKeystore) {
                signingConfigs.getByName("release")
            } else {
                // 开发机没配 keystore — 回落 debug 让 flutter run --release 可用.
                // 发布产物必须配 key.properties, 见上方注释.
                signingConfigs.getByName("debug")
            }
            // 侧装开关 — `-PneoxAppIdSuffix=.rel` 让 release 包换个 applicationId,
            // 跟机器上已装的 debug 包并存。用途: debug 是 debug 签名, release 是真
            // keystore 签名, 两者签名不同 **无法互相覆盖安装** (INSTALL_FAILED_UPDATE_
            // INCOMPATIBLE), 想验真包就得先卸载 debug —— 那会清掉配对关系和本地会话。
            // 加个后缀就能两个都留着。默认空串 = 对发行产物零影响。
            val appIdSuffix = (project.findProperty("neoxAppIdSuffix") as String?).orEmpty()
            if (appIdSuffix.isNotEmpty()) {
                applicationIdSuffix = appIdSuffix
                println("[neox] release applicationId 加后缀 '$appIdSuffix' (侧装测试包)")
                /* Firebase 按包名认 App: 带后缀的包是另一个登记 */
                val suffixedAppId = firebase("appId$appIdSuffix")
                if (hasFirebase && suffixedAppId.isNotEmpty()) resValue("string", "google_app_id", suffixedAppId)
            }
            // 发行包只带 arm64 (2026-09-30): 本地语音 (onnxruntime) 和本地大模型 (llama.cpp) 的原生库
            // 每个 ABI 一份, 四个 ABI 全带时安装包从 111MB 涨到 228MB, 其中 x86/x86_64/32 位 ARM
            // 占了 145MB —— 这几种手机今天基本不存在, 而本地大模型插件本来就只有 arm64。
            // debug 不限, 模拟器 (x86_64) 照常跑。
            ndk { abiFilters.clear(); abiFilters.add("arm64-v8a") }
            // Flutter release 默认开 R8 — 明确声明并挂混淆规则 (插件反射保护)
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro",
            )
        }
    }
}

dependencies {
    // core library desugaring runtime — flutter_local_notifications 要
    coreLibraryDesugaring("com.android.tools:desugar_jdk_libs:2.1.4")
    // 本机大模型第二引擎 (GPU / NPU), 见 LiteRtLmBridge.kt
    implementation("com.google.ai.edge.litertlm:litertlm-android:0.17.1")
    // FCM 推送: App 被杀 / 锁屏时把 Pilot 来电和急事送到 (NeoxPushService.kt)
    implementation("com.google.firebase:firebase-messaging:24.1.1")
    // 原生层单测 (PayGuard 动钱闸 / ScreenshotCache 清理), 只跑 JVM: ./gradlew :app:testDebugUnitTest
    testImplementation("junit:junit:4.13.2")
}

flutter {
    source = "../.."
}
