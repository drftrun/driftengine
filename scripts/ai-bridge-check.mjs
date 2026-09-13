/**
 * Do the two AI bridges compose, or do they merely both exist?
 *
 * `navigation.test.ts` proves a guard answers and `authority.test.ts` proves a participant never
 * decides. Neither proves that an agent whose destination a model chose, whose route a graph
 * guarded, whose decision crossed to a second peer, and whose ticks were then replayed, ends up in
 * the same place on both — which is the only claim a consumer has any use for.
 *
 * It is not a `*.test.mjs` and `npm run test:scripts` does not pick it up, deliberately: it needs a
 * dev server.
 *
 *     (setsid npx vite demo/dev --port 5212 > /tmp/vite.log 2>&1 < /dev/null &) ; sleep 7
 *     node scripts/ai-bridge-check.mjs --base=http://localhost:5212
 *
 * ## Claim 1 comes first for a reason
 *
 * Every other claim below is satisfied by a run in which no agent ever asked for anything. Two
 * peers that both did nothing agree; a participant that never decided has a request count of zero
 * whether the bridge works or not; a replay of an empty log matches another replay of an empty log.
 * So the first thing asserted is that **model decisions were taken and applied**, and everything
 * after it rests on that. This is the shape the 2026-09-04 audit removed fifty-seven of.
 *
 * ## The provider run, which has not been run
 *
 * `--endpoint=<url>` drives the same page against the real proxy adapter instead of
 * `DeterministicProvider`. **It is a proxy URL and not a key**: `packages/ai` holds no credential
 * and a test reads its source to prove it, so the credential lives on the consumer's endpoint.
 *
 * Everything above is proved without one, because `DeterministicProvider` answers after a stated
 * number of *ticks* rather than on a wall clock. What an endpoint adds is one claim: a real remote
 * provider also drives this end to end. That claim has never been checked, and this script refuses
 * to pretend otherwise — without `--endpoint` it says so and asserts nothing about it.
 *
 * Exits non-zero on the first failed check, so it can gate a commit.
 */
import { launch } from '../packages/core/scripts/browser.mjs';
import { connect } from '../packages/core/scripts/cdp.mjs';

function argOf(name, fallback) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit === undefined ? fallback : hit.slice(name.length + 3);
}

const base = argOf('base', 'http://localhost:5212').replace(/\/$/, '');
const endpoint = argOf('endpoint', null);
const query = endpoint === null ? '' : `?endpoint=${encodeURIComponent(endpoint)}`;

const browser = await launch();
const client = await connect(browser.port);
const page = await client.page(`${base}/aiBridges.html${query}`, 640, 480);
await page.settled('globalThis.__aiBridgeCheck', { settleMs: 5000 });
const result = JSON.parse(await page.eval('JSON.stringify(globalThis.__aiBridgeCheck)'));
const complaints = page.complaints().filter((line) => !line.includes('404'));
await page.close?.();
await browser.close?.();

let failed = 0;
function check(name, ok, detail) {
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}: ${detail}`);
}

console.log(`\nprovider: ${result.provider}\n`);
console.log(JSON.stringify(result, null, 2), '\n');

check('the page ran without complaint', complaints.length === 0, complaints.join(' | ') || 'clean');
check(
  'the page reported a result rather than an error',
  result.error === undefined,
  result.error ?? 'none',
);

/*
 * 1. The agents decided, and the decisions did something. Without this pair every claim below is
 *    satisfied by a run in which nothing happened.
 */
check(
  'model decisions were taken on the authority',
  result.modelDecisions > 0,
  `${result.modelDecisions} decisions over ${result.ticks} ticks`,
);
check(
  'and applying them moved the world',
  result.hostApplied > 0 && result.hostMoved === true,
  `${result.hostApplied} routes applied, world moved: ${result.hostMoved}`,
);

/* 2. The guard fired on a destination that stopped being reachable, through the model. */
check(
  'the guard refused destinations stranded by the cut',
  result.hostRefusedByGuard > 0,
  `${result.hostRefusedByGuard} refused`,
);

/* 3. The participant never decided. Its provider is present precisely so this can be false. */
check(
  'the participant never reached a provider',
  result.peerRequests === 0,
  `${result.peerRequests} requests`,
);
check('and it published nothing', result.peerPublished === 0, `${result.peerPublished} published`);
check(
  'while the authority’s decisions did reach it',
  result.decisionsAccepted > 0,
  `${result.decisionsAccepted} of ${result.modelDecisions}`,
);

/* 4. A rewind issued nothing and replayed the same intents. The count is the evidence. */
check(
  'a rewind issued no request',
  result.requestsAfterRewind === result.requestsBeforeRewind,
  `${result.requestsBeforeRewind} before, ${result.requestsAfterRewind} after`,
);
check(
  'and it had model intents to replay, not just floor ones',
  result.replayedIntents > 0,
  `${result.replayedIntents} replayed`,
);
check(
  'and two replays of one log agree',
  result.replayMatches === true,
  String(result.replayMatches),
);

/*
 * 5. The two peers agree, at a *confirmed* tick. Track J learned by going red that comparing the
 *    newest tick halts a healthy session, because it is speculative on both sides.
 */
check(
  'the two peers are in the same state at a confirmed tick',
  result.worldsAgree === true,
  result.worldsAgree ? 'identical' : `${result.hostAtConfirmed} against ${result.peerAtConfirmed}`,
);

/*
 * 6. And the claim this script will not make.
 *
 * Stated as a line of output rather than a check, because there is nothing to assert: a run without
 * an endpoint has not tested a remote provider, and printing PASS for that would be the exact thing
 * every other claim here is written to avoid.
 */
if (result.providerRun === true) {
  check(
    'a real provider drove the same page',
    result.modelDecisions > 0,
    `${result.modelDecisions} decisions through ${endpoint}`,
  );
} else {
  console.log(
    'NOT RUN  a real remote provider driving this page: pass --endpoint=<proxy url>. ' +
      'Everything above used DeterministicProvider, which answers on ticks rather than a clock.',
  );
}

console.log(`\n${failed === 0 ? 'all checks passed' : `${failed} failed`}`);
process.exit(failed === 0 ? 0 : 1);
