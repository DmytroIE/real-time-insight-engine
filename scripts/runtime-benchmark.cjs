'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { monitorEventLoopDelay, performance } = require('node:perf_hooks');

const { ConfigurationBuilder, Engine, InMemoryStateStore } = require('@sxs/industrial-core');
const { createUg65ExamplePluginRegistry } = require('@sxs/deployment-ug65-example');

const iterations = Number.parseInt(process.env.BENCH_ITERATIONS ?? '5000', 10);
if (!Number.isSafeInteger(iterations) || iterations < 1) {
  throw new Error('BENCH_ITERATIONS must be a positive safe integer');
}

const noOpTimers = {
  setTimeout: () => ({}),
  clearTimeout: () => undefined,
};

const immediate = () => new Promise((resolve) => setImmediate(resolve));
const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const nanosecondsToMilliseconds = (value) => value / 1_000_000;

const main = async () => {
  const profileEntry = require.resolve('@sxs/deployment-ug65-example');
  const settingsPath = path.join(path.dirname(profileEntry), '..', 'settings.example.json');
  const rawConfiguration = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  const plugins = createUg65ExamplePluginRegistry();
  const configuration = new ConfigurationBuilder(plugins).build(rawConfiguration);
  let wallTimeMs = 600_000;
  const clock = {
    wallTimeMs: () => wallTimeMs,
    monotonicTimeMs: () => wallTimeMs,
  };

  const startupStartedAt = performance.now();
  const engine = await Engine.create(configuration, {
    clock,
    timers: noOpTimers,
    plugins,
    stateStore: new InMemoryStateStore(),
  });
  const startupMs = performance.now() - startupStartedAt;

  const eventLoopDelay = monitorEventLoopDelay({ resolution: 10 });
  eventLoopDelay.enable();
  await delay(20);

  const memoryBefore = process.memoryUsage();
  const cpuBefore = process.cpuUsage();
  const workloadStartedAt = performance.now();
  try {
    for (let index = 0; index < iterations; index += 1) {
      wallTimeMs += 1_000;
      await engine.ingest({
        deviceId: 'enless-twin-temp-1',
        receivedTs: wallTimeMs,
        sourceTs: wallTimeMs,
        payload: { sensorType: 12, temp1: 100, temp2: 90 },
      });
      if (index % 10 === 0) {
        await engine.runApplication('steam-trap-1/failed-closed');
      }
      if (index % 100 === 0) {
        await immediate();
      }
    }
  } finally {
    await engine.close();
  }

  const workloadMs = performance.now() - workloadStartedAt;
  const cpu = process.cpuUsage(cpuBefore);
  const memoryAfter = process.memoryUsage();
  await delay(20);
  eventLoopDelay.disable();

  const result = {
    environment: {
      node: process.version,
      platform: `${process.platform}/${process.arch}`,
      iterations,
    },
    startupMs: Number(startupMs.toFixed(2)),
    workload: {
      elapsedMs: Number(workloadMs.toFixed(2)),
      ingestsPerSecond: Number(((iterations * 1_000) / workloadMs).toFixed(2)),
      applicationRuns: Math.ceil(iterations / 10),
      cpuUserMs: Number((cpu.user / 1_000).toFixed(2)),
      cpuSystemMs: Number((cpu.system / 1_000).toFixed(2)),
    },
    memory: {
      rssBeforeMiB: Number((memoryBefore.rss / 1_048_576).toFixed(2)),
      rssAfterMiB: Number((memoryAfter.rss / 1_048_576).toFixed(2)),
      heapUsedBeforeMiB: Number((memoryBefore.heapUsed / 1_048_576).toFixed(2)),
      heapUsedAfterMiB: Number((memoryAfter.heapUsed / 1_048_576).toFixed(2)),
    },
    eventLoopDelayMs: {
      mean: Number(nanosecondsToMilliseconds(eventLoopDelay.mean).toFixed(2)),
      p99: Number(nanosecondsToMilliseconds(eventLoopDelay.percentile(99)).toFixed(2)),
      max: Number(nanosecondsToMilliseconds(eventLoopDelay.max).toFixed(2)),
    },
  };

  console.log(JSON.stringify(result, null, 2));
};

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
