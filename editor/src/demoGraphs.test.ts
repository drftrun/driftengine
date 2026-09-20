import { expect, test } from 'vitest';

import { demoGraphs } from './demoGraphs.ts';
import { previewLines } from './panels/graph.ts';

/**
 * **Each demo graph compiles, which is the only reason to ship one.**
 *
 * A graph panel's preview says what the engine will actually run. A panel opened on a graph that
 * does not compile shows an error and proves nothing about either half — not that the canvas draws
 * and not that the compiler works — so an editor shipping three of those would look exactly like
 * an editor whose graph panels are broken.
 */
test('EVERY GRAPH THE EDITOR OPENS ON COMPILES TO THE ARTEFACT ITS PANEL PROMISES', () => {
  const graphs = demoGraphs();
  expect(graphs.map((world) => world.kind)).toEqual(['material', 'particle', 'behaviour']);

  for (const world of graphs) {
    const lines = previewLines(world);
    /* `not yet` is how every one of the three says it did not compile. */
    expect(lines[0], world.kind).not.toContain('not yet');
  }

  const [material, particle, behaviour] = graphs.map((world) => previewLines(world).join('\n'));
  /* The fact a reader most needs and least expects: a material graph is not a shader. */
  expect(material).toContain('DTEX decode program');
  expect(particle).toContain('alive of');
  expect(behaviour).toContain('system Movement');
  expect(behaviour).toContain('writes Position');
});
