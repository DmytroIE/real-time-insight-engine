import { Device } from './device.js';
import { eventBus } from './eventBus.js';


class EnlessTwinTempKit extends Device {

    static validatePayload = (payload, device) => {
        const isValid = (
            payload &&
            payload.object &&
            typeof payload.object === 'object' &&
            payload.object.sensorType == 12 &&
            String(new Date(payload.gatewayTime)) !== "Invalid Date"
        );
        return isValid;
    }

    static parseDsPayload = (pld, ds) => {
        let ts = (new Date(pld.gatewayTime)).getTime();

        const value = pld.object[ds.name];
        ds.state.numFaultyValues = ds.state.numFaultyValues ?? 0;
        if (value < -100 || value > 400) {
            ds.state.numFaultyValues++;
        }
        else {
            ds.state.numFaultyValues = 0;
            ds.update(ts, value);
        }
        if (ds.state.numFaultyValues >= 3) { // three faulty measurements in a row
            eventBus.emit('log', {
                instance: ds,
                timestamp: ts,
                payload: { "Sensor broken": { level: "e", meta: { value } } }
            });
            ds.state.hwError = true;
        }
        else {
            eventBus.emit('log', {
                instance: ds,
                timestamp: ts,
                payload: {
                    "Sensor broken": { level: null }
                }
            });
            ds.state.hwError = false;
        }
    }

    static parsePayloadRules = {
        'temp1': (pld, ds) => {
            EnlessTwinTempKit.parseDsPayload(pld, ds);
        },
        'temp2': (pld, ds) => {
            EnlessTwinTempKit.parseDsPayload(pld, ds);
        },
    }
}

export { EnlessTwinTempKit };