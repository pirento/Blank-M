/**
 * Runs once before any test file: makes sure the in-memory MongoDB binary is
 * downloaded. Without it, parallel test files on a fresh machine (CI) all
 * start the same download and race on renaming the archive.
 */
import { MongoBinary } from 'mongodb-memory-server';

export default async function setup() {
  await MongoBinary.getPath();
}
