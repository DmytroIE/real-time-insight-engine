import { TwinTempFailedClosed } from "./TwinTempFailedClosed.js";

// this object should have all settings for each application/device type
const defaultSettings = {
    TwinTempFailedClosed: {
        type: TwinTempFailedClosed,
        runInterval: 600000, // milliseconds
        appSettings: {
            tempDiffMargin: 0.5,
            offThreshold: 80.0,
            tempDiffThreshold: 30.0,
            windowSize: 1800000,
        },
        dsToDfSettings: {
            "tempIn": { // the datastream connected to the "tempIn" datafeed should have these settings
                maxBuffLength: 5,
                maxBuffInterval: 1800000,
                updInterval: 600000,
            },
            "tempOut": { // the datastream connected to the "tempOut" datafeed should have these settings
                maxBuffLength: 5,
                maxBuffInterval: 1800000,
                updInterval: 600000,
            }
        }
    },
};

export { defaultSettings };