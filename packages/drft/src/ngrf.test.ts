import { describe, expect, it } from 'vitest';

import { DrftError, fourCC } from './drftFormat.ts';
import { readDrft } from './drftRead.ts';
import { writeDrft } from './drftWrite.ts';
import { buildNgrf, readNgrf, type DrftGraph } from './ngrf.ts';

/**
 * `NGRF`: a network as a graph of operators, and its tensors, in either precision.
 *
 * The chunk carries no semantics — this package knows nothing of what `linear` or `attention` mean,
 * and `@driftengine/texture` validates a graph it reads — so what is tested here is that the
 * structure and the numbers come back exactly, and that a corrupt chunk is refused before a reader
 * trusts an offset out of it.
 */

function graph(role = 'DEPT'): DrftGraph {
  return {
    role,
    inputs: [{ name: 'image', shape: [3, 4, 4] }],
    outputs: ['depth'],
    nodes: [
      {
        op: 'conv2d',
        inputs: ['image', 'w', 'b'],
        output: 'depth',
        attributes: { stride: 2, padding: 0 },
      },
    ],
    tensors: [
      { name: 'w', shape: [1, 3, 2, 2], data: Float32Array.from({ length: 12 }, (_, i) => i / 8) },
      /* Half-precision bits, as a device uploads them: 1.0 is 0x3c00. */
      { name: 'b', shape: [1], data: Uint16Array.from([0x3c00]) },
    ],
  };
}

describe('the NGRF chunk', () => {
  it('ROUND-TRIPS A GRAPH: its structure, and every tensor in its own precision', () => {
    const bytes = buildNgrf([graph()]);
    const [back] = readNgrf(bytes.buffer as ArrayBuffer, bytes.byteOffset, bytes.byteLength);
    expect(back?.role).toBe('DEPT');
    expect(back?.inputs).toEqual([{ name: 'image', shape: [3, 4, 4] }]);
    expect(back?.outputs).toEqual(['depth']);
    expect(back?.nodes).toEqual(graph().nodes);
    const w = back?.tensors.find((tensor) => tensor.name === 'w');
    const b = back?.tensors.find((tensor) => tensor.name === 'b');
    expect(w?.data).toBeInstanceOf(Float32Array);
    expect(Array.from(w?.data ?? [])).toEqual(Array.from(graph().tensors[0]?.data ?? []));
    expect(b?.data).toBeInstanceOf(Uint16Array);
    expect(Array.from(b?.data ?? [])).toEqual([0x3c00]);
  });

  it('REFUSES A TENSOR WHOSE VALUES DISAGREE WITH ITS SHAPE', () => {
    const bad: DrftGraph = {
      ...graph(),
      tensors: [{ name: 'w', shape: [1, 3, 2, 2], data: new Float32Array(11) }],
    };
    expect(() => buildNgrf([bad])).toThrow(DrftError);
    expect(() => buildNgrf([bad])).toThrow(/w/);
  });

  it('refuses two graphs with one role, which a reader finds a graph by', () => {
    expect(() => buildNgrf([graph('DEPT'), graph('DEPT')])).toThrow(/DEPT/);
  });

  it('REFUSES A TENSOR WHOSE BYTES RUN PAST THE PAYLOAD, before trusting the offset', () => {
    const bytes = buildNgrf([graph()]);
    /* The payload length is the third word of the graph's header; shrink it under the tensors. */
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    view.setUint32(12, 8, true);
    expect(() => readNgrf(bytes.buffer as ArrayBuffer, bytes.byteOffset, bytes.byteLength)).toThrow(
      /payload/,
    );
  });

  it('refuses a structure that is not the shape a graph has', () => {
    const bytes = buildNgrf([graph()]);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    /* Overwrite the structure's first byte, its opening brace, with a letter. */
    bytes[16] = 0x78;
    expect(view.getUint32(4, true)).toBe(fourCC('DEPT'));
    expect(() => readNgrf(bytes.buffer as ArrayBuffer, bytes.byteOffset, bytes.byteLength)).toThrow(
      DrftError,
    );
  });
});

describe('a file that is a model', () => {
  it('A FILE HOLDING ONLY A GRAPH IS AN ASSET, and reads back its graph', () => {
    /*
     * A converted model is weights and nothing else. Refusing it for the absence of geometry would be
     * the format telling a consumer what an asset may be made of — the argument 1.5 made for splats.
     */
    const file = writeDrft({ meshes: [], graphs: [graph()] });
    const asset = readDrft(file);
    expect(asset.graphs.map((one) => one.role)).toEqual(['DEPT']);
    expect(asset.meshes).toEqual([]);
  });

  it('and a file holding nothing at all is still refused', () => {
    expect(() => writeDrft({ meshes: [] })).toThrow(DrftError);
  });
});
