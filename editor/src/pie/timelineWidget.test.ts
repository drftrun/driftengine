import { describe, expect, it } from 'vitest';
import { keyEvent, pointerEvent, wheelEvent } from '@driftengine/tools';
import { createTimeline, recordFrame, type Timeline, type TimelineOptions } from './timeline.ts';
import {
  HANDLE_WIDTH,
  TRACK_HEIGHT,
  buildTimelineWidget,
  createTimelineWidget,
  frameAtX,
  layoutTimelineWidget,
  routeTimelineWidget,
  secondsAtFrame,
  xOfFrame,
  type TimelineWidget,
} from './timelineWidget.ts';

interface Slot {
  n: number;
}

function timelineOf(
  frames: number,
  options: { interval?: number; capacity?: number } = {},
): Timeline<Slot, number> & TimelineOptions<Slot> {
  const timeline = createTimeline<Slot, number>({
    interval: options.interval ?? 10,
    capacity: options.capacity ?? 10000,
    createSnapshot: (): Slot => ({ n: 0 }),
    saveSnapshot: (): void => {},
  });
  for (let frame = 0; frame < frames; frame += 1) {
    recordFrame(timeline, frame, frame, `h${String(frame)}`);
  }
  return timeline;
}

function widgetOver(
  frames: number,
  options: { interval?: number; capacity?: number; oldest?: number; width?: number } = {},
): { widget: TimelineWidget; timeline: Timeline<Slot, number> } {
  const timeline = timelineOf(frames, options);
  const widget = createTimelineWidget();
  layoutTimelineWidget(widget, timeline, 0, options.width ?? 400, options.oldest ?? 0);
  buildTimelineWidget(widget, timeline);
  return { widget, timeline };
}

function named(widget: TimelineWidget, prefix: string): string[] {
  return widget.node.children.map((child) => child.name).filter((name) => name.startsWith(prefix));
}

describe('position and frame are exact inverses', () => {
  it('round-trips every frame on the track', () => {
    /* The lesson the graph canvas paid for: one formula to draw and another to hit puts the handle
       where the frame is not, and the error grows with the length of the track. */
    const { widget } = widgetOver(101, { width: 400 });
    for (let frame = 0; frame <= 100; frame += 1) {
      expect(frameAtX(widget, xOfFrame(widget, frame)), `frame ${String(frame)}`).toBe(frame);
    }
  });

  it('puts the ends of the range at the ends of the track', () => {
    const { widget } = widgetOver(101, { width: 400 });
    expect(xOfFrame(widget, 0)).toBe(0);
    expect(xOfFrame(widget, 100)).toBe(400);
    expect(xOfFrame(widget, 50)).toBe(200);
  });

  it('clamps rather than running off either end', () => {
    const { widget } = widgetOver(101, { width: 400 });
    expect(xOfFrame(widget, -20)).toBe(0);
    expect(xOfFrame(widget, 900)).toBe(400);
    expect(frameAtX(widget, -50)).toBe(0);
    expect(frameAtX(widget, 900)).toBe(100);
  });

  it('puts a single frame at the left edge rather than dividing by nothing', () => {
    const { widget } = widgetOver(1, { width: 400 });
    expect(widget.first).toBe(0);
    expect(widget.last).toBe(0);
    expect(xOfFrame(widget, 0)).toBe(0);
    expect(frameAtX(widget, 200)).toBe(0);
  });

  it('works on a range that does not start at zero, and a track that does not either', () => {
    /*
     * Every other test here sits at the origin with a range starting at frame zero, where
     * subtracting the start of either is a no-op — so two perturbations that dropped those
     * subtractions failed nothing. A session whose ring has moved on, drawn inside a panel with a
     * margin, is the ordinary case rather than the awkward one.
     */
    const timeline = timelineOf(40, { interval: 10, capacity: 20 });
    const widget = createTimelineWidget();
    layoutTimelineWidget(widget, timeline, 60, 400, 20);
    expect([widget.first, widget.last]).toEqual([20, 39]);

    expect(xOfFrame(widget, 20)).toBe(60);
    expect(xOfFrame(widget, 39)).toBe(460);
    expect(frameAtX(widget, 60)).toBe(20);
    expect(frameAtX(widget, 460)).toBe(39);
    for (let frame = 20; frame <= 39; frame += 1) {
      expect(frameAtX(widget, xOfFrame(widget, frame)), `frame ${String(frame)}`).toBe(frame);
    }
  });

  it('reads time off the fixed step, not off a clock', () => {
    expect(secondsAtFrame(0, 1 / 60)).toBe(0);
    expect(secondsAtFrame(120, 1 / 60)).toBe(2);
    expect(secondsAtFrame(50, 0.02)).toBe(1);
  });
});

describe('what the track shows', () => {
  it('marks keyframes and nothing else', () => {
    const { widget } = widgetOver(31, { interval: 10 });
    expect(named(widget, 'timeline:keyframe:')).toEqual([
      'timeline:keyframe:0',
      'timeline:keyframe:10',
      'timeline:keyframe:20',
      'timeline:keyframe:30',
    ]);
  });

  it('draws the part the ring dropped as unavailable, not as absent', () => {
    /* A track that simply started later looks like a session that started later. */
    const { widget } = widgetOver(40, { interval: 10, capacity: 20, oldest: 0, width: 400 });
    expect(widget.first).toBe(0);
    expect(widget.last).toBe(39);
    const lost = widget.node.children.find((child) => child.name === 'timeline:unavailable');
    expect(lost).toBeDefined();
    expect(lost?.x).toBe(0);
    /* Frames 0..19 are gone, so the lost part runs to where frame 20 is drawn. */
    expect(lost?.width).toBeCloseTo(xOfFrame(widget, 20), 6);
  });

  it('draws nothing unavailable when nothing has been dropped', () => {
    const { widget } = widgetOver(40, { interval: 10 });
    expect(named(widget, 'timeline:unavailable')).toEqual([]);
  });

  it('marks where the simulation rolled back', () => {
    const { widget, timeline } = widgetOver(40, { interval: 10 });
    widget.rollbacks.add(12);
    widget.rollbacks.add(31);
    /* And one outside the track, which must not be drawn off the end of it. */
    widget.rollbacks.add(900);
    buildTimelineWidget(widget, timeline);
    expect(named(widget, 'timeline:rollback:')).toEqual([
      'timeline:rollback:12',
      'timeline:rollback:31',
    ]);
  });

  it('puts the handle on the frame it is on', () => {
    const { widget, timeline } = widgetOver(101, { width: 400 });
    widget.frame = 25;
    buildTimelineWidget(widget, timeline);
    const handle = widget.node.children.find((child) => child.name === 'timeline:handle');
    expect(handle?.x).toBe(xOfFrame(widget, 25) - HANDLE_WIDTH / 2);
  });

  it('builds the same tree twice over the same state', () => {
    const { widget, timeline } = widgetOver(31);
    const once = widget.node.children.map((child) => `${child.name}@${String(child.x)}`);
    buildTimelineWidget(widget, timeline);
    expect(widget.node.children.map((child) => `${child.name}@${String(child.x)}`)).toEqual(once);
  });
});

describe('dragging the handle', () => {
  it('asks for a frame on the press, on every move, and lands on the release', () => {
    /* A scrubber that shows nothing until you let go is a scrubber you cannot aim. */
    const { widget } = widgetOver(101, { width: 400 });
    expect(routeTimelineWidget(widget, pointerEvent('down', 200, 5))).toEqual({
      frame: 50,
      settled: false,
    });
    expect(routeTimelineWidget(widget, pointerEvent('move', 100, 5))).toEqual({
      frame: 25,
      settled: false,
    });
    expect(routeTimelineWidget(widget, pointerEvent('up', 120, 5))).toEqual({
      frame: 30,
      settled: true,
    });
    expect(widget.dragging).toBe(false);
    expect(widget.frame).toBe(30);
  });

  it('keeps tracking when the pointer leaves the track', () => {
    /* The defect `uiPointer.ts` exists to prevent: a slider is a few pixels tall and a hand is
       not that steady, so a drag that stopped at the edge would stop on the first pixel. */
    const { widget } = widgetOver(101, { width: 400 });
    routeTimelineWidget(widget, pointerEvent('down', 200, 5));
    expect(routeTimelineWidget(widget, pointerEvent('move', 380, 900))).toEqual({
      frame: 95,
      settled: false,
    });
    expect(routeTimelineWidget(widget, pointerEvent('move', -500, 5))).toEqual({
      frame: 0,
      settled: false,
    });
  });

  it('ignores a press off the track, and a move that no press began', () => {
    const { widget } = widgetOver(101, { width: 400 });
    expect(routeTimelineWidget(widget, pointerEvent('down', 200, TRACK_HEIGHT + 4))).toBeNull();
    expect(routeTimelineWidget(widget, pointerEvent('down', 900, 5))).toBeNull();
    expect(routeTimelineWidget(widget, pointerEvent('move', 200, 5))).toBeNull();
    expect(widget.dragging).toBe(false);
  });

  it('ignores a wheel, which belongs to whatever the track is inside', () => {
    const { widget } = widgetOver(101);
    expect(routeTimelineWidget(widget, wheelEvent(200, 5, 0, -100))).toBeNull();
  });
});

describe('the keyboard steps exactly one frame', () => {
  it('moves one either way and settles immediately', () => {
    const { widget } = widgetOver(101);
    widget.frame = 50;
    expect(routeTimelineWidget(widget, keyEvent('ArrowRight'))).toEqual({
      frame: 51,
      settled: true,
    });
    expect(routeTimelineWidget(widget, keyEvent('ArrowLeft'))).toEqual({
      frame: 50,
      settled: true,
    });
  });

  it('asks for nothing at either end rather than asking for a frame that is not there', () => {
    const { widget } = widgetOver(101);
    widget.frame = 0;
    expect(routeTimelineWidget(widget, keyEvent('ArrowLeft'))).toBeNull();
    widget.frame = 100;
    expect(routeTimelineWidget(widget, keyEvent('ArrowRight'))).toBeNull();
  });

  it('ignores every other key', () => {
    const { widget } = widgetOver(101);
    widget.frame = 50;
    expect(routeTimelineWidget(widget, keyEvent('a'))).toBeNull();
    expect(routeTimelineWidget(widget, keyEvent('ArrowUp'))).toBeNull();
    expect(widget.frame).toBe(50);
  });
});

describe('laying out against the timeline', () => {
  it('clamps the handle into the range when the ring has moved on', () => {
    const { widget, timeline } = widgetOver(40, { interval: 10, capacity: 20 });
    widget.frame = 5;
    layoutTimelineWidget(widget, timeline, 0, 400, 20);
    /* Frame 5 is gone; the handle cannot stay on a frame the track no longer covers. */
    expect(widget.first).toBe(20);
    expect(widget.frame).toBe(20);
  });

  it('survives an empty timeline without inventing a range', () => {
    const timeline = timelineOf(0);
    const widget = createTimelineWidget();
    layoutTimelineWidget(widget, timeline, 0, 400, 0);
    buildTimelineWidget(widget, timeline);
    expect([widget.first, widget.last]).toEqual([0, 0]);
    expect(named(widget, 'timeline:keyframe:')).toEqual([]);
    expect(routeTimelineWidget(widget, pointerEvent('down', 200, 5))).toEqual({
      frame: 0,
      settled: false,
    });
  });
});
