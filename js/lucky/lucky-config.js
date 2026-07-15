/**
 * Lucky Feature Flag
 * ===================
 * This is the ONLY switch controlling whether Lucky exists anywhere
 * in the UI. When false, shell.js never fetches, injects, or
 * references any Lucky component, CSS, or script — Lucky has zero
 * footprint in the DOM and zero network requests.
 *
 * To enable Lucky on launch day: change false to true below.
 * No other file needs to change.
 */
window.LUCKY_ENABLED = false;
