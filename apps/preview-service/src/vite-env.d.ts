/// <reference types="vite/client" />

interface MonacoEnvironment {
  getWorker?(workerId: string, label: string): Worker;
  getWorkerUrl?(moduleId: string, label: string): string;
  globalAPI?: boolean;
}

interface Window {
  MonacoEnvironment?: MonacoEnvironment;
}

declare var MonacoEnvironment: MonacoEnvironment | undefined;

declare module "*?worker" {
  const workerConstructor: {
    new (): Worker;
  };
  export default workerConstructor;
}
