export async function readUtf8FileOrNull(filePath: string): Promise<string | null> {
  try {
    const fs = await import('fs/promises');
    return await fs.readFile(filePath, 'utf-8');
  } catch {
    return null;
  }
}

export async function listDirOrEmpty(dirPath: string): Promise<string[]> {
  try {
    const fs = await import('fs/promises');
    return await fs.readdir(dirPath);
  } catch {
    return [];
  }
}
