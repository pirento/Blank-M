/** Atomic, monotonic counters (for example the order-plan server revision). */
import mongoose from 'mongoose';

const counterSchema = new mongoose.Schema({ _id: String, value: { type: Number, default: 0 } });

export const Counter = mongoose.models.Counter || mongoose.model('Counter', counterSchema);

/** Atomically increments the named counter (creating it at 1) and returns the new value. */
export async function nextSequence(name) {
  const counter = await Counter.findOneAndUpdate(
    { _id: name },
    { $inc: { value: 1 } },
    { upsert: true, new: true },
  );
  if (!Number.isSafeInteger(counter.value)) throw new Error('Sequence exhausted.');
  return counter.value;
}
