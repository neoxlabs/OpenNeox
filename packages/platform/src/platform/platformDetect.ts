/**
 * Platform Detection Utilities
 *
 * Provides unified platform detection including WSL (Windows Subsystem for Linux).
 * WSL runs as Linux but needs special handling for Windows interop features.
 */

import fs from 'fs';
import os from 'os';

// ============================================================================
// Cache for expensive checks
// ============================================================================

let _isWSL: boolean | null = null;
let _wslVersion: 1 | 2 | null = null;

// ============================================================================
// Core Detection Functions
// ============================================================================

/**
 * Check if running in WSL (Windows Subsystem for Linux)
 *
 * Detection methods:
 * 1. Environment variables (fastest)
 * 2. /proc/version contains "microsoft" or "WSL"
 * 3. /proc/sys/fs/binfmt_misc/WSLInterop exists
 */
export function isWSL(): boolean {
  if (_isWSL !== null) return _isWSL;

  // Only check on Linux - WSL reports as Linux
  if (process.platform !== 'linux') {
    _isWSL = false;
    return false;
  }

  // Method 1: Check environment variables (fastest)
  if (process.env.WSL_DISTRO_NAME || process.env.WSLENV || process.env.WSL_INTEROP) {
    _isWSL = true;
    return true;
  }

  // Method 2: Check /proc/version
  try {
    const version = fs.readFileSync('/proc/version', 'utf-8').toLowerCase();
    if (version.includes('microsoft') || version.includes('wsl')) {
      _isWSL = true;
      return true;
    }
  } catch {
    // File not readable, continue to next method
  }

  // Method 3: Check WSL interop file
  try {
    if (fs.existsSync('/proc/sys/fs/binfmt_misc/WSLInterop')) {
      _isWSL = true;
      return true;
    }
  } catch {
    // Not accessible
  }

  _isWSL = false;
  return false;
}

/**
 * Get WSL version (1 or 2)
 * Returns null if not running in WSL
 */
export function getWSLVersion(): 1 | 2 | null {
  if (!isWSL()) return null;
  if (_wslVersion !== null) return _wslVersion;

  // WSL2 uses a real Linux kernel, check for Hyper-V
  try {
    const version = fs.readFileSync('/proc/version', 'utf-8').toLowerCase();
    // WSL2 typically has "microsoft-standard-WSL2" in version
    if (version.includes('wsl2') || version.includes('microsoft-standard')) {
      _wslVersion = 2;
    } else {
      _wslVersion = 1;
    }
  } catch {
    // Default to WSL1 if can't determine
    _wslVersion = 1;
  }

  return _wslVersion;
}

/**
 * Check if running on Windows (native, not WSL)
 */
export function isWindows(): boolean {
  return process.platform === 'win32';
}

/**
 * Check if running on macOS
 */
export function isMac(): boolean {
  return process.platform === 'darwin';
}

/**
 * Check if running on native Linux (not WSL)
 */
export function isLinux(): boolean {
  return process.platform === 'linux' && !isWSL();
}

/**
 * Check if running on any Linux environment (including WSL)
 */
export function isLinuxLike(): boolean {
  return process.platform === 'linux';
}

// ============================================================================
// Platform-specific Paths
// ============================================================================

/**
 * Get Windows user home directory from WSL
 * Returns null if not in WSL or can't determine
 */
export function getWindowsHomeFromWSL(): string | null {
  if (!isWSL()) return null;

  // Try USERPROFILE first (if WSLENV includes it)
  if (process.env.USERPROFILE) {
    return windowsToWslPath(process.env.USERPROFILE);
  }

  // Try common Windows user paths
  const username = process.env.WSL_USER || process.env.USER;
  if (username) {
    const possiblePaths = [
      `/mnt/c/Users/${username}`,
      `/mnt/d/Users/${username}`,
    ];
    for (const p of possiblePaths) {
      try {
        if (fs.existsSync(p)) return p;
      } catch {
        continue;
      }
    }
  }

  return null;
}

/**
 * Convert Windows path to WSL path
 * e.g., "C:\Users\name" -> "/mnt/c/Users/name"
 */
export function windowsToWslPath(windowsPath: string): string {
  if (!windowsPath) return windowsPath;

  // Already a Unix path
  if (windowsPath.startsWith('/')) return windowsPath;

  // Handle drive letter (C:\... or C:/...)
  const match = windowsPath.match(/^([a-zA-Z]):[\\\/](.*)$/);
  if (match) {
    const drive = match[1].toLowerCase();
    const rest = match[2].replace(/\\/g, '/');
    return `/mnt/${drive}/${rest}`;
  }

  // UNC path (\\server\share) - not fully supported
  if (windowsPath.startsWith('\\\\')) {
    return windowsPath; // Return as-is, may need special handling
  }

  return windowsPath;
}

/**
 * Convert WSL path to Windows path
 * e.g., "/mnt/c/Users/name" -> "C:\Users\name"
 * e.g., "/tmp/file.png" -> "\\wsl$\Ubuntu\tmp\file.png" (for WSL internal paths)
 */
export function wslToWindowsPath(wslPath: string): string {
  if (!wslPath) return wslPath;

  // Handle /mnt/X/... paths (Windows drives mounted in WSL)
  const match = wslPath.match(/^\/mnt\/([a-zA-Z])\/(.*)$/);
  if (match) {
    const drive = match[1].toUpperCase();
    const rest = match[2].replace(/\//g, '\\');
    return `${drive}:\\${rest}`;
  }

  // WSL internal paths (like /tmp, /home/user) - use \\wsl$\ UNC path
  // This allows Windows programs to access WSL filesystem
  const distroName = process.env.WSL_DISTRO_NAME || 'Ubuntu';
  const windowsPath = wslPath.replace(/\//g, '\\');
  return `\\\\wsl$\\${distroName}${windowsPath}`;
}

// ============================================================================
// Windows Interop Helpers
// ============================================================================

/**
 * Get the command to run a Windows executable from WSL
 * Handles .exe suffix and path conversion
 */
export function getWindowsCommand(command: string): string {
  if (!isWSL()) return command;

  // Common Windows commands that need .exe suffix
  const windowsCommands: Record<string, string> = {
    'powershell': 'powershell.exe',
    'cmd': 'cmd.exe',
    'explorer': 'explorer.exe',
    'clip': 'clip.exe',
    'notepad': 'notepad.exe',
    'code': 'code.exe',
  };

  return windowsCommands[command] || command;
}

/**
 * Check if Windows interop is enabled in WSL
 */
export function isWindowsInteropEnabled(): boolean {
  if (!isWSL()) return false;

  try {
    // Check if we can access Windows executables
    return fs.existsSync('/mnt/c/Windows/System32/cmd.exe');
  } catch {
    return false;
  }
}

// ============================================================================
// Unified Platform Info
// ============================================================================

export interface PlatformInfo {
  /** Raw Node.js platform */
  platform: NodeJS.Platform;
  /** Architecture */
  arch: string;
  /** Is running in WSL */
  isWSL: boolean;
  /** WSL version (1 or 2) if applicable */
  wslVersion: 1 | 2 | null;
  /** Effective platform for feature decisions */
  effectivePlatform: 'windows' | 'mac' | 'linux' | 'wsl';
  /** Home directory */
  homeDir: string;
  /** Windows home directory (if in WSL) */
  windowsHomeDir: string | null;
}

/**
 * Get comprehensive platform information
 */
export function getPlatformInfo(): PlatformInfo {
  const wsl = isWSL();

  let effectivePlatform: PlatformInfo['effectivePlatform'];
  if (wsl) {
    effectivePlatform = 'wsl';
  } else if (isWindows()) {
    effectivePlatform = 'windows';
  } else if (isMac()) {
    effectivePlatform = 'mac';
  } else {
    effectivePlatform = 'linux';
  }

  return {
    platform: process.platform,
    arch: process.arch,
    isWSL: wsl,
    wslVersion: getWSLVersion(),
    effectivePlatform,
    homeDir: os.homedir(),
    windowsHomeDir: getWindowsHomeFromWSL(),
  };
}

// ============================================================================
// Reset cache (for testing)
// ============================================================================

export function _resetCache(): void {
  _isWSL = null;
  _wslVersion = null;
}
