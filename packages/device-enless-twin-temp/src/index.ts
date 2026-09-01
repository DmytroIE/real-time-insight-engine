import {
  asPluginTypeId,
  type DeviceDatastream,
  type DevicePayloadContext,
  type DevicePayloadParseResult,
  type DevicePayloadParser,
  type DevicePlugin,
} from '@sxs/industrial-core';

export const ENLESS_TWIN_TEMPERATURE_TYPE = asPluginTypeId('sxs.enless-twin-temp');
export const ENLESS_TWIN_TEMPERATURE_SENSOR_TYPE = 12;
export const ENLESS_TWIN_TEMPERATURE_DATASTREAMS = ['temp1', 'temp2'] as const;
export const ENLESS_TWIN_TEMPERATURE_MIN = -100;
export const ENLESS_TWIN_TEMPERATURE_MAX = 400;

export type EnlessTwinTemperatureSettings = Record<string, never>;

interface EnlessTwinTemperaturePayload {
  readonly temp1: number;
  readonly temp2: number;
}

const settingsSchema = {
  type: 'object',
  additionalProperties: false,
} as const;

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const validatePayload = (payload: unknown): EnlessTwinTemperaturePayload | undefined => {
  if (!isRecord(payload) || !isRecord(payload['object'])) {
    return undefined;
  }
  const object = payload['object'];
  const temp1 = object['temp1'];
  const temp2 = object['temp2'];
  if (
    object['sensorType'] !== ENLESS_TWIN_TEMPERATURE_SENSOR_TYPE ||
    typeof temp1 !== 'number' ||
    !Number.isFinite(temp1) ||
    typeof temp2 !== 'number' ||
    !Number.isFinite(temp2)
  ) {
    return undefined;
  }
  return { temp1, temp2 };
};

const applyValue = (datastream: DeviceDatastream, value: number, sourceTimestamp: number): void => {
  if (value < ENLESS_TWIN_TEMPERATURE_MIN || value > ENLESS_TWIN_TEMPERATURE_MAX) {
    datastream.rejectInput(
      'Sensor value is outside the supported temperature range',
      {
        value,
        minimum: ENLESS_TWIN_TEMPERATURE_MIN,
        maximum: ENLESS_TWIN_TEMPERATURE_MAX,
        sourceTimestamp,
      },
      'SENSOR_BROKEN',
    );
    return;
  }
  datastream.acceptSample({ timestamp: sourceTimestamp, value });
};

class EnlessTwinTemperatureParser implements DevicePayloadParser {
  public parse(payload: unknown, context: DevicePayloadContext): DevicePayloadParseResult {
    const values = validatePayload(payload);
    if (values === undefined) {
      return {
        accepted: false,
        message: 'Expected Enless sensor type 12 with finite numeric temp1 and temp2 values',
      };
    }

    const temp1 = context.datastream('temp1');
    const temp2 = context.datastream('temp2');
    if (temp1 === undefined || temp2 === undefined) {
      return {
        accepted: false,
        message: 'Enless twin-temperature Datastreams are unavailable',
      };
    }

    applyValue(temp1, values.temp1, context.sourceTimestamp);
    applyValue(temp2, values.temp2, context.sourceTimestamp);
    return { accepted: true };
  }
}

export const enlessTwinTemperatureDevicePlugin: DevicePlugin<
  EnlessTwinTemperatureSettings,
  Record<string, never>,
  DevicePayloadParser
> = {
  kind: 'device',
  type: ENLESS_TWIN_TEMPERATURE_TYPE,
  version: 1,
  displayName: 'Enless Twin Temperature',
  datastreams: ENLESS_TWIN_TEMPERATURE_DATASTREAMS,
  settingsSchema,
  defaultSettings: {},
  create: () => new EnlessTwinTemperatureParser(),
};
