import { expect, it } from 'vitest';

import { prepared } from './rasterize.ts';

it('A PICTURE IS SIZED BY ITS ROOT, GIVEN A VIEW BOX WHERE IT HAD NONE, AND CARRIES ITS FACES INSIDE IT', () => {
  /* Declared at 512 over a 256 source: the root's size goes, the source's becomes the view box so
     the drawing scales rather than crops, and the faces follow the root as a style. */
  expect(prepared('<svg xmlns="x" width="256" height="128"><rect/></svg>', 512, 256, 'F')).toBe(
    '<svg width="512" height="256" viewBox="0 0 256 128" xmlns="x"><style>F</style><rect/></svg>',
  );
  /* A picture with a view box keeps it. */
  expect(prepared('<svg viewBox="0 0 10 10" width="10" height="10"><g/></svg>', 64, 64, '')).toBe(
    '<svg width="64" height="64" viewBox="0 0 10 10"><style></style><g/></svg>',
  );
});
