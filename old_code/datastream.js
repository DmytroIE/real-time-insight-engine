
import { Device } from './device.js';
import { global } from './constants.js';
import { eventBus } from './eventBus.js';


class Datastream {

    /**
     * A map of all datastream instances, keyed by their IDs.
     */
    static instanceMap = {};

    /**
     * 
     * @param {string} name - the name of the datastream, i.e. "pressure1"
     * @param {Device} device - the device to which this datastream belongs
     * @param {number} maxBuffLength - the maximum number of values to keep in the buffer
     * @param {number} maxBuffInterval - the maximum time interval (in milliseconds) to keep values in the buffer
     * @param {number} updInterval - the expected time interval (in milliseconds) for new data to arrive
     * @param {Object} state - an object to store persistent state data, such as update timestamps and the value buffer
     */
    constructor(
        name,
        device,
        maxBuffLength,
        maxBuffInterval,
        updInterval,
        state
    ) {
        this.name = name;
        this.parent = device;
        this.id = `${this.parent.name}/${this.name}`;
        this.maxBuffLength = Math.max(maxBuffLength, 2);
        this.maxBuffInterval = maxBuffInterval;
        this.updInterval = updInterval; // time interval in milliseconds for new data to come

        this.state = state;
        this.state.lastUpdTs = this.state.lastUpdTs ?? 0;
        this.state.nextUpdTs = this.state.lastUpdTs + this.updInterval * global.get("INTERVAL_MARGIN_COEFFICIENT");
        this.state.valBuffer = this.state.valBuffer ?? []; // [{ t: timestamp, v: value }]
        this.state.noDataError = this.state.noDataError ?? false; // when the buffer is empty for a long time
        this.state.hwError = this.state.hwError ?? false; // when the datastream reports an error

        Datastream.instanceMap[this.id] = this;
        this.parent.addDatastream(this);
    }

    get hasError() {
        return this.state.hwError || this.state.noDataError;
    }

    /**
     * Returns an array of values within the specified time range.
     * @param {number|null} timeStart 
     * @param {number|null} timeEnd 
     * @returns {Array<{t: number, v: number}>}
     */
    getValues(timeStart = 0, timeEnd = Infinity) {
        return this.state.valBuffer.filter(
            (x) => x.t >= timeStart && x.t <= timeEnd); // [{ t: timestamp, v: value }]
    }

    /**
     * Returns the last value within the specified time range, or null if no values exist in that range.
     * @param {number|null} timeStart
     * @param {number|null} timeEnd 
     * @returns {{t: number, v: number}|null}
     */
    getLastValue(timeStart = 0, timeEnd = Infinity) {
        const filteredValues = this.getValues(timeStart, timeEnd);
        if (filteredValues.length === 0) {
            return null;
        }
        return filteredValues[filteredValues.length - 1]; // { t: timestamp, v: value } or null
    }

    /**
     * Returns the average value within the specified time range, or null if no values exist in that range.
     * The returned object contains the average value and the timestamp of the last value in the range.
     * @param {number|null} timeStart
     * @param {number|null} timeEnd 
     * @returns {{t: number, v: number}|null}
     */
    getAvgValue(timeStart = 0, timeEnd = Infinity) {
        const filteredValues = this.getValues(timeStart, timeEnd);
        if (filteredValues.length === 0) {
            return null;
        }
        const sum = filteredValues.reduce((acc, curr) => acc + curr.v, 0);
        return {
            v: sum / filteredValues.length,
            t: filteredValues[filteredValues.length - 1].t
        }; // { t: timestamp of the last value, v: average value } or null
    }

    /**
     * Updates the value buffer with a new timestamp and value, and manages the buffer size 
     * by removing old values based on maxBuffLength and maxBuffInterval.
     * @param {number|null} ts 
     * @param {number|null} val
     */
    update(ts = null, val = null) {

        const nowTs = Date.now();

        if (ts != null && val != null) {
            this.state.valBuffer.push({ t: ts, v: val });
            this.state.valBuffer.sort((a, b) => a.t - b.t);
        }
        const cutoffTime = nowTs - this.maxBuffInterval;
        // Remove values older than the cutoff time
        this.state.valBuffer = this.state.valBuffer.filter(x => x.t >= cutoffTime);
        // Ensure the buffer does not exceed the maximum length
        if (this.state.valBuffer.length >= this.maxBuffLength) {
            this.state.valBuffer.splice(0, this.state.valBuffer.length - this.maxBuffLength);
        }

        const sessionStartTs = global.get("sessionStartTs") ?? 0;
        if (this.state.valBuffer.length == 0) {
            if (nowTs - sessionStartTs > this.updInterval * global.get("INTERVAL_MARGIN_COEFFICIENT")) {
                eventBus.emit(
                    "log",
                    {
                        instance: this,
                        timestamp: nowTs,
                        payload: { "Buffer empty": { level: "e" } }
                    }
                );
                this.state.noDataError = true;
            }
        }
        else {
            eventBus.emit(
                "log",
                {
                    instance: this,
                    timestamp: nowTs,
                    payload: {
                        "Buffer empty": { level: null } }
                }
            );
            this.state.noDataError = false;
        }
        this.state.lastUpdTs = nowTs;
        this.state.nextUpdTs = nowTs + this.updInterval * global.get("INTERVAL_MARGIN_COEFFICIENT");
        eventBus.emit('updated', { instance: this, timestamp: nowTs });
        this.parent.update();
    }

    /**
     * Returns 'maxNum' datastreams with the smallest next update timestamp
     * below or equal to 'nowTs', sorted in ascending order of next update timestamp
     * , or null if no datastreams exist or none are due for update
     * @param {number} nowTs - The current timestamp in milliseconds
     * @param {number} maxNum - The maximum number of datastreams to return
     * @returns {Datastream[]}
     */
    static getDssWithSmallestNextUpdTs(nowTs, maxNum = 3) {
        const instances = Object.values(Datastream.instanceMap);
        if (instances.length === 0) return [];
        const dssDueForUpdate = instances.filter(ds => ds.state.nextUpdTs <= nowTs);
        if (dssDueForUpdate.length === 0) return [];
        dssDueForUpdate.sort((a, b) => a.state.nextUpdTs - b.state.nextUpdTs);
        return dssDueForUpdate.slice(0, maxNum);
    }
}

export { Datastream };