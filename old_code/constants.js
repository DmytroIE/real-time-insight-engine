class GlobalStorage extends Map {
    constructor() {
        super();
    }
    /**
     * Mimics the behavior of Nodered's 'global.get' method that allows for an array of keys to be passed in.
     * @param {string|Array<string>} keys 
     */
    get(keys) {
        if (Array.isArray(keys)) {
            return keys.map(key => super.get(key));
        }
        return super.get(keys);
    }
}


const global = new GlobalStorage();
global.set("sessionStartTs", Date.now());
global.set("INTERVAL_MARGIN_COEFFICIENT", 1.5); // to account for some delays in data arrival

export { global };