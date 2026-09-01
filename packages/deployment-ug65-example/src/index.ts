import { twinTemperatureFailedClosedApplicationPlugin } from '@sxs/app-twin-temp-failed-closed';
import { enlessTwinTemperatureDevicePlugin } from '@sxs/device-enless-twin-temp';
import { PluginRegistry } from '@sxs/industrial-core';

export const createUg65ExamplePluginRegistry = (): PluginRegistry => {
  const registry = new PluginRegistry();
  registry.register(enlessTwinTemperatureDevicePlugin);
  registry.register(twinTemperatureFailedClosedApplicationPlugin);
  return registry;
};
