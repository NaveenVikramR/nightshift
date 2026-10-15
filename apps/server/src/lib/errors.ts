/**
 * An expected failure with a user-safe spoken message (no internals, IDs or URLs).
 * Tools and clients throw it; runTool turns it into an isError result with this speak.
 */
export class UserFacingError extends Error {
  constructor(
    readonly code: string,
    readonly speak: string,
    message?: string,
  ) {
    super(message ?? code);
    this.name = 'UserFacingError';
  }
}
