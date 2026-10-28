export class RuntimeAdapterError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "RuntimeAdapterError";
    this.code = code;
  }
}
