import { Datastream } from './datastream.js';
import { eventBus } from './eventBus.js';


class Device {

    /**
     * Abstract method to validate the incoming payload. Must be implemented in the subclass.
     * @param {Object} payload 
     * @param {Device} device
     * @returns {boolean} - Returns true if the payload is valid for this device, false otherwise.
     */
    static validatePayload = (payload, device) => {
        throw new Error("Abstract method 'validatePayload' must be implemented in the subclass.");
    }
    /**
     * The set of rules (functions) for parsing incoming payloads.
     * Subclasses should override this to provide device-specific and datastream-specific parsing logic.
     * Should look like this:
     * {
     *     'self': (payload, device) => { ... },
     *     'datastreamName': (payload, datastream) => { ... },
     *     ...
     * }
     */
    static parsePayloadRules = {};
    /**
     * Returns the names of the required datastreams.
     * @returns {Array<string>} - An array of required datastream names.
     */
    static getRequiredDatastreamNames() {
        return Object.keys(this.parsePayloadRules).filter(key => key !== 'self');
    }
    /**
     * A map of all device instances, keyed by their IDs.
     */
    static instanceMap = {};

    /**
     * 
     * @param {string} name - The name of the device.
     * @param {Object} state - The initial state of the device connected to persistent storage.
     */
    constructor(
        name,
        state
    ) {
        if (this.constructor === Device) {
            throw new Error("Abstract class 'Device' cannot be instantiated directly.");
        }
        this.name = name;
        this.id = name;
        this.dsMap = {};

        this.state = state; // state can be used to store any persistent data between runs
        this.state.lastUpdTs = this.state.lastUpdTs ?? 0;
        this.state.chldError = this.state.chldError ?? false;
        this.state.hwError = this.state.hwError ?? false; // error that belongs to the device itself, not to any of its datastreams

        Device.instanceMap[this.id] = this;
    }

    get hasError() {
        return this.state.hwError || this.state.chldError;
    }

    /**
     * Adds a datastream to the device's datastream map.
     * @param {Datastream} datastream - instance of the Datastream class to be added to the device
     */
    addDatastream(datastream) {
        this.dsMap[datastream.name] = datastream;
    }

    /**
     * Parses the incoming payload according to the device's parsePayloadRules.
     * @param {Object} payload - The incoming payload object to be parsed.
     */
    parsePayload(payload) {
        if (!this.constructor.validatePayload(payload, this)) {
            eventBus.emit(
                "log",
                {
                    instance: this,
                    timestamp: Date.now(),
                    payload: { "Invalid payload": { level: "e", meta: payload } }
                }
            );
            return;
        }
        eventBus.emit(
            "log",
            {
                instance: this,
                timestamp: Date.now(),
                payload: {
                    "Invalid payload": { level: null } }
            }
        );
        for (const [key, parseFunction] of Object.entries(this.constructor.parsePayloadRules)) {
            const instance = key === 'self' ? this : this.dsMap[key];
            parseFunction(payload, instance);
        }
    }

    /**
     * Updates the device's state immediately based on its own error state and the states of its datastreams.
     * This method is called internally by the `update` method.
     */
    _update() {
        // check the datastreams for errors
        this.state.chldError = false;
        for (const ds of Object.values(this.dsMap)) {
            if (ds.hasError) {
                this.state.chldError = true;
                break;
            }
        }
        
        this.state.lastUpdTs = Date.now();
        const nowTs = Date.now();
        eventBus.emit('updated', { instance: this, timestamp: nowTs });
    }

    /**
     * Updates the device's state based on its own error state and the states of its datastreams.
     * This method schedules an update to run after 1 second to avoid multiple updates in a short time.
     */
    update() {
        if (this.timerId === undefined) {
            // schedule the update to run after 1 second to avoid multiple rapid updates
            this.timerId = setTimeout(() => {
                this._update();
                this.timerId = undefined;
            }, 1000);
        }
    }
}

export { Device };
