// Encode the TOTP provisioning URI in the browser. The URI never goes to a QR service.
import qrcode from "qrcode-generator";

export function createQrMatrix(value: string): readonly (readonly boolean[])[] {
  const code = qrcode(0, "M");
  code.addData(value);
  code.make();
  const size = code.getModuleCount();
  return Array.from({ length: size }, (_, row) =>
    Array.from({ length: size }, (_, column) => code.isDark(row, column))
  );
}
