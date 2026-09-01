import type { Node, NodeAPI, NodeDef } from 'node-red';

export const registerScaffoldNode = (RED: NodeAPI, type: string): void => {
  function ScaffoldNode(this: Node, config: NodeDef): void {
    RED.nodes.createNode(this, config);
  }

  RED.nodes.registerType(type, ScaffoldNode);
};
