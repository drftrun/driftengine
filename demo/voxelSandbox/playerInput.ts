/**
 * Actions into an intent, and clicks into world edits.
 *
 * `InputSource` already owns pointer lock, the held-key set, mouse deltas, touches and gamepads,
 * and `ActionMap` owns which of those means what. So this class is only two things: filling in a
 * `PlayerIntent` each frame, and deciding what a mouse button does to the grid.
 *
 * **`onEdit` fires into nothing today.** Stage 4's water and falling blocks and stage 6's audio
 * all hang off it. Wiring the hook where the edits are written is one line; retrofitting it
 * across three stages is three.
 */
import type { ActionMap, InputSource, TouchControls } from '../../packages/core/src/index';

import { SLOT_CODES } from './actions';
import { Block, HOTBAR, isIndestructible } from './blocks';
import type { ChunkRenderer } from './chunkRenderer';
import type { Highlight } from './highlight';
import type { Player, PlayerIntent } from './player';
import { raycastVoxel, type RayHit } from './raycast';
import type { World } from './world';

/** How far a player can reach, in blocks. The reference's number. */
const REACH = 7;

export class PlayerInput {
  /** Which hotbar slot is selected. The HUD reads it; nothing else writes it. */
  selected = 0;

  /**
   * What was edited, and what it was.
   *
   * `blockId` is the block that was *removed* on a break and the one that was *placed*
   * otherwise — which is what a listener wants either way: debris takes its colour from what
   * broke, and a footstep or a place sound takes its material from what is now there.
   */
  onEdit: ((wx: number, wy: number, wz: number, broke: boolean, blockId: Block) => void) | null =
    null;

  private readonly input: InputSource;
  private readonly actions: ActionMap;
  private readonly player: Player;
  private readonly world: World;
  private readonly chunks: ChunkRenderer;
  private readonly highlight: Highlight;
  private readonly touch: TouchControls | null;
  private readonly canvas: HTMLCanvasElement;

  /* Rebuilt in place each frame; the loop must not allocate. */
  private readonly intent: PlayerIntent = {
    forward: 0,
    strafe: 0,
    jump: false,
    sprint: false,
    flying: false,
  };
  private readonly move = { x: 0, y: 0 };
  private readonly look = { dx: 0, dy: 0 };
  private readonly touchLook = { dx: 0, dy: 0 };

  private flying = false;
  private target: RayHit | null = null;
  private disposed = false;

  constructor(
    canvas: HTMLCanvasElement,
    input: InputSource,
    actions: ActionMap,
    player: Player,
    world: World,
    chunks: ChunkRenderer,
    highlight: Highlight,
    touch: TouchControls | null = null,
  ) {
    this.canvas = canvas;
    this.input = input;
    this.actions = actions;
    this.player = player;
    this.world = world;
    this.chunks = chunks;
    this.highlight = highlight;
    this.touch = touch;

    canvas.addEventListener('mousedown', this.onMouseDown);
    canvas.addEventListener('contextmenu', this.onContextMenu);
    /* Not passive: the wheel cycles the hotbar while the pointer is locked, and a passive
       listener cannot stop the page scrolling underneath it. */
    canvas.addEventListener('wheel', this.onWheel, { passive: false });
    window.addEventListener('keydown', this.onKeyDown);
  }

  update(dtSec: number, lookSensitivity: number): void {
    this.touch?.tick(performance.now());
    this.readLook(lookSensitivity);
    this.readIntent();
    this.player.step(dtSec, this.intent);
    this.aim();
  }

  /** What the crosshair is on, so a caller can report it. Null when nothing is in reach. */
  get aimed(): RayHit | null {
    return this.target;
  }

  get isFlying(): boolean {
    return this.flying;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.canvas.removeEventListener('mousedown', this.onMouseDown);
    this.canvas.removeEventListener('contextmenu', this.onContextMenu);
    this.canvas.removeEventListener('wheel', this.onWheel);
    window.removeEventListener('keydown', this.onKeyDown);
  }

  private readLook(sensitivity: number): void {
    this.input.consumeMouseDelta(this.look);
    let dx = this.look.dx;
    let dy = this.look.dy;
    if (this.touch !== null) {
      this.touch.consumeLook(this.touchLook);
      dx += this.touchLook.dx;
      dy += this.touchLook.dy;
    }
    /* Yaw grows to the right, matching `Camera`'s own basis. Pitch is inverted from screen
       coordinates because down the screen is down the world. */
    this.player.yaw += dx * sensitivity;
    const limit = Math.PI / 2 - 0.01;
    this.player.pitch = Math.max(-limit, Math.min(limit, this.player.pitch - dy * sensitivity));
  }

  private readIntent(): void {
    this.actions.vector('move', this.move);
    /* Up is negative in the stick convention, so forward is the negated y. */
    this.intent.forward = -this.move.y;
    this.intent.strafe = this.move.x;
    this.intent.jump = this.actions.down('jump');
    this.intent.sprint = this.actions.down('sprint');

    if (this.actions.consumePress('toggleFly')) this.flying = !this.flying;
    this.intent.flying = this.flying;

    if (this.actions.consumePress('slotNext')) this.cycleSlot(1);
    if (this.actions.consumePress('slotPrev')) this.cycleSlot(-1);
    if (this.actions.consumePress('break')) this.edit(true);
    if (this.actions.consumePress('place')) this.edit(false);

    if (this.touch !== null) {
      /*
       * The left half of the screen is the stick; its vector joins the action map's, so a pad,
       * a keyboard and a thumb all arrive as the same intent.
       *
       * **`TouchControls` and `ActionMap` disagree about which way is up, and this used to apply
       * the wrong one.** An action's `y` follows the stick convention, negative upward, which is
       * why `readIntent` negates it. `TouchControls.moveY` is already `-dy / length`: it has done
       * that negation itself, so pushing the stick forward reports a *positive* number. Negating
       * it again sent a player backwards when they pushed forward, and only on a phone.
       */
      this.intent.forward += this.touch.moveY;
      this.intent.strafe += this.touch.moveX;
      if (this.touch.consumePrimaryPress()) this.edit(true);
      if (this.touch.secondaryHeld) this.edit(false);
    }
  }

  /** Where the crosshair points, and the outline that follows it. */
  private aim(): void {
    const p = this.player;
    this.target = raycastVoxel(
      this.world,
      p.position[0],
      p.eyeY(),
      p.position[2],
      p.forward[0],
      p.forward[1],
      p.forward[2],
      REACH,
    );
    if (this.target === null) this.highlight.hide();
    else this.highlight.show(this.target.bx, this.target.by, this.target.bz);
  }

  private cycleSlot(direction: number): void {
    this.selected = (this.selected + direction + HOTBAR.length) % HOTBAR.length;
  }

  private edit(broke: boolean): void {
    const hit = this.target;
    if (hit === null) return;

    if (broke) {
      const removed = this.world.getBlock(hit.bx, hit.by, hit.bz);
      /* Bedrock is the world's floor. Mining it would open a hole to fall out through. */
      if (isIndestructible(removed)) return;
      if (this.world.setBlock(hit.bx, hit.by, hit.bz, Block.AIR) === null) return;
      this.chunks.remeshEdit(hit.bx, hit.bz);
      this.onEdit?.(hit.bx, hit.by, hit.bz, true, removed);
      return;
    }

    /* Placing a block inside your own body is the classic way to get stuck in the floor. */
    if (this.player.intersectsBlock(hit.px, hit.py, hit.pz)) return;
    const id = HOTBAR[this.selected];
    if (id === undefined) return;
    if (this.world.setBlock(hit.px, hit.py, hit.pz, id) === null) return;
    this.chunks.remeshEdit(hit.px, hit.pz);
    this.onEdit?.(hit.px, hit.py, hit.pz, false, id);
  }

  private readonly onMouseDown = (event: MouseEvent): void => {
    if (document.pointerLockElement !== this.canvas) return;
    if (event.button === 0) this.edit(true);
    else if (event.button === 2) this.edit(false);
  };

  /* Right-click is placement, so the browser menu has to stay out of the way. */
  private readonly onContextMenu = (event: Event): void => {
    event.preventDefault();
  };

  private readonly onWheel = (event: WheelEvent): void => {
    if (document.pointerLockElement !== this.canvas) return;
    event.preventDefault();
    this.cycleSlot(Math.sign(event.deltaY));
  };

  private readonly onKeyDown = (event: KeyboardEvent): void => {
    const slot = SLOT_CODES.indexOf(event.code);
    if (slot >= 0 && slot < HOTBAR.length) this.selected = slot;
  };
}
