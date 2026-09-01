import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

import { TWIN_TEMPERATURE_FAILED_CLOSED_TYPE } from '@sxs/app-twin-temp-failed-closed';
import { ENLESS_TWIN_TEMPERATURE_TYPE } from '@sxs/device-enless-twin-temp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import helper from 'node-red-node-test-helper';

import { createIndustrialPluginRegistry } from '../src/plugin-registry';
import {
  ENGINE_CONFIG_NODE_TYPE,
  ENGINE_MESSAGE_RECEIVER_NODE_TYPE,
  ENGINE_STATE_SNAPSHOT_NODE_TYPE,
  UG6X_INPUT_NODE_TYPE,
} from '../src/node-types';

type PackagedNodeInitializer = Extract<
  Parameters<typeof helper.load>[0],
  (...arguments_: never[]) => unknown
>;

const requireFromTest = createRequire(__filename);
const registerIndustrialEngineNode = requireFromTest(
  '../nodes/industrial-engine.js',
) as PackagedNodeInitializer;
const registerUg6xInputNode = requireFromTest('../nodes/ug6x-input.js') as PackagedNodeInitializer;
const registerEngineMessageReceiverNode = requireFromTest(
  '../nodes/engine-message-receiver.js',
) as PackagedNodeInitializer;
const registerEngineStateSnapshotNode = requireFromTest(
  '../nodes/engine-state-snapshot.js',
) as PackagedNodeInitializer;

interface NodeRedPackageManifest {
  readonly 'node-red'?: {
    readonly version?: string;
    readonly nodes?: Readonly<Record<string, string>>;
  };
}

const packageDirectory = join(__dirname, '..');
const manifest = JSON.parse(
  readFileSync(join(packageDirectory, 'package.json'), 'utf8'),
) as NodeRedPackageManifest;

const startServer = (): Promise<void> =>
  new Promise((resolve) => {
    helper.startServer(resolve);
  });

const stopServer = (): Promise<void> =>
  new Promise((resolve) => {
    helper.stopServer(resolve);
  });

describe('NR-01 Node-RED package discovery', () => {
  beforeAll(async () => {
    helper.init(require.resolve('node-red'));
    await startServer();
  });

  afterAll(async () => {
    await helper.unload();
    await stopServer();
  });

  it('declares discoverable runtime/editor entry points and loads all four node types', async () => {
    expect(manifest['node-red']?.version).toBe('>=3.0.2');
    const nodes = manifest['node-red']?.nodes;
    expect(nodes).toEqual({
      'industrial-engine': 'nodes/industrial-engine.js',
      'ug6x-input': 'nodes/ug6x-input.js',
      'engine-message-receiver': 'nodes/engine-message-receiver.js',
      'engine-state-snapshot': 'nodes/engine-state-snapshot.js',
    });
    for (const runtimePath of Object.values(nodes ?? {})) {
      expect(existsSync(join(packageDirectory, runtimePath))).toBe(true);
      expect(
        existsSync(
          join(
            packageDirectory,
            dirname(runtimePath),
            `${runtimePath.split('/').at(-1)?.replace(/\.js$/, '')}.html`,
          ),
        ),
      ).toBe(true);
    }

    await helper.load(
      [
        registerIndustrialEngineNode,
        registerUg6xInputNode,
        registerEngineMessageReceiverNode,
        registerEngineStateSnapshotNode,
      ],
      [
        { id: 'engine', type: ENGINE_CONFIG_NODE_TYPE },
        { id: 'input', type: UG6X_INPUT_NODE_TYPE },
        { id: 'receiver', type: ENGINE_MESSAGE_RECEIVER_NODE_TYPE },
        { id: 'snapshot', type: ENGINE_STATE_SNAPSHOT_NODE_TYPE },
      ],
    );

    expect(helper.getNode('engine')).toBeDefined();
    expect(helper.getNode('input')).toBeDefined();
    expect(helper.getNode('receiver')).toBeDefined();
    expect(helper.getNode('snapshot')).toBeDefined();

    const plugins = createIndustrialPluginRegistry();
    expect(plugins.resolveDevice(ENLESS_TWIN_TEMPERATURE_TYPE).type).toBe(
      ENLESS_TWIN_TEMPERATURE_TYPE,
    );
    expect(plugins.resolveApplication(TWIN_TEMPERATURE_FAILED_CLOSED_TYPE).type).toBe(
      TWIN_TEMPERATURE_FAILED_CLOSED_TYPE,
    );
  });
});
