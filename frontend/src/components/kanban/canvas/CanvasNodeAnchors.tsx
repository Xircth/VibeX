import { Handle, Position } from '@xyflow/react';

const ANCHOR_CLASS = 'canvas-edge-anchor';

export function CanvasNodeAnchors() {
  return (
    <>
      <Handle
        type="source"
        position={Position.Right}
        className={ANCHOR_CLASS}
        isConnectable={false}
      />
      <Handle
        type="target"
        position={Position.Left}
        className={ANCHOR_CLASS}
        isConnectable={false}
      />
    </>
  );
}
