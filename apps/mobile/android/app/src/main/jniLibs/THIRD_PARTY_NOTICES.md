# jniLibs 里的第三方程序 (本地 Linux / 「完全体」, 2026-10-12)

这几个文件取自 Termux 官方软件源 (packages.termux.dev, termux-main, aarch64), 下载后按 sha256 校验:

| 文件 | 来源包 | 许可 | 源码 |
|---|---|---|---|
| arm64-v8a/libproot.so | proot 5.1.107.96 (`usr/bin/proot`) | GPL-2.0 | https://github.com/termux/proot |
| arm64-v8a/libproot-loader.so | proot 5.1.107.96 (`usr/libexec/proot/loader`) | GPL-2.0 | https://github.com/termux/proot |
| arm64-v8a/libtalloc2.so | libtalloc 2.5.0 | LGPL-3.0 | https://www.samba.org/ftp/talloc/ |
| arm64-v8a/libandroid-shmem.so | libandroid-shmem 0.7 | BSD-3-Clause | https://github.com/termux/libandroid-shmem |

唯一的改动: `libproot.so` 的依赖名 `libtalloc.so.2` 被同长度改成 `libtalloc2.so`
(APK 只解出 `lib*.so` 这种名字的文件)。proot 作为独立程序被调用, 不链接进 Neox 自己的代码。
按 GPL-2.0 第 3 条, 上面的源码地址即对应源码; 有需要可向我们索取同版本源码。

运行时下载的 Alpine Linux (minirootfs 3.24.2 + apk 软件包) 各自遵循其许可, 不随 APK 分发。
