import {
  ProcessState,
  asPluginTypeId,
  type ApplicationDatastream,
  type ApplicationEvaluationContext,
  type ApplicationEvaluator,
  type ApplicationPlugin,
  type ApplicationResult,
} from '@sxs/industrial-core';

export const ECOBOLT2_FAILED_OPEN_TYPE = asPluginTypeId('sxs.ecobolt2-failed-open');
export const ECOBOLT2_FAILED_OPEN_DATAFEEDS = [
  'failedOpen',
  'active',
  'trapTemp',
  'losses',
] as const;

export interface Ecobolt2FailedOpenSettings {
  readonly windowSizeMs: number;
}

export enum Ecobolt2OperatingState {
  Undefined = 0,
  Inactive = 1,
  Active = 2,
}

export interface Ecobolt2FailedOpenState {
  readonly operState: Ecobolt2OperatingState;
  readonly trapTemp: number | null;
  readonly losses: number | null;
}

export const ecobolt2FailedOpenDefaultSettings: Ecobolt2FailedOpenSettings = {
  windowSizeMs: 3_600_000,
};

export const ecobolt2FailedOpenDefaultState: Ecobolt2FailedOpenState = {
  operState: Ecobolt2OperatingState.Undefined,
  trapTemp: null,
  losses: null,
};

const settingsSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['windowSizeMs'],
  properties: {
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
  settings: Ecobolt2FailedOpenSettings,
  context: ApplicationEvaluationContext<Ecobolt2FailedOpenState>,
): ApplicationResult<Ecobolt2FailedOpenState> => {
  const range = {
    startTimestamp: context.timestamp - settings.windowSizeMs,
    endTimestamp: context.timestamp,
  };
  const failedOpen = requireDatafeed(context.datafeeds, 'failedOpen').lastValue(range);
  const active = requireDatafeed(context.datafeeds, 'active').lastValue(range);
  const trapTemp = requireDatafeed(context.datafeeds, 'trapTemp').lastValue(range);
  const losses = requireDatafeed(context.datafeeds, 'losses').lastValue(range);

  if (failedOpen === null || active === null || trapTemp === null || losses === null) {
    const noDataError =
      context.timestamp - context.sessionStartTs >= settings.windowSizeMs || context.noDataError;
    if (noDataError) {
      context.diagnostics.report({
        code: 'NO_DATA',
        severity: 'error',
        message: 'Required Ecobolt2 values are unavailable',
      });
    }
    return {
      pluginState: ecobolt2FailedOpenDefaultState,
      currState: ProcessState.Undefined,
      noDataError,
      appError: false,
    };
  }

  return {
    pluginState: {
      operState:
        active.value !== 0 ? Ecobolt2OperatingState.Active : Ecobolt2OperatingState.Inactive,
      trapTemp: trapTemp.value,
      losses: losses.value,
    },
    currState: failedOpen.value !== 0 ? ProcessState.Warning : ProcessState.Ok,
    noDataError: false,
    appError: false,
  };
};

class Ecobolt2FailedOpenEvaluator implements ApplicationEvaluator<Ecobolt2FailedOpenState> {
  readonly #settings: Ecobolt2FailedOpenSettings;

  public constructor(settings: Ecobolt2FailedOpenSettings) {
    this.#settings = settings;
  }

  public evaluate(
    context: ApplicationEvaluationContext<Ecobolt2FailedOpenState>,
  ): ApplicationResult<Ecobolt2FailedOpenState> {
    return evaluate(this.#settings, context);
  }
}

export const ecobolt2FailedOpenApplicationPlugin: ApplicationPlugin<
  Ecobolt2FailedOpenSettings,
  Ecobolt2FailedOpenState,
  ApplicationEvaluator<Ecobolt2FailedOpenState>
> = {
  kind: 'application',
  type: ECOBOLT2_FAILED_OPEN_TYPE,
  version: 1,
  displayName: 'Ecobolt2 Failed Open',
  requiredDatafeeds: ECOBOLT2_FAILED_OPEN_DATAFEEDS,
  settingsSchema,
  defaultSettings: ecobolt2FailedOpenDefaultSettings,
  defaultState: ecobolt2FailedOpenDefaultState,
  create: ({ settings }) => new Ecobolt2FailedOpenEvaluator(settings),
};
