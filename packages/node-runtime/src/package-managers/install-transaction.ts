export interface InstallTransactionOptions {
  failAfterOperations?: number;
}

export interface InstallTransactionResult {
  completed: boolean;
  operations: number;
  interrupted: boolean;
}

export class InstallTransactionInterruptedError extends Error {
  code = "EINSTALLINTERRUPTED";
  operations: number;

  constructor(operations: number) {
    super(`install transaction interrupted after ${operations} operations`);
    this.name = "InstallTransactionInterruptedError";
    this.operations = operations;
  }
}

export function runInstallTransaction(operations: Array<() => void>, options: InstallTransactionOptions = {}): InstallTransactionResult {
  let completed = 0;
  for (const operation of operations) {
    if (options.failAfterOperations !== undefined && completed >= options.failAfterOperations) {
      throw new InstallTransactionInterruptedError(completed);
    }
    operation();
    completed += 1;
  }
  return {
    completed: true,
    operations: completed,
    interrupted: false
  };
}
