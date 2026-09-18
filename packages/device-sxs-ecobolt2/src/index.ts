import {
  asPluginTypeId,
  type DeviceDatastream,
  type DevicePayloadContext,
  type DevicePayloadParseResult,
  type DevicePayloadParser,
  type DevicePlugin,
} from '@sxs/industrial-core';

export const SXSECOBOLT2_TYPE = asPluginTypeId('sxs.ecobolt2');
export const SXSECOBOLT2_DATASTREAMS = ['failedOpen', 'active', 'trapTemp', 'losses'] as const;

interface Ecobolt2Payload {
  readonly statusBits: number;
  readonly trapTemp: number;
  readonly losses: number;
}

const hardwareStatusBits = [
  {
    mask: 1,
    code: 'TEMP_SENSOR_ERROR',
    message: 'Ecobolt2 temperature sensor error is active',
  },
  {
    mask: 2,
    code: 'EXTERNAL_TEMP_SENSOR_ERROR',
    message: 'Ecobolt2 external temperature sensor error is active',
  },
  {
    mask: 256,
    code: 'UNCONFIGURED',
    message: 'Ecobolt2 is unconfigured',
  },
] as const;

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isNumberInRange = (value: unknown, minimum: number, maximum: number): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= minimum && value <= maximum;

const validatePayload = (payload: unknown): Ecobolt2Payload | DevicePayloadParseResult => {
  if (!isRecord(payload)) {
    return { accepted: false, message: 'Expected an Ecobolt2 payload object' };
  }
  const statusBits = payload['statusBits'];
  if (!isNumberInRange(statusBits, 0, 65_535) || !Number.isInteger(statusBits)) {
    return {
      accepted: false,
      message: 'Ecobolt2 statusBits must be an integer from 0 through 65535',
      details: { field: 'statusBits', value: statusBits },
    };
  }
  const trapTemp = payload['trapTemp'];
  if (!isNumberInRange(trapTemp, 0, 625)) {
    return {
      accepted: false,
      message: 'Ecobolt2 trapTemp must be a finite number from 0 through 625',
      details: { field: 'trapTemp', value: trapTemp },
    };
  }
  const losses = payload['losses'];
  if (!isNumberInRange(losses, 0, 255)) {
    return {
      accepted: false,
      message: 'Ecobolt2 losses must be a finite number from 0 through 255',
      details: { field: 'losses', value: losses },
    };
  }
  return { statusBits, trapTemp, losses };
};

const isParseResult = (
  value: Ecobolt2Payload | DevicePayloadParseResult,
): value is DevicePayloadParseResult => 'accepted' in value;

const requireDatastream = (context: DevicePayloadContext, name: string): DeviceDatastream => {
  const datastream = context.datastream(name);
  if (datastream === undefined) {
    throw new Error(`Ecobolt2 Datastream is unavailable: ${name}`);
  }
  return datastream;
};

class SxSEcobolt2Parser implements DevicePayloadParser {
  public parse(payload: unknown, context: DevicePayloadContext): DevicePayloadParseResult {
    const values = validatePayload(payload);
    if (isParseResult(values)) {
      return values;
    }

    const diagnostics = hardwareStatusBits
      .filter(({ mask }) => (values.statusBits & mask) !== 0)
      .map(({ code, message }) => ({
        code,
        severity: 'error' as const,
        message,
        details: { statusBits: values.statusBits },
      }));
    context.setHardwareDiagnostics(diagnostics);
    if (diagnostics.length > 0) {
      return {
        accepted: false,
        message: 'Ecobolt2 reported active hardware errors',
        details: { statusBits: values.statusBits },
        suppressDiagnostic: true,
      };
    }

    requireDatastream(context, 'failedOpen').acceptSample({
      timestamp: context.sourceTimestamp,
      value: (values.statusBits & 32_768) !== 0 ? 1 : 0,
    });
    requireDatastream(context, 'active').acceptSample({
      timestamp: context.sourceTimestamp,
      value: (values.statusBits & 16_384) === 0 ? 1 : 0,
    });
    requireDatastream(context, 'trapTemp').acceptSample({
      timestamp: context.sourceTimestamp,
      value: values.trapTemp,
    });
    requireDatastream(context, 'losses').acceptSample({
      timestamp: context.sourceTimestamp,
      value: values.losses,
    });
    return { accepted: true };
  }
}

export const sxsEcobolt2DevicePlugin: DevicePlugin<
  Record<string, never>,
  Record<string, never>,
  DevicePayloadParser
> = {
  kind: 'device',
  type: SXSECOBOLT2_TYPE,
  version: 1,
  displayName: 'SxS Ecobolt2',
  datastreams: SXSECOBOLT2_DATASTREAMS,
  settingsSchema: { type: 'object', additionalProperties: false },
  defaultSettings: {},
  create: () => new SxSEcobolt2Parser(),
};
