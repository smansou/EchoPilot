/**
 * M03 resumable job state.
 *
 * `ImportCheckpointStore` is the durable commit point of the cold-start import job: the byte offset
 * that a killed import resumes at, kept in an atomically written file next to the store.
 */
export {
  IMPORT_CHECKPOINT_FILE,
  IMPORT_CHECKPOINT_VERSION,
  ImportCheckpointStore,
  type ImportCheckpoint,
} from './checkpoint.js';
