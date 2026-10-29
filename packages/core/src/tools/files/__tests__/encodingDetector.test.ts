import { describe, it, expect } from 'vitest';
import { detectEncoding, isTextFile, quickIsBinary } from '../encodingDetector.js';

describe('encodingDetector', () => {
  describe('detectEncoding', () => {
    it('detects empty file as utf-8', () => {
      const result = detectEncoding(Buffer.alloc(0));
      expect(result.encoding).toBe('utf-8');
      expect(result.confidence).toBe(1.0);
    });

    it('detects pure ASCII', () => {
      const result = detectEncoding(Buffer.from('Hello, world!\n'));
      expect(result.encoding).toBe('ascii');
      expect(result.isBinary).toBe(false);
    });

    it('detects UTF-8 BOM', () => {
      const bom = Buffer.from([0xEF, 0xBB, 0xBF]);
      const content = Buffer.from('Hello');
      const result = detectEncoding(Buffer.concat([bom, content]));
      expect(result.encoding).toBe('utf-8-bom');
      expect(result.hasBOM).toBe(true);
      expect(result.bomLength).toBe(3);
    });

    it('detects UTF-16 LE BOM', () => {
      const bom = Buffer.from([0xFF, 0xFE]);
      const content = Buffer.from('Hi');
      const result = detectEncoding(Buffer.concat([bom, content]));
      expect(result.encoding).toBe('utf-16-le');
      expect(result.hasBOM).toBe(true);
      expect(result.bomLength).toBe(2);
    });

    it('detects UTF-16 BE BOM', () => {
      const bom = Buffer.from([0xFE, 0xFF]);
      const content = Buffer.from('Hi');
      const result = detectEncoding(Buffer.concat([bom, content]));
      expect(result.encoding).toBe('utf-16-be');
      expect(result.hasBOM).toBe(true);
    });

    it('detects valid UTF-8 with multibyte chars', () => {
      const result = detectEncoding(Buffer.from('你好世界 Hello'));
      expect(result.encoding).toBe('utf-8');
      expect(result.isBinary).toBe(false);
    });

    it('detects binary (NUL bytes)', () => {
      const buf = Buffer.alloc(100);
      buf.write('header');
      // Fill with NUL bytes
      for (let i = 10; i < 100; i++) buf[i] = 0x00;
      const result = detectEncoding(buf);
      expect(result.encoding).toBe('binary');
      expect(result.isBinary).toBe(true);
    });

    it('detects binary (excessive control chars)', () => {
      const buf = Buffer.alloc(100);
      for (let i = 0; i < 100; i++) buf[i] = i < 10 ? 0x01 : 0x41; // 10% control chars
      const result = detectEncoding(buf);
      expect(result.encoding).toBe('binary');
      expect(result.isBinary).toBe(true);
    });
  });

  describe('isTextFile', () => {
    it('returns true for utf-8', () => {
      const result = detectEncoding(Buffer.from('Hello'));
      expect(isTextFile(result)).toBe(true);
    });

    it('returns false for binary', () => {
      const buf = Buffer.alloc(100, 0x00);
      const result = detectEncoding(buf);
      expect(isTextFile(result)).toBe(false);
    });

    it('returns false for utf-16', () => {
      const bom = Buffer.from([0xFF, 0xFE]);
      const result = detectEncoding(bom);
      expect(isTextFile(result)).toBe(false);
    });
  });

  describe('quickIsBinary', () => {
    it('returns false for text', () => {
      expect(quickIsBinary(Buffer.from('Hello world'))).toBe(false);
    });

    it('returns true for buffer with NUL', () => {
      const buf = Buffer.from([0x48, 0x65, 0x00, 0x6C]);
      expect(quickIsBinary(buf)).toBe(true);
    });
  });
});
