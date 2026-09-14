import { createContainer } from "/packages/sdk/src/container.ts";

const resultEl = document.getElementById("result");
const systemWorkerUrl = new URL("/workers/system-worker.ts", location.href);
const processWorkerUrl = new URL("/workers/process-worker.ts", location.href);

async function runCycle(index) {
  const container = createContainer({
    systemWorkerUrl,
    processWorkerUrl,
    timeoutMs: 2500
  });
  const boot = await container.boot();
  const statusAfterBoot = container.status;
  await container.teardown();
  return {
    index,
    boot,
    statusAfterBoot,
    statusAfterTeardown: container.status
  };
}

async function expectFailure(options) {
  const container = createContainer({
    systemWorkerUrl,
    processWorkerUrl,
    timeoutMs: 2500
  });
  try {
    await container.boot(options);
    return "unexpected success";
  } catch (error) {
    return error.message;
  } finally {
    await container.teardown();
  }
}

const cycles = [];
for (let i = 0; i < 3; i += 1) {
  cycles.push(await runCycle(i));
}

const failures = {
  process: await expectFailure({ forceProcessFailure: true }),
  system: await expectFailure({ forceSystemFailure: true })
};

globalThis.__workerBootResult = {
  crossOriginIsolated,
  cycles,
  failures,
  uiGuestRan: Boolean(globalThis.__guestRuntimeExecutedOnUi)
};

resultEl.textContent = JSON.stringify(globalThis.__workerBootResult, null, 2);
