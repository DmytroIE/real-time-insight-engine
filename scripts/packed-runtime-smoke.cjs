'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const RED = require('node-red');
const {
  ConfigurationBuilder,
  Engine,
  EntityKind,
  InMemoryStateStore,
  ProcessState,
} = require('@sxs/industrial-core');
const { createUg65ExamplePluginRegistry } = require('@sxs/deployment-ug65-example');
const { normalizeUg6xInput } = require('node-red-contrib-sxs-industrial');

const expectedNodeTypes = [
  'engine-message-receiver',
  'engine-state-snapshot',
  'industrial-engine',
  'ug6x-input',
];

const noOpTimers = {
  setTimeout: () => ({}),
  clearTimeout: () => undefined,
};

const main = async () => {
  const userDir = process.cwd();
  RED.init(null, {
    userDir,
    flowFile: 'flows.json',
    flowFilePretty: true,
    httpAdminRoot: false,
    httpNodeRoot: false,
    contextStorage: { default: { module: 'memory' } },
    logging: { console: { level: 'off' } },
  });

  let nodeRedStarted = false;
  let engine;
  try {
    await RED.start();
    nodeRedStarted = true;
    const installedTypes = RED.nodes
      .getNodeList()
      .filter(({ module }) => module === 'node-red-contrib-sxs-industrial')
      .flatMap(({ types }) => types)
      .sort();
    assert.deepEqual(installedTypes, expectedNodeTypes);

    const profileEntry = require.resolve('@sxs/deployment-ug65-example');
    const settingsPath = path.join(path.dirname(profileEntry), '..', 'settings.example.json');
    const rawConfiguration = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    const plugins = createUg65ExamplePluginRegistry();
    const configuration = new ConfigurationBuilder(plugins).build(rawConfiguration);
    const clock = {
      wallTimeMs: () => 600_000,
      monotonicTimeMs: () => 0,
    };
    engine = await Engine.create(configuration, {
      clock,
      timers: noOpTimers,
      plugins,
      stateStore: new InMemoryStateStore(),
    });

    const message = {
      deviceName: 'enless-twin-temp-1',
      gatewayTime: new Date(clock.wallTimeMs()).toISOString(),
      object: { sensorType: 12, temp1: 100, temp2: 90 },
    };
    assert.equal(await engine.ingest(normalizeUg6xInput(message, clock.wallTimeMs())), true);
    assert.equal(await engine.runApplication('steam-trap-1/failed-closed'), 'completed');

    const snapshot = engine.snapshot({ target: { scope: 'all' } });
    assert.equal(snapshot.entities.length, 5);
    const application = snapshot.entities.find(
      ({ entityType }) => entityType === EntityKind.Application,
    );
    assert.equal(application.state.currState, ProcessState.Ok);
    assert.doesNotThrow(() => JSON.stringify(snapshot));

    console.log(
      `PACKED_RUNTIME_OK node=${process.version} nodeRed=${RED.version()} nodes=${installedTypes.join(',')} entities=${snapshot.entities.length}`,
    );
  } finally {
    if (engine !== undefined) {
      await engine.close();
    }
    if (nodeRedStarted) {
      await RED.stop();
    }
  }
};

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
