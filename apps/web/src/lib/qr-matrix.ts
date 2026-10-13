// The repository already vendors this small Apache-2.0 QR encoder with the
// supported CLI toolchain. Importing its encoding core avoids sending a TOTP
// provisioning URI to a network QR service.
// @ts-expect-error vendored CommonJS module has no declaration file
import QRCode from "../../../../vendor/cli/npm/10.9.2/package/node_modules/qrcode-terminal/vendor/QRCode/index.js";
// @ts-expect-error vendored CommonJS module has no declaration file
import QRErrorCorrectLevel from "../../../../vendor/cli/npm/10.9.2/package/node_modules/qrcode-terminal/vendor/QRCode/QRErrorCorrectLevel.js";

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

