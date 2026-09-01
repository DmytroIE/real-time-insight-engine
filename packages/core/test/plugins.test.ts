import { describe, expect, it } from 'vitest';

import {
  PluginRegistry,
  asPluginTypeId,
  type ApplicationId,
  type ApplicationPlugin,
  type DeviceId,
  type DevicePlugin,
} from '../src';

const settingsSchema = {
  type: 'object',
  additionalProperties: false,
} as const;

interface TestSettings {
  readonly enabled: boolean;
}

interface TestState {
  readonly evaluations: number;
}

const devicePlugin: DevicePlugin<TestSettings, TestState, { readonly id: DeviceId }> = {
  kind: 'device',
  type: asPluginTypeId('sxs.test-device'),
  version: 1,
  displayName: 'Test Device',
  datastreams: ['temperature'],
  settingsSchema,
  defaultSettings: { enabled: true },
  create: (context) => ({ id: context.id }),
};

const applicationPlugin: ApplicationPlugin<
  TestSettings,
  TestState,
  { readonly id: ApplicationId }
> = {
  kind: 'application',
  type: asPluginTypeId('sxs.test-application'),
  version: 1,
  displayName: 'Test Application',
  requiredDatafeeds: ['temperature'],
  defaultState: { evaluations: 0 },
  settingsSchema,
  defaultSettings: { enabled: true },
  create: (context) => ({ id: context.id }),
};

describe('CFG-01 explicit plugin registry', () => {
  it('resolves installed plugins by stable type ID and kind', () => {
    const registry = new PluginRegistry();
    registry.register(devicePlugin);
    registry.register(applicationPlugin);

    expect(registry.resolve(devicePlugin.type)).toBe(devicePlugin);
    expect(registry.resolveDevice(devicePlugin.type)).toBe(devicePlugin);
    expect(registry.resolveApplication(applicationPlugin.type)).toBe(applicationPlugin);
    expect(registry.has(applicationPlugin.type)).toBe(true);
  });
});

describe('CFG-02 invalid plugin registration and lookup', () => {
  it('rejects duplicate stable type IDs', () => {
    const registry = new PluginRegistry();
    registry.register(devicePlugin);

    expect(() => registry.register(devicePlugin)).toThrow('Duplicate plugin type: sxs.test-device');
  });

  it('rejects unavailable and wrong-kind plugin types', () => {
    const registry = new PluginRegistry();
    registry.register(devicePlugin);

    expect(() => registry.resolve(asPluginTypeId('sxs.missing'))).toThrow(
      'Plugin type is not installed: sxs.missing',
    );
    expect(() => registry.resolveApplication(devicePlugin.type)).toThrow(
      'Plugin type is not an application plugin: sxs.test-device',
    );
  });
});
