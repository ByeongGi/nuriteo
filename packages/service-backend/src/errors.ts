export type ServiceBackendErrorCode =
  | "EAUTH"
  | "ENOTFOUND"
  | "EFORBIDDEN"
  | "ECONFLICT"
  | "EINVALID"
  | "EREVOKED";

export class ServiceBackendError extends Error {
  code: ServiceBackendErrorCode;

  constructor(message: string, code: ServiceBackendErrorCode) {
    super(message);
    this.name = "ServiceBackendError";
    this.code = code;
  }
}
