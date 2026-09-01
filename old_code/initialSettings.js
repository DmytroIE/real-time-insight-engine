import { EnlessTwinTempKit } from "./EnlessTwinTempKit.js";
import { TwinTempFailedClosed } from "./TwinTempFailedClosed.js";


const initialSettings = {
    devices: {
        "Device 1": {
            type: EnlessTwinTempKit, // required field
            datastreams: {
                "temp1": {
                    maxBuffLength: 6,
                    maxBuffInterval: 60000,
                    updInterval: 10000,
                },
                "temp2": {
                    maxBuffLength: 6,
                    maxBuffInterval: 60000,
                    updInterval: 10000,
                },
            },
        },
        "Device 2": {
            type: EnlessTwinTempKit,
            datastreams: {
                "temp1": {
                    maxBuffLength: 9,
                    maxBuffInterval: 2400000,
                    updInterval: 800000,
                },
            }
        },
        "Device 3": {
            type: EnlessTwinTempKit,
        }
    },
    assets: {
        "Trap 1": {
            applications: [
                {
                    type: TwinTempFailedClosed, // required field
                    runInterval: 120000,
                    settings: {
                        tempDiffMargin: 0.4,
                        offThreshold: 70.0,
                        tempDiffThreshold: 40.0,
                        windowSize: 180000,
                    },
                    dfToDsMap: { // required field, mapping datafeed names to datastreams
                        "tempIn": { device: "Device 1", datastream: "temp1" },
                        "tempOut": { device: "Device 1", datastream: "temp2" },
                    }
                }],
        },
        "Trap 2": {
            applications: [
                {
                    type: TwinTempFailedClosed,
                    dfToDsMap: {
                        "tempIn": { device: "Device 2", datastream: "temp1" },
                        "tempOut": { device: "Device 2", datastream: "temp2" },
                    }
                },
            ]
        },
        "Trap 3": {
            applications: [
                {
                    type: TwinTempFailedClosed,
                    dfToDsMap: {
                        "tempIn": { device: "Device 3", datastream: "temp1" },
                        "tempOut": { device: "Device 3", datastream: "temp2" },
                    }
                },
            ]
        },
    }
};

export { initialSettings };