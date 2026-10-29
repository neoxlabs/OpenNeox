#!/bin/bash
# 自动下载 Microsoft Java Debug 预构建 JAR

set -e

echo "📦 开始下载 Microsoft Java Debug (预构建版本)..."

SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
PROJECT_ROOT="$SCRIPT_DIR/.."
RESOURCES_DIR="$PROJECT_ROOT/resources/java-debug"

echo "📂 项目目录: $PROJECT_ROOT"
echo "📂 资源目录: $RESOURCES_DIR"

# 创建资源目录
mkdir -p "$RESOURCES_DIR"

# Microsoft Java Debug 最新稳定版本
# 注意：这个 JAR 是从 VS Code Java Debug Extension 中提取的
GITHUB_RELEASE_URL="https://github.com/microsoft/vscode-java-debug/releases/latest/download/com.microsoft.java.debug.plugin.jar"

# 备用 URL（如果上面的不可用）
ALTERNATIVE_URL="https://repo1.maven.org/maven2/com/microsoft/java/com.microsoft.java.debug.plugin/0.53.1/com.microsoft.java.debug.plugin-0.53.1.jar"

DEST_JAR="$RESOURCES_DIR/com.microsoft.java.debug.plugin.jar"

# 尝试下载
echo "🔽 正在下载..."
if curl -L -f -o "$DEST_JAR" "$GITHUB_RELEASE_URL" 2>/dev/null; then
    echo "✅ 从 GitHub Releases 下载成功"
elif curl -L -f -o "$DEST_JAR" "$ALTERNATIVE_URL" 2>/dev/null; then
    echo "✅ 从 Maven Central 下载成功"
else
    echo "❌ 下载失败"
    echo ""
    echo "请手动下载 JAR 文件："
    echo "1. 访问: https://github.com/microsoft/vscode-java-debug/releases"
    echo "2. 下载最新版本的 com.microsoft.java.debug.plugin.jar"
    echo "3. 将文件放置到: $RESOURCES_DIR/"
    exit 1
fi

# 验证文件
if [ ! -f "$DEST_JAR" ]; then
    echo "❌ JAR 文件不存在"
    exit 1
fi

# 获取文件大小
if command -v du &> /dev/null; then
    SIZE=$(du -h "$DEST_JAR" | cut -f1)
    echo "📊 文件大小: $SIZE"
fi

# 验证是否为有效的 JAR 文件
if command -v file &> /dev/null; then
    FILE_TYPE=$(file "$DEST_JAR")
    if [[ $FILE_TYPE == *"Zip archive"* ]] || [[ $FILE_TYPE == *"Java"* ]]; then
        echo "✅ JAR 文件有效"
    else
        echo "⚠️  警告: 文件可能不是有效的 JAR"
    fi
fi

# 创建 README
cat > "$RESOURCES_DIR/README.md" << EOF
# Microsoft Java Debug Plugin

这个目录包含 Microsoft Java Debug Plugin 的 JAR 文件。

## 版本信息

- 下载时间: $(date)
- 来源: GitHub Releases / Maven Central

## 许可证

Java Debug Plugin 使用 Eclipse Public License 1.0 许可。
详情: https://github.com/microsoft/java-debug/blob/main/LICENSE.txt

## 更新

要更新此 JAR，运行：
\`\`\`bash
npm run setup-java-debug
\`\`\`

或手动下载：
- GitHub: https://github.com/microsoft/vscode-java-debug/releases
- Maven: https://repo1.maven.org/maven2/com/microsoft/java/com.microsoft.java.debug.plugin/
EOF

echo ""
echo "✅ 完成！Microsoft Java Debug 已集成到项目中"
echo "📄 JAR 文件: $DEST_JAR"
echo ""
echo "下一步："
echo "1. 运行 npm run build 重新打包"
echo "2. Java Debug 工具将自动使用内置的 JAR"
