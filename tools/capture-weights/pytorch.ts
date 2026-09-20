/**
 * A PyTorch checkpoint, read as data: the zip `torch.save` writes, whose `data.pkl` pickles a state
 * dictionary and whose `data/<key>` entries hold each storage's bytes.
 *
 * **A pickle is a program, and this interprets a small, closed part of it.** The opcodes a state
 * dictionary is written with — dictionaries, tuples, strings, integers, persistent ids — and
 * exactly four callables: `OrderedDict`, and the three `torch._utils` functions that rebuild a
 * tensor or a parameter from a storage. **A pickle naming any other global is refused by that name
 * when the name is read**, before anything could look it up, so nothing a file names is ever run.
 * What it gives up is a checkpoint that pickles more than tensors — an optimiser, a whole module —
 * which is not a weights file, and which Python's own unpickler would have run.
 */
import { ELEMENT_BYTES, elementCount, type StoredTensor } from './checkpoint.ts';
import { zipEntries } from './zip.ts';

/** Storage classes, by the element type safetensors would give their elements. */
const STORAGES: Readonly<Record<string, string>> = {
  'torch.FloatStorage': 'F32',
  'torch.DoubleStorage': 'F64',
  'torch.HalfStorage': 'F16',
  'torch.BFloat16Storage': 'BF16',
  'torch.LongStorage': 'I64',
  'torch.IntStorage': 'I32',
  'torch.ShortStorage': 'I16',
  'torch.CharStorage': 'I8',
  'torch.ByteStorage': 'U8',
  'torch.BoolStorage': 'BOOL',
};

interface Global {
  readonly global: string;
}
interface Storage {
  readonly dtype: string;
  readonly bytes: Uint8Array;
}
interface Tensor {
  readonly tensor: StoredTensor;
}
type Value =
  | null
  | boolean
  | number
  | bigint
  | string
  | readonly Value[]
  | Map<Value, Value>
  | Global
  | Storage
  | Tensor;

const MARK = Symbol('mark');

/** `_rebuild_tensor_v2`: a view of a storage — offset, size and strides — made contiguous. */
function rebuildTensor(args: readonly Value[]): Tensor {
  const [storage, offset, size, stride] = args as [Storage, number, number[], number[]];
  const width = ELEMENT_BYTES[storage.dtype] as number;
  const count = elementCount(size);
  const elements = storage.bytes.byteLength / width;
  const contiguous = size.every((_, d) => stride[d] === elementCount(size.slice(d + 1)));
  if (contiguous) {
    if (offset + count > elements) throw new Error('a tensor reads past the end of its storage');
    const bytes = storage.bytes.subarray(offset * width, (offset + count) * width);
    return { tensor: { dtype: storage.dtype, shape: size, bytes } };
  }
  /* A strided view — a transpose, a slice — gathered element by element into row-major order. */
  const bytes = new Uint8Array(count * width);
  const index = size.map(() => 0);
  for (let n = 0; n < count; n += 1) {
    let from = offset;
    for (let d = 0; d < size.length; d += 1) from += (index[d] as number) * (stride[d] as number);
    if (from >= elements) throw new Error('a tensor reads past the end of its storage');
    bytes.set(storage.bytes.subarray(from * width, (from + 1) * width), n * width);
    for (let d = size.length - 1; d >= 0; d -= 1) {
      index[d] = (index[d] as number) + 1;
      if ((index[d] as number) < (size[d] as number)) break;
      index[d] = 0;
    }
  }
  return { tensor: { dtype: storage.dtype, shape: size, bytes } };
}

const CALLABLE: Readonly<Record<string, (args: readonly Value[]) => Value>> = {
  'collections.OrderedDict': () => new Map(),
  'torch._utils._rebuild_tensor_v2': rebuildTensor,
  'torch._utils._rebuild_parameter': (args) => args[0] as Value,
  'torch._utils._rebuild_parameter_with_state': (args) => args[0] as Value,
};

function allowed(name: string): Global {
  if (CALLABLE[name] === undefined && STORAGES[name] === undefined) {
    throw new Error(
      `the checkpoint's pickle names ${name}, which rebuilds no tensor; it is refused unread`,
    );
  }
  return { global: name };
}

/** The pickle's value, with each persistent id resolved to a storage by `load`. */
function unpickle(bytes: Uint8Array, load: (id: readonly Value[]) => Storage): Value {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const decoder = new TextDecoder();
  const stack: (Value | typeof MARK)[] = [];
  const memo = new Map<number, Value>();
  let at = 0;
  const pop = (): Value => stack.pop() as Value;
  const popMark = (): Value[] => {
    const mark = stack.lastIndexOf(MARK);
    const items = stack.splice(mark + 1) as Value[];
    stack.pop();
    return items;
  };
  const top = (): Value => stack[stack.length - 1] as Value;
  const string = (length: number): string => {
    const value = decoder.decode(bytes.subarray(at, at + length));
    at += length;
    return value;
  };
  const line = (): string => {
    const end = bytes.indexOf(0x0a, at);
    return string(end - at + 1).slice(0, -1);
  };
  const call = (callable: Value, args: readonly Value[]): Value => {
    const name = (callable as Global).global;
    const run = CALLABLE[name];
    if (run === undefined)
      throw new Error(`the checkpoint's pickle calls ${name}, which is not a constructor`);
    return run(args);
  };
  for (;;) {
    const op = bytes[at] as number;
    at += 1;
    switch (op) {
      case 0x80: // PROTO
        at += 1;
        break;
      case 0x95: // FRAME
        at += 8;
        break;
      case 0x7d: // EMPTY_DICT
        stack.push(new Map());
        break;
      case 0x5d: // EMPTY_LIST
        stack.push([]);
        break;
      case 0x29: // EMPTY_TUPLE
        stack.push([]);
        break;
      case 0x28: // MARK
        stack.push(MARK);
        break;
      case 0x71: // BINPUT
        memo.set(bytes[at] as number, top());
        at += 1;
        break;
      case 0x72: // LONG_BINPUT
        memo.set(view.getUint32(at, true), top());
        at += 4;
        break;
      case 0x94: // MEMOIZE
        memo.set(memo.size, top());
        break;
      case 0x68: // BINGET
        stack.push(memo.get(bytes[at] as number) as Value);
        at += 1;
        break;
      case 0x6a: // LONG_BINGET
        stack.push(memo.get(view.getUint32(at, true)) as Value);
        at += 4;
        break;
      case 0x58: // BINUNICODE
      case 0x54: // BINSTRING
        at += 4;
        stack.push(string(view.getUint32(at - 4, true)));
        break;
      case 0x8c: // SHORT_BINUNICODE
      case 0x55: // SHORT_BINSTRING
        at += 1;
        stack.push(string(bytes[at - 1] as number));
        break;
      case 0x8d: // BINUNICODE8
        at += 8;
        stack.push(string(Number(view.getBigUint64(at - 8, true))));
        break;
      case 0x63: {
        // GLOBAL
        const module = line();
        stack.push(allowed(`${module}.${line()}`));
        break;
      }
      case 0x93: {
        // STACK_GLOBAL
        const name = pop() as string;
        stack.push(allowed(`${pop() as string}.${name}`));
        break;
      }
      case 0x4a: // BININT
        stack.push(view.getInt32(at, true));
        at += 4;
        break;
      case 0x4b: // BININT1
        stack.push(bytes[at] as number);
        at += 1;
        break;
      case 0x4d: // BININT2
        stack.push(view.getUint16(at, true));
        at += 2;
        break;
      case 0x8a: {
        // LONG1: a little-endian two's-complement integer of the given length
        const length = bytes[at] as number;
        let value = 0n;
        for (let i = length - 1; i >= 0; i -= 1)
          value = (value << 8n) | BigInt(bytes[at + 1 + i] as number);
        if (length > 0 && ((bytes[at + length] as number) & 0x80) !== 0)
          value -= 1n << BigInt(8 * length);
        at += 1 + length;
        stack.push(
          value >= BigInt(Number.MIN_SAFE_INTEGER) && value <= BigInt(Number.MAX_SAFE_INTEGER)
            ? Number(value)
            : value,
        );
        break;
      }
      case 0x47: // BINFLOAT, big-endian
        stack.push(view.getFloat64(at, false));
        at += 8;
        break;
      case 0x4e: // NONE
        stack.push(null);
        break;
      case 0x88: // NEWTRUE
        stack.push(true);
        break;
      case 0x89: // NEWFALSE
        stack.push(false);
        break;
      case 0x74: // TUPLE
        stack.push(popMark());
        break;
      case 0x85: // TUPLE1
        stack.push([pop()]);
        break;
      case 0x86: {
        // TUPLE2
        const b = pop();
        stack.push([pop(), b]);
        break;
      }
      case 0x87: {
        // TUPLE3
        const c = pop();
        const b = pop();
        stack.push([pop(), b, c]);
        break;
      }
      case 0x51: // BINPERSID
        stack.push(load(pop() as readonly Value[]));
        break;
      case 0x52: {
        // REDUCE
        const args = pop() as readonly Value[];
        stack.push(call(pop(), args));
        break;
      }
      case 0x62: // BUILD: a state for the object below — `_metadata` on a state dictionary
        pop();
        break;
      case 0x73: {
        // SETITEM
        const value = pop();
        const key = pop();
        (top() as Map<Value, Value>).set(key, value);
        break;
      }
      case 0x75: {
        // SETITEMS
        const items = popMark();
        const map = top() as Map<Value, Value>;
        for (let i = 0; i < items.length; i += 2) map.set(items[i] as Value, items[i + 1] as Value);
        break;
      }
      case 0x61: {
        // APPEND
        const value = pop();
        (top() as Value[]).push(value);
        break;
      }
      case 0x65: // APPENDS
        (top() as Value[]).push(...popMark());
        break;
      case 0x2e: // STOP
        return pop();
      default:
        throw new Error(
          `the checkpoint's pickle has opcode 0x${op.toString(16)} at byte ${at - 1}, ` +
            'which a state dictionary is not written with',
        );
    }
  }
}

/** A checkpoint `torch.save` wrote: its state dictionary's tensors, by name, in its order. */
export function readPytorch(file: Uint8Array): Map<string, StoredTensor> {
  const entries = zipEntries(file);
  const pickle = [...entries.keys()].find((name) => name.endsWith('data.pkl'));
  if (pickle === undefined) throw new Error('no data.pkl: this is not a checkpoint torch wrote');
  const prefix = pickle.slice(0, -'data.pkl'.length);
  const order = entries.get(`${prefix}byteorder`);
  if (order !== undefined && new TextDecoder().decode(order).trim() !== 'little') {
    throw new Error('the checkpoint was written big-endian, and every reader here is little');
  }
  const storages = new Map<string, Storage>();
  const load = (id: readonly Value[]): Storage => {
    const [kind, type, key] = id as [string, Global, string];
    const dtype = STORAGES[type.global];
    const bytes = entries.get(`${prefix}data/${key}`);
    if (kind !== 'storage' || dtype === undefined || bytes === undefined) {
      throw new Error(`the checkpoint names a storage "${String(key)}" it does not hold`);
    }
    let storage = storages.get(key);
    if (storage === undefined) {
      storage = { dtype, bytes };
      storages.set(key, storage);
    }
    return storage;
  };
  const root = unpickle(entries.get(pickle) as Uint8Array, load);
  if (!(root instanceof Map)) throw new Error('the checkpoint is not a state dictionary');
  const tensors = new Map<string, StoredTensor>();
  for (const [name, value] of root) {
    if (
      typeof name !== 'string' ||
      value === null ||
      typeof value !== 'object' ||
      !('tensor' in value)
    ) {
      throw new Error(`the state dictionary's "${String(name)}" is not a tensor`);
    }
    tensors.set(name, value.tensor);
  }
  return tensors;
}
