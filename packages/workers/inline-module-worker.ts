export const MODULE_WORKER_BLOB_TYPE = "text/javascript;charset=utf-8";

export function moduleWorkerBlobSource(source: string, assetBase: string): string {
  const located = source.replaceAll("self.location.href", JSON.stringify(assetBase));
  return `URL.revokeObjectURL(import.meta.url);\n${located}`;
}
