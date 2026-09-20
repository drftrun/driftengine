import type { EntityProposal } from '@driftengine/capture';
import { pointerEvent } from '@driftengine/tools';
import { expect, test } from 'vitest';

import {
  CAPTURE_STAGES,
  capturePanel,
  createCaptureModel,
  createCaptureView,
  decideProposal,
  decisionOf,
  setProposals,
  stageDone,
  stageFailed,
  stageProgress,
  stageRunning,
} from './capture.ts';

/**
 * **A capture opens in the editor, and a person decides what it proposed.**
 *
 * Nothing here runs a stage: the panel is five rows and a number each, and the work is
 * `@driftengine/capture`'s, on a device, for minutes. What is under test is that the panel says
 * what is happening, and that accepting or rejecting a proposal is a command somebody can take
 * back — not a change to a world this panel was never handed.
 */

function proposal(region: number, label: string | null, walkable = false): EntityProposal {
  return {
    region,
    bounds: Float64Array.from([0, 0, 0, 1, 1, 1]),
    label,
    components: ['transform', 'mesh', 'collider'],
    walkable,
  };
}

function textOf(model: ReturnType<typeof createCaptureModel>): string[] {
  const view = createCaptureView();
  capturePanel.build(model, view, view.root);
  return view.root.children.map((node) => node.text ?? '');
}

test('EVERY STAGE SAYS WHAT IT IS DOING, AND WHAT IT PRODUCED WHEN IT IS DONE', () => {
  const model = createCaptureModel();
  expect(model.stages.length).toBe(CAPTURE_STAGES.length);
  expect(textOf(model)[0]).toBe('Camera path');

  stageRunning(model, 'poses');
  stageProgress(model, 'poses', 0.42);
  expect(textOf(model)[0]).toBe('Camera path 42%');

  /*
   * **Clamped**, because a stage reporting frames done over frames expected is reporting two
   * numbers it measured separately, and a bar past its own end is what somebody screenshots.
   */
  stageProgress(model, 'poses', 4);
  expect(textOf(model)[0]).toBe('Camera path 100%');

  stageDone(model, 'poses', '96 frames, 2.1 m');
  expect(textOf(model)[0]).toBe('Camera path — 96 frames, 2.1 m');
  /* And a finished stage does not move again when a late progress report arrives. */
  stageProgress(model, 'poses', 0.1);
  expect(textOf(model)[0]).toBe('Camera path — 96 frames, 2.1 m');

  stageFailed(model, 'gaussians', 'the clip never moved');
  expect(textOf(model)[1]).toBe('Splats failed: the clip never moved');
  /* The stages after it are untouched: a failure stops a run, it does not rewrite its history. */
  expect(textOf(model)[2]).toBe('Surface');
});

test('A PROPOSAL IS ACCEPTED OR REJECTED, AND BOTH ARE COMMANDS', () => {
  const model = createCaptureModel();
  setProposals(model, [proposal(0, null, true), proposal(1, 'crate')]);
  expect(decisionOf(model, 0)).toBe('open');

  const accept = decideProposal(model, 0, true);
  accept.apply();
  expect(decisionOf(model, 0)).toBe('accepted');

  const reject = decideProposal(model, 1, false);
  reject.apply();
  expect(decisionOf(model, 1)).toBe('rejected');

  /*
   * **Rejected is an answer, not an absence.** Undoing a rejection has to give back *undecided*
   * rather than *accepted*, or a person who rejects something and changes their mind finds the
   * editor has decided for them in the other direction.
   */
  reject.revert();
  expect(decisionOf(model, 1)).toBe('open');
  accept.revert();
  expect(decisionOf(model, 0)).toBe('open');
});

test('a click accepts a proposal and a context click rejects it', () => {
  const model = createCaptureModel();
  setProposals(model, [proposal(7, 'door')]);
  const view = createCaptureView();
  capturePanel.build(model, view, view.root);

  /* The proposal rows come after the five stage rows. */
  const y = CAPTURE_STAGES.length * view.rowHeight + 1;
  const accepted = capturePanel.route(model, view, pointerEvent('down', 10, y, 0));
  expect(accepted).not.toBeNull();
  accepted?.apply();
  expect(decisionOf(model, 7)).toBe('accepted');

  const rejected = capturePanel.route(model, view, pointerEvent('down', 10, y, 2));
  rejected?.apply();
  expect(decisionOf(model, 7)).toBe('rejected');

  /* A click on a stage row asks for nothing: a stage is something to watch, not something to do. */
  expect(capturePanel.route(model, view, pointerEvent('down', 10, 1, 0))).toBeNull();
});

test('a proposal row says what it is, whether anybody stands on it, and what was decided', () => {
  const model = createCaptureModel();
  setProposals(model, [proposal(0, null, true), proposal(1, 'crate')]);
  const rows = textOf(model).slice(CAPTURE_STAGES.length);
  expect(rows[0]).toBe('unlabelled · walkable — open');
  expect(rows[1]).toBe('crate — open');

  decideProposal(model, 1, true).apply();
  expect(textOf(model).slice(CAPTURE_STAGES.length)[1]).toBe('crate — accepted');
});

test('running the regions stage again drops decisions about regions that are gone', () => {
  /*
   * **A decision is about a region, and a second run renumbers them.** Keeping a decision whose
   * region no longer exists is how an editor comes to have a rejected thing it cannot show
   * anybody — and worse, how a *new* region inherits an answer nobody gave about it.
   */
  const model = createCaptureModel();
  setProposals(model, [proposal(0, 'wall'), proposal(1, 'crate')]);
  decideProposal(model, 0, true).apply();
  decideProposal(model, 1, false).apply();

  setProposals(model, [proposal(0, 'wall')]);
  expect(decisionOf(model, 0)).toBe('accepted');
  expect(model.decided.has(1)).toBe(false);
});

test('a panel with no capture behind it says so', () => {
  const model = createCaptureModel();
  model.stages.length = 0;
  const view = createCaptureView();
  capturePanel.build(model, view, view.root);
  expect(view.root.children.length).toBeGreaterThan(0);
  expect(view.root.children[0]?.text).toContain('No capture');
});
