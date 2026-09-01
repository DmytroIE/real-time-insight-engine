import { eventBus } from './eventBus.js';
import { Application } from './application.js';

class Asset {

    /**
     * A map of all asset instances, keyed by their IDs.
     */
    static instanceMap = {};

    /**
     * 
     * @param {string} name - asset's name
     * @param {Object} state - asset's initial state connected to persistent storage
     */
    constructor(
        name,
        state
    ) {
        this.name = name;
        this.id = name;

        this.appMap = {};

        this.state = state; // state can be used to store any persistent data between runs
        this.state.currState = this.state.currState ?? 0;
        this.state.error = this.state.error ?? false;
        this.state.lastUpdateTs = this.state.lastUpdateTs ?? 0;

        Asset.instanceMap[this.id] = this;
    }

    /**
     * Adds an application to the asset's application map.
     * @param {Application} application 
     */
    addApplication(application) {
        this.appMap[application.id] = application;
    }

    /**
     * Updates the asset's state immediately based on its applications' states.
     * This method is called internally by the `update` method.
     */
    _update() {
        // reset first the state values
        this.state.currState = 0;
        this.state.error = false;

        Object.values(this.appMap).forEach(app => {
            if (app.state.currState > this.state.currState) {
                this.state.currState = app.state.currState;
            }
            if (app.state.appError || app.state.noDataError) {
                this.state.error = true;
            }
        });
        this.state.lastUpdateTs = Date.now();
        const nowTs = Date.now();
        eventBus.emit('updated', { instance: this, timestamp: nowTs });
    }

    /**
     * Updates the asset's state based on its applications' states.
     * This method schedules an update to run after 1 second to avoid multiple updates in a short time.
     */
    update() {
        if (this.timerId === undefined) {
            // schedule the update to run after 1 second to avoid multiple updates in a short time
            this.timerId = setTimeout(() => {
                this._update();
                this.timerId = undefined;
            }, 1000);
        }
    }
}

export { Asset };
