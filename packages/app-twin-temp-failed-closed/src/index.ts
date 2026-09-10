import {
  ProcessState,
  asPluginTypeId,
  type ApplicationDatastream,
  type ApplicationEvaluationContext,
  type ApplicationEvaluator,
  type ApplicationPlugin,
  type ApplicationResult,
} from '@sxs/industrial-core';

export const TWIN_TEMPERATURE_FAILED_CLOSED_TYPE = asPluginTypeId('sxs.twin-temp-failed-closed');
export const TWIN_TEMPERATURE_FAILED_CLOSED_DATAFEEDS = ['tempIn', 'tempOut'] as const;

export interface TwinTemperatureFailedClosedSettings {
  readonly tempDiffMargin: number;
  readonly offThreshold: number;
  readonly tempDiffThreshold: number;
  readonly windowSizeMs: number;
}

export enum OperatingState {
  Undefined = 0,
  Off = 1,
  On = 2,
}

export interface TwinTemperatureFailedClosedState {
  readonly operState: OperatingState;
  readonly tempInAvg: number | null;
  readonly tempOutAvg: number | null;
}

export const twinTemperatureFailedClosedDefaultSettings: TwinTemperatureFailedClosedSettings = {
  tempDiffMargin: 0.5,
  offThreshold: 80,
  tempDiffThreshold: 30,
  windowSizeMs: 1_800_000,
};

export const twinTemperatureFailedClosedDefaultState: TwinTemperatureFailedClosedState = {
  operState: OperatingState.Undefined,
  tempInAvg: null,
  tempOutAvg: null,
};

const settingsSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['tempDiffMargin', 'offThreshold', 'tempDiffThreshold', 'windowSizeMs'],
  properties: {
    tempDiffMargin: { type: 'number', minimum: 0 },
    offThreshold: { type: 'number' },
    tempDiffThreshold: { type: 'number', minimum: 0 },
    windowSizeMs: { type: 'number', exclusiveMinimum: 0 },
  },
} as const;

const requireDatafeed = (
  datafeeds: Readonly<Record<string, ApplicationDatastream>>,
  name: string,
): ApplicationDatastream => {
  const datafeed = datafeeds[name];
  if (datafeed === undefined) {
    throw new Error(`Missing required datafeed: ${name}`);
  }
  return datafeed;
};

const evaluate = (
  settings: TwinTemperatureFailedClosedSettings,
  context: ApplicationEvaluationContext<TwinTemperatureFailedClosedState>,
): ApplicationResult<TwinTemperatureFailedClosedState> => {
  const tempIn = requireDatafeed(context.datafeeds, 'tempIn');
  const tempOut = requireDatafeed(context.datafeeds, 'tempOut');
  const range = {
    startTimestamp: context.timestamp - settings.windowSizeMs,
    endTimestamp: context.timestamp,
  };
  const tempInAvg = tempIn.averageValue(range);
  const tempOutAvg = tempOut.averageValue(range);
  const state: TwinTemperatureFailedClosedState = {
    operState: OperatingState.Undefined,
    tempInAvg: tempInAvg?.value ?? null,
    tempOutAvg: tempOutAvg?.value ?? null,
  };

  if (tempInAvg === null || tempOutAvg === null) {
    const noDataError =
      context.timestamp - context.sessionStartTs >= settings.windowSizeMs || context.noDataError;
    if (noDataError) {
      context.diagnostics.report({
        code: 'NO_DATA',
        severity: 'error',
        message: 'Required temperature averages are unavailable',
      });
    }
    return {
      pluginState: state,
      currState: ProcessState.Undefined,
      noDataError,
      appError: false,
    };
  }

  if (tempOutAvg.value - tempInAvg.value > settings.tempDiffMargin) {
    context.diagnostics.report({
      code: 'TEMP_OUT_ABOVE_IN',
      severity: 'error',
      message: 'Outlet temperature exceeds inlet temperature beyond the allowed margin',
      details: {
        tempInAvg: tempInAvg.value,
        tempOutAvg: tempOutAvg.value,
        margin: settings.tempDiffMargin,
      },
    });
    return {
      pluginState: state,
      currState: ProcessState.Undefined,
      noDataError: false,
      appError: true,
    };
  }

  if (tempInAvg.value < settings.offThreshold) {
    return {
      pluginState: { ...state, operState: OperatingState.Off },
      currState: ProcessState.Undefined,
      noDataError: false,
      appError: false,
    };
  }

  if (tempInAvg.value - tempOutAvg.value > settings.tempDiffThreshold) {
    context.assetDiagnostics.report({
      code: 'FAILED_CLOSED',
      severity: 'warning',
      message: 'Temperature difference indicates a failed-closed condition',
      details: {
        tempInAvg: tempInAvg.value,
        tempOutAvg: tempOutAvg.value,
        threshold: settings.tempDiffThreshold,
      },
    });
    return {
      pluginState: { ...state, operState: OperatingState.On },
      currState: ProcessState.Warning,
      noDataError: false,
      appError: false,
    };
  }

  return {
    pluginState: { ...state, operState: OperatingState.On },
    currState: ProcessState.Ok,
    noDataError: false,
    appError: false,
  };
};

class TwinTemperatureFailedClosedEvaluator implements ApplicationEvaluator<TwinTemperatureFailedClosedState> {
  readonly #settings: TwinTemperatureFailedClosedSettings;

  public constructor(settings: TwinTemperatureFailedClosedSettings) {
    this.#settings = settings;
  }

  public evaluate(
    context: ApplicationEvaluationContext<TwinTemperatureFailedClosedState>,
  ): ApplicationResult<TwinTemperatureFailedClosedState> {
    return evaluate(this.#settings, context);
  }
}

export const twinTemperatureFailedClosedApplicationPlugin: ApplicationPlugin<
  TwinTemperatureFailedClosedSettings,
  TwinTemperatureFailedClosedState,
  ApplicationEvaluator<TwinTemperatureFailedClosedState>
> = {
  kind: 'application',
  type: TWIN_TEMPERATURE_FAILED_CLOSED_TYPE,
  version: 1,
  displayName: 'Twin Temperature Failed Closed',
  requiredDatafeeds: TWIN_TEMPERATURE_FAILED_CLOSED_DATAFEEDS,
  settingsSchema,
  defaultSettings: twinTemperatureFailedClosedDefaultSettings,
  defaultState: twinTemperatureFailedClosedDefaultState,
  create: ({ settings }) => new TwinTemperatureFailedClosedEvaluator(settings),
};
