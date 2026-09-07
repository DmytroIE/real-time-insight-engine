import { Application } from './application.js';
import { global } from './constants.js';
import { eventBus } from './eventBus.js';


class TwinTempFailedClosed extends Application {

    static APPNAME = "Twin Temp Failed Closed";
    static requiredDatafeeds = ["tempIn", "tempOut"];
    static requiredSettings = [
        "tempDiffMargin",
        "offThreshold",
        "tempDiffThreshold",
        "windowSize"
    ];
    static defaultState = { // specific to this application type
        operState: 0, // 0: Undefined, 1: Off, 2: On
        tempInAvg: null,
        tempOutAvg: null,
    };

    _execute(nowTs = Date.now()) {

        // reset values that belong to this particular application type
        this.state.operState = 0;

        // get settings
        const tempDiffMargin = this.settings.tempDiffMargin;
        const offThreshold = this.settings.offThreshold;
        const tempDiffThreshold = this.settings.tempDiffThreshold;
        const windowSize = this.settings.windowSize;

        // get average values for tempIn and tempOut over the last runInterval
        const tempInAvg = this.dsMap["tempIn"].getAvgValue(nowTs - windowSize, nowTs);
        const tempOutAvg = this.dsMap["tempOut"].getAvgValue(nowTs - windowSize, nowTs);


        const sessionStartTs = global.get("sessionStartTs") ?? 0;
        const logPayload = {
            "No data available": { level: null },
            "Temp out > Temp in": { level: null },
            "Trap is off": { level: null },
        };
        const assetLogPayload = {
            "Failed closed": { level: null }
        };
        if (tempInAvg == null || tempOutAvg == null) {
            if (nowTs - sessionStartTs > windowSize) {
                this.state.noDataError = true;
                logPayload["No data available"] = { level: "e" };
            }
        }
        else {
            if (tempOutAvg.v - tempInAvg.v > tempDiffMargin) {
                this.state.appError = true;
                logPayload["Temp out > Temp in"] = { level: "e" };
            }
            else {
                if (tempInAvg.v < offThreshold) {
                    this.state.operState = 1; // Off
                }
                else {
                    this.state.operState = 2; // On
                    if (tempInAvg.v - tempOutAvg.v > tempDiffThreshold) {
                        this.state.currState = 2; // Warning
                        assetLogPayload["Failed closed"] = { level: "w" };
                    }
                    else {
                        this.state.currState = 1; // OK
                    }
                }
            }
        }
        this.state.tempInAvg = tempInAvg ? tempInAvg.v : null;
        this.state.tempOutAvg = tempOutAvg ? tempOutAvg.v : null;

        eventBus.emit(
            "log",
            {
                instance: this,
                timestamp: nowTs,
                payload: logPayload
            }
        );
        eventBus.emit(
            "log",
            {
                instance: this.parent,
                timestamp: nowTs,
                payload: assetLogPayload
            }
        );
    }
}


export { TwinTempFailedClosed };