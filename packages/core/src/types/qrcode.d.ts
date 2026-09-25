/**
 * Type declarations for qrcode module
 */
declare module 'qrcode' {
  interface QRCodeOptions {
    errorCorrectionLevel?: 'L' | 'M' | 'Q' | 'H';
    margin?: number;
    scale?: number;
    width?: number;
    color?: {
      dark?: string;
      light?: string;
    };
  }

  interface QRCodeToDataURLOptions extends QRCodeOptions {
    type?: 'image/png' | 'image/jpeg' | 'image/webp';
  }

  interface QRCodeToFileOptions extends QRCodeOptions {
    type?: 'png' | 'svg' | 'utf8';
  }

  /**
   * Generates a QR code and saves it to a file
   */
  export function toFile(
    path: string,
    text: string | object[],
    options?: QRCodeToFileOptions
  ): Promise<void>;

  /**
   * Generates a QR code and returns it as a data URL
   */
  export function toDataURL(
    text: string | object[],
    options?: QRCodeToDataURLOptions
  ): Promise<string>;

  /**
   * Generates a QR code and returns it as a string
   */
  export function toString(
    text: string | object[],
    options?: QRCodeOptions
  ): Promise<string>;

  /**
   * Generates a QR code on a canvas
   */
  export function toCanvas(
    canvas: any,
    text: string | object[],
    options?: QRCodeOptions
  ): Promise<void>;

  /**
   * Creates a QR code object
   */
  export function create(
    text: string | object[],
    options?: QRCodeOptions
  ): any;

  const qrcode: {
    toFile: typeof toFile;
    toDataURL: typeof toDataURL;
    toString: typeof toString;
    toCanvas: typeof toCanvas;
    create: typeof create;
  };

  export default qrcode;
}
