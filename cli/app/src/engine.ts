/**
 * The one door to the agent core.
 *
 * The CLI exists to test the engine as it is being written, so it imports the core from this repo's
 * `src/` rather than from npm: an engine change is testable the moment it is saved, with no build
 * and no publish. Every other file imports from here, so pointing the CLI at the published package
 * instead is a one-line change.
 */
export * from '../../../src/index.ts';
