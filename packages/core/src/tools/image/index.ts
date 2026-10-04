/**
 * Image Processing — 模块导出
 */

export {
  isImageFile,
  isPdfFile,
  detectImageFormatFromBuffer,
  getMediaTypeFromExtension,
  readImageFile,
  readPdfAsImages,
  extractPdfText,
  buildImageToolResult,
  parseImageResultImages,
  IMAGE_RESULT_PREFIX,
  API_IMAGE_MAX_BASE64_SIZE,
  IMAGE_TARGET_RAW_SIZE,
  IMAGE_MAX_WIDTH,
  IMAGE_MAX_HEIGHT,
  PDF_MAX_PAGES_PER_READ,
  PDF_MAX_PAGES_PER_TEXT_READ,
} from './imageProcessor.js';

export type {
  ImageMediaType,
  ImageReadResult,
  PdfReadResult,
  PdfTextResult,
} from './imageProcessor.js';
