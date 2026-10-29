/**
 * Clipboard Image Utilities
 *
 * Handles reading image data from system clipboard on macOS/Windows/Linux/WSL
 *
 * Key insight: When user pastes an image via Cmd+V, terminal receives empty
 * bracketed paste sequence. We detect this and check clipboard for images.
 *
 * WSL Support: WSL runs as Linux but needs to access Windows clipboard via
 * powershell.exe for clipboard operations.
 */

import { execSync, spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { cliLogger } from '@neoxlabs/kernel/platform/cliLogger.js';
import { isWSL, wslToWindowsPath } from '@neoxlabs/platform/platform/platformDetect.js';

// Cache the Swift tool path
let swiftToolPath: string | null = null;
let swiftToolCompiled = false;

/**
 * Compile Swift clipboard tool on first use (macOS only)
 */
function ensureSwiftTool(): string | null {
  if (process.platform !== 'darwin') return null;
  if (swiftToolCompiled) return swiftToolPath;
  
  swiftToolCompiled = true;
  const toolPath = path.join(os.tmpdir(), 'neox-clipboard-tool');
  
  // Check if already exists
  if (fs.existsSync(toolPath)) {
    swiftToolPath = toolPath;
    return toolPath;
  }
  
  const swiftCode = `
import Cocoa
let pb = NSPasteboard.general
if let image = pb.readObjects(forClasses: [NSImage.self], options: nil)?.first as? NSImage {
    if let tiffData = image.tiffRepresentation,
       let bitmap = NSBitmapImageRep(data: tiffData),
       let pngData = bitmap.representation(using: .png, properties: [:]) {
        let outputPath = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : "/tmp/clipboard.png"
        let url = URL(fileURLWithPath: outputPath)
        do {
            try pngData.write(to: url)
            print("OK")
        } catch {
            exit(1)
        }
    } else {
        exit(1)
    }
} else {
    exit(1)
}
`;
  
  const sourcePath = toolPath + '.swift';
  try {
    fs.writeFileSync(sourcePath, swiftCode);
    const result = spawnSync('swiftc', [sourcePath, '-o', toolPath], { 
      timeout: 30000,
      encoding: 'utf-8'
    });
    
    if (result.status === 0 && fs.existsSync(toolPath)) {
      swiftToolPath = toolPath;
      cliLogger.debug('CLIPBOARD', '✓ Swift clipboard tool compiled');
      return toolPath;
    }
  } catch (err) {
    cliLogger.debug('CLIPBOARD', 'Failed to compile Swift tool', { error: err });
  }
  
  return null;
}

/**
 * Get file path from clipboard (macOS only)
 * Returns the file path if a file is copied, null otherwise
 */
function getClipboardFilePath(): string | null {
  if (process.platform !== 'darwin') {
    return null;
  }

  try {
    // Use osascript to get file path from clipboard
    const result = execSync(
      `osascript -e 'try' -e 'set theFile to the clipboard as «class furl»' -e 'set thePath to POSIX path of theFile' -e 'return thePath' -e 'end try'`,
      { encoding: 'utf-8', timeout: 2000 }
    );

    const filePath = result.trim();
    if (filePath && fs.existsSync(filePath)) {
      // Check if it's an image file
      const ext = path.extname(filePath).toLowerCase();
      const imageExtensions = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.tiff', '.tif'];
      if (imageExtensions.includes(ext)) {
        cliLogger.debug('CLIPBOARD', `Found image file in clipboard: ${filePath}`);
        return filePath;
      }
    }
  } catch (error) {
    cliLogger.debug('CLIPBOARD', 'No file path in clipboard', { error });
  }

  return null;
}

/**
 * Check if clipboard contains an image
 */
export function hasClipboardImage(): boolean {
  if (process.platform === 'darwin') {
    return hasClipboardImageMac();
  } else if (process.platform === 'win32') {
    return hasClipboardImageWindows();
  } else if (isWSL()) {
    return hasClipboardImageWSL();
  } else {
    return hasClipboardImageLinux();
  }
}

/**
 * Save clipboard image to a temporary file
 * Returns the file path or null if no image in clipboard
 */
export async function saveClipboardImage(): Promise<string | null> {
  if (process.platform === 'darwin') {
    return saveClipboardImageMac();
  } else if (process.platform === 'win32') {
    return saveClipboardImageWindows();
  } else if (isWSL()) {
    return saveClipboardImageWSL();
  } else {
    return saveClipboardImageLinux();
  }
}

// ============ macOS Implementation ============

function hasClipboardImageMac(): boolean {
  try {
    // Use osascript to check clipboard content type
    const result = execSync(
      `osascript -e 'clipboard info'`,
      { encoding: 'utf-8', timeout: 2000 }
    );
    // Check for image types - look for TIFF which is macOS's native image format
    return result.includes('TIFF') || 
           result.includes('«class PNGf»') || 
           result.includes('«class TIFF»') || 
           result.includes('«class JPEG»') ||
           result.includes('public.png') ||
           result.includes('public.tiff') ||
           result.includes('public.jpeg');
  } catch (error) {
    cliLogger.debug('CLIPBOARD', 'Failed to check clipboard', { error });
    return false;
  }
}

async function saveClipboardImageMac(): Promise<string | null> {
  const tempDir = os.tmpdir();
  const tempFile = path.join(tempDir, `neox-clipboard-${Date.now()}.png`);

  try {
    // Check if pngpaste is available (cache the check result)
    const result = spawnSync('pngpaste', [tempFile], { timeout: 3000 }); // Reduced timeout
    if (result.status === 0 && fs.existsSync(tempFile)) {
      const stats = fs.statSync(tempFile);
      if (stats.size > 0) {
        cliLogger.info('CLIPBOARD', `✓ Saved clipboard image via pngpaste (${Math.round(stats.size / 1024)}KB)`);
        return tempFile;
      }
    }
  } catch {
    // pngpaste not available or failed - try other methods
  }

  // Method 1.5: osascript 读 PNGf 数据 — macOS 内置, 无需 pngpaste(没装)/swiftc(没 Xcode)。
  try {
    try { if (fs.existsSync(tempFile)) fs.unlinkSync(tempFile); } catch { /* ignore */ }
    const r = spawnSync('osascript', [
      '-e', 'set theData to (the clipboard as «class PNGf»)',
      '-e', `set theFile to open for access (POSIX file "${tempFile}") with write permission`,
      '-e', 'write theData to theFile',
      '-e', 'close access theFile',
    ], { timeout: 3000 });
    if (r.status === 0 && fs.existsSync(tempFile) && fs.statSync(tempFile).size > 0) {
      cliLogger.info('CLIPBOARD', `✓ Saved clipboard image via osascript PNGf (${Math.round(fs.statSync(tempFile).size / 1024)}KB)`);
      return tempFile;
    }
  } catch {
    // 剪贴板没 PNG / osascript 失败 → 继续试 Swift 工具
  }

  // Method 2: Use compiled Swift tool (more reliable but slower)
  const swiftTool = ensureSwiftTool();
  if (swiftTool) {
    try {
      const result = spawnSync(swiftTool, [tempFile], {
        timeout: 3000, // Reduced timeout
        encoding: 'utf-8'
      });

      if (result.status === 0 && fs.existsSync(tempFile)) {
        const stats = fs.statSync(tempFile);
        if (stats.size > 0) {
          cliLogger.info('CLIPBOARD', `✓ Saved clipboard image (${Math.round(stats.size / 1024)}KB) to ${tempFile}`);
          return tempFile;
        }
      }
    } catch (err) {
      cliLogger.debug('CLIPBOARD', 'Swift tool failed', { error: err });
    }
  }

  cliLogger.debug('CLIPBOARD', 'No image found in clipboard or all methods failed');
  return null;
}

// ============ Windows Implementation ============

function hasClipboardImageWindows(): boolean {
  try {
    const result = execSync(
      `powershell -command "Get-Clipboard -Format Image"`,
      { encoding: 'utf-8', timeout: 2000 }
    );
    return result.trim().length > 0;
  } catch {
    return false;
  }
}

async function saveClipboardImageWindows(): Promise<string | null> {
  const tempDir = os.tmpdir();
  const tempFile = path.join(tempDir, `neox-clipboard-${Date.now()}.png`);
  
  try {
    const script = `
$img = Get-Clipboard -Format Image
if ($img) {
  $img.Save("${tempFile.replace(/\\/g, '\\\\')}")
  Write-Host "OK"
}
`;
    const result = execSync(`powershell -command "${script}"`, { 
      encoding: 'utf-8', 
      timeout: 5000 
    });
    
    if (result.includes('OK') && fs.existsSync(tempFile)) {
      cliLogger.info('CLIPBOARD', `✓ Saved clipboard image to ${tempFile}`);
      return tempFile;
    }
  } catch (error) {
    cliLogger.debug('CLIPBOARD', 'Failed to save clipboard image', { error });
  }
  
  return null;
}

// ============ Linux Implementation ============

function hasClipboardImageLinux(): boolean {
  try {
    // Check with xclip
    execSync('xclip -selection clipboard -t TARGETS -o 2>/dev/null | grep -i png', { 
      encoding: 'utf-8',
      timeout: 2000 
    });
    return true;
  } catch {
    return false;
  }
}

async function saveClipboardImageLinux(): Promise<string | null> {
  const tempDir = os.tmpdir();
  const tempFile = path.join(tempDir, `neox-clipboard-${Date.now()}.png`);
  
  try {
    const fd = fs.openSync(tempFile, 'w');
    try {
      spawnSync('xclip', ['-selection', 'clipboard', '-t', 'image/png', '-o'], {
        timeout: 5000,
        stdio: ['ignore', fd, 'ignore'],
      });
    } finally {
      fs.closeSync(fd);
    }

    if (fs.existsSync(tempFile) && fs.statSync(tempFile).size > 0) {
      cliLogger.info('CLIPBOARD', `✓ Saved clipboard image to ${tempFile}`);
      return tempFile;
    }
  } catch (error) {
    cliLogger.debug('CLIPBOARD', 'Failed to save clipboard image', { error });
  }
  
  return null;
}

// ============ WSL Implementation ============
// WSL needs to access Windows clipboard via powershell.exe

function hasClipboardImageWSL(): boolean {
  try {
    // Use powershell.exe to check Windows clipboard
    const result = execSync(
      'powershell.exe -NoProfile -Command "Get-Clipboard -Format Image"',
      { encoding: 'utf-8', timeout: 3000 }
    );
    return result.trim().length > 0;
  } catch {
    cliLogger.debug('CLIPBOARD', 'WSL: Failed to check Windows clipboard');
    return false;
  }
}

async function saveClipboardImageWSL(): Promise<string | null> {
  const tempDir = os.tmpdir();
  const tempFile = path.join(tempDir, `neox-clipboard-${Date.now()}.png`);

  // Convert WSL path to Windows path for PowerShell
  const windowsPath = wslToWindowsPath(tempFile);

  try {
    // PowerShell script to save clipboard image
    // Note: We save to Windows temp first, then the file is accessible from WSL
    const script = `
$img = Get-Clipboard -Format Image
if ($img) {
  $img.Save('${windowsPath.replace(/'/g, "''")}')
  Write-Host 'OK'
}
`;
    const result = execSync(
      `powershell.exe -NoProfile -Command "${script.replace(/"/g, '\\"')}"`,
      { encoding: 'utf-8', timeout: 5000 }
    );

    if (result.includes('OK') && fs.existsSync(tempFile)) {
      const stats = fs.statSync(tempFile);
      if (stats.size > 0) {
        cliLogger.info('CLIPBOARD', `✓ WSL: Saved clipboard image (${Math.round(stats.size / 1024)}KB)`);
        return tempFile;
      }
    }
  } catch (error) {
    cliLogger.debug('CLIPBOARD', 'WSL: Failed to save clipboard image', { error });
  }

  return null;
}

export function getClipboardImageFingerprint(): string | null {
  if (process.platform !== 'darwin') return null;
  try {
    const info = execSync(`osascript -e 'clipboard info'`, { encoding: 'utf-8', timeout: 1500 });
    const hasImg =
      info.includes('PNGf') ||
      info.includes('TIFF') ||
      info.includes('JPEG') ||
      info.includes('GIF') ||
      info.includes('public.png') ||
      info.includes('public.tiff') ||
      info.includes('public.jpeg');
    if (!hasImg) return null;
    return info.trim();
  } catch {
    return null;
  }
}

/**
 * Try to paste from clipboard - returns image path if image was found,
 * or null if clipboard contains text (which will be handled normally)
 */
export async function tryPasteClipboardImage(): Promise<string | null> {
  if (hasClipboardImage()) {
    return saveClipboardImage();
  }
  return null;
}

/**
 * Convert image file to base64 data URL
 * Returns data URL string like: data:image/png;base64,iVBORw0KG...
 */
export function imageFileToBase64(imagePath: string): string | null {
  try {
    // Read image file
    const imageBuffer = fs.readFileSync(imagePath);
    
    // Determine MIME type from file extension
    const ext = path.extname(imagePath).toLowerCase();
    let mimeType = 'image/png'; // default
    if (ext === '.jpg' || ext === '.jpeg') {
      mimeType = 'image/jpeg';
    } else if (ext === '.gif') {
      mimeType = 'image/gif';
    } else if (ext === '.webp') {
      mimeType = 'image/webp';
    } else if (ext === '.bmp') {
      mimeType = 'image/bmp';
    }
    
    // Convert to base64
    const base64Data = imageBuffer.toString('base64');
    
    // Return as data URL
    return `data:${mimeType};base64,${base64Data}`;
  } catch (error) {
    cliLogger.error('CLIPBOARD', 'Failed to convert image to base64', { error, imagePath });
    return null;
  }
}

/**
 * Get base64 data from image file (without data URL prefix)
 * Returns object with mediaType and base64 data
 */
export function imageFileToBase64Data(imagePath: string): { mediaType: string; data: string } | null {
  try {
    // Read image file
    const imageBuffer = fs.readFileSync(imagePath);
    
    // Determine MIME type from file extension
    const ext = path.extname(imagePath).toLowerCase();
    let mediaType = 'image/png'; // default
    if (ext === '.jpg' || ext === '.jpeg') {
      mediaType = 'image/jpeg';
    } else if (ext === '.gif') {
      mediaType = 'image/gif';
    } else if (ext === '.webp') {
      mediaType = 'image/webp';
    } else if (ext === '.bmp') {
      mediaType = 'image/bmp';
    }
    
    // Convert to base64
    const data = imageBuffer.toString('base64');
    
    return { mediaType, data };
  } catch (error) {
    cliLogger.error('CLIPBOARD', 'Failed to convert image to base64', { error, imagePath });
    return null;
  }
}

/**
 * Paste image from clipboard and convert to base64
 * This is the main function to use for Cmd+V paste
 */
export async function pasteImageAsBase64(): Promise<{ mediaType: string; data: string; name: string } | null> {
  const filePath = getClipboardFilePath();
  if (filePath) {
    cliLogger.info('CLIPBOARD', `📎 Using image file from clipboard: ${filePath}`);

    // Convert file to base64
    const base64Data = imageFileToBase64Data(filePath);
    if (base64Data) {
      return {
        ...base64Data,
        name: path.basename(filePath)
      };
    }
  }

  // Fallback: save clipboard image to temp file
  const imagePath = await tryPasteClipboardImage();
  if (!imagePath) {
    return null;
  }

  // Convert to base64
  const base64Data = imageFileToBase64Data(imagePath);
  if (!base64Data) {
    return null;
  }

  // Extract filename for display
  const name = path.basename(imagePath);

  // Clean up temp file
  try {
    fs.unlinkSync(imagePath);
  } catch {
    // Ignore cleanup errors
  }

  return {
    ...base64Data,
    name
  };
}



