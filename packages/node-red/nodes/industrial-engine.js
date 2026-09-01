'use strict';

const {
	createIndustrialPluginRegistry,
	registerIndustrialEngineNode,
} = require('../dist/index.js');

module.exports = (RED) => {
	registerIndustrialEngineNode(RED, {
		createPluginRegistry: createIndustrialPluginRegistry,
	});
};