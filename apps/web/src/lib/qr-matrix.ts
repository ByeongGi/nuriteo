// Product copy of the MIT QR encoder (Kazuhiko Arase). The package-manager
// test fixture keeps its own copy inside the npm CLI tree. Encoding locally
// avoids sending a TOTP provisioning URI to a network QR service.
// @ts-expect-error vendored CommonJS module has no declaration file
import QRCode from "../../../../vendor/runtime/qrcode/index.js";
// @ts-expect-error vendored CommonJS module has no declaration file
import QRErrorCorrectLevel from "../../../../vendor/runtime/qrcode/QRErrorCorrectLevel.js";

interface QrCodeInstance {
  addData(value: string): void;
  make(): void;
  getModuleCount(): number;
  isDark(row: number, column: number): boolean;
}

export function createQrMatrix(value: string): readonly (readonly boolean[])[] {
  const code = new QRCode(-1, QRErrorCorrectLevel.M) as QrCodeInstance;
  code.addData(value);
  code.make();
  const size = code.getModuleCount();
  return Array.from({ length: size }, (_, row) =>
    Array.from({ length: size }, (_, column) => code.isDark(row, column))
  );
}

