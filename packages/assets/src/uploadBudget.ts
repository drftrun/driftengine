/**
 * How much uploading fits in one frame, and how to tell bytes from an error page.
 *
 * Pure decisions with no loader state behind them: whether another upload fits the frame's
 * budget, and whether a server answered a request for a model with HTML.
 */

export const DEFAULT_UPLOADS_PER_FRAME = 3;
export const DEFAULT_REVEAL_SEC = 0.35;

/**
 * How long one `update` may spend *starting* new stream work.
 *
 * A minority of a 60 Hz frame, and under the whole of a 120 Hz one, because the scene has to
 * draw as well as load. It is a budget for beginning work rather than for finishing it: a piece
 * already started is always finished, so a frame overruns by whatever the last piece cost — see
 * `mayBeginMore` for why that residue is a real limit and not a rounding error.
 */
export const DEFAULT_UPLOAD_MS_PER_FRAME = 6;

/**
 * Whether another piece of stream work may begin in this frame.
 *
 * **The clock decides, because a count cannot.** `uploadsPerFrame` bounded the number of parts a
 * frame took, on the reasoning in its own docstring: that a part is a small buffer upload and
 * that the allocations are the cost. Measured through the demo page on the shipped Audi, that is
 * backwards. `createMesh` costs 0.6 to 3.1 ms; the per-part CPU work around it costs 6 to 254 ms,
 * most of it the consumer's `transform` plus the two further walks over the same vertices this
 * class does itself. A count bounded the cheap term and left the expensive one free, so three
 * large parts made one 318 ms frame.
 *
 * The loader cannot know what a part costs before it pays for it, and it does not have to: a
 * clock read after each one is exact, needs no per-asset tuning, and is as right on a phone as on
 * a workstation.
 *
 * **The first piece always begins.** One part of a heavy model can cost more than the entire
 * budget, and a rule that asked only "is there room left" would then start nothing on any frame
 * and the load would never finish. A hitch is worse than smooth; a load stuck at 40% is worse
 * than a hitch.
 *
 * **`StepBudget` in `@driftengine/core` is the general form of this and is the one to reach for
 * in new code.** It adds what this cannot do: an estimate of the worst stop, so it refuses to
 * *begin* a unit there is no room to finish rather than discovering that afterwards, and a name
 * for the unit that blew the budget. This one stays because the loader's update is a priority
 * ladder rather than a queue of units — an outline, then parts, then one image, then a merge,
 * each with its own reason to go before the next — and the numbers below were measured against
 * that order.
 *
 * **What this does not fix, stated because measuring it is what found it.** A single part is
 * indivisible here, and the worst one in that car costs 254 ms on an RX 9070 XT. This stops the
 * others joining it in the same frame — the measured worst frame falls from 318 ms to 254 — and
 * that is the whole of the improvement. Making that one part fit a frame is a different change
 * to a different place: either its per-part work moves off the main thread, or a part large
 * enough is split across frames. Neither is a budget, which is why neither is here.
 *
 * **The second of those now exists** as `createMeshIncremental`, and it is deliberately not
 * wired up here: measured on that same car, `createMesh` is 0.6 to 3.1 ms of a part and the 254
 * belongs to the per-part CPU work around it. Splitting the upload would divide the small half.
 *
 * @param begunThisFrame How many pieces this frame has already started.
 * @param elapsedMs How long this frame has been spending on the stream.
 * @param budgetMs What it is allowed.
 */
export function mayBeginMore(begunThisFrame: number, elapsedMs: number, budgetMs: number): boolean {
  return begunThisFrame === 0 || elapsedMs < budgetMs;
}

/**
 * Whether a response carrying 200 is actually a *document* rather than a container.
 *
 * `response.ok` is not enough to tell a missing model from a broken one, and the gap is not
 * exotic: a dev server and most static hosts answer an unknown path with the site's own page
 * under a 200 rather than with a 404. The bytes then reach the reader, the magic does not
 * match, and a model that was simply never deployed is reported as a corrupt file.
 *
 * That is what this exists to prevent, and it was found on a published demo page: the site
 * serves no model, its dev server answered `/car.drft` with 2,947 bytes of HTML under a 200,
 * and the scene read **"the model failed: not a drft file"** at a reader. The deployed site
 * was correct at the same moment, because it answers a real 404 — so the two disagreed, and
 * the honest state was the one nobody could see locally.
 *
 * A declared content type is the right signal rather than sniffing the first bytes: a host
 * answering with a page says so in the header, and it says so *before* a byte of body is
 * read, which is what lets the caller skip downloading a page it has no use for. A genuinely
 * corrupt container still reaches the reader and still fails loudly, which is the distinction
 * worth keeping.
 */
export function isDocumentResponse(contentType: string | null): boolean {
  return (contentType ?? '').trim().toLowerCase().startsWith('text/html');
}
