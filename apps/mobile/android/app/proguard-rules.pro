# Neox mobile — R8/ProGuard 规则
# Flutter 引擎/嵌入层自身的规则由 Flutter Gradle 插件注入, 这里只补插件反射面.

# flutter_local_notifications — 通知回调走反射
-keep class com.dexterous.** { *; }

# drift/sqlite3 native bindings
-keep class org.sqlite.** { *; }

# flutter_secure_storage — Tink 加密 (Android EncryptedSharedPreferences)
-keep class com.google.crypto.tink.** { *; }

# mobile_scanner → ML Kit barcode
-keep class com.google.mlkit.** { *; }
-dontwarn com.google.mlkit.**

# Gson 泛型 (若被传递依赖引入)
-keepattributes Signature
-keepattributes *Annotation*

# Play Core 缺失类 (Flutter deferred components 未启用时的误报)
-dontwarn com.google.android.play.core.**

# llama_flutter_android — 本地大模型 (JNI + Pigeon 回调走反射)
-keep class com.write4me.llama_flutter_android.** { *; }
# LiteRT-LM — 原生层回调 Kotlin 类 (JNI 按名字找), BenchmarkInfo 走反射
-keep class com.google.ai.edge.litertlm.** { *; }
-keep class com.google.ai.edge.litert.** { *; }
-dontwarn com.google.ai.edge.**
-keep class kotlin.jvm.functions.Function1
-keepclassmembers class * implements kotlin.jvm.functions.Function1 {
    public java.lang.Object invoke(java.lang.Object);
}
-keepclasseswithmembernames class * {
    native <methods>;
}
