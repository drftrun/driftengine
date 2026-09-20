/**
 * The capture panel: what each stage is doing, and what to do with what it proposed.
 *
 * **Stages are declared here and run somewhere else.** This panel holds five rows and a progress
 * number each; `@driftengine/capture` does the work, on a device, for minutes at a time, and a
 * panel that ran it would be a panel that cannot be tested without one. The host drives
 * `stageRunning`, `stageProgress` and `stageDone`, and every one of those is a plain function over
 * the model rather than a method on it, so a host that runs the stages in a worker and a test that
 * runs none reach the same state by the same route.
 *
 * **A proposal is accepted or rejected, and both are commands.** Neither is a decision this file
 * takes: a capture proposes, and a person decides. The default for anything undecided is what the
 * capture already said — scenery, drawn and solid and doing nothing — so closing the editor without
 * touching the list loses nothing, and **rejecting is a real answer rather than an absence**, which
 * is why it is stored rather than inferred from not having accepted.
 *
 * **Nothing here writes the world.** `route` returns a `Command`; the shell applies it and the undo
 * stack keeps it. That is `@driftengine/tools`' rule and the signature is what enforces it.
 */
import type { EntityProposal } from '@driftengine/capture';
import { createPanelRoot, emptyPanel, type Command, type Panel } from '@driftengine/tools';
import { addUiChild, createUiNode, type UiNode } from '@driftengine/ui2d';

export type StageState = 'waiting' | 'running' | 'done' | 'failed';

export interface CaptureStage {
  readonly id: string;
  readonly title: string;
  state: StageState;
  /** 0 to 1, and only meaningful while `running`. */
  progress: number;
  /** One line about what the stage produced, or why it failed. Empty until there is one. */
  summary: string;
}

/**
 * The five stages, in the order a capture runs them.
 *
 * Named for what they produce rather than for how — a person watching a progress bar wants to know
 * what is being made, and the method is the engine's business and may change under them.
 */
export const CAPTURE_STAGES: readonly { readonly id: string; readonly title: string }[] = [
  { id: 'poses', title: 'Camera path' },
  { id: 'gaussians', title: 'Splats' },
  { id: 'surface', title: 'Surface' },
  { id: 'material', title: 'Material' },
  { id: 'regions', title: 'Regions' },
];

export interface CaptureWorld {
  readonly stages: readonly CaptureStage[];
  readonly proposals: readonly EntityProposal[];
  /** Region number → accepted. A region that is not here has not been decided. */
  readonly decided: ReadonlyMap<number, boolean>;
}

/** The mutable side, which commands write and the panel only reads. */
export interface CaptureModel extends CaptureWorld {
  readonly stages: CaptureStage[];
  proposals: EntityProposal[];
  readonly decided: Map<number, boolean>;
}

export function createCaptureModel(): CaptureModel {
  return {
    stages: CAPTURE_STAGES.map((stage) => ({
      id: stage.id,
      title: stage.title,
      state: 'waiting' as StageState,
      progress: 0,
      summary: '',
    })),
    proposals: [],
    decided: new Map(),
  };
}

function stageOf(model: CaptureModel, id: string): CaptureStage | undefined {
  return model.stages.find((stage) => stage.id === id);
}

export function stageRunning(model: CaptureModel, id: string): void {
  const stage = stageOf(model, id);
  if (stage === undefined) return;
  stage.state = 'running';
  stage.progress = 0;
}

/**
 * How far along a running stage is.
 *
 * Clamped, and it matters: a stage that reports frames done over frames expected is reporting two
 * numbers it measured separately, and a bar past its own end is the kind of thing a person
 * screenshots rather than reports.
 */
export function stageProgress(model: CaptureModel, id: string, fraction: number): void {
  const stage = stageOf(model, id);
  if (stage === undefined || stage.state !== 'running') return;
  stage.progress = Math.min(1, Math.max(0, fraction));
}

export function stageDone(model: CaptureModel, id: string, summary: string): void {
  const stage = stageOf(model, id);
  if (stage === undefined) return;
  stage.state = 'done';
  stage.progress = 1;
  stage.summary = summary;
}

/** A stage that failed says so and says why, and the stages after it stay where they are. */
export function stageFailed(model: CaptureModel, id: string, reason: string): void {
  const stage = stageOf(model, id);
  if (stage === undefined) return;
  stage.state = 'failed';
  stage.summary = reason;
}

/** What the regions stage produced. Replacing them clears decisions about regions that are gone. */
export function setProposals(model: CaptureModel, proposals: readonly EntityProposal[]): void {
  model.proposals = [...proposals];
  const live = new Set(proposals.map((proposal) => proposal.region));
  for (const region of [...model.decided.keys()]) {
    if (!live.has(region)) model.decided.delete(region);
  }
}

/** Accept or reject one proposal, as a command the shell can take back. */
export function decideProposal(model: CaptureModel, region: number, accepted: boolean): Command {
  const had = model.decided.has(region);
  const was = model.decided.get(region) ?? false;
  return {
    label: `${accepted ? 'accept' : 'reject'} region ${region}`,
    apply: () => {
      model.decided.set(region, accepted);
    },
    revert: () => {
      if (had) model.decided.set(region, was);
      else model.decided.delete(region);
    },
  };
}

/** What a row says about a proposal, in a word. */
export function decisionOf(world: CaptureWorld, region: number): 'accepted' | 'rejected' | 'open' {
  const decided = world.decided.get(region);
  if (decided === undefined) return 'open';
  return decided ? 'accepted' : 'rejected';
}

export interface CaptureView {
  readonly root: UiNode;
  rowHeight: number;
  /** What the last build laid out: the stage rows, then a row per proposal. */
  rows: { readonly stage: CaptureStage | null; readonly region: number }[];
}

export function createCaptureView(rowHeight = 16): CaptureView {
  return { root: createPanelRoot(capturePanel), rowHeight, rows: [] };
}

function stageText(stage: CaptureStage): string {
  if (stage.state === 'running') return `${stage.title} ${Math.round(stage.progress * 100)}%`;
  if (stage.state === 'done') return `${stage.title} — ${stage.summary}`;
  if (stage.state === 'failed') return `${stage.title} failed: ${stage.summary}`;
  return stage.title;
}

function proposalText(world: CaptureWorld, proposal: EntityProposal): string {
  const name = proposal.label ?? 'unlabelled';
  const walk = proposal.walkable ? ' · walkable' : '';
  return `${name}${walk} — ${decisionOf(world, proposal.region)}`;
}

export const capturePanel: Panel<CaptureWorld, CaptureView> = {
  id: 'capture',
  title: 'Capture',

  build(world, view, root): void {
    view.rows = [
      ...world.stages.map((stage) => ({ stage, region: -1 })),
      ...world.proposals.map((proposal) => ({ stage: null, region: proposal.region })),
    ];
    if (view.rows.length === 0) {
      emptyPanel(root, 'No capture open');
      return;
    }

    const children = root.children;
    while (children.length < view.rows.length) {
      addUiChild(root, createUiNode({ width: 'grow', height: view.rowHeight, interactive: true }));
    }
    children.length = view.rows.length;
    view.rows.forEach((row, at) => {
      const node = children[at] as UiNode;
      node.height = view.rowHeight;
      node.interactive = row.stage === null;
      if (row.stage !== null) {
        node.text = stageText(row.stage);
        node.name = `stage:${row.stage.id}`;
        return;
      }
      const proposal = world.proposals.find((held) => held.region === row.region);
      node.text = proposal === undefined ? '' : proposalText(world, proposal);
      node.name = `proposal:${row.region}`;
    });
  },

  /**
   * A click accepts, a context click rejects.
   *
   * **Clicking an accepted row does not toggle it back to undecided**, and that is deliberate:
   * *undecided* is where a proposal starts and is not a state anybody wants to return to by
   * accident. Undo is how a decision is taken back, which is also how everything else in this
   * editor is taken back.
   */
  route(world, view, event): Command | null {
    if (event.kind !== 'pointer' || event.phase !== 'down') return null;
    const row = view.rows[Math.floor(event.y / view.rowHeight)];
    if (row === undefined || row.stage !== null) return null;
    const model = world as CaptureModel;
    return decideProposal(model, row.region, event.button !== 2);
  },
};
