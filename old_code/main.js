import { global } from "./constants.js";
import { Device } from "./device.js";
import { Datastream } from "./datastream.js";
import { Asset } from "./asset.js";
import { Application } from "./application.js";
import { initialSettings } from "./initialSettings.js";
import { defaultSettings } from "./defaultSettings.js";
import { eventBus } from "./eventBus.js";

global.set("baseClasses", {
    Device,
    Datastream,
    Asset,
    Application
});

try {
    // 1. Validate the initialSettings object and fill in any missing values with defaults
    // it is done once at the beginning of the program, so that the rest of the code can assume that all required properties are present and valid

    // 1.1. Validate the default settings for each application type
    for (const [appTypeName, appDefaultSettings] of Object.entries(defaultSettings)) {
        const appType = appDefaultSettings.type; // get the class constructor from the name
        if (!appType || !(appType.prototype instanceof Application)) {
            throw new Error(`Invalid application type: ${appTypeName}`);
        }

        if (!('runInterval' in appDefaultSettings) || typeof appDefaultSettings.runInterval !== 'number') {
            throw new Error(`Missing default 'runInterval' for application type: '${appTypeName}'`);
        }

        const appDefaultAppSettings = appDefaultSettings.appSettings;
        for (const reqSetting of appType.requiredSettings) {
            if (!(reqSetting in appDefaultAppSettings)) {
                throw new Error(`Missing default '${reqSetting}' for application '${appTypeName}'`);
            }
        }

        const appDefaultDsToDfSettings = appDefaultSettings.dsToDfSettings;
        for (const reqDf of appType.requiredDatafeeds) {
            if (!(reqDf in appDefaultDsToDfSettings) || typeof appDefaultDsToDfSettings[reqDf] !== 'object') {
                throw new Error(`Missing default datastream settings for required datafeed '${reqDf}' in application '${appTypeName}'`);
            }
            const defaultDsSettings = appDefaultDsToDfSettings[reqDf];
            if (!('maxBuffLength' in defaultDsSettings)) {
                throw new Error(`Missing default 'maxBuffLength' for datastream connected to datafeed '${reqDf}' in application '${appTypeName}'`);
            }
            if (!('maxBuffInterval' in defaultDsSettings)) {
                throw new Error(`Missing default 'maxBuffInterval' for datastream connected to datafeed '${reqDf}' in application '${appTypeName}'`);
            }
            if (!('updInterval' in defaultDsSettings)) {
                throw new Error(`Missing default 'updInterval' for datastream connected to datafeed '${reqDf}' in application '${appTypeName}'`);
            }
        }
    }

    // 1.2. Validate initial settings for each asset and its applications and
    // ensure all required settings and datafeeds are present for each application
    for (const [assetName, assetConfig] of Object.entries(initialSettings.assets)) {
        const appConfigs = assetConfig.applications ?? []; // assets may not have applications, so we default to an empty array if not present
        for (const appConfig of appConfigs) {

            // check required fields in the initialSettings object for each application
            if (!appConfig.type || !(appConfig.type.prototype instanceof Application)) {
                throw new Error(`Missing required 'type' field for application in asset ${assetName}.`);
            }
            if (!appConfig.dfToDsMap || typeof appConfig.dfToDsMap !== 'object') {
                throw new Error(`Missing required 'dfToDsMap' field for application ${appConfig.type.name} in asset ${assetName}.`);
            }
            for (const reqDf of appConfig.type.requiredDatafeeds) {
                if (!(reqDf in appConfig.dfToDsMap)) {
                    throw new Error(`Missing required datafeed '${reqDf}' for application ${appConfig.type.name} in asset ${assetName}.`);
                }
            }

            const appType = appConfig.type;
            const defaultAppSettings = defaultSettings[appType.name].appSettings;

            // merge default settings with provided initial settings, giving precedence to provided settings
            appConfig.settings = { ...defaultAppSettings, ...appConfig.settings };

            appConfig.runInterval = appConfig.runInterval ?? defaultSettings[appType.name].runInterval;

            // validate the datastream settings for each datafeed in the application
            // and fill in any missing values with defaults
            for (const [dfName, dsConfig] of Object.entries(appConfig.dfToDsMap)) {
                const deviceSettings = initialSettings.devices[dsConfig.device];
                const dsSettings = deviceSettings.datastreams ?? {};
                deviceSettings.datastreams = dsSettings;
                const defaultDsSettings = defaultSettings[appType.name].dsToDfSettings[dfName];
                const dsName = dsConfig.datastream;
                dsSettings[dsName] = { ...defaultDsSettings, ...dsSettings[dsName] };
            }
        }
    }

    // 1.3. Validate initial settings for each device and ensure all required datastreams are present
    for (const [deviceName, deviceConfig] of Object.entries(initialSettings.devices)) {
        if (!deviceConfig.type || !(deviceConfig.type.prototype instanceof Device)) {
            throw new Error(`Missing required 'type' field for device ${deviceName}.`);
        }
        if (!deviceConfig.datastreams || typeof deviceConfig.datastreams !== 'object') {
            throw new Error(`Missing required 'datastreams' field for device ${deviceName}.`);
        }
        const requiredDsNames = deviceConfig.type.getRequiredDatastreamNames();
        for (const reqDsName of requiredDsNames) {
            if (!(reqDsName in deviceConfig.datastreams)) {
                throw new Error(`Missing required datastream '${reqDsName}' for device ${deviceName}.`);
            }
        }
    }

    // 2. Get persistent state storages

    const baseClasses = global.get("baseClasses");
    const defaultStateStorage = {};
    for (const clsName of Object.keys(baseClasses)) {
        defaultStateStorage[clsName] = {}; 
    }
    let stateStorage = global.get("stateStorage");
    if (!stateStorage || typeof stateStorage !== 'object') {
        stateStorage = defaultStateStorage;
    }
    else {
        stateStorage = { ...defaultStateStorage, ...stateStorage };
    }
    
    global.set("stateStorage", stateStorage);
    stateStorage = global.get("stateStorage");

    // 3. Create datastreams + devices
    const devices = initialSettings.devices;
    for (const [deviceName, deviceConfig] of Object.entries(devices)) {
        let deviceState = stateStorage["Device"][deviceName];
        if (!deviceState || typeof deviceState !== 'object') {
            stateStorage["Device"][deviceName] = {};
            deviceState = stateStorage["Device"][deviceName];
        }
        const device = new deviceConfig.type(deviceName, deviceState);
        for (const [dsName, dsConfig] of Object.entries(deviceConfig.datastreams)) {
            const dsId = `${deviceName}/${dsName}`; 
            let dsState = stateStorage["Datastream"][dsId];
            if (!dsState || typeof dsState !== 'object') {
                stateStorage["Datastream"][dsId] = {};
                dsState = stateStorage["Datastream"][dsId];
            }
            new Datastream(
                dsName,
                device,
                dsConfig.maxBuffLength,
                dsConfig.maxBuffInterval,
                dsConfig.updInterval,
                dsState
            );
        }
    }

    // 4. Create assets and applications
    for (const [assetName, assetConfig] of Object.entries(initialSettings.assets)) {
        let assetState = stateStorage["Asset"][assetName];
        if (!assetState || typeof assetState !== 'object') {
            stateStorage["Asset"][assetName] = {};
            assetState = stateStorage["Asset"][assetName];
        }
        const asset = new Asset(assetName, assetState);
        const appConfigs = assetConfig.applications;
        for (const appConfig of appConfigs) {
            const appId = `${assetName}/${appConfig.type.APPNAME}`
            let appState = stateStorage["Application"][appId];
            if (!appState || typeof appState !== 'object') {
                stateStorage["Application"][appId] = {};
                appState = stateStorage["Application"][appId];
            }
            const dsMap = {};
            for (const [dfName, dsConfig] of Object.entries(appConfig.dfToDsMap)) {
                const deviceName = dsConfig.device;
                const dsName = dsConfig.datastream;
                const dsId = `${deviceName}/${dsName}`;
                const datastream = Datastream.instanceMap[dsId];
                dsMap[dfName] = datastream;
            }

            new appConfig.type(
                asset,
                appConfig.runInterval,
                appConfig.settings,
                appState,
                dsMap
            );
        }
    }

    // 5. Clean all obsolete instances from the state storage
    for (const [clsName, cls] of Object.entries(baseClasses)) {
        const clsInstanceIdSet = new Set(Object.keys(cls.instanceMap));
        const storageKeys = Object.keys(stateStorage[clsName]);
        const obsoletekeys = storageKeys.filter(x => !clsInstanceIdSet.has(x)); //set2.difference(set1);
        for (const key of obsoletekeys) {
            // console.log(`Deleting obsolete key: ${clsName} -> ${key}`);
            delete stateStorage[clsName][key];
        }
    }
    // 6. Set up logging for all instances - for testing purposes
    eventBus.on("log", (logEvent) => {
        const { instance, timestamp, payload } = logEvent;

        for (const [key, value] of Object.entries(payload)) {
            if (value !== null && value.level !== null) {
                console.log(`[${instance.id}] - [${new Date(timestamp).toISOString()}] - [${value.level}] - [${key}]\n`, JSON.stringify(value.meta, null, 2));
            }
        }

    });
} catch (error) {
    console.error("Error while setting up initial state:", error.message);
    process.exit(1); // exit the program with an error code
}



console.log("Initial setup completed successfully.");


// imitate Nodered flow by sending a payload every 10 seconds and running the application logic
// In a real application, the application execution cycle is ensured by a separate 'Inject' node that sends 
// payloads every 5 seconds. The datastream force update cycle has its own 'Inject' node that payloads every 5 seconds.
// In both cases, the static functions a-la get<Instances>WithSmallestNextUpdTs are called 
// to determine which instances need to be updated. 
// The application execution cycle, in addition, is throttled by the runInterval property of each application instance.
setInterval(() => {
    const payload = {
        deviceName: "Device 1",
        gatewayTime: new Date().toISOString(),
        object: {}
    }
    payload.object.temp1 = Math.random() / 2 * 1000;
    payload.object.temp2 = Math.random() / 2 * 1000;

    if (Math.random() < 0.9) {
        payload.object.sensorType = 12;
    }

    const dev1 = Device.instanceMap["Device 1"];
    dev1.parsePayload(payload);

    const app1 = Application.instanceMap["Trap 1/Twin Temp Failed Closed"];
    app1.run();
}, 10000);
