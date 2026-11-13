// The one clock the timer code reads. Date.now() keeps wall time across iOS suspension;
// performance.now() may not, so it is never used for timing (plan section 10). Tests swap now().

export const clock = {
  /** @returns {number} epoch ms */
  now: () => Date.now(),
};
