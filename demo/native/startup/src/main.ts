/** The page's entry, for the desktop target: the canvas is in the page's own markup. */
import { mount } from './game.ts';

const canvas = document.querySelector<HTMLCanvasElement>('#stage');
if (canvas === null) throw new Error('the page must carry <canvas id="stage">');
await mount(canvas);
