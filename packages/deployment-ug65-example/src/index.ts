import { twinTemperatureFailedClosedApplicationPlugin } from '@sxs/app-twin-temp-failed-closed';
import { ecobolt2FailedOpenApplicationPlugin } from '@sxs/app-ecobolt2-failed-open';
import { enlessTwinTemperatureDevicePlugin } from '@sxs/device-enless-twin-temp';
import { sxsEcobolt2DevicePlugin } from '@sxs/device-sxs-ecobolt2';
import { PluginRegistry } from '@sxs/industrial-core';

export const createUg65ExamplePluginRegistry = (): PluginRegistry => {
  const registry = new PluginRegistry();
  registry.register(enlessTwinTemperatureDevicePlugin);
  registry.register(twinTemperatureFailedClosedApplicationPlugin);
  registry.register(sxsEcobolt2DevicePlugin);
  registry.register(ecobolt2FailedOpenApplicationPlugin);
  return registry;
};
