package com.mkco.neox.mobile

import android.app.Activity
import android.content.Context
import io.flutter.plugin.common.BinaryMessenger
import io.flutter.plugin.common.MethodChannel
import java.io.BufferedInputStream
import java.io.File
import java.io.FileOutputStream
import java.io.InputStream
import java.net.HttpURLConnection
import java.net.URL
import java.nio.file.Files
import java.nio.file.Paths
import java.security.MessageDigest
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.zip.GZIPInputStream

/**
 * 手机里的 Linux (「完全体」, 2026-10-12)。
 *
 * 用户: 「安卓本质上就类 Linux 系统, 你应该该支持的就能支持才对…我们就要最强」「让用户手动补全, 跟用户说大概占 100 兆」。
 *
 * 怎么跑起来的:
 *   · proot (Termux 打过安卓补丁的那份, GPL-2.0) 跟 talloc / android-shmem 一起放在 APK 的 jniLibs 里 ——
 *     安卓 10 起 App 不能 exec 自己数据目录里的文件 (W^X), 只有 APK 解出来的 nativeLibraryDir 能 exec。
 *     proot 依赖名 libtalloc.so.2 被改成 libtalloc2.so (同长度改字节), 因为 APK 只解 lib*.so 这种名字。
 *   · 系统盘: Alpine minirootfs (4MB, 固定版本 + sha256), 下载后在这里解 tar (Java 自己解, 不靠系统 tar)。
 *     proot 的 loader 去 mmap 数据目录里的程序 —— 安卓只禁 exec 不禁 mmap, 所以 Python / Node 都跑得起来。
 *   · 装好基础包 (python3 / pip / bash / git / curl / openpyxl …) 约 100MB; 别的 Agent 用 apk add 自己装。
 *   · Agent 的工作区挂到 /workspace, 在 Linux 里生成的文件 Neox 这边直接能拿到。
 *
 * 只在用户点了「补全」才下载; 不点就什么都不占。
 */
class LinuxEnv(private val activity: Activity, messenger: BinaryMessenger) {
    private val ctx: Context = activity.applicationContext
    private val io = Executors.newCachedThreadPool()

    private val root get() = File(ctx.filesDir, "linux")
    private val rootfs get() = File(root, "rootfs")
    private val marker get() = File(root, "installed.v1")
    private val nativeDir get() = ctx.applicationInfo.nativeLibraryDir

    /* 安装进度 (Dart 轮询) */
    @Volatile private var phase = "idle" // idle | downloading | extracting | packages | done | error
    @Volatile private var percent = 0
    @Volatile private var error: String? = null
    private val log = ArrayDeque<String>()

    init {
        MethodChannel(messenger, "neox.phone/linux").setMethodCallHandler { call, result ->
            when (call.method) {
                "status" -> result.success(status())
                "install" -> { startInstall(call.argument<List<String>>("packages").orEmpty()); result.success(true) }
                /* 已装好的再加装 (老用户补 Node.js 用): 不重下系统, 只 apk add */
                "add" -> { startAdd(call.argument<List<String>>("packages").orEmpty()); result.success(true) }
                "exec" -> io.execute {
                    val out = runCatching {
                        exec(
                            call.argument<String>("command") ?: "",
                            call.argument<String>("workspace"),
                            ((call.argument<Number>("timeoutSec")) ?: 120).toLong(),
                        )
                    }.getOrElse { mapOf("error" to (it.message ?: it.javaClass.simpleName)) }
                    activity.runOnUiThread { result.success(out) }
                }
                "uninstall" -> io.execute {
                    val ok = runCatching { deleteTree(root); true }.getOrDefault(false)
                    phase = "idle"; percent = 0; error = null
                    activity.runOnUiThread { result.success(ok) }
                }
                else -> result.notImplemented()
            }
        }
    }

    private fun status(): Map<String, Any?> = mapOf(
        "installed" to marker.exists(),
        "phase" to phase,
        "percent" to percent,
        "error" to error,
        "log" to synchronized(log) { log.joinToString("\n") },
        "bytes" to if (marker.exists()) (marker.readText().trim().toLongOrNull() ?: 0L) else 0L,
        "supported" to File(nativeDir, "libproot.so").exists(),
        /* 装了哪些 —— 设置页按它显示「Python ✓ Node.js ✓」, 缺的给加装按钮 */
        "tools" to mapOf(
            "python" to File(rootfs, "usr/bin/python3").exists(),
            "node" to File(rootfs, "usr/bin/node").exists(),
            "git" to File(rootfs, "usr/bin/git").exists(),
        ),
    )

    private fun startAdd(pkgs: List<String>) {
        if (phase in setOf("downloading", "extracting", "packages") || !marker.exists() || pkgs.isEmpty()) return
        phase = "packages"; percent = 0; error = null
        synchronized(log) { log.clear() }
        io.execute {
            try {
                say("安装 ${pkgs.joinToString(" ")}")
                val r = exec("apk add --no-cache ${pkgs.joinToString(" ")}", null, 1800, onLine = { line ->
                    say(line)
                    Regex("""^\((\d+)/(\d+)\)""").find(line)?.let { m ->
                        percent = (m.groupValues[1].toInt() * 100 / m.groupValues[2].toInt().coerceAtLeast(1))
                    }
                })
                if (r["exitCode"] != 0) throw IllegalStateException("装软件包失败: ${(r["stderr"] as? String).orEmpty().takeLast(300)}")
                marker.writeText(dirSize(rootfs).toString())
                phase = "done"; percent = 100
                say("装好了")
            } catch (e: Throwable) {
                phase = "error"; error = e.message ?: e.javaClass.simpleName
                say("出错: $error")
            }
        }
    }

    private fun say(line: String) = synchronized(log) { log.addLast(line.take(300)); while (log.size > 40) log.removeFirst() }

    // ───────────────────────── 安装 ─────────────────────────

    private fun startInstall(extra: List<String>) {
        if (phase in setOf("downloading", "extracting", "packages")) return
        phase = "downloading"; percent = 0; error = null
        synchronized(log) { log.clear() }
        io.execute {
            try {
                if (!File(nativeDir, "libproot.so").exists()) throw IllegalStateException("这台手机的 CPU 架构不支持 (只支持 arm64)")
                deleteTree(root)
                rootfs.mkdirs()
                /* 1. 系统盘 */
                val tgz = File(ctx.cacheDir, "alpine-rootfs.tar.gz")
                val mirror = download(tgz)
                /* 2. 解开 */
                phase = "extracting"; percent = 0
                say("解压系统…")
                untarGz(tgz, rootfs)
                tgz.delete()
                configure(mirror)
                /* 3. 基础包 */
                phase = "packages"; percent = 0
                val pkgs = (BASE_PACKAGES + extra).distinct()
                say("安装 ${pkgs.joinToString(" ")}")
                val r = exec("apk update && apk add --no-cache ${pkgs.joinToString(" ")}", null, 1800, onLine = { line ->
                    say(line)
                    /* apk 的进度行「(12/58) Installing …」 */
                    Regex("""^\((\d+)/(\d+)\)""").find(line)?.let { m ->
                        percent = (m.groupValues[1].toInt() * 100 / m.groupValues[2].toInt().coerceAtLeast(1))
                    }
                })
                if (r["exitCode"] != 0) throw IllegalStateException("装软件包失败: ${(r["stderr"] as? String).orEmpty().takeLast(300)}")
                /* 4. 办公三件套的 Python 库 (纯 Python, 共约 6MB): 以前要 Agent 现场 pip, 用户看着一串红色失败
                 * (2026-10-16)。装不上不算失败 —— 工具包本身能用, Agent 缺了再自己装 (pip.conf 已配镜像 + break-system-packages) */
                say("安装 ${PIP_PACKAGES.joinToString(" ")}")
                exec("pip install --no-cache-dir ${PIP_PACKAGES.joinToString(" ")}", null, 600, onLine = { say(it) })
                marker.writeText(dirSize(rootfs).toString())
                phase = "done"; percent = 100
                say("装好了")
            } catch (e: Throwable) {
                phase = "error"; error = e.message ?: e.javaClass.simpleName
                say("出错: $error")
            }
        }
    }

    /** 挨个镜像试 (国内先阿里云, 再官方 CDN), 校验 sha256; 返回用上的镜像 (后面 apk 也用它) */
    private fun download(dst: File): String {
        var last: Throwable? = null
        for (m in MIRRORS) {
            try {
                say("下载系统 ($m)…")
                val c = URL("$m/v$ALPINE_BRANCH/releases/aarch64/$ROOTFS_FILE").openConnection() as HttpURLConnection
                c.connectTimeout = 8000; c.readTimeout = 20000
                val total = c.contentLengthLong
                val md = MessageDigest.getInstance("SHA-256")
                c.inputStream.use { inp ->
                    FileOutputStream(dst).use { out ->
                        val buf = ByteArray(64 * 1024); var n: Int; var got = 0L
                        while (inp.read(buf).also { n = it } > 0) {
                            out.write(buf, 0, n); md.update(buf, 0, n); got += n
                            if (total > 0) percent = (got * 100 / total).toInt()
                        }
                    }
                }
                val sha = md.digest().joinToString("") { "%02x".format(it) }
                if (sha != ROOTFS_SHA256) throw IllegalStateException("校验不对 ($sha)")
                return m
            } catch (e: Throwable) { last = e; say("$m 不行: ${e.message}") }
        }
        throw IllegalStateException("系统下载失败: ${last?.message}")
    }

    private fun configure(mirror: String) {
        File(rootfs, "etc/resolv.conf").writeText("nameserver 223.5.5.5\nnameserver 119.29.29.29\nnameserver 8.8.8.8\n")
        File(rootfs, "etc/hosts").writeText("127.0.0.1 localhost\n::1 localhost\n")
        File(rootfs, "etc/apk/repositories").writeText("$mirror/v$ALPINE_BRANCH/main\n$mirror/v$ALPINE_BRANCH/community\n")
        File(rootfs, "workspace").mkdirs()
        File(rootfs, "root").mkdirs()
        /* 让 pip 能直接装 (Alpine 默认按 PEP 668 拒绝往系统 Python 里装) */
        File(rootfs, "etc/pip.conf").writeText("[global]\nbreak-system-packages = true\nindex-url = https://mirrors.aliyun.com/pypi/simple/\n")
        File(rootfs, "root/.npmrc").writeText("registry=https://registry.npmmirror.com\n")
    }

    // ───────────────────────── 执行 ─────────────────────────

    /**
     * 在 Linux 里跑一条命令 (sh -lc)。工作区挂在 /workspace, 当前目录就是它。
     * 输出各留最后 30000 字; 超时杀掉整个进程树 (proot --kill-on-exit)。
     */
    fun exec(command: String, workspace: String?, timeoutSec: Long, onLine: ((String) -> Unit)? = null): Map<String, Any?> {
        if (!rootfs.exists()) return mapOf("error" to "not_installed")
        val tmp = File(ctx.cacheDir, "proot-tmp").apply { mkdirs() }
        val args = mutableListOf(
            "$nativeDir/libproot.so",
            "--kill-on-exit", "--link2symlink", "--sysvipc", "-L", "-0",
            "-r", rootfs.absolutePath,
            "-b", "/dev", "-b", "/proc", "-b", "/sys",
            "-b", "/dev/urandom:/dev/random",
        )
        if (workspace != null && File(workspace).isDirectory) args += listOf("-b", "$workspace:/workspace")
        args += listOf(
            "-w", if (workspace != null) "/workspace" else "/root",
            /* env -i: 不把安卓的 LD_LIBRARY_PATH 等带进 Linux (里面的 musl 会去找安卓的 libc) */
            "/usr/bin/env", "-i",
            "HOME=/root", "USER=root", "TERM=xterm-256color", "LANG=C.UTF-8", "TMPDIR=/tmp",
            "PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
            "/bin/sh", "-lc", command,
        )
        val pb = ProcessBuilder(args)
        pb.environment().apply {
            put("PROOT_LOADER", "$nativeDir/libproot-loader.so")
            put("PROOT_TMP_DIR", tmp.absolutePath)
            put("LD_LIBRARY_PATH", nativeDir)
            remove("PROOT_LOADER_32")
        }
        val p = pb.start()
        p.outputStream.close()
        val out = StringBuilder(); val err = StringBuilder()
        val t1 = Thread { pump(p.inputStream, out, onLine) }.apply { start() }
        val t2 = Thread { pump(p.errorStream, err, onLine) }.apply { start() }
        val finished = p.waitFor(timeoutSec, TimeUnit.SECONDS)
        if (!finished) { p.destroyForcibly(); p.waitFor(5, TimeUnit.SECONDS) }
        t1.join(3000); t2.join(3000)
        return mapOf(
            "exitCode" to if (finished) p.exitValue() else -1,
            "stdout" to out.toString().takeLast(MAX_OUT),
            "stderr" to err.toString().takeLast(MAX_OUT),
            "timedOut" to !finished,
        )
    }

    private fun pump(s: InputStream, into: StringBuilder, onLine: ((String) -> Unit)?) {
        s.bufferedReader().useLines { lines ->
            for (l in lines) {
                synchronized(into) { into.append(l).append('\n'); if (into.length > MAX_OUT * 2) into.delete(0, into.length - MAX_OUT) }
                onLine?.invoke(l)
            }
        }
    }

    // ───────────────────────── tar ─────────────────────────

    /** 只认 Alpine minirootfs 里有的: 普通文件 / 目录 / 符号链接 / 硬链接, 带 GNU 长名和 pax path */
    private fun untarGz(src: File, dst: File) {
        val total = src.length().coerceAtLeast(1)
        val counted = CountingStream(BufferedInputStream(src.inputStream()))
        GZIPInputStream(counted).use { z ->
            val hdr = ByteArray(512)
            var longName: String? = null
            var longLink: String? = null
            while (true) {
                if (!readFully(z, hdr)) break
                if (hdr.all { it.toInt() == 0 }) break
                percent = (counted.count * 100 / total).toInt()
                var name = str(hdr, 0, 100)
                val prefix = str(hdr, 345, 155)
                if (prefix.isNotEmpty()) name = "$prefix/$name"
                val mode = oct(hdr, 100, 8).toInt()
                val size = oct(hdr, 124, 12)
                val type = hdr[156].toInt().toChar()
                var link = str(hdr, 157, 100)
                longName?.let { name = it; longName = null }
                longLink?.let { link = it; longLink = null }
                val data = if (type in "0\u0000LKx7" && size > 0) readBytesOrSkip(z, size, keep = type in "LKx") else null
                when (type) {
                    'L' -> { longName = String(data!!).trimEnd('\u0000'); continue }
                    'K' -> { longLink = String(data!!).trimEnd('\u0000'); continue }
                    'x' -> { paxPath(data!!)?.let { longName = it }; continue }
                    'g' -> { skip(z, size); continue }
                }
                /* 越界的条目不要。不用 canonicalPath: 它会顺着 rootfs 自己的符号链接 (/lib → /usr/lib 这种绝对链接)
                 * 解析到手机本身的目录, 把正常文件也判成越界 */
                val rel = name.removePrefix("./").trimStart('/')
                if (rel.isEmpty() || rel.split('/').any { it == ".." }) { if (type in "0\u00007") skip(z, size); continue }
                val out = File(dst, rel)
                when (type) {
                    '5' -> out.mkdirs()
                    '2' -> { out.parentFile?.mkdirs(); out.delete(); Files.createSymbolicLink(out.toPath(), Paths.get(link)) }
                    '1' -> {
                        out.parentFile?.mkdirs()
                        val target = File(dst, link.removePrefix("./"))
                        if (target.exists()) target.copyTo(out, overwrite = true)
                        out.setExecutable(target.canExecute(), false)
                    }
                    '0', '\u0000', '7' -> {
                        out.parentFile?.mkdirs()
                        FileOutputStream(out).use { o -> copyN(z, o, size) }
                        out.setReadable(true, false)
                        if (mode and 0b001_001_001 != 0) out.setExecutable(true, false)
                    }
                    else -> skip(z, size)
                }
                if (type in "0\u00007") skipPad(z, size)
            }
        }
    }

    private class CountingStream(inner: InputStream) : java.io.FilterInputStream(inner) {
        var count = 0L
        override fun read(): Int = super.read().also { if (it >= 0) count++ }
        override fun read(b: ByteArray, off: Int, len: Int): Int = super.read(b, off, len).also { if (it > 0) count += it }
    }

    private fun readFully(s: InputStream, b: ByteArray): Boolean {
        var off = 0
        while (off < b.size) { val n = s.read(b, off, b.size - off); if (n < 0) return off > 0 && false; off += n }
        return true
    }
    private fun str(b: ByteArray, off: Int, len: Int): String {
        var end = off; while (end < off + len && b[end].toInt() != 0) end++
        return String(b, off, end - off, Charsets.UTF_8)
    }
    private fun oct(b: ByteArray, off: Int, len: Int): Long = str(b, off, len).trim().ifEmpty { "0" }.toLong(8)
    private fun copyN(s: InputStream, o: java.io.OutputStream, n: Long) {
        val buf = ByteArray(64 * 1024); var left = n
        while (left > 0) { val r = s.read(buf, 0, minOf(buf.size.toLong(), left).toInt()); if (r < 0) break; o.write(buf, 0, r); left -= r }
    }
    /* OutputStream.nullOutputStream() 要 API 33, 我们最低 26 */
    private object Discard : java.io.OutputStream() {
        override fun write(b: Int) {}
        override fun write(b: ByteArray, off: Int, len: Int) {}
    }
    private fun skip(s: InputStream, n: Long) { copyN(s, Discard, n); skipPad(s, n) }
    private fun skipPad(s: InputStream, n: Long) { val pad = (512 - n % 512) % 512; copyN(s, Discard, pad) }
    private fun readBytesOrSkip(s: InputStream, n: Long, keep: Boolean): ByteArray? {
        if (!keep) return null
        val b = ByteArray(n.toInt()); var off = 0
        while (off < b.size) { val r = s.read(b, off, b.size - off); if (r < 0) break; off += r }
        skipPad(s, n)
        return b
    }
    private fun paxPath(b: ByteArray): String? =
        String(b, Charsets.UTF_8).lineSequence().mapNotNull { Regex("""^\d+ path=(.*)$""").find(it)?.groupValues?.get(1) }.firstOrNull()

    // ───────────────────────── 杂项 ─────────────────────────

    /** 删整棵树, 不跟着符号链接走 (rootfs 里 /proc 之类可能是指向外面的链接) */
    private fun deleteTree(f: File) {
        if (!f.exists() && !Files.isSymbolicLink(f.toPath())) return
        if (f.isDirectory && !Files.isSymbolicLink(f.toPath())) f.listFiles()?.forEach { deleteTree(it) }
        f.delete()
    }

    private fun dirSize(f: File): Long {
        if (Files.isSymbolicLink(f.toPath())) return 0
        if (f.isFile) return f.length()
        return f.listFiles()?.sumOf { dirSize(it) } ?: 0
    }

    companion object {
        private const val ALPINE_BRANCH = "3.24"
        private const val ROOTFS_FILE = "alpine-minirootfs-3.24.2-aarch64.tar.gz"
        private const val ROOTFS_SHA256 = "9bf70a7f18ea44094cbb5f70c58f9af129c8214745743db0e68e5502cc2ce773"
        private val MIRRORS = listOf("https://mirrors.aliyun.com/alpine", "https://dl-cdn.alpinelinux.org/alpine")
        /* 基础包 (装好约 95MB): Python / 联网 / 版本管理。表格、图表、音视频这些 Agent 要用时自己装。
         * 不放 py3-openpyxl: Alpine 的这个包连带 pandas + numpy (107MB, 第一版装完 201MB);
         * 要读写 Excel 时 pip install openpyxl (纯 Python 4MB) */
        /* 2026-10-12 加 Node.js + npm (+78MB, 实测装完约 200MB): 用户「里面 nodejs 等都没有」, 编码模式在手机上跑要它。
         * Java 装不了: HotSpot 启动要一页同时可写可执行的内存, targetSdk 29+ 的 App 被 SELinux 拒
         * (Failed to mark memory page as executable) —— Termux 能跑是因为它停在 targetSdk 28。 */
        private val BASE_PACKAGES = listOf(
            "bash", "coreutils", "curl", "git", "ca-certificates", "tzdata",
            "python3", "py3-pip", "py3-requests", "py3-pillow",
            "nodejs", "npm",
            /* 2026-10-16: 手机发来的压缩包 / 扫描 PDF 转图 最常用, 都很小 (合计约 8MB); lxml 给 python-docx / pptx 用 */
            "zip", "unzip", "file", "poppler-utils", "py3-lxml",
        )
        private val PIP_PACKAGES = listOf("openpyxl", "python-docx", "python-pptx")
        private const val MAX_OUT = 30000
    }
}
