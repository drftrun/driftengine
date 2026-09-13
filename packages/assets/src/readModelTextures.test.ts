import { describe, expect, it } from 'vitest';
import { readModel } from './readModel.ts';

/**
 * The images a model names, fetched through `beside` rather than left to the caller.
 *
 * Written against the case that made it necessary: an `.obj` and an `.mtl` naming a map by the
 * absolute path that was true on the machine that exported it, with the file itself sitting
 * somewhere else entirely under whatever folder the packer invented.
 */

const OBJ = ['mtllib model.mtl', 'usemtl Body', 'v 0 0 0', 'v 1 0 0', 'v 0 1 0', 'f 1 2 3'].join(
  '\n',
);

function source(mtl: string, hold: Record<string, string>) {
  const asked: string[] = [];
  return {
    asked,
    read: () =>
      readModel({
        name: 'model.obj',
        bytes: new TextEncoder().encode(OBJ),
        beside: async (relative: string) => {
          asked.push(relative);
          if (relative === 'model.mtl') return new TextEncoder().encode(mtl);
          const held = hold[relative];
          return held === undefined ? null : new TextEncoder().encode(held);
        },
      }),
  };
}

describe('a model that names its textures', () => {
  it('gets the bytes of one that is exactly where it said', async () => {
    const { read } = source('newmtl Body\nmap_Kd textures/body.png', {
      'textures/body.png': 'PIXELS',
    });
    const imported = await read();
    expect(imported.textures?.[0]?.bytes).toEqual(new TextEncoder().encode('PIXELS'));
  });

  it('gets the bytes of one named by a path from somebody else’s machine', async () => {
    const { read } = source('newmtl Body\nmap_Kd D:\\work\\car\\tex\\body.png', {
      'body.png': 'PIXELS',
    });
    const imported = await read();
    expect(imported.textures?.[0]?.bytes).toEqual(new TextEncoder().encode('PIXELS'));
  });

  it('says so when the file was somewhere other than where the model looked', async () => {
    const { read } = source('newmtl Body\nmap_Kd D:\\work\\car\\tex\\body.png', {
      'textures/body.png': 'PIXELS',
    });
    const imported = await read();
    expect(imported.notes.join(' ')).toContain('textures/body.png');
  });

  it('leaves a reference that resolves to nothing in its place, so no ordinal moves', async () => {
    const { read } = source('newmtl Body\nmap_Kd gone.png', {});
    const imported = await read();
    expect(imported.textures).toHaveLength(1);
    expect(imported.textures?.[0]?.bytes).toBeUndefined();
  });

  it('asks for the declared path before the bare name, so the specific one wins', async () => {
    const { asked, read } = source('newmtl Body\nmap_Kd tex/body.png', { 'body.png': 'WRONG' });
    await read();
    const declared = asked.indexOf('tex/body.png');
    expect(declared).toBeGreaterThan(-1);
    expect(declared).toBeLessThan(asked.indexOf('body.png'));
  });

  it('asks for nothing at all when the model carried its images itself', async () => {
    const { asked, read } = source('newmtl Body', {});
    await read();
    expect(asked.filter((relative) => relative !== 'model.mtl')).toEqual([]);
  });
});
