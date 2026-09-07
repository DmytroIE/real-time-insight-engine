import { Asset } from "./asset.js";
import { Datastream } from "./datastream.js";
import { eventBus } from "./eventBus.js";

class Application {

    static instanceMap = {};
    /**
     * The name of the application.
     * Subclasses should override this to provide a meaningful name.
     */
    static APPNAME = "Abstract Application";
    /**
     * The list of required datafeeds for the application.
     * Subclasses should override this to specify the datafeeds they depend on.
     */
    static requiredDatafeeds = [];
    /**
     * The list of required settings for the application.
     * Subclasses should override this to specify the settings they depend on.
     */
    static requiredSettings = [];
    /**
     * The default state for the application.
     * Subclasses should override this to include application-specific state properties and their default values.
     */
    static defaultState = {};

    /**
     * 
     * @param {Asset} asset - instance of the Asset class
     * @param {number} runInterval - the interval at which the application should run
     * @param {Object} settings - application settings
     * @param {Object} state - application state, connected to persistent storage
     * @param {{[key: string]: Datastream}} dsMap - mapping of datafeed names to datastreams
     * 
     */
    constructor(
        asset,
        runInterval,
        settings,
        state,
        dsMap
    ) {
        if (this.constructor === Application) {
            throw new Error("Abstract class 'Application' cannot be instantiated directly.");
        }
        this.dsMap = dsMap; // mapping of datafeed names to datastream instances

        this.name = this.constructor.APPNAME;
        this.id = `${asset.name}/${this.constructor.APPNAME}`;
        this.parent = asset;
        this.runInterval = runInterval;

        this.settings = settings;

        this.state = state; // state can be used to store any persistent data between runs

        // this items are in every app state
        this.state.lastUpdTs = this.state.lastUpdTs ?? 0;
        this.state.nextUpdTs = this.state.lastUpdTs + this.runInterval;
        this.state.currState = this.state.currState ?? 0; // 0: Undefined, 1: OK, 2: Warning, 3: Error
        this.state.noDataError = this.state.noDataError ?? false;
        this.state.appError = this.state.appError ?? false;

        // this function adds to the state the items that are specific to the application type
        // Redefine "defaultState" in the subclasses 
        // to include application-specific state properties and their default values
        this.applyDefaultState();

        Application.instanceMap[this.id] = this;
        this.parent.addApplication(this);

    }

    get hasError() {
        return this.state.appError || this.state.noDataError;
    }

    /**
     * Check for missing required state properties and substitute missing ones with default values
     * without overwriting the existing state object
     */
    applyDefaultState() {
        for (const [key, defaultValue] of Object.entries(this.constructor.defaultState)) {
            if (this.state[key] === undefined) {
                this.state[key] = defaultValue;
            }
        }
    }

    /**
     * A template method that contains the common logic for running an application, including error handling and logging.
     * The specific application logic should be implemented in the "execute" method of the subclass.
     */
    run() {
        const nowTs = Date.now();
        // Throttle (check if the interval has elapsed)
        if (nowTs < this.state.nextUpdTs) {
            //console.log("Throttled");
            return;
        }

        // updtate the last and next run timestamps before executing the application logic
        this.state.lastUpdTs = nowTs;
        this.state.nextUpdTs = nowTs + this.runInterval;

        // reset all the common values in the state
        this.state.currState = 0;
        this.state.noDataError = false;
        this.state.appError = false;

        for (const dfName in this.dsMap) {
            this.dsMap[dfName].update();
        }
        // 2. Delegate specialized logic to the subclass
        try {
            this._execute(nowTs);
            eventBus.emit(
                "log",
                {
                    instance: this,
                    timestamp: nowTs,
                    payload: {
                        "Error executing application": { level: null }
                    }
                });
        } catch (error) {
            // 3. Common Error Handling / Logging
            this.state.appError = true;
            eventBus.emit(
                "log",
                {
                    instance: this,
                    timestamp: nowTs,
                    payload: { "Error executing application": { level: "e", meta: error.message } }
                });
        }
        eventBus.emit("updated", { instance: this, timestamp: nowTs });
        this.parent.update();
    }

    /**
     * An abstract method. Must be implemented by subclasses to define specific application logic.
     * This method is called internally by the `run` method to execute the application's specific logic.
     * @param {number} nowTs - The current timestamp in milliseconds.
     */
    _execute(nowTs = Date.now()) {
        throw new Error(`Abstract method "_execute()" must be implemented in ${this.constructor.name}`);
    }

    /**
     * Returns "maxNum" applications with the smallest next run timestamp
     * below or equal to "nowTs", sorted in ascending order of next run timestamp
     * , or null if no applications exist or none are due for execution
     * @param {number} nowTs - The current timestamp in milliseconds
     * @param {number} maxNum - The maximum number of applications to return
     * @returns {Application[]}
     */
    static getAppsWithSmallestNextUpdTs(nowTs, maxNum = 3) {
        const instances = Object.values(Application.instanceMap);
        if (instances.length === 0) return [];
        const appsDueForUpdate = instances.filter(app => app.state.nextUpdTs <= nowTs);
        if (appsDueForUpdate.length === 0) return [];
        appsDueForUpdate.sort((a, b) => a.state.nextUpdTs - b.state.nextUpdTs);
        return appsDueForUpdate.slice(0, maxNum);
    }
}


export { Application };