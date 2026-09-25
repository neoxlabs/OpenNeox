/**
 * Java Debug Utilities - Helper functions for Java Debug Tools
 */

import * as path from 'path';
import * as fs from 'fs/promises';
import { fileURLToPath } from 'url';

// Get __dirname equivalent in ES modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Get the bundled Java Debug JAR path
 * Automatically detects JAR in development or production environment
 */
export async function getBundledJavaDebugJar(): Promise<string | null> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const electronProcess = process as any;
  const possiblePaths = [
    // Production: Electron app resources (only available in Electron)
    ...(electronProcess.resourcesPath
      ? [path.join(electronProcess.resourcesPath, 'java-debug', 'com.microsoft.java.debug.plugin.jar')]
      : []
    ),

    // Development: project resources directory
    path.join(process.cwd(), 'resources', 'java-debug', 'com.microsoft.java.debug.plugin.jar'),

    // Alternative development path (relative to this file)
    path.join(__dirname, '..', '..', '..', 'resources', 'java-debug', 'com.microsoft.java.debug.plugin.jar'),
  ];

  for (const jarPath of possiblePaths) {
    try {
      await fs.access(jarPath);
      console.log(`✓ 找到内置 Java Debug JAR: ${jarPath}`);
      return jarPath;
    } catch {
      // Try next path
    }
  }

  return null;
}

/**
 * Get Java Debug JAR path from config or bundled version
 */
export async function getJavaDebugJarPath(configPath?: string): Promise<string> {
  // Priority 1: User configured path
  if (configPath) {
    try {
      await fs.access(configPath);
      console.log(`✓ 使用配置的 Java Debug JAR: ${configPath}`);
      return configPath;
    } catch (error) {
      console.warn(`⚠️  配置的 JAR 路径无效: ${configPath}`);
    }
  }

  // Priority 2: Bundled JAR
  const bundledJar = await getBundledJavaDebugJar();
  if (bundledJar) {
    return bundledJar;
  }

  // Not found
  throw new Error(
    'Java Debug JAR 未找到！\n' +
    '请执行以下步骤之一：\n' +
    '1. 运行 npm run setup-java-debug 自动下载\n' +
    '2. 在配置中指定 JAR 路径\n' +
    '3. 手动下载并编译：https://github.com/microsoft/java-debug'
  );
}

/**
 * Check if Java is available
 */
export async function checkJavaAvailable(): Promise<{ available: boolean; version?: string; path?: string }> {
  const { exec } = await import('child_process');
  const { promisify } = await import('util');
  const execAsync = promisify(exec);

  try {
    // java -version outputs to stderr; capture both streams
    const { stdout, stderr } = await execAsync('java -version', {
      env: process.env,
    });
    const output = stderr || stdout;
    const versionMatch = output.match(/(?:java|openjdk) version "(.+?)"/i);
    const version = versionMatch ? versionMatch[1] : 'unknown';

    // Read JAVA_HOME directly from env instead of shelling out
    const javaPath = process.env.JAVA_HOME || undefined;

    return {
      available: true,
      version,
      path: javaPath,
    };
  } catch (error) {
    return { available: false };
  }
}

/**
 * Get Java Debug status information
 */
export async function getJavaDebugStatus(): Promise<{
  javaAvailable: boolean;
  javaVersion?: string;
  jarFound: boolean;
  jarPath?: string;
  ready: boolean;
}> {
  const javaStatus = await checkJavaAvailable();
  const jarPath = await getBundledJavaDebugJar();

  return {
    javaAvailable: javaStatus.available,
    javaVersion: javaStatus.version,
    jarFound: !!jarPath,
    jarPath: jarPath || undefined,
    ready: javaStatus.available && !!jarPath,
  };
}
