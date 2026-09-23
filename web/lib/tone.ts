/**
 * The colour a signed result earns, everywhere one is shown: ahead is green,
 * behind is red, level is neither. One rule, one place, so a win never reads
 * as a loss on one screen and a win on the next.
 *
 * Money that is simply held - a balance, a stake, a prize - is gold instead,
 * and takes no tone from here: it is a quantity, not an outcome.
 */
export const netTone = (n: number): string => (n > 0 ? "text-win" : n < 0 ? "text-loss" : "text-muted");

/** The same rule for a filled bar rather than text. */
export const netFill = (n: number): string => (n > 0 ? "bg-win" : n < 0 ? "bg-loss" : "bg-line");
