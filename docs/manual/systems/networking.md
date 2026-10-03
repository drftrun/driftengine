---
title: Networking and rollback
description: Two peers simulating one match over a lossy link, inputs as bytes, a rewind that replays a wrong guess, and an authority with clients that predict.
packages: ['@driftengine/network', '@driftengine/entities', '@driftengine/script']
areas: ['network']
plain: ['Pilot', 'Craft', 'Ball', 'Score', 'Session', 'Rewind']
---

# Networking and rollback

`@driftengine/network` keeps several copies of one game in agreement over a link that is late and
loses things. It has two ways of doing it. In lockstep, every peer simulates the whole match from
everybody's inputs, and only inputs cross the wire. With an authority, one world is the truth and
publishes its state, and each client predicts its own player until the truth arrives. Both rest on
one mechanism: put the world back to an earlier tick, correct what was wrong about it, and step
forward to now.

<!-- run: netplay -->

The example runs both peers of a lockstep match in one page. The left pitch is your screen, where
you steer cyan with WASD, the arrows or a stick; the right pitch is the other player's screen, where
a bot steers magenta. Each peer has its own world and its own session, and the only thing they share
is the messages they send each other over a link the strip makes worse: latency, lost packets, how
many recent inputs each packet repeats, and how many ticks of input delay the match runs with. The
readout says how far each peer has confirmed the match, and how often and how far it has rewound.

## The rules both peers run

```drs sample=netplay/pitch.drs#fly
// Every craft turns its pilot's input into speed, and stays on the pitch.
system Fly {
    reads Pilot
    writes Craft

    update {
        for e in query<Pilot, Craft>() {
            e.Craft.vx = e.Craft.vx + (e.Pilot.x * THRUST - e.Craft.vx * DRAG) / 60
            e.Craft.vz = e.Craft.vz + (e.Pilot.z * THRUST - e.Craft.vz * DRAG) / 60
            e.Craft.x = math.clamp(e.Craft.x + e.Craft.vx / 60, 0 - HALF_WIDTH, HALF_WIDTH)
            e.Craft.z = math.clamp(e.Craft.z + e.Craft.vz / 60, 0 - HALF_LENGTH, HALF_LENGTH)
        }
    }
}
```

The match is a DriftScript module: craft, a ball and a score as components, and two systems that
move them. Both peers run every rule, and a rewind runs them again over ticks already played, so a
rule has to give the same answer from the same world and the same inputs every time it runs. These
read nothing but components. The controls reach them as a `Pilot` component the page fills in from
the session before each step, never as a read of the keyboard, which would differ between the two
machines and between a tick and its replay.

```drs sample=netplay/pitch.drs#kick
// A craft that touches the ball sends it off the way it was hit; the ball rolls, slows, bounces off
// the sides, and a goal puts it back on the spot.
system Kick {
    reads Craft
    writes Ball
    writes Score

    update {
        for ball in query<Ball>() {
            for craft in query<Craft>() {
                let dx = ball.Ball.x - craft.Craft.x
                let dz = ball.Ball.z - craft.Craft.z
                let reach = dx * dx + dz * dz
                if reach < TOUCH * TOUCH && reach > 0.0001 {
                    let d = math.sqrt(reach)
                    ball.Ball.x = craft.Craft.x + dx / d * TOUCH
                    ball.Ball.z = craft.Craft.z + dz / d * TOUCH
                    ball.Ball.vx = dx / d * 5 + craft.Craft.vx * 0.6
                    ball.Ball.vz = dz / d * 5 + craft.Craft.vz * 0.6
                }
            }

            let keep = 1 - (1 - ROLL) / 60
            ball.Ball.vx = ball.Ball.vx * keep
            ball.Ball.vz = ball.Ball.vz * keep
            ball.Ball.x = ball.Ball.x + ball.Ball.vx / 60
            ball.Ball.z = ball.Ball.z + ball.Ball.vz / 60

            if math.abs(ball.Ball.x) > HALF_WIDTH {
                ball.Ball.x = math.clamp(ball.Ball.x, 0 - HALF_WIDTH, HALF_WIDTH)
                ball.Ball.vx = 0 - ball.Ball.vx
            }
            if math.abs(ball.Ball.z) > HALF_LENGTH {
                if math.abs(ball.Ball.x) < GOAL {
                    for score in query<Score>() {
                        if ball.Ball.z < 0 {
                            score.Score.cyan = score.Score.cyan + 1
                        } else {
                            score.Score.magenta = score.Score.magenta + 1
                        }
                    }
                    ball.Ball.x = 0
                    ball.Ball.z = 0
                    ball.Ball.vx = 0
                    ball.Ball.vz = 0
                } else {
                    ball.Ball.z = math.clamp(ball.Ball.z, 0 - HALF_LENGTH, HALF_LENGTH)
                    ball.Ball.vz = 0 - ball.Ball.vz
                }
            }
        }
    }
}
```

Save the file during a match and both peers take the new rule from the next tick, and the match
carries on. [Entities](../simulation/entities.md) covers components and systems, and
[Determinism](../concepts/determinism.md) what a simulation may compute and stay identical on every
machine.

## An input is bytes

```ts sample=netplay/main.ts#input
/* An input is bytes the game chooses. This one is a single byte, a bit for each of four keys. */
const LEFT = 1;
const RIGHT = 2;
const UP = 4;
const DOWN = 8;

function decode(bits: number): { x: number; z: number } {
  return {
    x: (bits & RIGHT ? 1 : 0) - (bits & LEFT ? 1 : 0),
    z: (bits & DOWN ? 1 : 0) - (bits & UP ? 1 : 0),
  };
}
```

The package does not know what an input is. A game decides, and encodes each tick's input into a
fixed number of bytes; here one byte, a bit per direction. Fixed so the log of every participant's
inputs is one array for the whole session, and neither recording an input nor reading one back in a
replay allocates. The step decodes it into the `Pilot` component.

## A peer

```ts sample=netplay/main.ts#peer
/* One peer: its own world, the inputs every participant sent it, and a rewind loop that can put
   the world back to any of the last `depth` ticks and step it forward again. */
const FIXED_DT = 1 / 60;
const PARTICIPANTS = 2;

interface Peer {
  readonly world: World;
  readonly crafts: readonly Entity[];
  readonly ball: Entity;
  readonly score: Entity;
  readonly inputs: InputLog;
  readonly loop: RewindLoop<WorldSnapshot>;
}

function makePeer(): Peer {
  const world = new World();
  const crafts = [world.create(), world.create()];
  world.add(crafts[0] as Entity, Craft, { z: 3 });
  world.add(crafts[1] as Entity, Craft, { z: -3 });
  for (const craft of crafts) world.add(craft, Pilot, {});
  const ball = world.create();
  world.add(ball, Ball, {});
  const score = world.create();
  world.add(score, Score, {});

  const inputs = new InputLog({ participants: PARTICIPANTS, depth: 64, inputBytes: 1 });
  const held = new Uint8Array(1);
  /* One tick: each participant's input for it, from the log, into its pilot, then the rules. A
     rewind calls this again for every tick it replays, with the inputs it now knows. */
  const step = (_dt: number, tick: number): void => {
    for (let participant = 0; participant < PARTICIPANTS; participant += 1) {
      inputs.into(participant, tick, held);
      const { x, z } = decode(held[0] ?? 0);
      const pilot = crafts[participant] as Entity;
      world.write(pilot, Pilot, 'x', x);
      world.write(pilot, Pilot, 'z', z);
    }
    runSchedule(world, schedule, tick);
  };
  const loop = new RewindLoop({
    step,
    snapshotter: worldSnapshotter(world),
    inputs,
    fixedDt: FIXED_DT,
    depth: 24,
  });
  return { world, crafts, ball, score, inputs, loop };
}
```

A peer is a world, an `InputLog` of every participant's inputs, and a `RewindLoop`. The loop calls
`step(dt, tick)` once a tick, and before each step it saves the world into a ring `depth` ticks long,
so slot _T_ holds the world as tick _T_ began. When an input arrives for a tick already played and it
differs from what the peer guessed, the loop puts the world back to that tick's slot and replays
every tick since with the inputs it now has. Here that is twenty-four ticks, 400 ms at 60 Hz.

`worldSnapshotter(world)` is what the loop saves and restores: the whole entity world, every store,
with nothing allocated per tick once the ring has gone round. A game whose state lives somewhere
else writes its own `Snapshotter`, and `combineSnapshotters` puts several together, such as a world
and a seeded random generator's position.

## A lockstep session

```ts sample=netplay/main.ts#session
/* A match: a network, two peers and a lockstep session each. Changing the link starts a new one. */
interface Match {
  readonly net: LoopbackNetwork;
  readonly peers: readonly [Peer, Peer];
  readonly sessions: readonly [LockstepSession<WorldSnapshot>, LockstepSession<WorldSnapshot>];
  tick: number;
}

function startMatch(): Match {
  const net = new LoopbackNetwork();
  const peers = [makePeer(), makePeer()] as const;
  const sessions = peers.map(
    (peer, self) =>
      new LockstepSession({
        transport: net.open({ self, seed: 11 + self, impairment: impairment() }),
        loop: peer.loop,
        inputs: peer.inputs,
        self,
        participants: PARTICIPANTS,
        inputDelay,
        redundancy,
      }),
  ) as unknown as Match['sessions'];
  return { net, peers, sessions, tick: 0 };
}
let match = startMatch();
```

```ts sample=netplay/main.ts#tick
/* One fixed step of the whole match: each peer reads what has arrived, publishes this tick's input,
   and advances, rewinding first if something it guessed turned out wrong. */
const yours = new Uint8Array(1);
const theirs = new Uint8Array(1);

function tick(): void {
  const [a, b] = match.sessions;
  a.poll();
  b.poll();
  yours[0] = yourInput();
  theirs[0] = botInput(match.peers[1]);
  a.submit(match.tick, yours);
  b.submit(match.tick, theirs);
  if (a.status === 'running') a.advance(FIXED_DT, match.tick);
  if (b.status === 'running') b.advance(FIXED_DT, match.tick);
  match.net.advance(1000 * FIXED_DT);
  match.tick += 1;
}
```

Each tick, every peer does the same three things: `poll` applies whatever has arrived, `submit`
publishes this tick's local input, and `advance` steps, rewinding first when an arrival changed a
tick already played. Missing inputs are guessed by repeating the participant's last one, so a peer
never waits for the network, and it rewinds only when a guess was wrong. Leave the keys alone and
the other player's screen never rewinds, since it keeps guessing you hold nothing and is right;
yours rewinds whenever the bot turns.

Three settings decide how it behaves on a bad link:

- **`inputDelay`** publishes a local input for a later tick: two ticks is 33 ms at 60 Hz. A link
  faster than that delivers every input before anybody needs it, so on that link no peer guesses
  and none rewinds. The cost is that your own control is that late on your own screen. Set it to
  six ticks on the strip and the rewinds stop at 60 ms; set it to none and they climb.
- **`redundancy`** repeats the last few inputs in every packet, four by default. An input is only
  useful for its own tick, so asking for a lost one again would bring it after its tick had gone.
  With one input a packet and 20% loss, an input lost for good leaves a guess that is never
  corrected, and the two worlds part within two seconds; with four, the same link keeps the match
  in step.
- **Fingerprints** are a hash of each peer's world at a tick every input has confirmed, sent every
  eight ticks. When two disagree, the session halts and names the tick: two peers computed different
  worlds from the same inputs, which is a determinism defect, and carrying on would give each player
  a plausible match unrelated to the other's. An input that arrives for a tick older than the rewind
  can reach halts it too.

`status` is `running` or `halted`, and `reason` is the sentence the readout shows. Restarting is a
new session, as `R` does here.

## The link

```ts sample=netplay/main.ts#link
/* The link both peers share. Everything about it is decided by the strip: how late a packet is,
   how much later some are than others, and how many never arrive. It runs on the simulation's
   clock, so one setting gives the same match every time it is played the same way. */
let latency = Number(flag('latency', '60'));
let loss = Number(flag('loss', '5'));
let redundancy = Number(flag('redundancy', '4'));
let inputDelay = Number(flag('delay', '2'));

function impairment(): Impairment {
  return { latencyMs: latency, jitterMs: latency / 3, loss: loss / 100 };
}
```

`LoopbackNetwork` connects transports inside one page, and an `Impairment` makes the connection as
bad as asked: latency, jitter, loss, reordering and duplication, all drawn from a seed. It delivers
on the clock `advance(ms)` gives it, which the example moves by one fixed step a tick, so a setting
plays the same match every time it is played the same way. Tests and examples run on it.

Between machines a session takes a real transport. Both send binary frames and neither queues
inputs while connecting, since an input addressed to a tick that has passed is no use to anyone:

```ts sample=snippets/network.ts#transports
/** A relay over a WebSocket, which every browser and server has. Messages are binary frames. */
export function overWebSocket(url: string): WebSocketTransport {
  return new WebSocketTransport({ socket: new WebSocket(url) });
}

/**
 * Peer to peer over WebRTC, on a channel that neither orders nor retransmits: a late input is
 * worth nothing, and the session's redundancy already covers a lost one. Signalling, the offer and
 * answer exchange, is the page's, since every game does it through its own server.
 */
export function overWebRtc(connection: RTCPeerConnection, self: number): WebRtcTransport {
  return new WebRtcTransport({ channel: unreliableChannel(connection), self });
}
```

## One world as the truth

```ts sample=snippets/network.ts#authority
/**
 * One world is the truth. The host steps it and publishes what it holds; a client predicts its own
 * player, and when the host's state arrives for a tick it already ran, rewinds to it and replays its
 * own inputs over the top.
 */
export function authority(transport: WebSocketTransport, world: World, bodies: readonly Entity[]) {
  const inputs = new InputLog({ participants: bodies.length, depth: 64, inputBytes: 1 });
  const loop = new RewindLoop<WorldSnapshot>({
    step: (dt) => {
      for (const body of bodies) {
        world.write(body, Body, 'x', (world.read(body, Body, 'x') as number) + dt);
      }
    },
    snapshotter: worldSnapshotter(world),
    inputs,
    fixedDt: 1 / 60,
    depth: 16,
  });
  /* What crosses the wire is the game's to choose: here each body's position as two doubles. */
  const view = new DataView(new ArrayBuffer(16 * bodies.length));
  const replicator: Replicator = {
    encode(into) {
      bodies.forEach((body, i) => {
        view.setFloat64(i * 16, world.read(body, Body, 'x') as number);
        view.setFloat64(i * 16 + 8, world.read(body, Body, 'z') as number);
      });
      into.set(new Uint8Array(view.buffer));
      return view.byteLength;
    },
    apply(from) {
      const read = new DataView(from.buffer, from.byteOffset, from.byteLength);
      bodies.forEach((body, i) => {
        world.write(body, Body, 'x', read.getFloat64(i * 16));
        world.write(body, Body, 'z', read.getFloat64(i * 16 + 8));
      });
    },
  };
  return new AuthorityHost({ transport, loop, inputs, replicator, stateEvery: 3 });
}

export function client(
  transport: WebSocketTransport,
  loop: RewindLoop<WorldSnapshot>,
  inputs: InputLog,
  replicator: Replicator,
  self: number,
) {
  return new PredictingClient({ transport, loop, inputs, replicator, self });
}
```

With an authority, the host's world decides. `AuthorityHost` collects every client's inputs into
its own log and steps, and every `stateEvery` ticks publishes its world through a `Replicator`, the
game's own encoding of what a client needs. A `PredictingClient` steps its own copy with its own
inputs at once, so its player answers at once; when the host's state for a tick arrives, it writes
that state in, saves it over its slot, and replays its own inputs since then on top, so the
correction keeps what the player did after it. `corrections` counts them.

```ts sample=snippets/network.ts#smooth
/**
 * Another player's body, drawn between the last two states that arrived, four ticks behind, so it
 * glides where the newest state alone would step every third tick.
 */
const remote = new StateInterpolator(16, 16, 4);

export function received(tick: number, state: Uint8Array): void {
  remote.push(tick, state);
}

export function drawnAt(renderTick: number, out: { x: number; z: number }): boolean {
  const sample = remote.sample(renderTick);
  if (sample === null) return false;
  const from = new DataView(sample.from.buffer, sample.from.byteOffset, 16);
  const to = new DataView(sample.to.buffer, sample.to.byteOffset, 16);
  out.x = from.getFloat64(0) + (to.getFloat64(0) - from.getFloat64(0)) * sample.alpha;
  out.z = from.getFloat64(8) + (to.getFloat64(8) - from.getFloat64(8)) * sample.alpha;
  return true;
}
```

A body the client does not predict arrives every few ticks. `StateInterpolator` keeps the last few
states and answers two of them and a fraction between, a few ticks behind the newest, so the body
glides between the host's states instead of stepping to each.

## What a script can see

```ts sample=snippets/network.ts#script
/**
 * What a script sees of a session: who it is, whether it is the authority, how far confirmed the
 * inputs are, and a few scalars per participant it can publish and read. The page points one at
 * whichever session it runs and hands it to the script as an argument.
 */
export function scriptView(session: LockstepSession<WorldSnapshot>): ScriptSession {
  return new ScriptSession({ self: session.self, participants: session.participants }).follow(
    session,
  );
}
```

`drift/network` gives a script a `Session`: which participant it is, whether it is the authority,
the highest confirmed tick, whether the session halted and why, and a few numbered scalars per
participant that it can publish and read, such as a health bar or a lap count. A `ScriptSession`
follows whichever session the page runs and is handed to the script as an argument. `drift/rollback`
gives it the `RewindLoop` as a `Rewind`: the tick, how far a rewind reaches, and whether this step is
a replay, which is what a sound or a particle burst checks so it happens once.

Only who a peer is and whether it is the authority may be read by a `@deterministic` function. The
rest moves with packet timing, and `replicate` sends, so a replay would send again.
[What a script can reach](../scripting/reach.md#driftnetwork) lists them all.

## Fixed point

```ts sample=snippets/network.ts#fixed
/**
 * Fixed point, 48.16 in a double, for a simulation that wants its arithmetic exact on every
 * machine whatever anyone argues about floating point. Every operation is a function.
 */
export function fixedStep(position: number, velocity: number, dt: number): number {
  const next = simAdd(simFrom(position), simMul(simFrom(velocity), simFrom(dt)));
  return simTo(next);
}
```

`Sim` is a 48.16 fixed-point number held in a double, for a simulation that wants every operation
exact on every machine without depending on how a platform rounds. It is opt-in: the arithmetic
IEEE 754 fixes exactly is already the same everywhere, and [Determinism](../concepts/determinism.md)
says which operations those are.
