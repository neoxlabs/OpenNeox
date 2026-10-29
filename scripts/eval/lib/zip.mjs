/**
 * 极简 ZIP 读取器 (只读, 支持 stored / deflate), 给 docx / pptx 判分用。
 *
 * xlsx.mjs 自带了一份同样逻辑 —— 那个文件已经在跑旧任务, 不为复用去改它的行为;
 * 新加的两类产物走这里。
 */
import * as fs from 'node:fs';
import * as zlib from 'node:zlib';

function findEndOfCentralDirectory(buf) {
  const minOffset = Math.max(0, buf.length - 66_000);
  for (let i = buf.length - 22; i >= minOffset; i -= 1) {
    if (buf.readUInt32LE(i) === 0x06054b50) return i;
  }
  return -1;
}

function readEntries(buf) {
  const eocd = findEndOfCentralDirectory(buf);
  if (eocd < 0) throw new Error('不是有效的 zip 容器 (缺少目录)');
  const count = buf.readUInt16LE(eocd + 10);
  let offset = buf.readUInt32LE(eocd + 16);
  const entries = new Map();
  for (let i = 0; i < count; i += 1) {
    if (buf.readUInt32LE(offset) !== 0x02014b50) break;
    const method = buf.readUInt16LE(offset + 10);
    const compressedSize = buf.readUInt32LE(offset + 20);
    const nameLength = buf.readUInt16LE(offset + 28);
    const extraLength = buf.readUInt16LE(offset + 30);
    const commentLength = buf.readUInt16LE(offset + 32);
    const localOffset = buf.readUInt32LE(offset + 42);
    const name = buf.toString('utf8', offset + 46, offset + 46 + nameLength);
    entries.set(name, { method, compressedSize, localOffset });
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

function readEntry(buf, entry) {
  if (buf.readUInt32LE(entry.localOffset) !== 0x04034b50) throw new Error('zip local header 损坏');
  const nameLength = buf.readUInt16LE(entry.localOffset + 26);
  const extraLength = buf.readUInt16LE(entry.localOffset + 28);
  const start = entry.localOffset + 30 + nameLength + extraLength;
  const data = buf.subarray(start, start + entry.compressedSize);
  if (entry.method === 0) return data;
  if (entry.method === 8) return zlib.inflateRawSync(data);
  throw new Error(`不支持的 zip 压缩方式: ${entry.method}`);
}

/** @returns {{ names: string[], has: (name: string) => boolean, read: (name: string) => Buffer | null, text: (name: string) => string }} */
export function openZip(file) {
  const buf = fs.readFileSync(file);
  const entries = readEntries(buf);
  const read = (name) => (entries.has(name) ? readEntry(buf, entries.get(name)) : null);
  return {
    names: [...entries.keys()],
    has: (name) => entries.has(name),
    read,
    text: (name) => {
      const data = read(name);
      return data == null ? null : data.toString('utf8');
    },
  };
}
