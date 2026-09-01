import { Device } from './device.js';
import { eventBus } from './eventBus.js';


class EnlessTwinTempKit extends Device {

    static validatePayload = (payload, device) => {
        const isValid = (
            payload &&
            payload.object &&
            typeof payload.object === 'object' &&
            payload.object.sensorType == 12 &&
            "time" in payload &&
            !isNaN(new Date(payload.time).getTime())
        );
        return isValid;
    }

    static parseDsPayload = (pld, ds) => {
        let ts = (new Date(pld.time)).getTime();

        const value = pld.object[ds.name];
        if (value < -100 || value > 400) {
            eventBus.emit('log', {
                instance: ds,
                timestamp: ts,
                payload: { "Sensor broken": { level: "e", meta: { value } } }
            });
            ds.state.hwError = true;
        }
        else {
            ds.update(ts, value);
            eventBus.emit('log', {
                instance: ds,
                timestamp: ts,
                payload: { "Sensor broken": null }
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