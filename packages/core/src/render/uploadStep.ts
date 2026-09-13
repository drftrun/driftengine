/**
 * How much of a mesh one upload step moves, in bytes.
 *
 * A quarter of a megabyte. Measured on the interleave, which is the CPU half of the cost and the
 * half a test can time: on a desktop part, 65,536 floats interleave in 0.14 ms and a whole
 * 250,000-vertex group in 5.5 ms. A megabyte a step was the first choice and is 2.2 ms here,
 * which is most of a 4 ms streaming budget before the GPU half is counted and several times that
 * on a phone. A quarter buys a step small enough that a slow device still fits one.
 *
 * The same number bounds the `writeBuffer` beside it, in the same bytes, because the two are one
 * stop and a consumer's report suspects the queue rather than the arithmetic: a whole square's
 * geometry landing at once measured 57 ms where this interleave accounts for six.
 */
export const UPLOAD_BYTES_PER_STEP = 1 << 18;
